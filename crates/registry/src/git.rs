//! A published version as a Git commit, for a host that serves a package's
//! versions over Git as well as over the registry API (the Worker, at
//! `/git/{owner}/{repo}.git`).
//!
//! Each version is a commit of its archive's files at the repository's root,
//! on `main`, tagged `v{version}`. APM installs `{ git: <url>, ref: ^1.0.0 }`
//! by resolving the range against those tags, as its registry client resolves
//! `{ id, version: ^1.0.0 }` against the versions, and needs no experimental
//! flag to do it. Both routes install the same files: the archive's.
//!
//! A version's parent is the version published before it, so `main` is the
//! latest publish and `git log` lists the versions. The commit is a function
//! of the archive, the version, the time it was published, and the parent,
//! so committing the same version on the same parent twice makes the same
//! commit, and a retry or a race between two hosts is harmless.
//!
//! The registry refuses an archive whose `apm.yml` declares another version
//! than the one it is published as, so no two versions have the same files
//! and every version makes a commit.

use crate::{PackageId, archive, digest};
use shelfkit_git::{
    CommitInput, CommitPlan, FileEntry, Mode, NewFile, ObjectId, Signature, Source, plan_commit,
};

/// The name and address a version's commit gives as its author and committer.
pub const AUTHOR: (&str, &str) = ("ShelfKit", "registry@shelfkit.invalid");

/// The tag a version's commit carries: `refs/tags/v{version}`.
pub fn tag(version: &str) -> String {
    format!("refs/tags/v{version}")
}

/// A published version to commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version<'a> {
    pub package: &'a PackageId,
    pub version: &'a str,
    /// The archive as the registry stored it.
    pub archive: &'a [u8],
    /// When it was published, in Unix seconds: the commit's time.
    pub published_at: i64,
    /// The commit `main` is at, and every file of it; `None` for the first
    /// version.
    pub parent: Option<(ObjectId, &'a [FileEntry])>,
}

/// The version's commit, and the receive-pack request that moves `main` to
/// it and creates its tag.
pub fn commit(version: &Version<'_>) -> Result<CommitPlan, String> {
    let name = format!("{} {}", version.package.name(), version.version);
    let files = archive::read(version.archive)
        .map_err(|error| format!("the archive of {name} does not read: {error}"))?;
    let signature = Signature {
        name: AUTHOR.0.to_owned(),
        email: AUTHOR.1.to_owned(),
        time: version.published_at,
        offset: 0,
    };
    let input = CommitInput {
        parent: version.parent.map(|(commit, _)| commit),
        base: version
            .parent
            .map(|(_, files)| files.to_vec())
            .unwrap_or_default(),
        files: files
            .into_iter()
            .map(|(path, contents)| NewFile {
                path,
                mode: Mode::File,
                source: Source::Contents(contents),
            })
            .collect(),
        reference: "refs/heads/main".to_owned(),
        tags: vec![tag(version.version)],
        author: signature,
        committer: None,
        message: format!(
            "{name}\n\nPublished to the registry as {name}, archive {}.\n",
            digest(version.archive)
        ),
    };
    let plan = plan_commit(&input).map_err(|errors| {
        let reasons: Vec<String> = errors.iter().map(ToString::to_string).collect();
        format!("{name} cannot be committed: {}", reasons.join("; "))
    })?;
    if plan.unchanged() {
        return Err(format!(
            "{name} has the same files as the version before it, so it makes no commit"
        ));
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use shelfkit_git::receive_pack;
    use std::collections::BTreeMap;

    fn archive(version: &str) -> Vec<u8> {
        let mut files = BTreeMap::new();
        files.insert(
            "apm.yml".to_owned(),
            format!("name: review\nversion: {version}\n").into_bytes(),
        );
        files.insert(
            ".apm/instructions/review.instructions.md".to_owned(),
            b"Review carefully.\n".to_vec(),
        );
        archive::pack(&files).unwrap()
    }

    #[test]
    fn versions_are_commits_on_main_each_tagged() {
        let package = PackageId::parse("acme/review").unwrap();
        let first_archive = archive("1.0.0");
        let first = commit(&Version {
            package: &package,
            version: "1.0.0",
            archive: &first_archive,
            published_at: 1_760_000_000,
            parent: None,
        })
        .unwrap();
        let paths: Vec<&str> = first.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(
            paths,
            [".apm/instructions/review.instructions.md", "apm.yml"]
        );
        let first_commit = first.push.as_ref().unwrap().commit;

        let second_archive = archive("1.1.0");
        let second_version = Version {
            package: &package,
            version: "1.1.0",
            archive: &second_archive,
            published_at: 1_760_000_100,
            parent: Some((first_commit, &first.files)),
        };
        let second = commit(&second_version).unwrap();
        let push = second.push.as_ref().unwrap();
        let request = receive_pack::parse_request(&push.request).unwrap();
        let updates: Vec<(&str, ObjectId, ObjectId)> = request
            .updates
            .iter()
            .map(|update| (update.name.as_str(), update.old, update.new))
            .collect();
        assert_eq!(
            updates,
            [
                ("refs/heads/main", first_commit, push.commit),
                ("refs/tags/v1.1.0", ObjectId::ZERO, push.commit),
            ]
        );
        // The same version on the same parent is the same commit.
        assert_eq!(
            commit(&second_version).unwrap().push.unwrap().commit,
            push.commit
        );
    }

    #[test]
    fn an_archive_that_does_not_read_is_an_error() {
        let package = PackageId::parse("acme/review").unwrap();
        let error = commit(&Version {
            package: &package,
            version: "1.0.0",
            archive: b"not gzip",
            published_at: 0,
            parent: None,
        })
        .unwrap_err();
        assert!(
            error.starts_with("the archive of acme/review 1.0.0"),
            "{error}"
        );
    }
}
