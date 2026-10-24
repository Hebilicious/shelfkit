//! The Git calls: `shelfkit_git_commit`, `shelfkit_git_report`, and
//! `shelfkit_git_receive` (see the crate documentation for their JSON).

use crate::{Encoding, Failure, Problem, Status, bad_request};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use shelfkit_git::receive_pack::{self, RefStatus};
use shelfkit_git::tree;
use shelfkit_git::{
    Commit, CommitInput, FileEntry, Kind, Mode, NewFile, ObjectId, Signature, Source, pack,
    plan_commit,
};
use shelfkit_registry::base64;

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
    let plan = match plan_commit(&input) {
        Ok(plan) => plan,
        Err(errors) => return failure(&errors),
    };
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
        author: request.author.into(),
        committer: request.committer.map(Signature::from),
        message: request.message,
    })
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
            json!({ "id": id, "kind": kind, "entries": entries })
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
            })
        }
    })
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
