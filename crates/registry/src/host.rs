//! The registry over synchronous storage: what `shelfkit serve` runs, and a
//! reference for any host whose storage can be read in line.
//!
//! A host implements [`Store`] and [`Keys`]; [`Registry::handle`] does the
//! rest through [`crate::protocol`]. [`MemoryStore`] and [`MemoryKeys`] keep
//! everything in memory, which is all a local registry needs: durability is
//! the hosted service's concern.

use crate::auth::{Access, Credential, Scope};
use crate::identity::PackageId;
use crate::protocol::{self, Body, Context, Payload, Prepared, Response, ShelfInfo, VersionRecord};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Where packages live.
pub trait Store {
    /// The shelf serving `owner` (lowercase), if there is one.
    fn shelf(&self, owner: &str) -> Option<ShelfInfo>;
    /// The versions of a package (by [`PackageId::key`]), in publish order.
    fn versions(&self, package: &str) -> Vec<VersionRecord>;
    /// The archive of one version.
    fn archive(&self, package: &str, version: &str) -> Option<Vec<u8>>;
    /// Store a version, only if it is absent. On a conflict, return the
    /// version already there and change nothing.
    fn insert(
        &mut self,
        package: &str,
        record: VersionRecord,
        archive: Vec<u8>,
    ) -> Result<(), VersionRecord>;
}

/// Which keys exist, and their scopes.
pub trait Keys {
    /// The scopes of `key`, or `None` when the registry has no such key.
    fn scopes(&self, key: &str) -> Option<Vec<Scope>>;
}

/// An HTTP request, as much of it as the registry reads.
#[derive(Debug, Clone, Default)]
pub struct Request {
    pub method: String,
    /// The path relative to the registry's base URL, with any query.
    pub path: String,
    /// Header names in any case.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// An HTTP response with its body in bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// A registry over a store and a key set, served below `mount`.
pub struct Registry<S, K> {
    pub store: S,
    pub keys: K,
    /// The path the base URL adds: `""` at the root, `/apm` under PRD 7.1's
    /// mount. Request paths include it.
    pub mount: String,
}

impl<S: Store, K: Keys> Registry<S, K> {
    /// A registry at the root of its host.
    pub fn new(store: S, keys: K) -> Self {
        Self {
            store,
            keys,
            mount: String::new(),
        }
    }

    /// Handle one request. `now` is the time a publish records, RFC 3339 UTC.
    pub fn handle(&mut self, request: &Request, now: &str) -> HttpResponse {
        self.dispatch(request, None, now)
    }

    /// Publish an archive the host built itself, exactly as a `PUT` with a
    /// `publish:{owner}/*` key would: how `shelfkit serve` puts the shelf's
    /// own profiles up.
    pub fn publish(
        &mut self,
        package: &PackageId,
        version: &str,
        archive: Vec<u8>,
        now: &str,
    ) -> HttpResponse {
        let request = Request {
            method: "PUT".to_owned(),
            path: format!(
                "{}/v1/packages/{}/versions/{}",
                self.mount,
                package.path(),
                crate::identity::encode(version)
            ),
            headers: vec![(
                "Content-Type".to_owned(),
                crate::archive::CONTENT_TYPE.to_owned(),
            )],
            body: archive,
        };
        let access = Access::Key {
            scopes: vec![Scope::PublishOwner(package.owner_key())],
        };
        self.dispatch(&request, Some(access), now)
    }

    fn dispatch(&mut self, request: &Request, access: Option<Access>, now: &str) -> HttpResponse {
        let prepared = protocol::prepare(
            &request.method,
            &request.path,
            &self.mount,
            request.header("authorization"),
        );
        let (route, credential) = match prepared {
            Prepared::Respond(response) => return self.send(response),
            Prepared::Route { route, credential } => (route, credential),
        };
        let access = access.unwrap_or_else(|| resolve(&self.keys, &credential));
        let package = route.package().clone();
        let context = Context {
            shelf: self.store.shelf(&package.owner_key()),
            versions: self.store.versions(&package.key()),
        };
        let payload = Payload {
            content_type: request.header("content-type"),
            if_none_match: request.header("if-none-match"),
            body: &request.body,
        };
        let outcome = protocol::respond(&route, &request.path, &access, &context, payload, now);
        if let Some(record) = outcome.publish
            && let Err(existing) = self
                .store
                .insert(&package.key(), record, request.body.clone())
        {
            let instance = request.path.split('?').next().unwrap_or_default();
            return self.send(protocol::conflict(&package, &existing, instance));
        }
        self.send(outcome.response)
    }

    fn send(&self, response: Response) -> HttpResponse {
        let body = match response.body {
            Body::Empty => Vec::new(),
            Body::Json { text } => text.into_bytes(),
            Body::Archive { package, version } => {
                match self.store.archive(&package, &version) {
                    Some(bytes) => bytes,
                    None => {
                        // The record exists but its bytes do not: the store is broken.
                        return self.send(protocol::problem(
                            500,
                            "missing-archive",
                            "Archive missing",
                            &format!("the archive of {package} {version} is missing from storage"),
                            "",
                        ));
                    }
                }
            }
        };
        HttpResponse {
            status: response.status,
            headers: response.headers,
            body,
        }
    }
}

/// Resolve a credential to what the key set says about it.
pub fn resolve(keys: &dyn Keys, credential: &Credential) -> Access {
    match credential {
        Credential::None => Access::Anonymous,
        Credential::Unreadable(_) => Access::Invalid,
        Credential::Key(key) => match keys.scopes(key) {
            Some(scopes) => Access::Key { scopes },
            None => Access::Invalid,
        },
    }
}

/// Packages in memory, under one or more shelves.
#[derive(Debug, Default)]
pub struct MemoryStore {
    shelves: BTreeMap<String, ShelfInfo>,
    packages: BTreeMap<String, Vec<(VersionRecord, Vec<u8>)>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Serve a shelf under `owner`.
    pub fn add_shelf(&mut self, owner: &str, public: bool) {
        self.shelves
            .insert(owner.to_ascii_lowercase(), ShelfInfo { public });
    }
}

impl Store for MemoryStore {
    fn shelf(&self, owner: &str) -> Option<ShelfInfo> {
        self.shelves.get(owner).copied()
    }

    fn versions(&self, package: &str) -> Vec<VersionRecord> {
        self.packages
            .get(package)
            .map(|versions| versions.iter().map(|(record, _)| record.clone()).collect())
            .unwrap_or_default()
    }

    fn archive(&self, package: &str, version: &str) -> Option<Vec<u8>> {
        self.packages
            .get(package)?
            .iter()
            .find(|(record, _)| record.version == version)
            .map(|(_, bytes)| bytes.clone())
    }

    fn insert(
        &mut self,
        package: &str,
        record: VersionRecord,
        archive: Vec<u8>,
    ) -> Result<(), VersionRecord> {
        let versions = self.packages.entry(package.to_owned()).or_default();
        if let Some((existing, _)) = versions.iter().find(|(r, _)| r.version == record.version) {
            return Err(existing.clone());
        }
        versions.push((record, archive));
        Ok(())
    }
}

/// Keys in memory, held as `sha256` digests and compared in constant time,
/// so a key is never kept, logged, or compared as plain text.
#[derive(Default)]
pub struct MemoryKeys {
    keys: Vec<([u8; 32], Vec<Scope>)>,
}

impl MemoryKeys {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, key: &str, scopes: Vec<Scope>) {
        self.keys
            .push((Sha256::digest(key.as_bytes()).into(), scopes));
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

impl std::fmt::Debug for MemoryKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MemoryKeys({} keys)", self.keys.len())
    }
}

impl Keys for MemoryKeys {
    fn scopes(&self, key: &str) -> Option<Vec<Scope>> {
        let presented: [u8; 32] = Sha256::digest(key.as_bytes()).into();
        let mut found = None;
        for (digest, scopes) in &self.keys {
            let difference = digest
                .iter()
                .zip(presented.iter())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b));
            if difference == 0 && found.is_none() {
                found = Some(scopes.clone());
            }
        }
        found
    }
}
