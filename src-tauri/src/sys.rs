use std::io::Write;
use std::process::{Command, Stdio};

use crate::util::which;

/// Open a native terminal emulator at the given folder.
#[tauri::command]
pub(crate) fn open_terminal(cwd: Option<String>) -> Result<(), String> {
    let dir = cwd
        .filter(|s| !s.trim().is_empty())
        .or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_else(|| ".".to_string());

    // macOS: open the default Terminal at the folder
    #[cfg(target_os = "macos")]
    {
        if Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(&dir)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }

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

/// Write text to a file (used for "export conversation").
#[tauri::command]
pub(crate) fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

// Clipboard via the system tool (navigator.clipboard is unreliable in webkit2gtk).
#[tauri::command]
pub(crate) fn clipboard_set(text: String) -> Result<(), String> {
    let tools: [(&str, &[&str]); 4] = [
        ("pbcopy", &[]), // macOS
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
pub(crate) fn clipboard_get() -> Result<String, String> {
    let tools: [(&str, &[&str]); 4] = [
        ("pbpaste", &[]), // macOS
        ("wl-paste", &["--no-newline"]),
        ("xclip", &["-selection", "clipboard", "-o"]),
        ("xsel", &["--clipboard", "--output"]),
    ];
    for (bin, args) in tools {
        if which(bin) {
            if let Ok(o) = Command::new(bin).args(args).output() {
                if o.status.success() {
                    // Only return real text. If the clipboard holds an image or
                    // other binary (invalid UTF-8), return empty instead of
                    // dumping raw bytes into the terminal — pasting binary is a
                    // frequent trigger for webkit crashes / broken TUIs.
                    return Ok(String::from_utf8(o.stdout).unwrap_or_default());
                }
            }
        }
    }
    Err("هیچ ابزار کلیپ‌بوردی پیدا نشد".into())
}
