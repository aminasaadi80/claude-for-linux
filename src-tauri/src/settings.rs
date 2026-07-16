// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Settings {
    #[serde(default = "default_lang")]
    lang: String,
    /// Optional proxy for the `claude` CLI (e.g. "127.0.0.1:8080" or
    /// "http://127.0.0.1:8080"). Injected as HTTPS_PROXY/HTTP_PROXY/ALL_PROXY
    /// on every spawned claude process. Empty = no proxy.
    #[serde(default)]
    proxy: String,
}

fn default_lang() -> String {
    "en".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Settings { lang: default_lang(), proxy: String::new() }
    }
}

/// The configured proxy, normalized to a full URL (adds http:// if no scheme).
/// Returns None when no proxy is set.
pub(crate) fn proxy_url() -> Option<String> {
    let p = load_settings().proxy.trim().to_string();
    if p.is_empty() {
        return None;
    }
    Some(if p.contains("://") {
        p
    } else {
        format!("http://{}", p)
    })
}

pub(crate) fn config_file(name: &str) -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("claude-linux");
    let _ = std::fs::create_dir_all(&dir);
    // the config dir may hold session state — keep it private to the user
    restrict_permissions(&dir, 0o700);
    dir.push(name);
    dir
}

/// chmod a path (files 0o600, dirs 0o700) so other local users can't read
/// session/settings data. Best-effort — never fails the caller.
fn restrict_permissions(path: &std::path::Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
}

/// Write a config file and make it user-only (0600).
fn write_private(path: &PathBuf, data: &str) -> Result<(), String> {
    std::fs::write(path, data).map_err(|e| e.to_string())?;
    restrict_permissions(path, 0o600);
    Ok(())
}

#[tauri::command]
pub(crate) fn load_settings() -> Settings {
    std::fs::read_to_string(config_file("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) fn save_settings(settings: Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    write_private(&config_file("settings.json"), &json)
}

#[tauri::command]
pub(crate) fn load_session() -> String {
    std::fs::read_to_string(config_file("session.json")).unwrap_or_default()
}

#[tauri::command]
pub(crate) fn save_session(data: String) -> Result<(), String> {
    write_private(&config_file("session.json"), &data)
}
