//! The shelf engine as a WebAssembly module: load, resolve, and compile one
//! profile, the same code `shelfkit compile --dry-run` runs.
//!
//! Built for `wasm32-unknown-unknown` with no bindings generator: the module
//! imports nothing and exports a handful of plain functions, so the Worker
//! and the browser instantiate it with an empty import object, and
//! `@shelfkit/engine` is the one typed port over it.
//!
//! # The ABI
//!
//! JSON in, JSON out, through two buffers the module owns:
//!
//! 1. `shelfkit_input(len) -> ptr` sizes the input buffer to `len` bytes and
//!    returns where it starts. The host writes the request there.
//! 2. `shelfkit_plan() -> status` reads the request and leaves its answer in
//!    the output buffer.
//! 3. `shelfkit_output_ptr()` and `shelfkit_output_len()` locate the answer.
//!
//! A pointer is good until the next call into the module. The request is
//! `{ "files": [{ "path", "contents", "encoding"? }], "profile"?,
//! "overrideProfile"? }`, with `encoding` `utf-8` (the default) or `base64`.
//! The status is [`Status`]: on success the output is the plan exactly as
//! `compile --dry-run --json` prints it; otherwise it is `{ "errors": [{
//! "path", "message" }] }`.
//!
//! `shelfkit_abi_version()` changes whenever any of this does.

use serde::{Deserialize, Serialize};
use shelfkit_compiler::engine::{Request, plan};
use shelfkit_core::{Errors, MemorySource};
use std::cell::RefCell;

/// What `shelfkit_plan` returns.
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// The output is the plan.
    Planned = 0,
    /// The shelf or the profile does not compile; the output lists why.
    Failed = 1,
    /// The request itself is malformed; the output says how.
    BadRequest = 2,
}

/// The ABI's version, for a host to check before it calls anything else.
pub const ABI_VERSION: u32 = 1;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_abi_version() -> u32 {
    ABI_VERSION
}

/// Size the input buffer to `len` bytes, zeroed, and return its address.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_input(len: u32) -> *mut u8 {
    INPUT.with_borrow_mut(|input| {
        input.clear();
        input.resize(len as usize, 0);
        input.as_mut_ptr()
    })
}

/// Plan the request in the input buffer; see the crate documentation.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_plan() -> u32 {
    let (status, output) = INPUT.with_borrow(|input| respond(input));
    OUTPUT.with_borrow_mut(|buffer| *buffer = output);
    status as u32
}

#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_output_ptr() -> *const u8 {
    OUTPUT.with_borrow(|output| output.as_ptr())
}

#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_output_len() -> u32 {
    OUTPUT.with_borrow(|output| u32::try_from(output.len()).unwrap_or(u32::MAX))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanInput {
    files: Vec<FileInput>,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    override_profile: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileInput {
    path: String,
    contents: String,
    #[serde(default)]
    encoding: Encoding,
}

#[derive(Deserialize, Default, PartialEq, Eq)]
enum Encoding {
    #[default]
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "base64")]
    Base64,
}

#[derive(Serialize)]
struct Failure {
    errors: Vec<Problem>,
}

#[derive(Serialize)]
struct Problem {
    path: String,
    message: String,
}

/// Answer one request: the status and the bytes of the output. Plain Rust,
/// so the native tests drive exactly what the exports run.
pub fn respond(input: &[u8]) -> (Status, Vec<u8>) {
    let request: PlanInput = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => return bad_request(format!("not a plan request: {error}")),
    };
    let mut source = MemorySource::new();
    for file in request.files {
        let bytes = match file.encoding {
            Encoding::Utf8 => file.contents.into_bytes(),
            Encoding::Base64 => match shelfkit_compiler::base64::decode(&file.contents) {
                Some(bytes) => bytes,
                None => {
                    return bad_request(format!("{}: contents are not valid base64", file.path));
                }
            },
        };
        source.insert(file.path, bytes);
    }
    let plan_request = Request {
        profile: request.profile,
        override_profile: request.override_profile,
        ..Request::default()
    };
    match plan(&source, &plan_request) {
        Ok(compiled) => (Status::Planned, compiled.to_json().into_bytes()),
        Err(errors) => (Status::Failed, failure(errors)),
    }
}

fn failure(errors: Errors) -> Vec<u8> {
    let errors = errors
        .into_iter()
        .map(|error| Problem {
            path: error.path,
            message: error.kind.to_string(),
        })
        .collect();
    serde_json::to_vec(&Failure { errors }).unwrap_or_default()
}

fn bad_request(message: String) -> (Status, Vec<u8>) {
    let body = Failure {
        errors: vec![Problem {
            path: "<request>".to_owned(),
            message,
        }],
    };
    (
        Status::BadRequest,
        serde_json::to_vec(&body).unwrap_or_default(),
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn request(files: &[(&str, &str)], profile: Option<&str>) -> Vec<u8> {
        let files: Vec<serde_json::Value> = files
            .iter()
            .map(|(path, contents)| serde_json::json!({ "path": path, "contents": contents }))
            .collect();
        serde_json::to_vec(&serde_json::json!({ "files": files, "profile": profile })).unwrap()
    }

    #[test]
    fn plans_through_the_buffers() {
        let body = request(
            &[
                ("shelf.json", r#"{ "name": "t" }"#),
                (
                    "profiles/p.json",
                    r#"{ "id": "p", "title": "P", "items": [] }"#,
                ),
            ],
            Some("p"),
        );
        let len = u32::try_from(body.len()).unwrap();
        let ptr = shelfkit_input(len);
        assert!(!ptr.is_null());
        INPUT.with_borrow_mut(|input| input.copy_from_slice(&body));
        assert_eq!(shelfkit_plan(), Status::Planned as u32);
        let output = OUTPUT.with_borrow(Clone::clone);
        assert_eq!(shelfkit_output_len() as usize, output.len());
        let plan: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(plan["apmYml"], "name: p\nversion: \"0.0.0\"\n");
    }

    #[test]
    fn a_shelf_that_does_not_load_is_a_failure_with_paths() {
        let (status, output) = respond(&request(&[("profiles/p.json", "{")], Some("p")));
        assert_eq!(status, Status::Failed);
        let body: serde_json::Value = serde_json::from_slice(&output).unwrap();
        let paths: Vec<&str> = body["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&"shelf.json"), "{paths:?}");
        assert!(paths.contains(&"profiles/p.json"), "{paths:?}");
    }

    #[test]
    fn a_malformed_request_is_a_bad_request() {
        assert_eq!(respond(b"[]").0, Status::BadRequest);
        let bad = br#"{ "files": [{ "path": "a", "contents": "!", "encoding": "base64" }] }"#;
        assert_eq!(respond(bad).0, Status::BadRequest);
        assert_eq!(
            respond(br#"{ "files": [], "extra": 1 }"#).0,
            Status::BadRequest
        );
    }
}
