// Claude for Linux — Tauri backend (Claude Code GUI)
//
// Drives the local `claude` CLI as a coding agent and streams its output to the
// UI via Tauri events. Authentication is whatever the installed `claude` CLI
// already has (the same browser login you use in the terminal) — no API key.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

// Maps an in-flight request id -> the child process group id, so a running
// `claude` invocation can be cancelled from the UI.
#[derive(Default)]
struct AppState {
    children: Mutex<HashMap<String, u32>>,
}

// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Settings {
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
fn proxy_url() -> Option<String> {
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
fn load_settings() -> Settings {
    std::fs::read_to_string(config_file("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(config_file("settings.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session() -> String {
    std::fs::read_to_string(config_file("session.json")).unwrap_or_default()
}

#[tauri::command]
fn save_session(data: String) -> Result<(), String> {
    std::fs::write(config_file("session.json"), data).map_err(|e| e.to_string())
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
fn code_stop(state: State<AppState>, request_id: String) {
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
fn code_send(
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

/// Open a native terminal emulator at the given folder.
#[tauri::command]
fn open_terminal(cwd: Option<String>) -> Result<(), String> {
    let dir = cwd
        .filter(|s| !s.trim().is_empty())
        .or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_else(|| ".".to_string());

    // try the common emulators in order
    let attempts: Vec<(&str, Vec<String>)> = vec![
        ("gnome-terminal", vec![format!("--working-directory={}", dir)]),
        ("konsole", vec!["--workdir".into(), dir.clone()]),
        ("xfce4-terminal", vec![format!("--working-directory={}", dir)]),
        ("tilix", vec!["-w".into(), dir.clone()]),
        ("kitty", vec!["-d".into(), dir.clone()]),
        ("alacritty", vec!["--working-directory".into(), dir.clone()]),
        ("x-terminal-emulator", vec![]),
        ("xterm", vec![]),
    ];

    for (term, args) in attempts {
        if which(term) {
            let mut c = Command::new(term);
            c.args(&args);
            if term == "x-terminal-emulator" || term == "xterm" {
                c.current_dir(&dir);
            }
            if c.spawn().is_ok() {
                return Ok(());
            }
        }
    }
    Err("هیچ ترمینالی پیدا نشد".into())
}

fn which(bin: &str) -> bool {
    Command::new("which")
        .arg(bin)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ----------------------------------------------------------------------------
// Embedded terminal — a real interactive `claude` running inside a PTY, so the
// full Claude Code TUI (slash commands, live permission prompts, plan mode) is
// available. Rendered with xterm.js on the frontend.
// ----------------------------------------------------------------------------

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn PtyChild + Send + Sync>,
}

#[derive(Default)]
struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Serialize, Clone)]
struct PtyData {
    id: String,
    data: String, // base64 of raw bytes
}

#[tauri::command]
fn pty_open(
    app: AppHandle,
    state: State<PtyState>,
    term_id: String,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    extra_args: Option<Vec<String>>,
) -> Result<(), String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(claude_binary());
    cmd.env("TERM", "xterm-256color");
    if let Some(px) = proxy_url() {
        cmd.env("HTTPS_PROXY", &px);
        cmd.env("HTTP_PROXY", &px);
        cmd.env("ALL_PROXY", &px);
    }
    // e.g. ["--continue"] for restored tabs, ["--resume"] for the session picker
    if let Some(args) = extra_args {
        for a in args {
            if !a.trim().is_empty() {
                cmd.arg(a);
            }
        }
    }
    if let Some(dir) = cwd.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.cwd(dir);
    } else if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave); // parent doesn't need the slave handle

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let app_r = app.clone();
    let id_r = term_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_r.emit("pty://data", PtyData { id: id_r.clone(), data });
                }
            }
        }
        let _ = app_r.emit("pty://exit", PtyData { id: id_r.clone(), data: String::new() });
    });

    state.sessions.lock().unwrap().insert(
        term_id,
        PtySession { master: pair.master, writer, child },
    );
    Ok(())
}

#[tauri::command]
fn pty_write(state: State<PtyState>, term_id: String, data: String) {
    if let Some(s) = state.sessions.lock().unwrap().get_mut(&term_id) {
        let _ = s.writer.write_all(data.as_bytes());
        let _ = s.writer.flush();
    }
}

#[tauri::command]
fn pty_resize(state: State<PtyState>, term_id: String, rows: u16, cols: u16) {
    if let Some(s) = state.sessions.lock().unwrap().get(&term_id) {
        let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

#[tauri::command]
fn pty_close(state: State<PtyState>, term_id: String) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&term_id) {
        let _ = s.child.kill();
    }
}

/// Write text to a file (used for "export conversation").
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

// Clipboard via the system tool (navigator.clipboard is unreliable in webkit2gtk).
#[tauri::command]
fn clipboard_set(text: String) -> Result<(), String> {
    let tools: [(&str, &[&str]); 3] = [
        ("wl-copy", &[]),
        ("xclip", &["-selection", "clipboard"]),
        ("xsel", &["--clipboard", "--input"]),
    ];
    for (bin, args) in tools {
        if which(bin) {
            if let Ok(mut child) = Command::new(bin).args(args).stdin(Stdio::piped()).spawn() {
                if let Some(mut sin) = child.stdin.take() {
                    let _ = sin.write_all(text.as_bytes());
                } // sin dropped here → EOF
                let _ = child.wait();
                return Ok(());
            }
        }
    }
    Err("هیچ ابزار کلیپ‌بوردی پیدا نشد (wl-clipboard یا xclip را نصب کن)".into())
}

#[tauri::command]
fn clipboard_get() -> Result<String, String> {
    let tools: [(&str, &[&str]); 3] = [
        ("wl-paste", &["--no-newline"]),
        ("xclip", &["-selection", "clipboard", "-o"]),
        ("xsel", &["--clipboard", "--output"]),
    ];
    for (bin, args) in tools {
        if which(bin) {
            if let Ok(o) = Command::new(bin).args(args).output() {
                if o.status.success() {
                    return Ok(String::from_utf8_lossy(&o.stdout).to_string());
                }
            }
        }
    }
    Err("هیچ ابزار کلیپ‌بوردی پیدا نشد".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(PtyState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            load_session,
            save_session,
            claude_check,
            code_send,
            code_stop,
            open_terminal,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            write_text_file,
            clipboard_set,
            clipboard_get
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
