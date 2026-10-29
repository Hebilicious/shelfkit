//! The Git calls: `shelfkit_git_commit` and `shelfkit_git_report` for a
//! client; `shelfkit_git_receive`, `shelfkit_git_advertise`,
//! `shelfkit_git_upload_request`, `shelfkit_git_upload_response`, and
//! `shelfkit_git_status` for a server (see the crate documentation for their
//! JSON).

use crate::{Encoding, Failure, Problem, Status, bad_request};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use shelfkit_git::receive_pack::{self, RefStatus};
use shelfkit_git::serve::{self, Negotiation, Service, UploadAnswer};
use shelfkit_git::tree;
use shelfkit_git::{
    Commit, CommitInput, CommitPlan, FileEntry, Kind, Mode, NewFile, ObjectId, Signature, Source,
    pack, plan_commit,
};
use shelfkit_registry::{PackageId, base64};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitRequest {
    #[serde(default)]
    parent: Option<String>,
    base: Vec<BaseFile>,
    files: Vec<FileInput>,
    #[serde(default = "default_reference", rename = "ref")]
    reference: String,
    author: SignatureInput,
    #[serde(default)]
    committer: Option<SignatureInput>,
    message: String,
}

fn default_reference() -> String {
    "refs/heads/main".to_owned()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BaseFile {
    path: String,
    mode: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileInput {
    path: String,
    #[serde(default)]
    mode: Option<String>,
    /// A blob of the parent commit.
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    contents: Option<String>,
    #[serde(default)]
    encoding: Encoding,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignatureInput {
    name: String,
    email: String,
    /// Unix seconds.
    time: i64,
    /// Minutes east of UTC.
    offset: i32,
}

impl From<SignatureInput> for Signature {
    fn from(input: SignatureInput) -> Self {
        Self {
            name: input.name,
            email: input.email,
            time: input.time,
            offset: input.offset,
        }
    }
}

#[derive(Serialize)]
struct FileOutput {
    path: String,
    mode: &'static str,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitOutput {
    commit: Option<String>,
    tree: String,
    unchanged: bool,
    objects: usize,
    files: Vec<FileOutput>,
    /// The receive-pack request body, base64.
    request: Option<String>,
}

/// Plan a commit and its push: the output of `shelfkit_git_commit`.
pub fn commit(input: &[u8]) -> (Status, Vec<u8>) {
    let request: CommitRequest = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => return bad_request(format!("not a commit request: {error}")),
    };
    let input = match commit_input(request) {
        Ok(input) => input,
        Err(answer) => return answer,
    };
    match plan_commit(&input) {
        Ok(plan) => planned(&plan),
        Err(errors) => failure(&errors),
    }
}

/// A planned commit as `shelfkit_git_commit` and `shelfkit_git_version` answer it.
fn planned(plan: &CommitPlan) -> (Status, Vec<u8>) {
    let output = CommitOutput {
        commit: plan.push.as_ref().map(|push| push.commit.to_string()),
        tree: plan.tree.to_string(),
        unchanged: plan.unchanged(),
        objects: plan.objects,
        files: plan
            .files
            .iter()
            .map(|file| FileOutput {
                path: file.path.clone(),
                mode: file.mode.as_str(),
                id: file.id.to_string(),
            })
            .collect(),
        request: plan.push.as_ref().map(|push| base64::encode(&push.request)),
    };
    (
        Status::Planned,
        serde_json::to_vec(&output).unwrap_or_default(),
    )
}

/// The library's input from the request. A malformed id or encoding is a
/// bad request; a mode that is not a file mode is an error on its file.
fn commit_input(request: CommitRequest) -> Result<CommitInput, (Status, Vec<u8>)> {
    let mut problems = Vec::new();
    let mut mode = |path: &str, text: Option<&str>| match text.map(str::parse::<Mode>) {
        None => Mode::File,
        Some(Ok(mode)) => mode,
        Some(Err(_)) => {
            problems.push(Problem {
                path: path.to_owned(),
                message: format!(
                    "`{}` is not a file mode: 100644, 100755, 120000, or 160000",
                    text.unwrap_or_default()
                ),
            });
            Mode::File
        }
    };
    let parent = match request.parent.as_deref().map(object_id).transpose() {
        Ok(parent) => parent,
        Err(message) => return Err(bad_request(format!("parent: {message}"))),
    };
    let mut base = Vec::with_capacity(request.base.len());
    for file in request.base {
        let id = object_id(&file.id)
            .map_err(|message| bad_request(format!("base {}: {message}", file.path)))?;
        base.push(FileEntry {
            mode: mode(&file.path, Some(&file.mode)),
            path: file.path,
            id,
        });
    }
    let mut files = Vec::with_capacity(request.files.len());
    for file in request.files {
        let source = match (file.id, file.contents) {
            (Some(id), None) => Source::Known(
                object_id(&id)
                    .map_err(|message| bad_request(format!("{}: {message}", file.path)))?,
            ),
            (None, Some(contents)) => Source::Contents(match file.encoding {
                Encoding::Utf8 => contents.into_bytes(),
                Encoding::Base64 => base64::decode(&contents).ok_or_else(|| {
                    bad_request(format!("{}: contents are not valid base64", file.path))
                })?,
            }),
            _ => {
                return Err(bad_request(format!(
                    "{}: a file has either `id` or `contents`",
                    file.path
                )));
            }
        };
        files.push(NewFile {
            mode: mode(&file.path, file.mode.as_deref()),
            path: file.path,
            source,
        });
    }
    if !problems.is_empty() {
        return Err((
            Status::Failed,
            serde_json::to_vec(&Failure { errors: problems }).unwrap_or_default(),
        ));
    }
    Ok(CommitInput {
        parent,
        base,
        files,
        reference: request.reference,
        tags: Vec::new(),
        author: request.author.into(),
        committer: request.committer.map(Signature::from),
        message: request.message,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionRequest {
    /// `owner/repo`.
    package: String,
    version: String,
    /// The archive, base64.
    archive: String,
    /// Unix seconds.
    published_at: i64,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    base: Vec<BaseFile>,
}

/// Commit a published version: the output of `shelfkit_git_version`.
pub fn version(input: &[u8]) -> (Status, Vec<u8>) {
    let request: VersionRequest = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => return bad_request(format!("not a version request: {error}")),
    };
    let package = match PackageId::parse(&request.package) {
        Ok(package) => package,
        Err(message) => return bad_request(format!("package: {message}")),
    };
    let Some(archive) = base64::decode(&request.archive) else {
        return bad_request("`archive` is not valid base64".to_owned());
    };
    let parent = match request.parent.as_deref().map(object_id).transpose() {
        Ok(parent) => parent,
        Err(message) => return bad_request(format!("parent: {message}")),
    };
    let mut base = Vec::with_capacity(request.base.len());
    for file in request.base {
        let (Ok(id), Ok(mode)) = (object_id(&file.id), file.mode.parse::<Mode>()) else {
            return bad_request(format!("base {}: not an id and a file mode", file.path));
        };
        base.push(FileEntry {
            path: file.path,
            mode,
            id,
        });
    }
    let committed = shelfkit_registry::git::commit(&shelfkit_registry::git::Version {
        package: &package,
        version: &request.version,
        archive: &archive,
        published_at: request.published_at,
        parent: parent.map(|commit| (commit, base.as_slice())),
    });
    match committed {
        Ok(plan) => planned(&plan),
        Err(message) => (
            Status::Failed,
            serde_json::to_vec(&Failure {
                errors: vec![Problem {
                    path: "<archive>".to_owned(),
                    message,
                }],
            })
            .unwrap_or_default(),
        ),
    }
}

fn object_id(text: &str) -> Result<ObjectId, String> {
    text.parse::<ObjectId>()
        .map_err(|_| format!("`{text}` is not an object id: 40 hex digits"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BodyRequest {
    /// The bytes, base64.
    body: String,
}

fn body(input: &[u8], call: &str) -> Result<Vec<u8>, (Status, Vec<u8>)> {
    let request: BodyRequest = serde_json::from_slice(input)
        .map_err(|error| bad_request(format!("not a {call} request: {error}")))?;
    base64::decode(&request.body)
        .ok_or_else(|| bad_request("`body` is not valid base64".to_owned()))
}

/// Read a receive-pack report: the output of `shelfkit_git_report`.
pub fn report(input: &[u8]) -> (Status, Vec<u8>) {
    let body = match body(input, "report") {
        Ok(body) => body,
        Err(answer) => return answer,
    };
    let report = match receive_pack::parse_report(&body) {
        Ok(report) => report,
        Err(error) => return failure(&[error]),
    };
    let unpack = match report.unpack {
        Ok(()) => json!({ "ok": true }),
        Err(message) => json!({ "ok": false, "message": message }),
    };
    let refs: Vec<Value> = report
        .refs
        .into_iter()
        .map(|RefStatus { name, result }| match result {
            Ok(()) => json!({ "name": name, "ok": true }),
            Err(reason) => json!({ "name": name, "ok": false, "reason": reason }),
        })
        .collect();
    let output = json!({ "unpack": unpack, "refs": refs });
    (
        Status::Planned,
        serde_json::to_vec(&output).unwrap_or_default(),
    )
}

/// Read a receive-pack request as a server does: the output of
/// `shelfkit_git_receive`.
pub fn receive(input: &[u8]) -> (Status, Vec<u8>) {
    let body = match body(input, "receive") {
        Ok(body) => body,
        Err(answer) => return answer,
    };
    let request = match receive_pack::parse_request(&body) {
        Ok(request) => request,
        Err(error) => return failure(&[error]),
    };
    let objects = if request.pack.is_empty() {
        Vec::new()
    } else {
        match pack::read(&request.pack) {
            Ok(objects) => objects,
            Err(error) => return failure(&[error]),
        }
    };
    let mut described = Vec::with_capacity(objects.len());
    for object in &objects {
        match describe(object) {
            Ok(value) => described.push(value),
            Err(error) => return failure(&[error]),
        }
    }
    let updates: Vec<Value> = request
        .updates
        .iter()
        .map(|update| {
            json!({
                "old": update.old.to_string(),
                "new": update.new.to_string(),
                "name": update.name,
            })
        })
        .collect();
    let output = json!({
        "updates": updates,
        "capabilities": request.capabilities,
        "objects": described,
    });
    (
        Status::Planned,
        serde_json::to_vec(&output).unwrap_or_default(),
    )
}

/// One object of a received pack, decoded by its kind.
fn describe(object: &pack::PackObject) -> shelfkit_git::Result<Value> {
    let id = object.id.to_string();
    let kind = object.kind.name();
    Ok(match object.kind {
        Kind::Blob | Kind::Tag => {
            json!({ "id": id, "kind": kind, "contents": base64::encode(&object.body) })
        }
        Kind::Tree => {
            let entries: Vec<Value> = tree::decode(&object.body)?
                .into_iter()
                .map(|entry| {
                    json!({
                        "name": entry.name,
                        "mode": entry.mode.as_str(),
                        "id": entry.id.to_string(),
                    })
                })
                .collect();
            json!({ "id": id, "kind": kind, "entries": entries, "body": base64::encode(&object.body) })
        }
        Kind::Commit => {
            let commit = Commit::decode(&object.body)?;
            let parents: Vec<String> = commit.parents.iter().map(ToString::to_string).collect();
            json!({
                "id": id,
                "kind": kind,
                "tree": commit.tree.to_string(),
                "parents": parents,
                "author": { "name": commit.author.name, "email": commit.author.email },
                "committer": { "name": commit.committer.name, "email": commit.committer.email },
                "authoredAt": commit.author.time,
                "committedAt": commit.committer.time,
                "message": commit.message,
                "body": base64::encode(&object.body),
            })
        }
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AdvertiseRequest {
    service: String,
    refs: Vec<RefInput>,
    #[serde(default)]
    head: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RefInput {
    name: String,
    id: String,
}

fn service(name: &str) -> Result<Service, String> {
    match name {
        "git-upload-pack" => Ok(Service::UploadPack),
        "git-receive-pack" => Ok(Service::ReceivePack),
        other => Err(format!(
            "`{other}` is not `git-upload-pack` or `git-receive-pack`"
        )),
    }
}

fn answer(body: shelfkit_git::Result<Vec<u8>>) -> (Status, Vec<u8>) {
    match body {
        Ok(body) => (
            Status::Planned,
            serde_json::to_vec(&json!({ "body": base64::encode(&body) })).unwrap_or_default(),
        ),
        Err(error) => failure(&[error]),
    }
}

/// The body of `GET info/refs?service=<service>`: the output of
/// `shelfkit_git_advertise`.
pub fn advertise(input: &[u8]) -> (Status, Vec<u8>) {
    let request: AdvertiseRequest = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => return bad_request(format!("not an advertise request: {error}")),
    };
    let wanted = match service(&request.service) {
        Ok(wanted) => wanted,
        Err(message) => return bad_request(message),
    };
    let mut refs = Vec::with_capacity(request.refs.len());
    for reference in request.refs {
        match object_id(&reference.id) {
            Ok(id) => refs.push((reference.name, id)),
            Err(message) => return bad_request(message),
        }
    }
    answer(serve::advertise(wanted, &refs, request.head.as_deref()))
}

fn negotiation_name(negotiation: Negotiation) -> &'static str {
    match negotiation {
        Negotiation::None => "none",
        Negotiation::Round => "round",
        Negotiation::Done => "done",
    }
}

fn ids(ids: &[ObjectId]) -> Vec<String> {
    ids.iter().map(ToString::to_string).collect()
}

/// Read a `git-upload-pack` request: the output of
/// `shelfkit_git_upload_request`.
pub fn upload_request(input: &[u8]) -> (Status, Vec<u8>) {
    let body = match body(input, "upload") {
        Ok(body) => body,
        Err(answer) => return answer,
    };
    let request = match serve::parse_upload_request(&body) {
        Ok(request) => request,
        Err(error) => return failure(&[error]),
    };
    let output = json!({
        "wants": ids(&request.wants),
        "capabilities": request.capabilities,
        "shallows": ids(&request.shallows),
        "depth": request.depth,
        "haves": ids(&request.haves),
        "negotiation": negotiation_name(request.negotiation),
        "deepens": request.deepens(),
    });
    (
        Status::Planned,
        serde_json::to_vec(&output).unwrap_or_default(),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UploadResponseRequest {
    deepens: bool,
    shallow: Vec<String>,
    unshallow: Vec<String>,
    negotiation: String,
    common: Vec<String>,
    pack: Vec<PackInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PackInput {
    kind: String,
    /// The object's body, base64.
    body: String,
}

fn parse_ids(texts: &[String]) -> Result<Vec<ObjectId>, String> {
    texts.iter().map(|text| object_id(text)).collect()
}

fn kind(name: &str) -> Result<Kind, String> {
    match name {
        "commit" => Ok(Kind::Commit),
        "tree" => Ok(Kind::Tree),
        "blob" => Ok(Kind::Blob),
        "tag" => Ok(Kind::Tag),
        other => Err(format!("`{other}` is not an object kind")),
    }
}

/// The body of a `git-upload-pack` answer: the output of
/// `shelfkit_git_upload_response`.
pub fn upload_response(input: &[u8]) -> (Status, Vec<u8>) {
    let request: UploadResponseRequest = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => return bad_request(format!("not an upload response request: {error}")),
    };
    let read = || -> Result<_, String> {
        let negotiation = match request.negotiation.as_str() {
            "none" => Negotiation::None,
            "round" => Negotiation::Round,
            "done" => Negotiation::Done,
            other => return Err(format!("`{other}` is not `none`, `round`, or `done`")),
        };
        let mut pack = Vec::with_capacity(request.pack.len());
        for object in &request.pack {
            let body = base64::decode(&object.body)
                .ok_or_else(|| "an object's `body` is not valid base64".to_owned())?;
            pack.push((kind(&object.kind)?, body));
        }
        Ok((
            negotiation,
            parse_ids(&request.shallow)?,
            parse_ids(&request.unshallow)?,
            parse_ids(&request.common)?,
            pack,
        ))
    };
    let (negotiation, shallow, unshallow, common, pack) = match read() {
        Ok(read) => read,
        Err(message) => return bad_request(message),
    };
    answer(serve::upload_response(&UploadAnswer {
        deepens: request.deepens,
        shallow: &shallow,
        unshallow: &unshallow,
        negotiation,
        common: &common,
        pack: &pack,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusRequest {
    unpack: UnpackInput,
    refs: Vec<RefStatusInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UnpackInput {
    ok: bool,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RefStatusInput {
    name: String,
    ok: bool,
    #[serde(default)]
    reason: Option<String>,
}

/// The body of a `git-receive-pack` answer: the output of
/// `shelfkit_git_status`.
pub fn status(input: &[u8]) -> (Status, Vec<u8>) {
    let request: StatusRequest = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => return bad_request(format!("not a status request: {error}")),
    };
    let refused = |reason: Option<String>| reason.unwrap_or_else(|| "refused".to_owned());
    let unpack = if request.unpack.ok {
        Ok(())
    } else {
        Err(refused(request.unpack.message))
    };
    let refs: Vec<RefStatus> = request
        .refs
        .into_iter()
        .map(|reference| RefStatus {
            name: reference.name,
            result: if reference.ok {
                Ok(())
            } else {
                Err(refused(reference.reason))
            },
        })
        .collect();
    answer(serve::status_report(&unpack, &refs))
}

fn failure(errors: &[shelfkit_git::Error]) -> (Status, Vec<u8>) {
    let errors = errors
        .iter()
        .map(|error| Problem {
            path: error.path().to_owned(),
            message: error.reason().to_owned(),
        })
        .collect();
    (
        Status::Failed,
        serde_json::to_vec(&Failure { errors }).unwrap_or_default(),
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn author() -> Value {
        json!({ "name": "ShelfKit", "email": "s@example.com", "time": 1_700_000_000, "offset": 60 })
    }

    fn call(run: fn(&[u8]) -> (Status, Vec<u8>), request: &Value) -> (Status, Value) {
        let (status, output) = run(&serde_json::to_vec(request).unwrap());
        (status, serde_json::from_slice(&output).unwrap())
    }

    #[test]
    fn a_published_version_is_a_tagged_commit_on_main() {
        let mut files = std::collections::BTreeMap::new();
        files.insert(
            "apm.yml".to_owned(),
            b"name: review\nversion: 1.0.0\n".to_vec(),
        );
        let archive = shelfkit_registry::archive::pack(&files).unwrap();
        let request = json!({
            "package": "acme/review",
            "version": "1.0.0",
            "archive": base64::encode(&archive),
            "publishedAt": 1_760_000_000,
        });
        let (status, plan) = call(version, &request);
        assert_eq!(status, Status::Planned, "{plan}");
        let (_, received) = call(receive, &json!({ "body": plan["request"] }));
        let names: Vec<&str> = received["updates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|update| update["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["refs/heads/main", "refs/tags/v1.0.0"]);
        let commit = received["objects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|object| object["kind"] == "commit")
            .unwrap();
        assert_eq!(commit["author"]["name"], "ShelfKit");
        assert_eq!(commit["committedAt"], 1_760_000_000);

        let (status, refused) = call(
            version,
            &json!({ "package": "acme/review", "version": "1.0.0", "archive": "AAAA", "publishedAt": 0 }),
        );
        assert_eq!(status, Status::Failed);
        assert_eq!(refused["errors"][0]["path"], "<archive>");
    }

    #[test]
    fn a_commit_round_trips_through_receive() {
        let (status, plan) = call(
            commit,
            &json!({
                "base": [],
                "files": [
                    { "path": "shelf.json", "contents": "{}\n" },
                    { "path": "bin/run", "mode": "100755", "contents": "IyEvYmluL3NoCg==", "encoding": "base64" }
                ],
                "author": author(),
                "message": "Create"
            }),
        );
        assert_eq!(status, Status::Planned, "{plan}");
        assert_eq!(plan["unchanged"], false);
        assert_eq!(plan["objects"], 5);
        assert_eq!(plan["files"][1]["mode"], "100755");

        let (status, received) = call(receive, &json!({ "body": plan["request"] }));
        assert_eq!(status, Status::Planned, "{received}");
        assert_eq!(received["updates"][0]["old"], "0".repeat(40));
        assert_eq!(received["updates"][0]["new"], plan["commit"]);
        assert_eq!(received["updates"][0]["name"], "refs/heads/main");
        let objects = received["objects"].as_array().unwrap();
        assert_eq!(objects.len(), 5);
        assert_eq!(objects[0]["kind"], "commit");
        assert_eq!(objects[0]["tree"], plan["tree"]);
        assert_eq!(objects[0]["parents"], json!([]));
        assert_eq!(objects[0]["authoredAt"], 1_700_000_000);
        assert_eq!(objects[0]["message"], "Create\n");
        let blob = objects
            .iter()
            .find(|object| object["id"] == plan["files"][1]["id"])
            .unwrap();
        assert_eq!(
            base64::decode(blob["contents"].as_str().unwrap()).unwrap(),
            b"#!/bin/sh\n"
        );

        // The same files on top of that commit are unchanged.
        let (status, again) = call(
            commit,
            &json!({
                "parent": plan["commit"],
                "base": plan["files"],
                "files": [
                    { "path": "shelf.json", "id": plan["files"][0]["id"] },
                    { "path": "bin/run", "mode": "100755", "contents": "#!/bin/sh\n" }
                ],
                "author": author(),
                "message": "Nothing"
            }),
        );
        assert_eq!(status, Status::Planned, "{again}");
        assert_eq!(again["unchanged"], true);
        assert_eq!(again["commit"], Value::Null);
        assert_eq!(again["request"], Value::Null);
    }

    #[test]
    fn bad_paths_and_modes_are_errors_on_their_files() {
        let (status, output) = call(
            commit,
            &json!({
                "base": [],
                "files": [
                    { "path": "../x", "contents": "" },
                    { "path": "y", "mode": "40000", "contents": "" }
                ],
                "author": author(),
                "message": "Bad"
            }),
        );
        assert_eq!(status, Status::Failed);
        assert_eq!(output["errors"][0]["path"], "y");
        let (status, output) = call(
            commit,
            &json!({ "base": [], "files": [{ "path": "../x", "contents": "" }], "author": author(), "message": "Bad" }),
        );
        assert_eq!(status, Status::Failed);
        assert_eq!(output["errors"][0]["path"], "../x");
    }

    #[test]
    fn a_gitlink_is_kept_by_id_and_refused_with_contents() {
        let submodule = "1".repeat(40);
        let (status, plan) = call(
            commit,
            &json!({
                "base": [],
                "files": [{ "path": "vendor/sub", "mode": "160000", "id": submodule }],
                "author": author(),
                "message": "Submodule"
            }),
        );
        assert_eq!(status, Status::Planned, "{plan}");
        assert_eq!(
            plan["files"],
            json!([{ "path": "vendor/sub", "mode": "160000", "id": submodule }])
        );
        let (_, received) = call(receive, &json!({ "body": plan["request"] }));
        let vendor = received["objects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|object| object["entries"][0]["name"] == "sub")
            .unwrap();
        assert_eq!(vendor["entries"][0]["mode"], "160000");

        let (status, output) = call(
            commit,
            &json!({
                "base": [],
                "files": [{ "path": "vendor/sub", "mode": "160000", "contents": "x" }],
                "author": author(),
                "message": "Submodule"
            }),
        );
        assert_eq!(status, Status::Failed);
        assert_eq!(output["errors"][0]["path"], "vendor/sub");
    }

    #[test]
    fn malformed_requests_are_bad_requests() {
        for request in [
            json!({ "base": [], "files": [{ "path": "x" }], "author": author(), "message": "" }),
            json!({ "base": [], "files": [{ "path": "x", "id": "nope" }], "author": author(), "message": "" }),
            json!({ "parent": "nope", "base": [], "files": [], "author": author(), "message": "" }),
            json!({ "base": [], "files": [], "message": "" }),
        ] {
            assert_eq!(call(commit, &request).0, Status::BadRequest, "{request}");
        }
        assert_eq!(call(report, &json!({ "body": "!" })).0, Status::BadRequest);
    }

    #[test]
    fn reads_reports() {
        let body =
            b"000eunpack ok\n0017ok refs/heads/main\n0025ng refs/heads/x non-fast-forward\n0000";
        let (status, output) = call(report, &json!({ "body": base64::encode(body) }));
        assert_eq!(status, Status::Planned);
        assert_eq!(
            output,
            json!({
                "unpack": { "ok": true },
                "refs": [
                    { "name": "refs/heads/main", "ok": true },
                    { "name": "refs/heads/x", "ok": false, "reason": "non-fast-forward" }
                ]
            })
        );
        let (status, output) = call(report, &json!({ "body": base64::encode(b"nonsense") }));
        assert_eq!(status, Status::Failed);
        assert!(output["errors"][0]["message"].is_string());
    }
}
