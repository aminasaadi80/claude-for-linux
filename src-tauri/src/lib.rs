// Claude for Linux — Tauri backend (Claude Code GUI)
//
// Drives the local `claude` CLI as a coding agent and streams its output to the
// UI via Tauri events. Authentication is whatever the installed `claude` CLI
// already has (the same browser login you use in the terminal) — no API key.

mod claude;
mod git;
mod proxy;
mod pty;
mod remote;
mod secrets;
mod settings;
mod sys;
mod util;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(claude::AppState::default())
        .manage(pty::PtyState::default())
        .manage(remote::RemoteState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            settings::save_settings,
            settings::load_session,
            settings::save_session,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            claude::claude_check,
            claude::code_send,
            claude::code_stop,
            sys::open_terminal,
            pty::pty_open,
            pty::ssh_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            sys::write_text_file,
            sys::clipboard_set,
            sys::clipboard_get,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_discard,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_fetch,
            git::git_branches,
            git::git_checkout,
            git::git_log,
            remote::remote_connect,
            remote::remote_list,
            remote::local_list,
            remote::remote_download,
            remote::remote_upload,
            remote::remote_mkdir,
            remote::remote_delete,
            remote::remote_rename,
            remote::remote_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
