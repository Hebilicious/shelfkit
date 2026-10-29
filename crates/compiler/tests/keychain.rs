//! The OS keychain itself, where `shelfkit login` keeps a deployment's key: the macOS Keychain, the Windows Credential
//! Manager, or the Secret Service. It writes to the machine's keychain, so it runs only when asked (`--ignored`); the
//! release workflow runs it on the macOS and Windows runners it builds on.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use shelfkit_compiler::cli::{HostSystem, System};

#[test]
#[ignore = "writes to the OS keychain; run with --ignored"]
fn a_key_is_kept_read_back_and_removed() {
    let system = HostSystem;
    let account = format!("https://keychain-test-{}.invalid", std::process::id());
    let key = "sko_keychaintestkeychaintestkeychaintestkeychain";
    system.keychain_set(&account, key).unwrap();
    assert_eq!(system.keychain_get(&account).unwrap().as_deref(), Some(key));
    assert!(system.keychain_delete(&account).unwrap());
    assert_eq!(system.keychain_get(&account).unwrap(), None);
    assert!(!system.keychain_delete(&account).unwrap());
}
