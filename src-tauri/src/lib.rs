// Claude for Linux — Tauri backend
//
// Two engines:
//   * chat_send  — talks to the Anthropic Messages API over raw HTTPS (SSE streaming)
//   * code_send  — drives the local `claude` CLI as a coding agent (line streaming)
//
// Streaming is delivered to the UI via Tauri events rather than return values so the
// frontend can render tokens as they arrive.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

// ----------------------------------------------------------------------------
// Settings (persisted as JSON in the user's config dir)
// ----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    api_key: String,
    #[serde(default = "default_model")]
    model: String,
    #[serde(default)]
    proxy: String,
}

/// Accept "127.0.0.1:8080" or "http://..." and return a proxy URL with a scheme.
fn normalize_proxy(p: &str) -> Option<String> {
    let p = p.trim();
    if p.is_empty() {
        return None;
    }
    if p.contains("://") {
        Some(p.to_string())
    } else {
        Some(format!("http://{}", p))
    }
}

fn default_model() -> String {
    "claude-opus-4-8".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            api_key: String::new(),
            model: default_model(),
            proxy: String::new(),
        }
    }
}

fn settings_path() -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("claude-linux");
    let _ = std::fs::create_dir_all(&dir);
    dir.push("settings.json");
    dir
}

#[tauri::command]
fn load_settings() -> Settings {
    let path = settings_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    let path = settings_path();
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

// ----------------------------------------------------------------------------
// Chat (Anthropic Messages API, streaming via SSE)
// ----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Serialize, Clone)]
struct StreamPayload {
    id: String,
    text: String,
}

#[derive(Serialize, Clone)]
struct DonePayload {
    id: String,
}

#[derive(Serialize, Clone)]
struct ErrorPayload {
    id: String,
    message: String,
}

#[tauri::command]
async fn chat_send(
    app: AppHandle,
    request_id: String,
    api_key: String,
    model: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    proxy: Option<String>,
) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("کلید API تنظیم نشده است. از تنظیمات (⚙) کلید را وارد کن.".into());
    }

    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 16000,
        "stream": true,
        "messages": messages
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
    });
    if let Some(sys) = system {
        if !sys.trim().is_empty() {
            body["system"] = serde_json::json!(sys);
        }
    }

    let mut builder = reqwest::Client::builder();
    if let Some(p) = proxy.as_deref().and_then(normalize_proxy) {
        builder = builder
            .proxy(reqwest::Proxy::all(&p).map_err(|e| format!("پراکسی نامعتبر: {}", e))?);
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let resp = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = format!("خطای API ({}): {}", status, text);
        let _ = app.emit(
            "chat://error",
            ErrorPayload {
                id: request_id,
                message: msg.clone(),
            },
        );
        return Err(msg);
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit(
                    "chat://error",
                    ErrorPayload {
                        id: request_id.clone(),
                        message: e.to_string(),
                    },
                );
                return Err(e.to_string());
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // SSE events are separated by blank lines; process complete lines.
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim_end_matches('\r').to_string();
            buffer.drain(..=pos);

            let data = match line.strip_prefix("data:") {
                Some(d) => d.trim(),
                None => continue,
            };
            if data.is_empty() {
                continue;
            }

            if let Ok(evt) = serde_json::from_str::<serde_json::Value>(data) {
                match evt.get("type").and_then(|t| t.as_str()) {
                    Some("content_block_delta") => {
                        if let Some(text) = evt
                            .get("delta")
                            .and_then(|d| d.get("text"))
                            .and_then(|t| t.as_str())
                        {
                            let _ = app.emit(
                                "chat://delta",
                                StreamPayload {
                                    id: request_id.clone(),
                                    text: text.to_string(),
                                },
                            );
                        }
                    }
                    Some("message_stop") => {
                        let _ = app.emit("chat://done", DonePayload { id: request_id.clone() });
                    }
                    _ => {}
                }
            }
        }
    }

    let _ = app.emit("chat://done", DonePayload { id: request_id });
    Ok(())
}

// ----------------------------------------------------------------------------
// Code (local `claude` CLI as a coding agent, streaming stdout lines)
// ----------------------------------------------------------------------------

/// Resolve the `claude` binary: prefer ~/.local/bin/claude (the official install
/// location), fall back to whatever is on PATH.
fn claude_binary() -> String {
    if let Some(home) = dirs::home_dir() {
        let local = home.join(".local/bin/claude");
        if local.exists() {
            return local.to_string_lossy().into_owned();
        }
    }
    "claude".to_string()
}

#[tauri::command]
fn claude_check() -> Option<String> {
    let bin = claude_binary();
    Command::new(&bin)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

#[tauri::command]
fn code_send(
    app: AppHandle,
    request_id: String,
    prompt: String,
    cwd: Option<String>,
    proxy: Option<String>,
) -> Result<(), String> {
    let bin = claude_binary();
    let mut cmd = Command::new(&bin);
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            cmd.current_dir(dir);
        }
    }

    if let Some(p) = proxy.as_deref().and_then(normalize_proxy) {
        cmd.env("HTTPS_PROXY", &p).env("HTTP_PROXY", &p);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("اجرای claude ناموفق بود ({}): {}", bin, e)
    })?;

    let stdout = child.stdout.take().ok_or("stdout در دسترس نیست")?;
    let app_out = app.clone();
    let id_out = request_id.clone();

    // Stream stdout: each line of `stream-json` is a JSON event; pull assistant
    // text out of it, and fall back to the raw line if it isn't recognizable.
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let text = extract_cli_text(&line);
            if let Some(text) = text {
                if !text.is_empty() {
                    let _ = app_out.emit(
                        "code://delta",
                        StreamPayload {
                            id: id_out.clone(),
                            text,
                        },
                    );
                }
            }
        }
    });

    // Wait for the process on a separate thread so we don't block the UI, then
    // signal completion (or surface stderr on failure).
    let app_done = app.clone();
    let id_done = request_id.clone();
    std::thread::spawn(move || {
        let stderr_text = child
            .stderr
            .take()
            .map(|e| {
                let mut s = String::new();
                let mut r = BufReader::new(e);
                let _ = std::io::Read::read_to_string(&mut r, &mut s);
                s
            })
            .unwrap_or_default();

        match child.wait() {
            Ok(status) if status.success() => {
                let _ = app_done.emit("code://done", DonePayload { id: id_done });
            }
            Ok(status) => {
                let msg = if stderr_text.trim().is_empty() {
                    format!("claude با کد {} خارج شد", status)
                } else {
                    stderr_text
                };
                let _ = app_done.emit(
                    "code://error",
                    ErrorPayload {
                        id: id_done,
                        message: msg,
                    },
                );
            }
            Err(e) => {
                let _ = app_done.emit(
                    "code://error",
                    ErrorPayload {
                        id: id_done,
                        message: e.to_string(),
                    },
                );
            }
        }
    });

    Ok(())
}

/// Pull human-readable text out of one `stream-json` line from the Claude CLI.
/// Recognizes the `assistant` message events and the final `result`; ignores
/// system/tool bookkeeping events.
fn extract_cli_text(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => {
            let content = v.get("message")?.get("content")?.as_array()?;
            let mut out = String::new();
            for block in content {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        out.push_str(t);
                    }
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        // The final result is already covered by the streamed assistant text.
        Some("result") | Some("system") | Some("user") => None,
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            chat_send,
            claude_check,
            code_send
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
