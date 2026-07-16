// ----------------------------------------------------------------------------
// Embedded terminal — a real interactive `claude` running inside a PTY, so the
// full Claude Code TUI (slash commands, live permission prompts, plan mode) is
// available. Rendered with xterm.js on the frontend.
// ----------------------------------------------------------------------------

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::proxy::ssh_proxy_command;
use crate::settings::proxy_url;
use crate::util::{augmented_path, claude_binary, which};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn PtyChild + Send + Sync>,
}

#[derive(Default)]
pub(crate) struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Serialize, Clone)]
struct PtyData {
    id: String,
    data: String, // base64 of raw bytes
}

/// Claude Code keeps each conversation at
/// `~/.claude/projects/<slug>/<session_id>.jsonl`, where <slug> is the absolute
/// project folder with every non-alphanumeric character turned into '-'. This
/// lets us tell whether a given tab's dedicated session already exists *for the
/// current folder* — sessions are folder-scoped, so a session created in folder A
/// can't be resumed from folder B.
fn claude_session_file(cwd: &str, session_id: &str) -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    let slug: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(
        home.join(".claude")
            .join("projects")
            .join(slug)
            .join(format!("{session_id}.jsonl")),
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // tauri commands mirror the frontend call shape
pub(crate) fn pty_open(
    app: AppHandle,
    state: State<PtyState>,
    term_id: String,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    extra_args: Option<Vec<String>>,
    // optional per-tab claude session id. When set, the tab resumes this exact
    // session (`--resume`) if it already exists for the current folder, or
    // creates it (`--session-id`) otherwise — so tabs sharing a folder stay
    // distinct and a folder change starts a fresh conversation instead of
    // failing to resume a session that lives under a different folder.
    claude_session: Option<String>,
) -> Result<(), String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(claude_binary());
    cmd.env("TERM", "xterm-256color");
    cmd.env("PATH", augmented_path()); // find `claude`/`node` on macOS GUI too
    if let Some(px) = proxy_url() {
        cmd.env("HTTPS_PROXY", &px);
        cmd.env("HTTP_PROXY", &px);
        cmd.env("ALL_PROXY", &px);
    }
    // the folder this claude runs in (explicit cwd, else home) — also the key
    // under which its session file lives
    let effective_cwd = cwd
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .or_else(|| dirs::home_dir().map(|h| h.to_string_lossy().into_owned()));

    // resume this tab's own session if it already exists for this folder,
    // otherwise create it with that id (keeps same-folder tabs independent)
    if let Some(sid) = claude_session.as_deref().filter(|s| !s.trim().is_empty()) {
        let exists = effective_cwd
            .as_deref()
            .and_then(|c| claude_session_file(c, sid))
            .map(|p| p.exists())
            .unwrap_or(false);
        cmd.arg(if exists { "--resume" } else { "--session-id" });
        cmd.arg(sid);
    }

    // e.g. ["--continue"] for legacy restored tabs, ["--resume"] for the picker
    if let Some(args) = extra_args {
        for a in args {
            if !a.trim().is_empty() {
                cmd.arg(a);
            }
        }
    }
    if let Some(dir) = effective_cwd.as_deref() {
        cmd.cwd(dir);
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

// ----------------------------------------------------------------------------
// SSH terminal — a real interactive `ssh` login running inside a PTY (same
// rendering path as the embedded claude terminal). Each connection can carry its
// OWN optional proxy (via SSH ProxyCommand), completely independent from the
// app-wide `claude` proxy configured in Settings.
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct SshCreds {
    host: String,
    port: u16,
    username: String,
    /// optional password (used via `sshpass` when available; otherwise ssh will
    /// prompt for it interactively inside the terminal)
    password: Option<String>,
    /// optional private key file
    key_path: Option<String>,
    /// optional per-connection proxy, e.g. "127.0.0.1:8080",
    /// "http://127.0.0.1:8080" or "socks5://127.0.0.1:1080". Separate from the
    /// app proxy — routed through SSH's ProxyCommand (needs `nc`/netcat).
    proxy: Option<String>,
}

#[tauri::command]
pub(crate) fn ssh_open(
    app: AppHandle,
    state: State<PtyState>,
    term_id: String,
    creds: SshCreds,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    // Use sshpass when a password is given and the tool exists; otherwise ssh
    // asks for the password interactively (works fine inside the PTY).
    let use_sshpass = creds
        .password
        .as_deref()
        .map(|s| !s.is_empty())
        .unwrap_or(false)
        && which("sshpass");

    let mut cmd = if use_sshpass {
        let mut c = CommandBuilder::new("sshpass");
        c.arg("-p");
        c.arg(creds.password.as_deref().unwrap_or(""));
        c.arg("ssh");
        c
    } else {
        CommandBuilder::new("ssh")
    };

    cmd.env("TERM", "xterm-256color");
    cmd.env("PATH", augmented_path()); // so `nc`/`sshpass` (proxy/password) are found
    // NOTE: intentionally NOT injecting the app proxy here — SSH proxying is
    // per-connection and handled below via ProxyCommand.
    cmd.arg("-tt"); // force a PTY on the remote even through ProxyCommand
    cmd.arg("-p");
    cmd.arg(creds.port.to_string());
    cmd.arg("-o");
    cmd.arg("StrictHostKeyChecking=accept-new"); // don't block on the yes/no prompt

    if let Some(key) = creds.key_path.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("-i");
        cmd.arg(key);
    }
    if let Some(px) = creds.proxy.as_deref().filter(|s| !s.trim().is_empty()) {
        if let Some(pc) = ssh_proxy_command(px) {
            cmd.arg("-o");
            cmd.arg(format!("ProxyCommand={}", pc));
        }
    }
    cmd.arg(format!("{}@{}", creds.username, creds.host));

    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home); // so ssh can find ~/.ssh, keys, config
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

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

    state
        .sessions
        .lock()
        .unwrap()
        .insert(term_id, PtySession { master: pair.master, writer, child });
    Ok(())
}

#[tauri::command]
pub(crate) fn pty_write(state: State<PtyState>, term_id: String, data: String) {
    if let Some(s) = state.sessions.lock().unwrap().get_mut(&term_id) {
        let _ = s.writer.write_all(data.as_bytes());
        let _ = s.writer.flush();
    }
}

#[tauri::command]
pub(crate) fn pty_resize(state: State<PtyState>, term_id: String, rows: u16, cols: u16) {
    if let Some(s) = state.sessions.lock().unwrap().get(&term_id) {
        let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

#[tauri::command]
pub(crate) fn pty_close(state: State<PtyState>, term_id: String) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&term_id) {
        let _ = s.child.kill();
    }
}
