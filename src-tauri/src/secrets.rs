// OS-keyring storage for connection secrets (SSH / SFTP / FTP passwords).
//
// Secrets live in the desktop keyring (Secret Service — gnome-keyring/KWallet)
// instead of plaintext localStorage / session.json. The frontend keys each
// entry by connection identity, e.g. "ssh:root@example.com:22".

const SERVICE: &str = "claude-linux";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn secret_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

/// Ok(None) = no secret stored for this key (not an error).
#[tauri::command]
pub(crate) fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub(crate) fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
