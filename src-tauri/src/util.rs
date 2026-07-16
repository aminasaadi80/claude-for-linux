use std::path::PathBuf;
use std::process::Command;

/// Common locations for user-installed CLIs (npm/homebrew/local), used both to
/// locate `claude` directly and to widen PATH for spawned processes. GUI apps —
/// especially on macOS, launched from Finder — inherit only a minimal PATH, so
/// tools installed in these dirs aren't found unless we add them ourselves.
fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut v = vec![];
    if let Some(home) = dirs::home_dir() {
        v.push(home.join(".local/bin"));
        v.push(home.join(".npm-global/bin"));
        v.push(home.join(".bun/bin"));
        v.push(home.join("bin"));
    }
    v.push(PathBuf::from("/opt/homebrew/bin")); // macOS (Apple Silicon)
    v.push(PathBuf::from("/usr/local/bin")); // macOS (Intel) / npm global
    v.push(PathBuf::from("/usr/bin"));
    v
}

/// PATH with the common CLI dirs prepended to whatever the app already has.
pub(crate) fn augmented_path() -> String {
    let extra = extra_bin_dirs()
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":");
    match std::env::var("PATH") {
        Ok(p) if !p.is_empty() => format!("{}:{}", extra, p),
        _ => extra,
    }
}

pub(crate) fn claude_binary() -> String {
    for dir in extra_bin_dirs() {
        let cand = dir.join("claude");
        if cand.exists() {
            return cand.to_string_lossy().into_owned();
        }
    }
    "claude".to_string()
}

pub(crate) fn which(bin: &str) -> bool {
    Command::new("which")
        .arg(bin)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
