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

// ----------------------------------------------------------------------------
// Git — shell out to the system `git`, scoped to a tab's project folder, so the
// usual day-to-day workflow (stage, commit, push/pull, branches, log, diff) can
// be driven from a panel instead of an external IDE.
// ----------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct GitFile {
    path: String,
    /// index (staged) status char from `git status --porcelain`
    staged: String,
    /// worktree (unstaged) status char
    unstaged: String,
    staged_flag: bool,
    unstaged_flag: bool,
    untracked: bool,
}

#[derive(Serialize, Clone)]
struct GitStatus {
    is_repo: bool,
    branch: String,
    upstream: String,
    ahead: u32,
    behind: u32,
    files: Vec<GitFile>,
}

#[derive(Serialize, Clone)]
struct GitBranches {
    current: String,
    branches: Vec<String>,
}

#[derive(Serialize, Clone)]
struct GitCommit {
    hash: String,
    short: String,
    author: String,
    date: String,
    message: String,
}

/// Resolve the folder a git command runs in (tab cwd, else home).
fn git_cwd(cwd: Option<String>) -> String {
    cwd.filter(|s| !s.trim().is_empty())
        .or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_else(|| ".".to_string())
}

/// Run git, returning stdout on success or stderr (trimmed) as the error.
fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git پیدا نشد: {}", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Run git for its stdout only, ignoring a non-zero exit (e.g. `git diff`,
/// which returns 1 when differences exist).
fn git_out(dir: &str, args: &[&str]) -> String {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn git_status(cwd: Option<String>) -> GitStatus {
    let dir = git_cwd(cwd);
    let is_repo = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !is_repo {
        return GitStatus {
            is_repo: false,
            branch: String::new(),
            upstream: String::new(),
            ahead: 0,
            behind: 0,
            files: vec![],
        };
    }

    let branch = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let upstream = run_git(
        &dir,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )
    .unwrap_or_default()
    .trim()
    .to_string();

    let (mut ahead, mut behind) = (0u32, 0u32);
    if !upstream.is_empty() {
        if let Ok(s) = run_git(&dir, &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]) {
            let parts: Vec<&str> = s.split_whitespace().collect();
            if parts.len() == 2 {
                behind = parts[0].parse().unwrap_or(0);
                ahead = parts[1].parse().unwrap_or(0);
            }
        }
    }

    let mut files = vec![];
    // --untracked-files=all forces untracked files to show (overriding any
    // status.showUntrackedFiles=no config) and lists each file inside a new
    // folder individually instead of collapsing it to the directory.
    let raw = git_out(&dir, &["status", "--porcelain", "--untracked-files=all"]);
    for line in raw.lines() {
        if line.len() < 4 {
            continue;
        }
        let x = &line[0..1];
        let y = &line[1..2];
        let mut path = line[3..].to_string();
        // renames are "orig -> new"; keep the new path
        if let Some(idx) = path.find(" -> ") {
            path = path[idx + 4..].to_string();
        }
        let untracked = x == "?";
        files.push(GitFile {
            path,
            staged: x.to_string(),
            unstaged: y.to_string(),
            staged_flag: x != " " && !untracked,
            unstaged_flag: y != " " && !untracked,
            untracked,
        });
    }

    GitStatus { is_repo: true, branch, upstream, ahead, behind, files }
}

#[tauri::command]
fn git_diff(cwd: Option<String>, path: String, staged: bool) -> String {
    let dir = git_cwd(cwd);
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--staged");
    }
    args.push("--");
    args.push(&path);
    let mut s = git_out(&dir, &args);
    // untracked files have no diff target; show them as added vs /dev/null
    if s.trim().is_empty() && !staged {
        s = git_out(&dir, &["diff", "--no-index", "--", "/dev/null", &path]);
    }
    s
}

#[tauri::command]
fn git_stage(cwd: Option<String>, path: String) -> Result<(), String> {
    run_git(&git_cwd(cwd), &["add", "--", &path]).map(|_| ())
}

#[tauri::command]
fn git_unstage(cwd: Option<String>, path: String) -> Result<(), String> {
    run_git(&git_cwd(cwd), &["restore", "--staged", "--", &path]).map(|_| ())
}

#[tauri::command]
fn git_stage_all(cwd: Option<String>) -> Result<(), String> {
    run_git(&git_cwd(cwd), &["add", "-A"]).map(|_| ())
}

#[tauri::command]
fn git_unstage_all(cwd: Option<String>) -> Result<(), String> {
    run_git(&git_cwd(cwd), &["reset"]).map(|_| ())
}

/// Discard worktree changes for a file (tracked: restore; untracked: delete).
#[tauri::command]
fn git_discard(cwd: Option<String>, path: String, untracked: bool) -> Result<(), String> {
    let dir = git_cwd(cwd);
    if untracked {
        let full = std::path::Path::new(&dir).join(&path);
        std::fs::remove_file(full).map_err(|e| e.to_string())
    } else {
        run_git(&dir, &["restore", "--", &path]).map(|_| ())
    }
}

#[tauri::command]
fn git_commit(cwd: Option<String>, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("پیام commit خالی است".into());
    }
    run_git(&git_cwd(cwd), &["commit", "-m", &message])
}

#[tauri::command]
fn git_push(cwd: Option<String>) -> Result<String, String> {
    let dir = git_cwd(cwd);
    // set upstream automatically on first push of a new branch
    let out = Command::new("git")
        .args(["push"])
        .current_dir(&dir)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    if err.contains("has no upstream branch") || err.contains("--set-upstream") {
        let branch = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap_or_default()
            .trim()
            .to_string();
        return run_git(&dir, &["push", "--set-upstream", "origin", &branch]);
    }
    Err(err.trim().to_string())
}

#[tauri::command]
fn git_pull(cwd: Option<String>) -> Result<String, String> {
    run_git(&git_cwd(cwd), &["pull"])
}

#[tauri::command]
fn git_fetch(cwd: Option<String>) -> Result<String, String> {
    run_git(&git_cwd(cwd), &["fetch", "--all", "--prune"])
}

#[tauri::command]
fn git_branches(cwd: Option<String>) -> GitBranches {
    let dir = git_cwd(cwd);
    let current = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let out = git_out(&dir, &["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    let branches = out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    GitBranches { current, branches }
}

#[tauri::command]
fn git_checkout(cwd: Option<String>, branch: String, create: bool) -> Result<String, String> {
    let dir = git_cwd(cwd);
    if create {
        run_git(&dir, &["checkout", "-b", &branch])
    } else {
        run_git(&dir, &["checkout", &branch])
    }
}

#[tauri::command]
fn git_log(cwd: Option<String>, limit: u32) -> Vec<GitCommit> {
    let dir = git_cwd(cwd);
    // \x1f between fields, \x1e between records
    let fmt = "--pretty=format:%H\x1f%h\x1f%an\x1f%ar\x1f%s%x1e";
    let n = format!("-n{}", limit.max(1));
    let out = git_out(&dir, &["log", fmt, &n]);
    out.split('\u{1e}')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            if rec.trim().is_empty() {
                return None;
            }
            let p: Vec<&str> = rec.split('\u{1f}').collect();
            if p.len() < 5 {
                return None;
            }
            Some(GitCommit {
                hash: p[0].to_string(),
                short: p[1].to_string(),
                author: p[2].to_string(),
                date: p[3].to_string(),
                message: p[4].to_string(),
            })
        })
        .collect()
}

// ----------------------------------------------------------------------------
// Remote files — SFTP (over SSH) and FTP/FTPS. Each connection is kept alive in
// state and addressed by a conn_id, so the UI can browse/transfer across calls.
// ----------------------------------------------------------------------------

use std::net::TcpStream;

#[derive(Deserialize)]
struct RemoteCreds {
    /// "sftp" | "ftp" | "ftps"
    protocol: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    /// private key file for SFTP key auth
    key_path: Option<String>,
    passphrase: Option<String>,
}

#[derive(Serialize, Clone)]
struct RemoteFile {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    /// modification time, unix epoch seconds (0 = unknown)
    modified: i64,
}

enum Conn {
    Sftp {
        // keep the session alive alongside the sftp channel
        _sess: ssh2::Session,
        sftp: ssh2::Sftp,
    },
    Ftp(suppaftp::FtpStream),
    Ftps(suppaftp::NativeTlsFtpStream),
}

#[derive(Default)]
struct RemoteState {
    conns: Mutex<HashMap<String, Conn>>,
}

/// Join a remote base path and an entry name with forward slashes.
fn remote_join(base: &str, name: &str) -> String {
    if base.is_empty() || base == "/" {
        format!("/{}", name.trim_start_matches('/'))
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

fn open_sftp(c: &RemoteCreds) -> Result<Conn, String> {
    let addr = format!("{}:{}", c.host, c.port);
    let tcp = TcpStream::connect(&addr).map_err(|e| format!("اتصال ناموفق: {}", e))?;
    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| format!("handshake ناموفق: {}", e))?;

    let mut authed = false;
    // 1) explicit private key
    if let Some(key) = c.key_path.as_deref().filter(|s| !s.trim().is_empty()) {
        if sess
            .userauth_pubkey_file(&c.username, None, std::path::Path::new(key), c.passphrase.as_deref())
            .is_ok()
        {
            authed = true;
        }
    }
    // 2) password
    if !authed {
        if let Some(pw) = c.password.as_deref().filter(|s| !s.is_empty()) {
            if sess.userauth_password(&c.username, pw).is_ok() {
                authed = true;
            }
        }
    }
    // 3) ssh-agent
    if !authed {
        let _ = sess.userauth_agent(&c.username);
        authed = sess.authenticated();
    }
    if !authed {
        return Err("احراز هویت ناموفق بود (کلید/رمز/agent هیچ‌کدام نپذیرفت)".into());
    }

    let sftp = sess.sftp().map_err(|e| format!("شروع SFTP ناموفق: {}", e))?;
    Ok(Conn::Sftp { _sess: sess, sftp })
}

fn open_ftp(c: &RemoteCreds, secure: bool) -> Result<Conn, String> {
    let addr = format!("{}:{}", c.host, c.port);
    let pw = c.password.clone().unwrap_or_default();
    if secure {
        let stream = suppaftp::NativeTlsFtpStream::connect(&addr)
            .map_err(|e| format!("اتصال ناموفق: {}", e))?;
        // many FTPS servers use self-signed certs — be lenient
        let ctx = suppaftp::native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()
            .map_err(|e| e.to_string())?;
        let mut ftp = stream
            .into_secure(suppaftp::NativeTlsConnector::from(ctx), &c.host)
            .map_err(|e| format!("TLS ناموفق: {}", e))?;
        ftp.login(&c.username, &pw).map_err(|e| format!("ورود ناموفق: {}", e))?;
        Ok(Conn::Ftps(ftp))
    } else {
        let mut ftp = suppaftp::FtpStream::connect(&addr)
            .map_err(|e| format!("اتصال ناموفق: {}", e))?;
        ftp.login(&c.username, &pw).map_err(|e| format!("ورود ناموفق: {}", e))?;
        Ok(Conn::Ftp(ftp))
    }
}

#[tauri::command]
fn remote_connect(state: State<RemoteState>, conn_id: String, creds: RemoteCreds) -> Result<String, String> {
    let mut conn = match creds.protocol.as_str() {
        "sftp" => open_sftp(&creds)?,
        "ftp" => open_ftp(&creds, false)?,
        "ftps" => open_ftp(&creds, true)?,
        other => return Err(format!("پروتکل ناشناخته: {}", other)),
    };
    // report a sensible starting directory
    let start = match &mut conn {
        Conn::Sftp { sftp, .. } => sftp
            .realpath(std::path::Path::new("."))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".to_string()),
        Conn::Ftp(f) => f.pwd().unwrap_or_else(|_| "/".to_string()),
        Conn::Ftps(f) => f.pwd().unwrap_or_else(|_| "/".to_string()),
    };
    state.conns.lock().unwrap().insert(conn_id, conn);
    Ok(start)
}

#[tauri::command]
fn remote_list(state: State<RemoteState>, conn_id: String, path: String) -> Result<Vec<RemoteFile>, String> {
    let mut guard = state.conns.lock().unwrap();
    let conn = guard.get_mut(&conn_id).ok_or("اتصال یافت نشد")?;
    let dir = if path.trim().is_empty() { "/".to_string() } else { path };
    let mut out = vec![];
    match conn {
        Conn::Sftp { sftp, .. } => {
            let entries = sftp
                .readdir(std::path::Path::new(&dir))
                .map_err(|e| e.to_string())?;
            for (pb, st) in entries {
                let name = pb
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if name.is_empty() || name == "." || name == ".." {
                    continue;
                }
                out.push(RemoteFile {
                    path: remote_join(&dir, &name),
                    name,
                    is_dir: st.is_dir(),
                    size: st.size.unwrap_or(0),
                    modified: st.mtime.map(|m| m as i64).unwrap_or(0),
                });
            }
        }
        Conn::Ftp(f) => list_ftp(f.list(Some(&dir)).map_err(|e| e.to_string())?, &dir, &mut out),
        Conn::Ftps(f) => list_ftp(f.list(Some(&dir)).map_err(|e| e.to_string())?, &dir, &mut out),
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Parse raw FTP LIST lines into RemoteFile entries.
fn list_ftp(lines: Vec<String>, dir: &str, out: &mut Vec<RemoteFile>) {
    for line in lines {
        if let Ok(f) = line.parse::<suppaftp::list::File>() {
            let name = f.name().to_string();
            if name == "." || name == ".." {
                continue;
            }
            let modified = f
                .modified()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push(RemoteFile {
                path: remote_join(dir, &name),
                is_dir: f.is_directory(),
                size: f.size() as u64,
                modified,
                name,
            });
        }
    }
}

#[tauri::command]
fn remote_download(
    state: State<RemoteState>,
    conn_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let mut guard = state.conns.lock().unwrap();
    let conn = guard.get_mut(&conn_id).ok_or("اتصال یافت نشد")?;
    let mut local = std::fs::File::create(&local_path).map_err(|e| e.to_string())?;
    match conn {
        Conn::Sftp { sftp, .. } => {
            let mut rf = sftp.open(std::path::Path::new(&remote_path)).map_err(|e| e.to_string())?;
            std::io::copy(&mut rf, &mut local).map_err(|e| e.to_string())?;
        }
        Conn::Ftp(f) => {
            let buf = f.retr_as_buffer(&remote_path).map_err(|e| e.to_string())?;
            local.write_all(buf.into_inner().as_slice()).map_err(|e| e.to_string())?;
        }
        Conn::Ftps(f) => {
            let buf = f.retr_as_buffer(&remote_path).map_err(|e| e.to_string())?;
            local.write_all(buf.into_inner().as_slice()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn remote_upload(
    state: State<RemoteState>,
    conn_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let mut guard = state.conns.lock().unwrap();
    let conn = guard.get_mut(&conn_id).ok_or("اتصال یافت نشد")?;
    let mut local = std::fs::File::open(&local_path).map_err(|e| e.to_string())?;
    match conn {
        Conn::Sftp { sftp, .. } => {
            let mut rf = sftp.create(std::path::Path::new(&remote_path)).map_err(|e| e.to_string())?;
            std::io::copy(&mut local, &mut rf).map_err(|e| e.to_string())?;
        }
        Conn::Ftp(f) => {
            f.put_file(&remote_path, &mut local).map_err(|e| e.to_string())?;
        }
        Conn::Ftps(f) => {
            f.put_file(&remote_path, &mut local).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn remote_mkdir(state: State<RemoteState>, conn_id: String, path: String) -> Result<(), String> {
    let mut guard = state.conns.lock().unwrap();
    let conn = guard.get_mut(&conn_id).ok_or("اتصال یافت نشد")?;
    match conn {
        Conn::Sftp { sftp, .. } => sftp.mkdir(std::path::Path::new(&path), 0o755).map_err(|e| e.to_string()),
        Conn::Ftp(f) => f.mkdir(&path).map_err(|e| e.to_string()),
        Conn::Ftps(f) => f.mkdir(&path).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
fn remote_delete(
    state: State<RemoteState>,
    conn_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let mut guard = state.conns.lock().unwrap();
    let conn = guard.get_mut(&conn_id).ok_or("اتصال یافت نشد")?;
    match conn {
        Conn::Sftp { sftp, .. } => {
            if is_dir {
                sftp.rmdir(std::path::Path::new(&path)).map_err(|e| e.to_string())
            } else {
                sftp.unlink(std::path::Path::new(&path)).map_err(|e| e.to_string())
            }
        }
        Conn::Ftp(f) => {
            if is_dir { f.rmdir(&path).map_err(|e| e.to_string()) } else { f.rm(&path).map_err(|e| e.to_string()) }
        }
        Conn::Ftps(f) => {
            if is_dir { f.rmdir(&path).map_err(|e| e.to_string()) } else { f.rm(&path).map_err(|e| e.to_string()) }
        }
    }
}

#[tauri::command]
fn remote_rename(
    state: State<RemoteState>,
    conn_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let mut guard = state.conns.lock().unwrap();
    let conn = guard.get_mut(&conn_id).ok_or("اتصال یافت نشد")?;
    match conn {
        Conn::Sftp { sftp, .. } => sftp
            .rename(std::path::Path::new(&from), std::path::Path::new(&to), None)
            .map_err(|e| e.to_string()),
        Conn::Ftp(f) => f.rename(&from, &to).map_err(|e| e.to_string()),
        Conn::Ftps(f) => f.rename(&from, &to).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
fn remote_disconnect(state: State<RemoteState>, conn_id: String) {
    if let Some(conn) = state.conns.lock().unwrap().remove(&conn_id) {
        match conn {
            Conn::Ftp(mut f) => {
                let _ = f.quit();
            }
            Conn::Ftps(mut f) => {
                let _ = f.quit();
            }
            Conn::Sftp { .. } => { /* dropped → session closes */ }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(PtyState::default())
        .manage(RemoteState::default())
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
            clipboard_get,
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_stage_all,
            git_unstage_all,
            git_discard,
            git_commit,
            git_push,
            git_pull,
            git_fetch,
            git_branches,
            git_checkout,
            git_log,
            remote_connect,
            remote_list,
            remote_download,
            remote_upload,
            remote_mkdir,
            remote_delete,
            remote_rename,
            remote_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
