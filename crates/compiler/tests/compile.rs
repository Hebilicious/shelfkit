//! How each kind compiles, and the problems a compile refuses, on small
//! shelves held in memory.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use shelfkit_compiler::engine::{Request, plan};
use shelfkit_compiler::yaml::Node;
use shelfkit_compiler::{CompiledManifest, NoteCode};
use shelfkit_core::{Errors, MemorySource};

const SHELF: &str = r#"{ "name": "t", "defaultProfile": "p" }"#;

fn shelf(files: &[(&str, &str)]) -> MemorySource {
    let mut source: MemorySource = [("shelf.json", SHELF)].into_iter().collect();
    for (path, text) in files {
        source.insert(*path, *text);
    }
    source
}

fn compile(source: &MemorySource) -> Result<CompiledManifest, Errors> {
    plan(source, &Request::default())
}

fn profile(items: &[&str], compile: &str) -> String {
    let items: Vec<String> = items.iter().map(|i| format!("\"{i}\"")).collect();
    format!(
        r#"{{ "id": "p", "title": "P", "items": [{}], "compile": {{ {compile} }} }}"#,
        items.join(", ")
    )
}

fn apm_entries(plan: &CompiledManifest) -> Vec<Node> {
    let manifest = Node::parse(&plan.apm_yml).unwrap();
    match manifest.get("dependencies").and_then(|d| d.get("apm")) {
        Some(Node::Seq(items)) => items.clone(),
        _ => Vec::new(),
    }
}

const HOOK_JSON: &str =
    r#"{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "make lint" }] }] } }"#;

#[test]
fn a_hook_is_vendored_and_never_a_direct_dependency_even_when_imported() {
    let source = shelf(&[
        (
            "items/hooks/lint/item.json",
            r#"{ "id": "lint", "kind": "hook", "title": "Lint",
                 "source": { "repo": "https://github.com/o/r", "path": "hooks/lint.json", "ref": "v1" } }"#,
        ),
        ("items/hooks/lint/hook.json", HOOK_JSON),
        ("profiles/p.json", &profile(&["lint"], "")),
    ]);
    let plan = compile(&source).unwrap();
    assert!(
        plan.files
            .iter()
            .any(|f| f.path == "vendor/p/.apm/hooks/lint.json")
    );
    assert_eq!(apm_entries(&plan), vec![Node::string("./vendor/p")]);
    assert!(!plan.apm_yml.contains("lint.json"), "{}", plan.apm_yml);
    assert!(!plan.apm_yml.contains("o/r"), "{}", plan.apm_yml);
    let approval: Vec<_> = plan
        .notes
        .iter()
        .filter(|n| n.code == NoteCode::HookApproval)
        .collect();
    assert_eq!(approval.len(), 1);
    assert_eq!(approval[0].path, "items/hooks/lint/item.json");
}

#[test]
fn an_imported_hook_without_its_json_cannot_compile() {
    let source = shelf(&[
        (
            "items/hooks/lint/item.json",
            r#"{ "id": "lint", "kind": "hook", "title": "Lint",
                 "source": { "repo": "https://github.com/o/r", "path": "hooks/lint.json", "ref": "v1" } }"#,
        ),
        ("profiles/p.json", &profile(&["lint"], "")),
    ]);
    let errors = compile(&source).unwrap_err().to_string();
    assert!(
        errors.starts_with("items/hooks/lint/item.json:"),
        "{errors}"
    );
    assert!(errors.contains("cannot pin a `.json`"), "{errors}");
}

#[test]
fn a_hook_with_files_it_cannot_reference_is_refused() {
    let source = shelf(&[
        (
            "items/hooks/lint/item.json",
            r#"{ "id": "lint", "kind": "hook", "title": "Lint" }"#,
        ),
        ("items/hooks/lint/hook.json", HOOK_JSON),
        ("items/hooks/lint/run.sh", "make lint\n"),
        ("profiles/p.json", &profile(&["lint"], "")),
    ]);
    let errors = compile(&source).unwrap_err().to_string();
    assert!(errors.contains("run.sh"), "{errors}");
}

#[test]
fn vendor_authored_false_leaves_authored_items_nowhere_and_says_so() {
    let source = shelf(&[
        (
            "items/agents/a/item.json",
            r#"{ "id": "a", "kind": "agent", "title": "A" }"#,
        ),
        ("items/agents/a/agent.md", "Agent.\n"),
        (
            "profiles/p.json",
            &profile(&["a"], r#""vendorAuthored": false"#),
        ),
    ]);
    let errors = compile(&source).unwrap_err().to_string();
    assert!(errors.starts_with("profiles/p.json:"), "{errors}");
    assert!(errors.contains("`a`"), "{errors}");
}

#[test]
fn an_item_with_neither_upstream_nor_content_is_refused_at_its_file() {
    let source = shelf(&[
        (
            "items/skills/s/item.json",
            r#"{ "id": "s", "kind": "skill", "title": "S", "source": { "url": "https://catalog.example/s" } }"#,
        ),
        ("profiles/p.json", &profile(&["s"], "")),
    ]);
    let errors = compile(&source).unwrap_err().to_string();
    assert!(errors.starts_with("items/skills/s/item.json:"), "{errors}");
    assert!(errors.contains("no upstream"), "{errors}");
}

#[test]
fn registries_are_what_apm_accepts_one_per_manifest_with_only_a_url() {
    let registry = |id: &str, url: &str| {
        format!(r#"{{ "id": "{id}", "kind": "apm-registry", "url": "{url}" }}"#)
    };
    let item = |id: &str, source: &str| {
        (
            format!("items/instructions/{id}/item.json"),
            format!(
                r#"{{ "id": "{id}", "kind": "instructions", "title": "{id}",
                     "source": {{ "id": "{source}", "path": "o/{id}", "version": "1.0.0" }} }}"#
            ),
        )
    };
    let build = |sources: &[String], items: &[(String, String)], selected: &[&str]| {
        let mut source: MemorySource = [(
            "shelf.json".to_owned(),
            format!(
                r#"{{ "name": "t", "defaultProfile": "p", "sources": [{}] }}"#,
                sources.join(", ")
            ),
        )]
        .into_iter()
        .collect();
        for (path, text) in items {
            source.insert(path.clone(), text.clone());
        }
        source.insert("profiles/p.json", profile(selected, ""));
        source
    };

    // APM 0.33.0 allows plain http only for loopback: RFC 1918 and public hosts are refused.
    for url in [
        "http://192.168.1.20:8787/apm",
        "http://10.0.0.5/apm",
        "http://shelf.example/apm",
    ] {
        let shelf = build(&[registry("a", url)], &[item("x", "a")], &["x"]);
        let errors = compile(&shelf).unwrap_err().to_string();
        assert!(
            errors.contains("loopback") && errors.contains("https"),
            "{url}: {errors}"
        );
    }

    let loopback = build(
        &[registry("a", "http://127.0.0.1:8787/apm")],
        &[item("x", "a")],
        &["x"],
    );
    let plan = compile(&loopback).unwrap();
    assert!(
        plan.apm_yml
            .contains("registries:\n  a:\n    url: \"http://127.0.0.1:8787/apm\"\n  default: a\n"),
        "{}",
        plan.apm_yml
    );
    assert!(!plan.apm_yml.contains("insecure"), "{}", plan.apm_yml);
    assert_eq!(
        plan.install_command,
        "apm experimental enable registries && apm install"
    );

    let two = build(
        &[
            registry("a", "https://a.example/apm"),
            registry("b", "https://b.example/apm"),
        ],
        &[item("x", "a"), item("y", "b")],
        &["x", "y"],
    );
    let errors = compile(&two).unwrap_err().to_string();
    assert!(errors.contains("`a` and `b`"), "{errors}");
}

#[test]
fn a_git_reference_is_the_explicit_object_form_so_no_default_registry_can_capture_it() {
    let source = shelf(&[
        (
            "items/prompts/review/item.json",
            r#"{ "id": "review", "kind": "prompt", "title": "Review",
                 "source": { "repo": "https://github.com/acme/agent-kit", "path": "prompts/review.prompt.md", "ref": "v3" } }"#,
        ),
        (
            "profiles/p.json",
            &profile(&["review"], r#""pin": "latest""#),
        ),
    ]);
    let plan = compile(&source).unwrap();
    // `acme/agent-kit/prompts/review.prompt.md#v3` would be routed through a default registry set
    // in the repository's apm.yml or in ~/.apm/config.json.
    assert_eq!(
        apm_entries(&plan),
        vec![Node::Map(vec![
            (
                "git".into(),
                Node::string("acme/agent-kit/prompts/review.prompt.md")
            ),
            ("ref".into(), Node::string("v3")),
        ])]
    );
    assert!(!plan.apm_yml.contains('#'), "{}", plan.apm_yml);
}

#[test]
fn an_mcp_entry_apm_would_refuse_fails_the_compile() {
    let source = shelf(&[
        (
            "items/mcp/bad/item.json",
            r#"{ "id": "bad", "kind": "mcp", "title": "Bad", "flavour": "remote", "name": "!bad", "url": "https://x.example/mcp" }"#,
        ),
        ("profiles/p.json", &profile(&["bad"], "")),
    ]);
    // The loader accepts the name; APM's name rule (`^[a-zA-Z0-9@_]...`) does not, and the published schema's
    // MCP error is not waived for an entry that breaks APM's own rules.
    let errors = compile(&source).unwrap_err().to_string();
    assert!(
        errors.contains("/dependencies/mcp/0/name: APM's MCP entry rules"),
        "{errors}"
    );
    assert!(errors.contains("oneOf"), "{errors}");
}

#[test]
fn mcp_servers_compile_to_apm_entries_and_hosted_ones_to_a_note() {
    let source = shelf(&[
        (
            "items/mcp/gh/item.json",
            r#"{ "id": "gh", "kind": "mcp", "title": "GH", "flavour": "remote", "name": "io.github.github/github-mcp-server" }"#,
        ),
        (
            "items/mcp/local/item.json",
            r#"{ "id": "local", "kind": "mcp", "title": "Local", "flavour": "stdio", "command": "/opt/My Server/bin" }"#,
        ),
        (
            "items/mcp/relay/item.json",
            r#"{ "id": "relay", "kind": "mcp", "title": "Relay", "flavour": "hosted", "url": "https://mcp.example/mcp" }"#,
        ),
        ("profiles/p.json", &profile(&["gh", "local", "relay"], "")),
    ]);
    let plan = compile(&source).unwrap();
    let manifest = Node::parse(&plan.apm_yml).unwrap();
    let Some(Node::Seq(mcp)) = manifest.get("dependencies").and_then(|d| d.get("mcp")) else {
        panic!("{}", plan.apm_yml);
    };
    assert_eq!(mcp[0], Node::string("io.github.github/github-mcp-server"));
    // A command with a space is accepted by APM only beside `args`.
    assert_eq!(mcp[1].get("args"), Some(&Node::Seq(vec![])));
    assert_eq!(mcp[1].get("name"), Some(&Node::string("local")));
    assert_eq!(mcp.len(), 2, "the hosted server compiles to no entry");
    let codes: Vec<NoteCode> = plan.notes.iter().map(|n| n.code).collect();
    assert_eq!(
        codes,
        vec![NoteCode::McpSchemaMismatch, NoteCode::HostedMcp]
    );
}

#[test]
fn an_override_profile_compiles_without_being_saved_and_is_validated_like_one() {
    let source = shelf(&[
        (
            "items/agents/a/item.json",
            r#"{ "id": "a", "kind": "agent", "title": "A" }"#,
        ),
        ("items/agents/a/agent.md", "Agent.\n"),
        ("profiles/p.json", &profile(&[], "")),
    ]);
    let draft: serde_json::Value =
        serde_json::from_str(&profile(&["a"], r#""targets": ["claude"]"#)).unwrap();
    let request = Request {
        override_profile: Some(draft),
        ..Request::default()
    };
    let plan = plan(&source, &request).unwrap();
    assert!(
        plan.apm_yml.contains("targets:\n  - claude\n"),
        "{}",
        plan.apm_yml
    );
    assert!(
        plan.files
            .iter()
            .any(|f| f.path == "vendor/p/.apm/agents/a.agent.md")
    );

    let broken: serde_json::Value =
        serde_json::from_str(&profile(&["ghost"], r#""unknownKey": 1"#)).unwrap();
    let request = Request {
        override_profile: Some(broken),
        ..Request::default()
    };
    let errors = shelfkit_compiler::engine::plan(&source, &request)
        .unwrap_err()
        .to_string();
    assert!(errors.contains("profiles/p.json"), "{errors}");
    assert!(
        errors.contains("ghost") || errors.contains("unknownKey"),
        "{errors}"
    );
}

#[test]
fn targets_on_the_command_line_need_the_same_opt_in_as_in_a_profile() {
    let source = shelf(&[("profiles/p.json", &profile(&[], ""))]);
    let kiro = Request {
        targets: Some(vec!["claude".into(), "kiro".into()]),
        ..Request::default()
    };
    let errors = plan(&source, &kiro).unwrap_err().to_string();
    assert!(errors.contains("`kiro`"), "{errors}");

    let opted = Request {
        allow_nonconformant_targets: true,
        ..kiro
    };
    let compiled = plan(&source, &opted).unwrap();
    assert!(compiled.apm_yml.contains("  - kiro\n"));
    assert_eq!(
        compiled.notes[0].code,
        NoteCode::ProducerNonconformantTarget
    );
}

#[test]
fn the_same_shelf_compiles_to_the_same_bytes_whatever_the_line_endings() {
    let files = [
        (
            "items/prompts/x/item.json",
            "{\n  \"id\": \"x\",\n  \"kind\": \"prompt\",\n  \"title\": \"X\"\n}\n",
        ),
        ("items/prompts/x/prompt.md", "One.\nTwo.\n"),
    ];
    let mut unix = shelf(&files);
    let mut windows = shelf(&[]);
    for (path, text) in files {
        windows.insert(path, text.replace('\n', "\r\n"));
    }
    for source in [&mut unix, &mut windows] {
        source.insert("profiles/p.json", profile(&["x"], ""));
    }
    let compiled = compile(&unix).unwrap();
    assert_eq!(compiled.to_json(), compile(&windows).unwrap().to_json());
    let prompt = &compiled.files[0];
    assert_eq!(prompt.contents, "---\ndescription: X\n---\n\nOne.\nTwo.\n");
}
