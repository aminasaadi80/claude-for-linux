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

fn config_file(name: &str) -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("claude-linux");
    let _ = std::fs::create_dir_all(&dir);
    dir.push(name);
    dir
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
    std::fs::write(config_file("settings.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn load_session() -> String {
    std::fs::read_to_string(config_file("session.json")).unwrap_or_default()
}

#[tauri::command]
pub(crate) fn save_session(data: String) -> Result<(), String> {
    std::fs::write(config_file("session.json"), data).map_err(|e| e.to_string())
}
