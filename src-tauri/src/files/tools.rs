// SPDX-License-Identifier: MIT

//! Tool-call execution for the chat tool-use loop.
#![allow(clippy::needless_pass_by_value)]

//!
//! Phase 3 (May 2026): the chat tool loop lives in JS (handleSend in
//! ui/main.jsx) because the streaming /api/chat call is owned there. Rust
//! provides:
//!   - `write_file_tool_schema()` — the schema the JS side includes in the
//!     `tools:` field on /api/chat requests.
//!   - `tool_write_file` Tauri command — executes one write_file call
//!     atomically, with sandbox containment + chat_files history row.
//!   - `default_output_dir_for_chat` — computes the suggested path for
//!     the permission modal: `<app_data>/Outputs/<chat-slug>/`.
//!
//! ## Permission lifecycle handled inside `tool_write_file`
//!
//!   - `output_dir IS NULL` → emit `chat:needs_output_dir` event, return
//!     `Err("permission_required")`. JS catches the error, awaits the user
//!     choice via the OutputDirModal, and retries the call.
//!   - `output_dir = ""`    → return `Err("user_blocked")`. JS feeds this
//!     as a tool-result error back to the model.
//!   - `output_dir = "/…"`  → resolve via sandbox, atomic-write, log to
//!     chat_files.
//!
//! ## Why atomic writes
//!
//! `<target>.ekorbia-tmp` + `rename` keeps the on-disk file consistent if
//! the app crashes mid-write — the user's previous version stays intact
//! until the new one is fully flushed. The .ekorbia-tmp suffix is
//! deliberately uncommon so it won't collide with editor swap files.

use crate::db::{now_unix, DbState};
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{Emitter, Manager};

const TOOL_CONTENTS_MAX_BYTES: usize = 5 * 1024 * 1024; // 5 MB per write

/// The JSON schema we send to Ollama for the write_file tool. Lives in this
/// module so the JS tool loop and any future capability surface can read a
/// single source of truth (re-export via `chat_tool_schemas` below).
pub(crate) fn write_file_tool_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Save a file to the user's project directory for this chat. \
    Use this whenever you want to deliver a file the user can open or run \
    (HTML, CSS, JS, Python, scripts, configs, etc.). Prefer this over fenced \
    code blocks for any file the user will keep. Sub-directories are allowed; \
    they will be created if needed. Always send the full file contents — \
    partial edits are not supported.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path within the chat's output directory. No leading slash, no '..'. Examples: 'index.html', 'src/main.py', 'styles/site.css'."
                    },
                    "contents": {
                        "type": "string",
                        "description": "Full file contents. Send the entire file every time — partial edits are not supported."
                    }
                },
                "required": ["path", "contents"]
            }
        }
    })
}

/// Returned to JS so the request body can include `tools: [...]` without
/// duplicating the schema on the JS side. Returns an array (one element
/// today; future tools — read_file, delete_file — slot in here).
#[tauri::command]
pub(crate) fn chat_tool_schemas() -> Vec<Value> {
    vec![write_file_tool_schema()]
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolWriteFileResult {
    ok: bool,
    /// The chat_files row id for this save. Threaded back to JS so freshly-
    /// saved chips can call chat_file_reveal / chat_file_open the same way
    /// reloaded chips do (both routes go through the chat_files-id-validated
    /// native opener — no JS-side absolute paths).
    id: String,
    rel_path: String,
    bytes: usize,
    version: i64,
    /// Absolute path on disk — kept for backward compat / debug display.
    /// The UI MUST NOT pass this to any opener (shell plugin scope rejects
    /// bare paths; native opener takes a file_id instead).
    abs_path: String,
}

// Slugify lives in `db::slugify` — chat-output-dir uses a 60-char cap so the
// suggested directory name stays short even for long chat titles.

#[tauri::command]
pub(crate) fn default_output_dir_for_chat(
    app: tauri::AppHandle,
    chat_id: String,
    chat_title: String,
) -> Result<String, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?
        .join("Outputs");
    let slug = crate::db::slugify(&chat_title, Some(60));
    let leaf = if slug.is_empty() {
        format!("chat-{chat_id}")
    } else {
        slug
    };
    Ok(base.join(leaf).to_string_lossy().to_string())
}

fn gen_chat_file_id() -> String {
    crate::db::gen_id("cf")
}

/// Shared implementation behind both `tool_write_file` (model-driven, via
/// the tool-use loop) and `chat_save_manual_file` (user-driven, via the
/// heuristic fenced-block Save buttons). `source` is recorded on the
/// chat_files row so the UI / future cleanup logic can tell them apart.
///
/// Side effects, in order:
///   1. Validates contents size (≤ 5 MB).
///   2. Reads chat.output_dir; emits `chat:needs_output_dir` + returns
///      `permission_required` if NULL; refuses if "".
///   3. Resolves the requested path via files::sandbox::resolve_within.
///   4. Atomic write: tempfile + rename.
///   5. Inserts a chat_files row with a fresh version number.
fn write_chat_file_impl(
    app: &tauri::AppHandle,
    chat_id: &str,
    message_id: Option<&str>,
    path: &str,
    contents: &str,
    source: &str,
) -> Result<ToolWriteFileResult, String> {
    if contents.len() > TOOL_CONTENTS_MAX_BYTES {
        return Err(format!(
            "contents too large: {} bytes (max {})",
            contents.len(),
            TOOL_CONTENTS_MAX_BYTES
        ));
    }
    // Whitelist source values to keep the chat_files CHECK constraint happy
    // — bad input here would error at INSERT time anyway, but failing fast
    // here gives a clearer message.
    if source != "tool" && source != "manual" {
        return Err(format!("invalid source: {source}"));
    }

    // Resolve output_dir + chat title for the permission flow. Locks scoped
    // tightly — never held across the .await below.
    let (output_dir, chat_title): (Option<String>, String) = {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        db.query_row(
            "SELECT output_dir, title FROM chats WHERE id = ?",
            params![chat_id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(|e| format!("chat {chat_id} not found: {e}"))?
    };

    let output_dir = match output_dir {
        None => {
            // Never asked. Emit the needs-permission event so the UI shows
            // the modal, and return a typed error the JS retry loop can
            // catch. The event payload carries the suggested default path
            // so the modal pre-populates sensibly.
            let suggested =
                default_output_dir_for_chat(app.clone(), chat_id.to_string(), chat_title.clone())
                    .unwrap_or_default();
            let _ = app.emit(
                "chat:needs_output_dir",
                json!({
                    "chatId": chat_id,
                    "chatTitle": chat_title,
                    "suggested": suggested,
                }),
            );
            return Err("permission_required".into());
        }
        Some(s) if s.is_empty() => return Err("user_blocked".into()),
        Some(s) => PathBuf::from(s),
    };

    // Sandbox + atomic write happen synchronously (no .await). Safe to do
    // off the executor's hot path — these are fast filesystem ops.
    let target = crate::files::sandbox::resolve_within(&output_dir, path)?;
    let tmp_name = format!(
        "{}.ekorbia-tmp",
        target.file_name().and_then(|s| s.to_str()).unwrap_or("out")
    );
    let tmp = target.with_file_name(tmp_name);
    std::fs::write(&tmp, contents).map_err(|e| format!("write failed: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("rename failed: {e}"))?;
    let bytes = contents.len();

    // Log to chat_files with an incremented version. We compute version
    // and insert in one lock scope so concurrent writes to the same
    // rel_path (extremely unlikely — the loop is serial) can't both pick
    // the same version.
    let id = gen_chat_file_id();
    let version: i64 = {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        let prev: i64 = db
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM chat_files WHERE chat_id = ? AND rel_path = ?",
                params![chat_id, path],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let next = prev + 1;
        db.execute(
            "INSERT INTO chat_files (id, chat_id, message_id, rel_path, bytes, saved_at, source, version) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![id, chat_id, message_id, path, bytes as i64, now_unix(), source, next],
        )
        .map_err(|e| e.to_string())?;
        next
    };

    // Notify the UI that this chat's file list has changed. The FilesPanel
    // in ui/files.jsx listens for this and reloads chat_files_list. We emit
    // the relPath + version so listeners can be more granular (e.g. flash
    // the row that just updated) without re-querying everything.
    let _ = app.emit(
        "chat:files_changed",
        json!({
            "chatId": chat_id,
            "relPath": path,
            "version": version,
            "source": source,
        }),
    );

    Ok(ToolWriteFileResult {
        ok: true,
        id,
        rel_path: path.to_string(),
        bytes,
        version,
        abs_path: target.to_string_lossy().to_string(),
    })
}

/// Model-driven write — invoked by the JS chat tool loop, one per
/// `tool_call` returned by Ollama. `source = "tool"` on the resulting
/// chat_files row.
///
/// **Async safety**: delegates to sync `write_chat_file_impl`, which scopes
/// every `DbState` lock in a block ending with `};` before any subsequent
/// work. There are no `.await` points inside this command. Declared `async`
/// so Tauri runs it on the runtime threadpool rather than blocking the main
/// thread on the file I/O. See CLAUDE.md "DB lock held across await deadlocks".
#[tauri::command]
pub(crate) async fn tool_write_file(
    app: tauri::AppHandle,
    chat_id: String,
    message_id: Option<String>,
    path: String,
    contents: String,
) -> Result<ToolWriteFileResult, String> {
    write_chat_file_impl(
        &app,
        &chat_id,
        message_id.as_deref(),
        &path,
        &contents,
        "tool",
    )
}

/// User-driven write — invoked when the user clicks "Save" on a fenced
/// code block the model emitted as plain markdown (heuristic-fallback
/// path for models that don't actually use the write_file tool). Same
/// permission flow, sandbox, and history log as the tool path; differs
/// only in the `source = "manual"` tag on chat_files.
///
/// **Async safety**: same as `tool_write_file` — delegates to sync
/// `write_chat_file_impl`.
#[tauri::command]
pub(crate) async fn chat_save_manual_file(
    app: tauri::AppHandle,
    chat_id: String,
    message_id: Option<String>,
    path: String,
    contents: String,
) -> Result<ToolWriteFileResult, String> {
    write_chat_file_impl(
        &app,
        &chat_id,
        message_id.as_deref(),
        &path,
        &contents,
        "manual",
    )
}
