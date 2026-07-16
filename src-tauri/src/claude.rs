use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::settings::proxy_url;
use crate::util::{augmented_path, claude_binary};

// Maps an in-flight request id -> the child process group id, so a running
// `claude` invocation can be cancelled from the UI.
#[derive(Default)]
pub(crate) struct AppState {
    children: Mutex<HashMap<String, u32>>,
}

// ----------------------------------------------------------------------------
// Event payloads
// ----------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct StreamPayload {
    id: String,
    text: String,
}
#[derive(Serialize, Clone)]
struct SessionPayload {
    id: String,
    session_id: String,
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
#[derive(Serialize, Clone)]
struct UsagePayload {
    id: String,
    input: u64,
    output: u64,
}

// ----------------------------------------------------------------------------
// Claude Code
// ----------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn claude_check() -> Option<String> {
    Command::new(claude_binary())
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Build a short, human-readable label for a tool_use block.
fn tool_label(block: &serde_json::Value) -> Option<String> {
    let name = block.get("name")?.as_str()?;
    let detail = block.get("input").and_then(|i| {
        for key in ["file_path", "path", "command", "pattern", "url", "prompt"] {
            if let Some(v) = i.get(key).and_then(|v| v.as_str()) {
                return Some(v.to_string());
            }
        }
        None
    });
    Some(match detail {
        Some(d) if !d.is_empty() => {
            let d = if d.len() > 80 { format!("{}…", &d[..80]) } else { d };
            format!("{} · {}", name, d)
        }
        _ => name.to_string(),
    })
}

#[tauri::command]
pub(crate) fn code_stop(state: State<AppState>, request_id: String) {
    if let Some(pgid) = state.children.lock().unwrap().remove(&request_id) {
        // negative pid → signal the whole process group
        unsafe {
            kill_group(pgid);
        }
    }
}

// SIGTERM the process group (claude + any children it spawned).
unsafe fn kill_group(pgid: u32) {
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(format!("-{}", pgid))
        .status();
}

#[tauri::command]
pub(crate) fn code_send(
    app: AppHandle,
    state: State<AppState>,
    request_id: String,
    prompt: String,
    cwd: Option<String>,
    resume: Option<String>,
    permission: Option<String>,
) -> Result<(), String> {
    let bin = claude_binary();
    let mut cmd = Command::new(&bin);
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose");

    if let Some(id) = resume.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--resume").arg(id);
    }
    if let Some(mode) = permission.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--permission-mode").arg(mode);
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.process_group(0); // own group so we can cancel the whole tree

    cmd.env("PATH", augmented_path()); // so `claude`/`node` are found (esp. macOS GUI)
    if let Some(px) = proxy_url() {
        cmd.env("HTTPS_PROXY", &px);
        cmd.env("HTTP_PROXY", &px);
        cmd.env("ALL_PROXY", &px);
    }

    if let Some(dir) = cwd.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.current_dir(dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("اجرای claude ناموفق بود ({}): {}", bin, e))?;

    let pgid = child.id();
    state
        .children
        .lock()
        .unwrap()
        .insert(request_id.clone(), pgid);

    let stdout = child.stdout.take().ok_or("stdout در دسترس نیست")?;
    let app = app.clone();
    let id = request_id.clone();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut needs_login = false;
        let mut sent_session = false;

        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            if line.contains("authentication_failed") || line.contains("Not logged in") {
                needs_login = true;
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            // capture the session id once (for multi-turn --resume)
            if !sent_session {
                if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                    sent_session = true;
                    let _ = app.emit(
                        "code://session",
                        SessionPayload { id: id.clone(), session_id: sid.to_string() },
                    );
                }
            }

            if v.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                if let Some(content) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
                    for block in content {
                        match block.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(txt) = block.get("text").and_then(|t| t.as_str()) {
                                    if !txt.is_empty() {
                                        let _ = app.emit(
                                            "code://delta",
                                            StreamPayload { id: id.clone(), text: txt.to_string() },
                                        );
                                    }
                                }
                            }
                            Some("tool_use") => {
                                if let Some(label) = tool_label(block) {
                                    let _ = app.emit(
                                        "code://tool",
                                        StreamPayload { id: id.clone(), text: label },
                                    );
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }

            // token usage (final totals arrive on the `result` line)
            if v.get("type").and_then(|t| t.as_str()) == Some("result") {
                if let Some(u) = v.get("usage") {
                    let g = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                    let input = g("input_tokens") + g("cache_read_input_tokens") + g("cache_creation_input_tokens");
                    let output = g("output_tokens");
                    let _ = app.emit("code://usage", UsagePayload { id: id.clone(), input, output });
                }
            }
        }

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
        let status = child.wait();

        if let Some(st) = app.try_state::<AppState>() {
            st.children.lock().unwrap().remove(&id);
        }

        if needs_login {
            let _ = app.emit("code://error", ErrorPayload { id, message: "NOT_LOGGED_IN".into() });
            return;
        }
        match status {
            Ok(s) if s.success() => {
                let _ = app.emit("code://done", DonePayload { id });
            }
            Ok(s) => {
                // a SIGTERM (cancel) shows up as a signal exit — treat as a clean stop
                let msg = if stderr_text.trim().is_empty() {
                    format!("claude با کد {} خارج شد", s)
                } else {
                    stderr_text
                };
                let _ = app.emit("code://error", ErrorPayload { id, message: msg });
            }
            Err(e) => {
                let _ = app.emit("code://error", ErrorPayload { id, message: e.to_string() });
            }
        }
    });

    Ok(())
}
