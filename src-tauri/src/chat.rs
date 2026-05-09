// SPDX-License-Identifier: MIT

//! Chat / message persistence commands.
#![allow(clippy::needless_pass_by_value)]

//!
//! IMPORTANT: `db_upsert_chat` and `db_upsert_message` deliberately use
//! `INSERT … ON CONFLICT DO UPDATE` rather than `INSERT OR REPLACE`. Both
//! rows are FK parents (`messages.chat_id` references `chats.id` ON DELETE
//! CASCADE), and REPLACE would cascade-delete all messages before re-
//! inserting the chat row — wiping history on every send. See CLAUDE.md.

use crate::db::DbState;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRow {
    id: String,
    title: String,
    model: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageRow {
    id: String,
    chat_id: String,
    role: String,
    content: String,
    model: Option<String>,
    time: Option<String>,
    tokens_in: Option<i64>,
    tokens_out: Option<i64>,
    tokens_ms: Option<i64>,
    prompts_json: Option<String>,
    /// JSON-encoded array of citation sources for assistant messages, as
    /// returned by attachment_prepare_for_send. None on user messages and on
    /// pre-attachment historical rows.
    #[serde(default)]
    sources_json: Option<String>,
    /// JSON array of tool_calls emitted by an assistant turn (one entry per
    /// call). Populated when the model uses the write_file (or future) tool.
    /// NULL on regular turns + on role='user'/'tool' rows.
    #[serde(default)]
    tool_calls_json: Option<String>,
    /// For role='tool' rows, the id of the tool_call this is the response to.
    /// Matches the model-supplied id from the corresponding assistant
    /// tool_calls entry. NULL on every other role.
    #[serde(default)]
    tool_call_id: Option<String>,
    seq: i64,
}

#[tauri::command]
pub(crate) fn db_load_chats(state: tauri::State<'_, DbState>) -> Result<Vec<ChatRow>, String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db.prepare(
        "SELECT id, title, model, created_at, updated_at FROM chats ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(ChatRow {
            id: row.get(0)?,
            title: row.get(1)?,
            model: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    }).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn db_load_messages(state: tauri::State<'_, DbState>, chat_id: String) -> Result<Vec<MessageRow>, String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db.prepare(
        "SELECT id, chat_id, role, content, model, time, tokens_in, tokens_out, tokens_ms, prompts_json, sources_json, tool_calls_json, tool_call_id, seq \
         FROM messages WHERE chat_id = ?1 ORDER BY seq ASC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&chat_id], |row| {
        Ok(MessageRow {
            id: row.get(0)?,
            chat_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            model: row.get(4)?,
            time: row.get(5)?,
            tokens_in: row.get(6)?,
            tokens_out: row.get(7)?,
            tokens_ms: row.get(8)?,
            prompts_json: row.get(9)?,
            sources_json: row.get(10)?,
            tool_calls_json: row.get(11)?,
            tool_call_id: row.get(12)?,
            seq: row.get(13)?,
        })
    }).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn db_upsert_chat(state: tauri::State<'_, DbState>, chat: ChatRow) -> Result<(), String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    // CRITICAL: must NOT use INSERT OR REPLACE here. The messages table
    // foreign-keys to chats(id) with ON DELETE CASCADE and `PRAGMA
    // foreign_keys = ON` is set, so REPLACE (= DELETE + INSERT) would
    // cascade-delete every message belonging to this chat before re-
    // inserting the row. Each call to handleSend bumps updated_at on the
    // existing chat — so any chat with more than one exchange would lose
    // every message except the most recent one.
    //
    // Using INSERT … ON CONFLICT DO UPDATE keeps the row in place; the
    // foreign-key constraint is not violated and no cascade fires.
    // created_at is intentionally not in the SET list so the original
    // creation timestamp survives subsequent updates.
    db.execute(
        "INSERT INTO chats (id, title, model, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(id) DO UPDATE SET \
            title = excluded.title, \
            model = excluded.model, \
            updated_at = excluded.updated_at",
        (&chat.id, &chat.title, &chat.model, chat.created_at, chat.updated_at),
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn db_upsert_message(state: tauri::State<'_, DbState>, msg: MessageRow) -> Result<(), String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    // Use ON CONFLICT DO UPDATE to keep the row's identity stable. Messages
    // are themselves the parent of the FTS triggers (AFTER UPDATE OF content
    // refreshes the snippet), so an OR REPLACE here would cascade-delete the
    // FTS row + re-insert — not strictly broken, but the ON CONFLICT path is
    // cheaper and matches the chats-table convention.
    db.execute(
        "INSERT INTO messages \
         (id, chat_id, role, content, model, time, tokens_in, tokens_out, tokens_ms, prompts_json, sources_json, tool_calls_json, tool_call_id, seq) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) \
         ON CONFLICT(id) DO UPDATE SET \
            chat_id = excluded.chat_id, \
            role = excluded.role, \
            content = excluded.content, \
            model = excluded.model, \
            time = excluded.time, \
            tokens_in = excluded.tokens_in, \
            tokens_out = excluded.tokens_out, \
            tokens_ms = excluded.tokens_ms, \
            prompts_json = excluded.prompts_json, \
            sources_json = excluded.sources_json, \
            tool_calls_json = excluded.tool_calls_json, \
            tool_call_id = excluded.tool_call_id, \
            seq = excluded.seq",
        (
            &msg.id, &msg.chat_id, &msg.role, &msg.content,
            &msg.model, &msg.time,
            msg.tokens_in, msg.tokens_out, msg.tokens_ms,
            &msg.prompts_json, &msg.sources_json,
            &msg.tool_calls_json, &msg.tool_call_id,
            msg.seq,
        ),
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn db_delete_chat(state: tauri::State<'_, DbState>, id: String) -> Result<(), String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM chats WHERE id = ?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Wipe every chat row. FK ON DELETE CASCADE from chats fans out to
/// `messages`, `attachments`, `attachment_files`, `attachment_chunks`,
/// and `chat_files` (see SCHEMA in db.rs). The `messages_fts_ad` trigger
/// removes corresponding FTS rows. Returns the number of chat rows that
/// were deleted so the UI can confirm in a toast / log line.
///
/// Files saved to disk via the write_file tool are NOT touched — only
/// their `chat_files` index rows go away. This matches the per-chat
/// delete semantic and keeps a single rule: "Clear chats" never deletes
/// user data on disk; only DB rows.
///
/// Single statement under one lock acquisition; no `.await` involved
/// (sync rusqlite). Safe to hold the DbState lock for the full call.
#[tauri::command]
pub(crate) fn db_clear_all_chats(state: tauri::State<'_, DbState>) -> Result<usize, String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let n = db
        .execute("DELETE FROM chats", [])
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// Truncate a chat: delete the message identified by `from_message_id` and
/// every message after it (by `seq` order). Used by:
///   • Edit-and-resubmit: pencil-edit a past user message, save → truncate
///     from that message inclusive, then handleSend re-adds it + a fresh
///     assistant reply.
///   • Retry: refresh on an assistant message → truncate from the previous
///     user message inclusive, then handleSend re-runs that user turn.
///
/// Both flows treat the from-message as the resend point, so it's always
/// deleted and re-created by the subsequent send. No special "preserve
/// metadata" handling here — the caller decides what to re-insert.
///
/// FK behaviour that matters:
///   • `messages_fts` rows auto-clean via the AD trigger (db.rs).
///   • `chat_files.message_id` is ON DELETE SET NULL, so any files saved
///     by a deleted assistant turn keep their row in chat_files (the file
///     itself stays on disk too). Surfacing this via FilesPanel after a
///     truncate is the right call — the user may want to keep them.
#[tauri::command]
pub(crate) fn db_truncate_chat_from(
    state: tauri::State<'_, DbState>,
    chat_id: String,
    from_message_id: String,
) -> Result<(), String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    // Look up the seq of the anchor message. Scoping by chat_id as well as
    // by message id is defensive: message ids are UUIDs and globally unique
    // in practice, but the WHERE chat_id filter on the DELETE below requires
    // the seq to be from the right chat anyway.
    let seq: i64 = db
        .query_row(
            "SELECT seq FROM messages WHERE id = ?1 AND chat_id = ?2",
            (&from_message_id, &chat_id),
            |row| row.get(0),
        )
        .map_err(|e| format!("message not found in chat: {e}"))?;
    db.execute(
        "DELETE FROM messages WHERE chat_id = ?1 AND seq >= ?2",
        (&chat_id, seq),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Serialise an entire chat (the row + every message) to a user-chosen
/// path. `format` is "markdown" or "json"; anything else is rejected so a
/// typo in the UI dispatch doesn't silently write the wrong serialisation.
///
/// The path comes from the OS save-dialog (tauri-plugin-dialog), so the
/// user has already consented to the destination — no sandbox check here
/// the way `tool_write_file` enforces, because tool writes come from the
/// model (untrusted) and export comes from the user (trusted, explicit).
///
/// Markdown export is human-readable and lossy: it drops tool-role rows
/// (they're model context, not human content), tool_calls metadata, and
/// per-message token counts. JSON export is roundtrip-faithful — every
/// column on every row is preserved so a future "import chat" path could
/// reconstruct the conversation byte-for-byte.
#[tauri::command]
pub(crate) fn chat_export_to_path(
    state: tauri::State<'_, DbState>,
    chat_id: String,
    format: String,
    path: String,
) -> Result<(), String> {
    let format = format.to_lowercase();
    if format != "markdown" && format != "json" {
        return Err(format!("unknown export format: {format}"));
    }

    let db = state.0.lock().map_err(|e| e.to_string())?;

    // Load the chat row first so we can include its metadata in both
    // formats. A missing row (deleted between menu-open and click) is a
    // user-visible error, not a panic.
    let chat = db
        .query_row(
            "SELECT id, title, model, created_at, updated_at FROM chats WHERE id = ?1",
            [&chat_id],
            |row| {
                Ok(ChatRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    model: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .map_err(|e| format!("chat not found: {e}"))?;

    // Pull every message column for JSON parity; markdown ignores most of
    // these but loading once + branching is cheaper than two prepared
    // statements + cleaner to maintain.
    let mut stmt = db
        .prepare(
            "SELECT id, chat_id, role, content, model, time, tokens_in, tokens_out, tokens_ms, \
                    prompts_json, sources_json, tool_calls_json, tool_call_id, seq \
             FROM messages WHERE chat_id = ?1 ORDER BY seq ASC",
        )
        .map_err(|e| e.to_string())?;
    let messages: Vec<MessageRow> = stmt
        .query_map([&chat_id], |row| {
            Ok(MessageRow {
                id: row.get(0)?,
                chat_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                model: row.get(4)?,
                time: row.get(5)?,
                tokens_in: row.get(6)?,
                tokens_out: row.get(7)?,
                tokens_ms: row.get(8)?,
                prompts_json: row.get(9)?,
                sources_json: row.get(10)?,
                tool_calls_json: row.get(11)?,
                tool_call_id: row.get(12)?,
                seq: row.get(13)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // Drop the DB lock before doing filesystem I/O. Filesystem writes can
    // block on slow disks / remote volumes and we don't want to hold the
    // executor's only SQLite connection while that happens.
    drop(stmt);
    drop(db);

    let body = match format.as_str() {
        "markdown" => render_markdown(&chat, &messages),
        "json" => render_json(&chat, &messages)?,
        _ => unreachable!("format validated above"),
    };

    std::fs::write(&path, body).map_err(|e| format!("write {path}: {e}"))?;
    Ok(())
}

/// Markdown export — human-readable, intended for sharing or pasting into
/// a notes app. Tool-role rows are omitted (they're orchestration noise to
/// a reader); assistant `tool_calls` show up as a small italic line so the
/// reader can see "the model used tool X" without the raw JSON payload.
fn render_markdown(chat: &ChatRow, messages: &[MessageRow]) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let _ = writeln!(out, "# {}\n", chat.title);
    let _ = writeln!(out, "> Model: `{}` • Exported from Ekorbia\n", chat.model);
    out.push_str("---\n\n");

    for msg in messages {
        match msg.role.as_str() {
            "user" => out.push_str("## You\n\n"),
            "assistant" => out.push_str("## Assistant\n\n"),
            "system" => out.push_str("## System\n\n"),
            // Tool-role rows: skip entirely. They carry tool outputs the
            // model consumed but the human reader doesn't need to see.
            "tool" => continue,
            other => {
                let _ = writeln!(out, "## {other}\n");
            }
        }
        // Preserve the message content verbatim. If the model emitted
        // fenced code blocks, they round-trip; if not, plain prose does
        // too. We add a blank line after so consecutive messages render
        // with breathing room rather than smashed together.
        out.push_str(msg.content.trim_end());
        out.push_str("\n\n");

        // Surface tool calls as a compact note so a reader can tell the
        // assistant invoked something — without dumping the raw JSON.
        if let Some(tc) = &msg.tool_calls_json {
            if !tc.is_empty() && tc != "null" {
                out.push_str("*(used tools)*\n\n");
            }
        }
    }
    out
}

/// JSON export — roundtrip-faithful. The shape is `{ chat: {...}, messages: [...] }`
/// where each row mirrors the database column set. We hand-build the JSON
/// rather than deriving Serialize on a wrapper struct so the field order
/// is deterministic + easy to scan when the file is opened in an editor.
fn render_json(chat: &ChatRow, messages: &[MessageRow]) -> Result<String, String> {
    // Wrapper for serialization — the underlying ChatRow / MessageRow are
    // already serde::Serialize, so this is a straight pass-through.
    #[derive(serde::Serialize)]
    struct Export<'a> {
        chat: &'a ChatRow,
        messages: &'a [MessageRow],
    }
    let payload = Export { chat, messages };
    serde_json::to_string_pretty(&payload).map_err(|e| format!("serialize JSON: {e}"))
}
