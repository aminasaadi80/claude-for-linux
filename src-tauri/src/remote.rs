// ----------------------------------------------------------------------------
// Remote files — SFTP (over SSH) and FTP/FTPS. Each connection is kept alive in
// state and addressed by a conn_id, so the UI can browse/transfer across calls.
// ----------------------------------------------------------------------------

use std::collections::HashMap;
use std::io::Write;
use std::net::TcpStream;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::proxy::connect_via_proxy;

#[derive(Deserialize)]
pub(crate) struct RemoteCreds {
    /// "sftp" | "ftp" | "ftps"
    protocol: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    /// private key file for SFTP key auth
    key_path: Option<String>,
    passphrase: Option<String>,
    /// optional per-connection proxy (independent of the app proxy). Empty =
    /// direct connection.
    #[serde(default)]
    proxy: Option<String>,
}

#[derive(Serialize, Clone)]
pub(crate) struct RemoteFile {
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
pub(crate) struct RemoteState {
    conns: Mutex<HashMap<String, Conn>>,
}

#[derive(Serialize)]
pub(crate) struct LocalListing {
    /// the resolved absolute folder that was listed
    path: String,
    files: Vec<RemoteFile>,
}

/// List a local folder for the dual-pane view of the SFTP/FTP tab. An empty
/// path resolves to the user's home directory (the default left pane).
#[tauri::command]
pub(crate) fn local_list(path: Option<String>) -> Result<LocalListing, String> {
    let dir = match path.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(p) => std::path::PathBuf::from(p),
        None => dirs::home_dir().ok_or_else(|| "پوشه‌ی خانه پیدا نشد".to_string())?,
    };
    let dir = dir.canonicalize().map_err(|e| format!("{}: {}", dir.display(), e))?;
    let mut files = Vec::new();
    for ent in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(ent) = ent else { continue };
        let Ok(md) = ent.metadata() else { continue };
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        files.push(RemoteFile {
            name: ent.file_name().to_string_lossy().into_owned(),
            path: ent.path().to_string_lossy().into_owned(),
            is_dir: md.is_dir(),
            size: md.len(),
            modified,
        });
    }
    files.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(LocalListing { path: dir.to_string_lossy().into_owned(), files })
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
    // through the per-connection proxy if set, otherwise a direct socket
    let tcp = match c.proxy.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(px) => connect_via_proxy(px, &c.host, c.port)
            .map_err(|e| format!("اتصال از طریق پروکسی ناموفق: {}", e))?,
        None => TcpStream::connect(format!("{}:{}", c.host, c.port))
            .map_err(|e| format!("اتصال ناموفق: {}", e))?,
    };
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
    let proxy = c.proxy.clone().filter(|s| !s.trim().is_empty());

    if secure {
        // control connection: through the proxy tunnel if set
        let stream = match &proxy {
            Some(px) => {
                let tcp = connect_via_proxy(px, &c.host, c.port)
                    .map_err(|e| format!("اتصال از طریق پروکسی ناموفق: {}", e))?;
                suppaftp::NativeTlsFtpStream::connect_with_stream(tcp)
                    .map_err(|e| format!("اتصال ناموفق: {}", e))?
            }
            None => suppaftp::NativeTlsFtpStream::connect(&addr)
                .map_err(|e| format!("اتصال ناموفق: {}", e))?,
        };
        // passive data connections also go through the proxy
        let stream = match &proxy {
            Some(px) => {
                let px = px.clone();
                stream.passive_stream_builder(move |a| {
                    connect_via_proxy(&px, &a.ip().to_string(), a.port())
                        .map_err(suppaftp::FtpError::ConnectionError)
                })
            }
            None => stream,
        };
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
        let stream = match &proxy {
            Some(px) => {
                let tcp = connect_via_proxy(px, &c.host, c.port)
                    .map_err(|e| format!("اتصال از طریق پروکسی ناموفق: {}", e))?;
                suppaftp::FtpStream::connect_with_stream(tcp)
                    .map_err(|e| format!("اتصال ناموفق: {}", e))?
            }
            None => suppaftp::FtpStream::connect(&addr)
                .map_err(|e| format!("اتصال ناموفق: {}", e))?,
        };
        let mut ftp = match &proxy {
            Some(px) => {
                let px = px.clone();
                stream.passive_stream_builder(move |a| {
                    connect_via_proxy(&px, &a.ip().to_string(), a.port())
                        .map_err(suppaftp::FtpError::ConnectionError)
                })
            }
            None => stream,
        };
        ftp.login(&c.username, &pw).map_err(|e| format!("ورود ناموفق: {}", e))?;
        Ok(Conn::Ftp(ftp))
    }
}

#[tauri::command]
pub(crate) fn remote_connect(state: State<RemoteState>, conn_id: String, creds: RemoteCreds) -> Result<String, String> {
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
pub(crate) fn remote_list(state: State<RemoteState>, conn_id: String, path: String) -> Result<Vec<RemoteFile>, String> {
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
pub(crate) fn remote_download(
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
pub(crate) fn remote_upload(
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
pub(crate) fn remote_mkdir(state: State<RemoteState>, conn_id: String, path: String) -> Result<(), String> {
    let mut guard = state.conns.lock().unwrap();
    let conn = guard.get_mut(&conn_id).ok_or("اتصال یافت نشد")?;
    match conn {
        Conn::Sftp { sftp, .. } => sftp.mkdir(std::path::Path::new(&path), 0o755).map_err(|e| e.to_string()),
        Conn::Ftp(f) => f.mkdir(&path).map_err(|e| e.to_string()),
        Conn::Ftps(f) => f.mkdir(&path).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub(crate) fn remote_delete(
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
pub(crate) fn remote_rename(
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
pub(crate) fn remote_disconnect(state: State<RemoteState>, conn_id: String) {
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
