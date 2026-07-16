// ----------------------------------------------------------------------------
// Git — shell out to the system `git`, scoped to a tab's project folder, so the
// usual day-to-day workflow (stage, commit, push/pull, branches, log, diff) can
// be driven from a panel instead of an external IDE.
// ----------------------------------------------------------------------------

use std::process::Command;

use serde::Serialize;

use crate::proxy::ssh_proxy_command;

#[derive(Serialize, Clone)]
pub(crate) struct GitFile {
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
pub(crate) struct GitStatus {
    is_repo: bool,
    branch: String,
    upstream: String,
    ahead: u32,
    behind: u32,
    files: Vec<GitFile>,
}

#[derive(Serialize, Clone)]
pub(crate) struct GitBranches {
    current: String,
    branches: Vec<String>,
}

#[derive(Serialize, Clone)]
pub(crate) struct GitCommit {
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

/// Build a `git` command for a network operation, routed through the given
/// optional per-connection proxy (independent of the app proxy). Any ambient
/// proxy inherited from the app's own environment is stripped, so an empty
/// proxy means a truly direct connection — never the app proxy.
fn git_net_command(dir: &str, proxy: &Option<String>) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir);
    for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] {
        cmd.env_remove(k);
    }
    if let Some(px) = proxy.as_deref().filter(|s| !s.trim().is_empty()) {
        let url = if px.contains("://") { px.to_string() } else { format!("http://{}", px) };
        // http(s) remotes
        cmd.arg("-c").arg(format!("http.proxy={}", url));
        cmd.arg("-c").arg(format!("https.proxy={}", url));
        // ssh remotes (e.g. git@github.com) — proxy via ssh ProxyCommand
        if let Some(pc) = ssh_proxy_command(px) {
            cmd.arg("-c")
                .arg(format!("core.sshCommand=ssh -o ProxyCommand='{}'", pc));
        }
    }
    cmd
}

/// Run a git network command, returning the most informative output on success
/// (push/pull report progress on stderr) or stderr as the error.
fn run_git_net(dir: &str, proxy: &Option<String>, args: &[&str]) -> Result<String, String> {
    let out = git_net_command(dir, proxy)
        .args(args)
        .output()
        .map_err(|e| format!("git پیدا نشد: {}", e))?;
    let so = String::from_utf8_lossy(&out.stdout);
    let se = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(if !so.trim().is_empty() { so.trim().to_string() } else { se.trim().to_string() })
    } else {
        Err(se.trim().to_string())
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
pub(crate) fn git_status(cwd: Option<String>) -> GitStatus {
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
pub(crate) fn git_diff(cwd: Option<String>, path: String, staged: bool) -> String {
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
pub(crate) fn git_stage(cwd: Option<String>, path: String) -> Result<(), String> {
    run_git(&git_cwd(cwd), &["add", "--", &path]).map(|_| ())
}

#[tauri::command]
pub(crate) fn git_unstage(cwd: Option<String>, path: String) -> Result<(), String> {
    run_git(&git_cwd(cwd), &["restore", "--staged", "--", &path]).map(|_| ())
}

#[tauri::command]
pub(crate) fn git_stage_all(cwd: Option<String>) -> Result<(), String> {
    run_git(&git_cwd(cwd), &["add", "-A"]).map(|_| ())
}

#[tauri::command]
pub(crate) fn git_unstage_all(cwd: Option<String>) -> Result<(), String> {
    run_git(&git_cwd(cwd), &["reset"]).map(|_| ())
}

/// Discard worktree changes for a file (tracked: restore; untracked: delete).
#[tauri::command]
pub(crate) fn git_discard(cwd: Option<String>, path: String, untracked: bool) -> Result<(), String> {
    let dir = git_cwd(cwd);
    if untracked {
        let full = std::path::Path::new(&dir).join(&path);
        std::fs::remove_file(full).map_err(|e| e.to_string())
    } else {
        run_git(&dir, &["restore", "--", &path]).map(|_| ())
    }
}

#[tauri::command]
pub(crate) fn git_commit(cwd: Option<String>, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("پیام commit خالی است".into());
    }
    run_git(&git_cwd(cwd), &["commit", "-m", &message])
}

#[tauri::command]
pub(crate) fn git_push(cwd: Option<String>, proxy: Option<String>) -> Result<String, String> {
    let dir = git_cwd(cwd);
    // set upstream automatically on first push of a new branch
    let out = git_net_command(&dir, &proxy)
        .arg("push")
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
        return run_git_net(&dir, &proxy, &["push", "--set-upstream", "origin", &branch]);
    }
    Err(err.trim().to_string())
}

#[tauri::command]
pub(crate) fn git_pull(cwd: Option<String>, proxy: Option<String>) -> Result<String, String> {
    run_git_net(&git_cwd(cwd), &proxy, &["pull"])
}

#[tauri::command]
pub(crate) fn git_fetch(cwd: Option<String>, proxy: Option<String>) -> Result<String, String> {
    run_git_net(&git_cwd(cwd), &proxy, &["fetch", "--all", "--prune"])
}

#[tauri::command]
pub(crate) fn git_branches(cwd: Option<String>) -> GitBranches {
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
pub(crate) fn git_checkout(cwd: Option<String>, branch: String, create: bool) -> Result<String, String> {
    let dir = git_cwd(cwd);
    if create {
        run_git(&dir, &["checkout", "-b", &branch])
    } else {
        run_git(&dir, &["checkout", &branch])
    }
}

#[tauri::command]
pub(crate) fn git_log(cwd: Option<String>, limit: u32) -> Vec<GitCommit> {
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
