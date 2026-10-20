//! The OS keychain, where `shelfkit login` keeps a key: the Secret Service on
//! Linux and the BSDs, the Keychain on macOS, and the Credential Manager on
//! Windows. Entries are the service [`super::system::KEYCHAIN_SERVICE`] and
//! the hosted service's URL as the account. Only [`super::HostSystem`] calls
//! this.

use super::system::KEYCHAIN_SERVICE;
use keyring_core::{CredentialStore, Entry, Error};
use std::io;
use std::sync::Arc;

#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "ios", target_os = "android"))
))]
fn store() -> keyring_core::Result<Arc<CredentialStore>> {
    Ok(dbus_secret_service_keyring_store::Store::new()?)
}

#[cfg(target_os = "macos")]
fn store() -> keyring_core::Result<Arc<CredentialStore>> {
    Ok(apple_native_keyring_store::keychain::Store::new()?)
}

#[cfg(windows)]
fn store() -> keyring_core::Result<Arc<CredentialStore>> {
    Ok(windows_native_keyring_store::Store::new()?)
}

#[cfg(not(any(unix, windows)))]
fn store() -> keyring_core::Result<Arc<CredentialStore>> {
    Err(Error::NoDefaultStore)
}

fn entry(account: &str) -> io::Result<Entry> {
    store()
        .and_then(|store| store.build(KEYCHAIN_SERVICE, account, None))
        .map_err(failure)
}

/// The error, which names the keychain's problem and never a secret.
fn failure(error: Error) -> io::Error {
    io::Error::other(format!("the OS keychain: {error}"))
}

pub fn get(account: &str) -> io::Result<Option<String>> {
    match entry(account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(failure(error)),
    }
}

pub fn set(account: &str, secret: &str) -> io::Result<()> {
    entry(account)?.set_password(secret).map_err(failure)
}

pub fn delete(account: &str) -> io::Result<bool> {
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(true),
        Err(Error::NoEntry) => Ok(false),
        Err(error) => Err(failure(error)),
    }
}
