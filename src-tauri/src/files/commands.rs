// SPDX-License-Identifier: MIT

//! Tauri commands for chat-generated file management.
#![allow(clippy::needless_pass_by_value)]

//!
//! - `chat_set_output_dir(chat_id, dir)` — user-facing accept of the
//!   permission modal. Persists the chosen directory on the chat row;
//!   subsequent tool calls auto-allow within it.
//! - `chat_output_dir(chat_id)` — read-only accessor used by the Files panel
//!   and the JS-side guard before sending tool-enabled prompts.
//! - `chat_files_list(chat_id)` — every save the tool loop has recorded for
//!   this chat, newest first. Versions of the same rel_path collapse in the
//!   UI but are kept in the table.
//! - `chat_file_reveal(file_id)` — open the saved file's parent in Finder
//!   via the shell plugin, with the file selected.
//!
//! Permission lifecycle for output_dir:
//!   - `NULL`              — never picked. First tool call triggers the
//!     modal in the UI.
//!   - `""` (empty string) — "block always". Tool calls return an error
//!     tool-result so the model can recover.
//!   - `"/absolute/path"`  — auto-allow. write_file resolves paths inside it.

use crate::db::{get_chat_output_dir, now_unix, DbState};
use rusqlite::params;
use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatFile {
    id: String,
    chat_id: String,
    message_id: Option<String>,
    rel_path: String,
    bytes: i64,
    saved_at: i64,
    source: String,
    version: i64,
}

/// Persist a user-chosen output directory on the chat row. Pass an empty
/// string to mean "block always" (the user said no to the permission modal
/// and doesn't want to be asked again). Pass an absolute path otherwise;
/// relative paths are rejected here so a corrupt UI can't accidentally turn
/// a chat into a folder-relative writer.
#[tauri::command]
pub(crate) fn chat_set_output_dir(
    app: tauri::AppHandle,
    chat_id: String,
    dir: String,
) -> Result<(), String> {
    if !dir.is_empty() && !std::path::Path::new(&dir).is_absolute() {
        return Err("output_dir must be absolute (or empty to block)".into());
    }
    let state = app.state::<DbState>();
    let db = state.0.lock().map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE chats SET output_dir = ?, updated_at = ? WHERE id = ?",
        params![dir, now_unix(), chat_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn chat_output_dir(
    app: tauri::AppHandle,
    chat_id: String,
) -> Result<Option<String>, String> {
    let state = app.state::<DbState>();
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let v: Option<Option<String>> = db
        .query_row(
            "SELECT output_dir FROM chats WHERE id = ?",
            params![chat_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok();
    Ok(v.flatten())
}

#[tauri::command]
pub(crate) fn chat_files_list(
    app: tauri::AppHandle,
    chat_id: String,
) -> Result<Vec<ChatFile>, String> {
    let state = app.state::<DbState>();
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT id, chat_id, message_id, rel_path, bytes, saved_at, source, version \
             FROM chat_files WHERE chat_id = ? ORDER BY saved_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![chat_id], |r| {
            Ok(ChatFile {
                id: r.get(0)?,
                chat_id: r.get(1)?,
                message_id: r.get(2)?,
                rel_path: r.get(3)?,
                bytes: r.get(4)?,
                saved_at: r.get(5)?,
                source: r.get(6)?,
                version: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Resolve a saved file's absolute path on disk (output_dir + rel_path),
/// returning it for the JS side to hand to the shell plugin's `revealItemInDir`
/// or `open` action. We don't reveal directly from Rust because shell-plugin
/// invocation goes through the JS-side `window.__TAURI__.shell.open` for
/// permission-prompt UX consistency with the existing Sources footer.
#[tauri::command]
pub(crate) fn chat_file_path(app: tauri::AppHandle, file_id: String) -> Result<String, String> {
    let state = app.state::<DbState>();
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let (chat_id, rel_path): (String, String) = db
        .query_row(
            "SELECT chat_id, rel_path FROM chat_files WHERE id = ?",
            params![file_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("chat_file {file_id} not found: {e}"))?;
    let dir = get_chat_output_dir(&db, &chat_id)?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "chat has no output_dir set".to_string())?;
    // `dir` is the sandbox root; `rel_path` came from chat_files which is
    // populated via `write_chat_file_impl` → `sandbox::resolve_within`. So
    // the join here can't escape the sandbox without a stale DB row, and
    // chat_file_open/reveal additionally re-check `Path::exists()` before
    // spawning the opener.
    let mut p = std::path::PathBuf::from(dir);
    p.push(rel_path);
    Ok(p.to_string_lossy().to_string())
}

// ── Path open / reveal — bypasses tauri-plugin-shell scope ───────────────
//
// `shell.open(path)` from the JS side runs through tauri-plugin-shell, which
// validates the argument against the `shell:allow-open` permission's default
// regex `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+`. Bare filesystem paths
// fail that regex, so Reveal/Open from the Files panel used to silently die
// with "Scoped command argument at position 0 was found, but failed regex
// validation".
//
// Rather than wrestle the capability JSON into accepting file paths
// (which has changed shape across plugin-shell versions and is fragile),
// we spawn the platform's native opener directly. macOS: `open` / `open -R`.
// Linux: `xdg-open` (no reveal flag → fall back to opening the parent dir).
// Windows: `cmd /c start` / `explorer /select,`.
//
// Both commands sandbox their input to a confined set of chat output_dirs:
// we re-resolve the path inside the recorded output_dir for each chat
// before spawning the opener, so a stale or fabricated file_id can't
// trick us into opening `/etc/passwd`. The lookup goes through the same
// DB-backed validation as chat_file_path.

/// Open a file with the OS default application. `file_id` must reference a
/// row in chat_files; we resolve the abs path through chat_file_path's
/// semantics and confirm it exists before spawning the opener.
#[tauri::command]
pub(crate) fn chat_file_open(app: tauri::AppHandle, file_id: String) -> Result<(), String> {
    let abs = chat_file_path(app, file_id)?;
    if !std::path::Path::new(&abs).exists() {
        return Err(format!("file does not exist: {abs}"));
    }
    spawn_opener(&abs, /* reveal */ false)
}

/// Reveal a file in the OS file manager (Finder selection on macOS).
/// Same sandboxing as chat_file_open — only accepts a valid chat_files id.
#[tauri::command]
pub(crate) fn chat_file_reveal(app: tauri::AppHandle, file_id: String) -> Result<(), String> {
    let abs = chat_file_path(app, file_id)?;
    if !std::path::Path::new(&abs).exists() {
        return Err(format!("file does not exist: {abs}"));
    }
    spawn_opener(&abs, /* reveal */ true)
}

/// Reveal the chat's whole output_dir in the file manager. No file_id —
/// we go straight to the chat row. Sandboxed to chats that actually have
/// an output_dir set (NULL / empty rejected).
#[tauri::command]
pub(crate) fn chat_output_dir_reveal(
    app: tauri::AppHandle,
    chat_id: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let dir = get_chat_output_dir(&db, &chat_id)?;
    drop(db);
    let dir = dir
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "chat has no output_dir set".to_string())?;
    if !std::path::Path::new(&dir).exists() {
        return Err(format!("output_dir does not exist: {dir}"));
    }
    spawn_opener(&dir, /* reveal */ false)
}

// Exposed to other modules (memory.rs uses it to open memory.md in the
// OS default editor). Behaviour is identical on each platform; only the
// visibility changed from private to pub(crate).
#[cfg(target_os = "macos")]
pub(crate) fn spawn_opener(path: &str, reveal: bool) -> Result<(), String> {
    let mut cmd = std::process::Command::new("open");
    if reveal {
        cmd.arg("-R");
    }
    cmd.arg(path);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open spawn failed: {e}"))
}

#[cfg(target_os = "linux")]
pub(crate) fn spawn_opener(path: &str, reveal: bool) -> Result<(), String> {
    // xdg-open has no reveal semantics. Best we can do: open the parent
    // directory and trust the file manager to leave the user near the file.
    let target = if reveal {
        std::path::Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    };
    std::process::Command::new("xdg-open")
        .arg(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("xdg-open spawn failed: {e}"))
}

#[cfg(target_os = "windows")]
pub(crate) fn spawn_opener(path: &str, reveal: bool) -> Result<(), String> {
    if reveal {
        std::process::Command::new("explorer.exe")
            .args(["/select,", path])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("explorer spawn failed: {e}"))
    } else {
        // The empty quoted string is a `start` title placeholder so the
        // path isn't mis-parsed as the window title.
        std::process::Command::new("cmd")
            .args(["/c", "start", "", path])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("start spawn failed: {e}"))
    }
}
