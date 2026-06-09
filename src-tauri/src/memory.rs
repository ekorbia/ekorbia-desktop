// SPDX-License-Identifier: MIT

#![allow(clippy::needless_pass_by_value)]
//! Memory file — a single user-edited `memory.md` whose contents are
//! injected as a system message on every chat send. Read-only from the
//! model's perspective in v1: the user edits the file in their OS default
//! editor, we never write to it programmatically.
//!
//! The file path is configurable via the `memory_file_path` setting.
//! When the setting is unset (or empty), the default is
//! `~/Documents/Ekorbia/memory.md`. The path is *not* sandboxed — this is
//! a user-chosen file on their own machine, and the user is the only
//! actor that writes to it.
//!
//! Pipeline:
//!   • `memory_info`  → UI status line (path + size + warning if huge)
//!   • `memory_read`  → JS calls before send; prepends as system message
//!   • `memory_set_path` → user picks a different file via dialog
//!   • `memory_open` → spawn the OS default editor (creates if missing)
//!
//! The 10 KB warning is a soft cap, not enforced. We send whatever the
//! user has in memory.md — but a multi-megabyte file would eat tokens on
//! every send, so the UI shows a warning to make the cost visible.

use crate::db::{get_setting, set_setting, DbState};
use crate::files::commands::spawn_opener;
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

const MEMORY_PATH_KEY: &str = "memory_file_path";
const MEMORY_SOFT_CAP: u64 = 10 * 1024; // 10 KB

/// Resolve the configured memory-file path, falling back to the default
/// inside `~/Documents/Ekorbia/`. Returns an absolute path string.
///
/// The default uses `dirs::document_dir()` (already a project dependency
/// for the prompts folder default) — same resolution rules. If we somehow
/// can't resolve a documents dir, we fall back to the user's home; if
/// even that fails, an empty string is returned and callers degrade
/// gracefully (memory_read returns None, the UI surfaces an error).
pub(crate) fn current_memory_path(app: &tauri::AppHandle) -> String {
    let state = app.state::<DbState>();
    if let Ok(db) = state.0.lock() {
        if let Some(s) = get_setting(&db, MEMORY_PATH_KEY) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    default_memory_path()
}

fn default_memory_path() -> String {
    let base: Option<PathBuf> = dirs::document_dir().or_else(dirs::home_dir);
    match base {
        Some(p) => p
            .join("Ekorbia")
            .join("memory.md")
            .to_string_lossy()
            .to_string(),
        None => String::new(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryInfo {
    /// The configured (or defaulted) absolute path. Always returned, even
    /// when the file doesn't exist — the UI uses this to show "where the
    /// file would be created" if the user clicks Edit.
    path: String,
    exists: bool,
    /// File size in bytes when it exists; 0 when it doesn't.
    bytes: u64,
    /// True when bytes exceeds the 10 KB soft cap. Surfaces the
    /// "this is going to cost tokens every send" warning in the UI.
    oversized: bool,
    /// True when the path resolves to an empty string (couldn't
    /// resolve dirs::document_dir() or home_dir()). In this state the
    /// UI shows an error and asks the user to choose a path manually.
    unresolvable: bool,
}

#[tauri::command]
pub(crate) fn memory_info(app: tauri::AppHandle) -> Result<MemoryInfo, String> {
    let path = current_memory_path(&app);
    if path.is_empty() {
        return Ok(MemoryInfo {
            path,
            exists: false,
            bytes: 0,
            oversized: false,
            unresolvable: true,
        });
    }
    let meta = std::fs::metadata(&path).ok();
    let exists = meta.as_ref().is_some_and(std::fs::Metadata::is_file);
    let bytes = meta.map_or(0, |m| m.len());
    Ok(MemoryInfo {
        path,
        exists,
        bytes,
        oversized: bytes > MEMORY_SOFT_CAP,
        unresolvable: false,
    })
}

/// Read the memory file's content. Returns:
///   • `Some(s)` when the file exists and is non-empty after trim
///   • `None` when the file is missing, empty, or unreadable
///
/// The UI calls this before each send and prepends the result as a
/// system message. None → omit the system message entirely, so we don't
/// burn tokens on an empty wrapper.
#[tauri::command]
pub(crate) fn memory_read(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = current_memory_path(&app);
    if path.is_empty() {
        return Ok(None);
    }
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            if s.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(s))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read memory file: {e}")),
    }
}

/// Update the memory-file path setting. Empty string resets to default
/// (we clear the setting rather than writing an empty value, so a later
/// schema change to the default just works).
#[tauri::command]
pub(crate) fn memory_set_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let trimmed = path.trim();
    set_setting(&db, MEMORY_PATH_KEY, trimmed)
}

/// Open the memory file in the OS default editor. Creates the file (and
/// its parent directory) if it doesn't exist yet — so the first time the
/// user clicks "Edit memory" they get an editable empty file rather than
/// an "open: file not found" error. Existing files are left untouched.
#[tauri::command]
pub(crate) fn memory_open(app: tauri::AppHandle) -> Result<(), String> {
    let path = current_memory_path(&app);
    if path.is_empty() {
        return Err("could not resolve a default memory path — pick one in Settings".to_string());
    }
    let p = std::path::Path::new(&path);
    if !p.exists() {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create memory dir: {e}"))?;
        }
        // Seed with a small template so the user has somewhere to start.
        // Markdown headers + a one-line example help the model recognise
        // this is durable memory rather than the current message.
        let template = "# About me\n\n- \n";
        std::fs::write(&path, template).map_err(|e| format!("create memory file: {e}"))?;
    }
    spawn_opener(&path, /* reveal */ false)
}

// ── Space-scoped memory (Phase 5) ──────────────────────────────────────────
//
// A Space can optionally carry its own `memory.md` whose path lives in
// `spaces.memory_path`. The UI looks it up from the cached Space row,
// hands the path to these commands, and the send pipeline appends the
// Space memory AFTER the global memory so Space context overlays on top
// without clobbering the user's global preferences.
//
// These take the path as a parameter rather than reading a setting
// because the spaces table itself is the source of truth — wrapping that
// indirection through `app_settings` would just add an unnecessary
// round-trip. The trust model matches `memory_read` / `memory_open`: the
// user chose the path via the file picker, so we read/open it as-is.

/// Read a Space's memory file at the given absolute path. Returns:
///   • `Some(s)` when the file exists and is non-empty after trim
///   • `None`    when the file is missing, empty, or the path is empty
///
/// Mirrors `memory_read`'s contract so the UI's send pipeline can use the
/// same "None → omit the system message" code path for both files.
#[tauri::command]
pub(crate) fn space_memory_read(path: String) -> Result<Option<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match std::fs::read_to_string(trimmed) {
        Ok(s) => {
            if s.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(s))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read Space memory file: {e}")),
    }
}

/// Open a Space's memory file in the OS default editor (when `reveal` is
/// false) or reveal it in the file manager (when true). When opening for
/// edit and the file doesn't exist yet, creates the parent directory and
/// seeds a small template — same UX as `memory_open` so a fresh Space
/// gets editable empty memory on first click.
///
/// Refuses an empty path with a clear error so the UI can show a toast
/// rather than silently no-oping.
#[tauri::command]
pub(crate) fn space_memory_open(path: String, reveal: bool) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Space has no memory file set — pick one first".to_string());
    }
    if !reveal {
        let p = std::path::Path::new(trimmed);
        if !p.exists() {
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("create Space memory dir: {e}"))?;
            }
            let template = "# Space memory\n\n- \n";
            std::fs::write(trimmed, template)
                .map_err(|e| format!("create Space memory file: {e}"))?;
        }
    }
    spawn_opener(trimmed, reveal)
}
