use shelfkit_core::{Item, ItemKind, Profile, Result};

/// A file the compiler wants written into the target repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendorFile {
    pub path: String,
    pub contents: String,
}

/// The result of compiling a profile.
///
/// This is the single object rendered by `shelfkit compile --dry-run`, by the
/// composer's manifest preview, and by the MCP `shelf_plan_compile` tool, so
/// three surfaces cannot drift.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledManifest {
    /// The rendered `apm.yml`.
    pub apm_yml: String,
    pub files: Vec<VendorFile>,
    /// The command the user runs next. Printed, never executed by `compile`.
    pub install_command: String,
}

/// Compile a profile into an `apm.yml`.
///
/// Items whose `apm` coordinate is an upstream reference stay references.
/// Items authored in the shelf, and every `hook` (which APM cannot pin as a
/// virtual file), compile into a vendored `.apm/` package.
pub fn compile(profile: &Profile, items: &[Item]) -> Result<CompiledManifest> {
    let mut deps: Vec<String> = Vec::new();

    for item in items {
        Item::validate_id(&item.id)?;
        match item.kind {
            ItemKind::Mcp => {}
            _ => deps.push(format!(
                "./vendor/{}",
                profile.compile.name.as_deref().unwrap_or(&profile.id)
            )),
        }
    }

    let name = profile
        .compile
        .name
        .clone()
        .unwrap_or_else(|| profile.id.clone());

    let mut yml = String::new();
    yml.push_str(&format!("name: {name}\n"));
    yml.push_str("version: 0.0.0\n");
    if !profile.compile.targets.is_empty() {
        yml.push_str(&format!(
            "targets: [{}]\n",
            profile.compile.targets.join(", ")
        ));
    }
    if !deps.is_empty() {
        deps.sort();
        deps.dedup();
        yml.push_str("dependencies:\n  apm:\n");
        for dep in &deps {
            yml.push_str(&format!("    - {dep}\n"));
        }
    }

    Ok(CompiledManifest {
        apm_yml: yml,
        files: Vec::new(),
        install_command: "apm install".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use shelfkit_core::CompileOptions;

    fn item(id: &str, kind: ItemKind) -> Item {
        Item {
            id: id.to_owned(),
            kind,
            title: id.to_owned(),
            description: String::new(),
            tags: Vec::new(),
            targets: Vec::new(),
            requires: Vec::new(),
        }
    }

    fn profile(items: Vec<&str>) -> Profile {
        Profile {
            id: "default".into(),
            title: "Default".into(),
            description: String::new(),
            items: items.into_iter().map(str::to_owned).collect(),
            bundles: Vec::new(),
            extends: Vec::new(),
            compile: CompileOptions::default(),
        }
    }

    #[test]
    fn emits_required_manifest_fields() {
        let out = compile(
            &profile(vec!["style"]),
            &[item("style", ItemKind::Instructions)],
        )
        .unwrap();
        assert!(out.apm_yml.contains("name: default"));
        assert!(out.apm_yml.contains("version: 0.0.0"));
        assert!(out.apm_yml.contains("dependencies:"));
    }

    #[test]
    fn vendored_dependency_is_deduplicated() {
        let out = compile(
            &profile(vec!["a", "b"]),
            &[item("a", ItemKind::Prompt), item("b", ItemKind::Agent)],
        )
        .unwrap();
        assert_eq!(out.apm_yml.matches("./vendor/default").count(), 1);
    }

    #[test]
    fn mcp_items_do_not_vendor() {
        let out = compile(&profile(vec!["ctx"]), &[item("ctx", ItemKind::Mcp)]).unwrap();
        assert!(!out.apm_yml.contains("./vendor/"));
    }

    #[test]
    fn install_is_printed_not_run() {
        let out = compile(&profile(vec![]), &[]).unwrap();
        assert_eq!(out.install_command, "apm install");
    }
}
