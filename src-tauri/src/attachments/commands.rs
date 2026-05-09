// SPDX-License-Identifier: MIT

//! Tauri commands for the chat-attachments feature surface.
//!
//! `attachment_list`, `attachment_add_files`, `attachment_remove`,
//! `attachment_prepare_for_send`, plus the stale-embedding admin commands
//! `embedding_stale_count` and `attachment_reindex_stale`.
//!
//! `attachment_reindex` lives in `super::pipeline` (it's the entry point
//! that re-runs the indexing pipeline) and `attachment_add_folder` lives in
//! `super::folder` (it shares the walker setup).

// Tauri's IPC bridge deserialises command args into owned types (String,
// Vec<T>, …). Clippy can't tell those apart from "you forgot to take &str"
// — so we allow the lint file-wide for command-only modules. Helpers that
// could take borrowed args still warn (just move them out of this file or
// add a per-fn allow).
#![allow(clippy::needless_pass_by_value)]

use crate::attachments::cancel::{cancel_index, register_cancel};
use crate::attachments::config::{current_embedding_model, current_top_k};
use crate::attachments::folder::index_folder;
use crate::attachments::pipeline::{
    index_attachment, retrieve_chunks, set_attachment_status,
};
use crate::attachments::types::{
    classify_attachment, map_attachment_row, AttachmentPayload, AttachmentRow, PreparedAttachment,
    PreparedHit, RetrievedChunk, ATTACHMENT_COLUMNS, ATTACHMENT_MAX_BYTES, SMALL_TEXT_THRESHOLD,
};
use crate::db::{ensure_chat_row, nanos_since_epoch, now_unix, DbState};
use crate::log::log_warn;
use crate::ollama::model_has_vision;
use crate::text_extract::extract_text_from_file;
use serde::Serialize;
use std::path::Path;
use tauri::Manager;

#[tauri::command]
pub(crate) fn attachment_list(
    state: tauri::State<'_, DbState>,
    chat_id: String,
) -> Result<Vec<AttachmentRow>, String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE chat_id = ?1 ORDER BY added_at ASC"
    );
    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&chat_id], map_attachment_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn attachment_add_files(
    app: tauri::AppHandle,
    chat_id: String,
    paths: Vec<String>,
) -> Result<Vec<AttachmentRow>, String> {
    let now = now_unix();
    // Batch mint: one nanos seed + per-file index suffix (`att_{ns_base:x}_{i}`)
    // disambiguates concurrent inserts that share a single SystemTime tick.
    // See `db::gen_id` doc — single-shot callers should use `gen_id` instead.
    let ns_base = nanos_since_epoch();
    let mut added: Vec<AttachmentRow> = Vec::new();
    {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        // FK insurance for attachments.chat_id while the chat is still
        // pre-send. See `ensure_chat_row` doc for why this is INSERT OR IGNORE.
        ensure_chat_row(&db, &chat_id, now)?;
        for (i, raw) in paths.into_iter().enumerate() {
            let p = Path::new(&raw);
            let Some(kind) = classify_attachment(p) else {
                return Err(format!("Unsupported file type: {raw}"));
            };
            let meta = std::fs::metadata(p)
                .map_err(|e| format!("Cannot read {raw}: {e}"))?;
            let bytes = meta.len();
            if bytes > ATTACHMENT_MAX_BYTES {
                return Err(format!(
                    "File too large ({} MB cap): {}",
                    ATTACHMENT_MAX_BYTES / 1024 / 1024,
                    raw
                ));
            }
            let label = p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&raw)
                .to_string();
            let id = format!("att_{ns_base:x}_{i}");
            // Decide initial status from raw bytes — large text files head
            // straight to 'indexing' (the spawned task picks them up below);
            // small text + all images skip the pipeline entirely.
            let initial_status = if kind == "text" && (bytes as usize) > SMALL_TEXT_THRESHOLD {
                "indexing"
            } else {
                "ready"
            };
            db.execute(
                "INSERT INTO attachments (id, chat_id, kind, path, label, bytes, added_at, status) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                (
                    &id,
                    &chat_id,
                    kind,
                    &raw,
                    &label,
                    bytes as i64,
                    now,
                    initial_status,
                ),
            )
            .map_err(|e| e.to_string())?;
            added.push(AttachmentRow {
                id,
                chat_id: chat_id.clone(),
                kind: kind.to_string(),
                path: raw,
                label,
                bytes: bytes as i64,
                added_at: now,
                status: initial_status.to_string(),
                error: None,
                file_count: 0,
            });
        }
    } // lock dropped here

    // Spawn indexing tasks AFTER the lock is released.
    for att in &added {
        if att.status == "indexing" {
            let app_clone = app.clone();
            let att_id = att.id.clone();
            let token = register_cancel(&att_id);
            let cancel = token.flag.clone();
            tauri::async_runtime::spawn(async move {
                // Move the token into the spawned task so its Drop runs
                // when the task ends — normal, early return, or panic.
                // Without this, a `pdf-extract` panic would leak the
                // registry entry forever.
                let _token = token;
                if let Err(e) = index_attachment(app_clone, att_id, cancel).await {
                    log_warn!("attachment index failed: {e}");
                }
            });
        }
    }

    Ok(added)
}

#[tauri::command]
pub(crate) fn attachment_remove(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    // Flip the cancel flag BEFORE the DELETE so any in-flight indexing
    // task sees the cancellation as it walks the file list — the DELETE
    // cascades chunks/sources, and the task's next write would otherwise
    // hit a row that no longer exists.
    cancel_index(&id);
    let db = state.0.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM attachments WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Open or reveal an attachment's own path in the OS file manager.
/// `attachment_id` is validated against the `attachments` table — only paths
/// the user has actually attached can be opened. Replaces a previous
/// `shellApi.open(path)` from the JS side, which the tauri-plugin-shell
/// default scope regex silently rejected (it only allows mailto/tel/http
/// URLs, not bare filesystem paths). See files/commands.rs for the same
/// pattern on chat_files.
///
/// `reveal=true` opens the parent in Finder with the file selected (macOS
/// `open -R`); `reveal=false` hands the file to the OS default app.
#[tauri::command]
pub(crate) fn attachment_reveal(
    state: tauri::State<'_, DbState>,
    attachment_id: String,
    reveal: bool,
) -> Result<(), String> {
    let path: String = {
        let db = state.0.lock().map_err(|e| e.to_string())?;
        db.query_row(
            "SELECT path FROM attachments WHERE id = ?1",
            [&attachment_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("attachment {attachment_id} not found: {e}"))?
    };
    if !std::path::Path::new(&path).exists() {
        return Err(format!("attachment path does not exist: {path}"));
    }
    crate::files::commands::spawn_opener(&path, reveal)
}

/// Open a sub-file inside a folder-kind attachment. `sub_path` is the path
/// relative to the attachment's root, as surfaced by retrieve_chunks' hits
/// (UI strips the leading folder path before sending). The sandbox helper
/// re-validates: rejects absolute paths, `..` traversal, NUL bytes, and
/// symlink-via-parent escapes, then confirms the canonical result lives
/// inside the canonical attachment root.
///
/// Only folder-kind attachments are accepted. A single-file attachment with
/// `sub_path = ""` would resolve to the directory containing the file —
/// confusing for the user and not what the SourcesFooter Expand→Open flow
/// is asking for. Use `attachment_reveal` for the file-itself path.
#[tauri::command]
pub(crate) fn attachment_hit_open(
    state: tauri::State<'_, DbState>,
    attachment_id: String,
    sub_path: String,
    reveal: bool,
) -> Result<(), String> {
    let (kind, root): (String, String) = {
        let db = state.0.lock().map_err(|e| e.to_string())?;
        db.query_row(
            "SELECT kind, path FROM attachments WHERE id = ?1",
            [&attachment_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("attachment {attachment_id} not found: {e}"))?
    };
    if kind != "folder" {
        return Err(format!(
            "attachment_hit_open only valid for folder attachments (got '{kind}')"
        ));
    }
    let abs = crate::files::sandbox::resolve_within(
        std::path::Path::new(&root),
        &sub_path,
    )?;
    if !abs.exists() {
        return Err(format!("sub-path does not exist: {}", abs.display()));
    }
    crate::files::commands::spawn_opener(&abs.to_string_lossy(), reveal)
}

/// Read a single attachment's text content, dispatching on extension.
/// Reuses `extract_text_from_file` so PDF extraction stays in one place.
async fn read_text_attachment(path: &Path) -> Result<String, String> {
    extract_text_from_file(path).await
}

/// Prepare the attachment payload for the next Ollama send.
/// `query` is the user's current message — used to embed-and-retrieve
/// top-k chunks from large indexed attachments. An empty query just skips
/// the retrieval step (small files are still inlined).
///
/// **Async safety**: the `DbState` lock is held only in the row-fetch block
/// at the top (ending with `};`) — released before any FS read, embed call,
/// or vision-capability probe. See CLAUDE.md "DB lock held across await
/// deadlocks".
#[tauri::command]
pub(crate) async fn attachment_prepare_for_send(
    app: tauri::AppHandle,
    chat_id: String,
    model: String,
    query: String,
) -> Result<AttachmentPayload, String> {
    // Pull attachment rows under the lock, then drop the lock before doing
    // any filesystem or network I/O.
    let rows: Vec<AttachmentRow> = {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        let sql = format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE chat_id = ?1 \
             ORDER BY added_at ASC"
        );
        let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([&chat_id], map_attachment_row)
            .map_err(|e| e.to_string())?;
        it.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };

    if rows.is_empty() {
        return Ok(AttachmentPayload {
            system_block: String::new(),
            images: Vec::new(),
            sources: Vec::new(),
            images_skipped: false,
        });
    }

    let vision_capable = model_has_vision(&model).await.unwrap_or(false);

    let mut sources: Vec<PreparedAttachment> = Vec::new();
    let mut text_blocks: Vec<String> = Vec::new();
    let mut images_b64: Vec<String> = Vec::new();
    let mut images_skipped = false;

    let mut retrieval_attachments: Vec<(usize, &AttachmentRow)> = Vec::new();
    for (i, att) in rows.iter().enumerate() {
        let citation_index = (i as i32) + 1;
        sources.push(PreparedAttachment {
            id: att.id.clone(),
            label: att.label.clone(),
            path: att.path.clone(),
            kind: att.kind.clone(),
            citation_index,
            hits: Vec::new(),
        });
        let path = Path::new(&att.path);
        match att.kind.as_str() {
            "text" => {
                let is_large = (att.bytes as usize) > SMALL_TEXT_THRESHOLD
                    && att.status == "ready";
                if is_large {
                    retrieval_attachments.push((i, att));
                } else if att.status == "indexing" {
                    text_blocks.push(format!(
                        "[{citation_index}] {label}\n<indexing in progress — content will be available on the next send>",
                        label = att.path,
                    ));
                } else if att.status == "error" {
                    let detail = att.error.clone().unwrap_or_else(|| "unknown".to_string());
                    text_blocks.push(format!(
                        "[{citation_index}] {label}\n<indexing failed: {detail}>",
                        label = att.path,
                    ));
                } else {
                    // Small file: inline whole.
                    match read_text_attachment(path).await {
                        Ok(body) => text_blocks.push(format!(
                            "[{citation_index}] {label}\n{body}",
                            label = att.path,
                            body = body.trim()
                        )),
                        Err(e) => text_blocks.push(format!(
                            "[{citation_index}] {label}\n<error reading file: {e}>",
                            label = att.path,
                        )),
                    }
                }
            }
            "folder" => {
                if att.status == "ready" {
                    retrieval_attachments.push((i, att));
                } else if att.status == "indexing" {
                    text_blocks.push(format!(
                        "[{citation_index}] {label} (folder)\n<indexing in progress — try again once it finishes>",
                        label = att.path,
                    ));
                } else if att.status == "error" {
                    let detail = att.error.clone().unwrap_or_else(|| "unknown".to_string());
                    text_blocks.push(format!(
                        "[{citation_index}] {label} (folder)\n<indexing failed: {detail}>",
                        label = att.path,
                    ));
                }
            }
            "image" => {
                if vision_capable {
                    match std::fs::read(path) {
                        Ok(bytes) => {
                            use base64::Engine;
                            let b64 = base64::engine::general_purpose::STANDARD
                                .encode(&bytes);
                            images_b64.push(b64);
                        }
                        Err(_) => images_skipped = true,
                    }
                } else {
                    images_skipped = true;
                }
            }
            _ => {}
        }
    }

    if !retrieval_attachments.is_empty() && !query.trim().is_empty() {
        let hits = retrieve_chunks(&app, &chat_id, &query, current_top_k(&app)).await
            .unwrap_or_else(|e| {
                log_warn!("retrieve_chunks failed: {e}");
                Vec::new()
            });
        use std::collections::HashMap;
        let mut by_att: HashMap<String, Vec<RetrievedChunk>> = HashMap::new();
        for h in hits {
            by_att.entry(h.attachment_id.clone()).or_default().push(h);
        }
        for (i, att) in &retrieval_attachments {
            let citation_index = (*i as i32) + 1;
            let chunks_for = by_att.remove(&att.id).unwrap_or_default();
            let kind_suffix = if att.kind == "folder" { " (folder)" } else { "" };
            if chunks_for.is_empty() {
                text_blocks.push(format!(
                    "[{citation_index}] {label}{kind_suffix}\n<no chunks matched the query>",
                    label = att.path,
                ));
                continue;
            }
            if let Some(src) = sources.iter_mut().find(|s| s.id == att.id) {
                for c in &chunks_for {
                    src.hits.push(PreparedHit {
                        path: c.source_path.clone().unwrap_or_else(|| att.path.clone()),
                        score: c.score,
                        char_start: c.char_start,
                        char_end: c.char_end,
                    });
                }
            }
            use std::fmt::Write as _;
            let mut body = String::new();
            for (j, c) in chunks_for.iter().enumerate() {
                if j > 0 {
                    body.push_str("\n\n---\n\n");
                }
                let where_from = c
                    .source_path
                    .as_deref()
                    .map(|p| format!("from {p}, "))
                    .unwrap_or_default();
                let _ = write!(
                    body,
                    "({where_from}chars {}-{}, relevance {:.2})\n{}",
                    c.char_start,
                    c.char_end,
                    c.score,
                    c.text.trim()
                );
            }
            text_blocks.push(format!(
                "[{citation_index}] {label}{kind_suffix}\n{body}",
                label = att.path,
            ));
        }
    } else if !retrieval_attachments.is_empty() {
        // Query is empty — emit a marker so the model can still cite the
        // file/folder by index if it has prior context about it.
        for (i, att) in &retrieval_attachments {
            let citation_index = (*i as i32) + 1;
            let kind_suffix = if att.kind == "folder" { " (folder)" } else { "" };
            text_blocks.push(format!(
                "[{citation_index}] {label}{kind_suffix}\n<indexed; no query to retrieve from>",
                label = att.path,
            ));
        }
    }

    let system_block = if text_blocks.is_empty() {
        String::new()
    } else {
        format!(
            "The user has attached files. When you use information from them, \
             cite the source inline using [N] markers matching the numbers below.\n\n\
             ATTACHED FILES:\n\n{}",
            text_blocks.join("\n\n---\n\n")
        )
    };

    Ok(AttachmentPayload {
        system_block,
        images: images_b64,
        sources,
        images_skipped,
    })
}

// ── Stale-embedding admin ───────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StaleAttachmentInfo {
    /// Number of distinct attachments with chunks whose embed_model differs
    /// from the current setting. Includes folders and large files.
    count: i64,
    /// The current embedding model name — surfaced in the banner copy so
    /// the user knows what they're reindexing for.
    current_model: String,
}

#[tauri::command]
pub(crate) fn embedding_stale_count(app: tauri::AppHandle) -> Result<StaleAttachmentInfo, String> {
    let current = current_embedding_model(&app);
    let state = app.state::<DbState>();
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let count: i64 = db
        .query_row(
            "SELECT COUNT(DISTINCT attachment_id) FROM attachment_chunks WHERE embed_model != ?1",
            [current.as_str()],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(StaleAttachmentInfo {
        count,
        current_model: current,
    })
}

/// Reindex every attachment whose chunks use a non-current embed_model.
/// Each attachment is reindexed in a fresh spawned task — they share the
/// embed-call serialization via Ollama, so we don't over-parallelise.
/// Returns the number of attachments queued; emits status_changed events
/// as each one starts.
#[tauri::command]
pub(crate) fn attachment_reindex_stale(app: tauri::AppHandle) -> Result<i64, String> {
    let current = current_embedding_model(&app);
    let stale_ids: Vec<(String, String)> = {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = db
            .prepare(
                "SELECT DISTINCT a.id, a.kind FROM attachments a \
                 JOIN attachment_chunks c ON c.attachment_id = a.id \
                 WHERE c.embed_model != ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([current.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    let n = i64::try_from(stale_ids.len()).unwrap_or(i64::MAX);
    for (id, kind) in stale_ids {
        let _ = set_attachment_status(&app, &id, "indexing", None);
        let app_clone = app.clone();
        let id_clone = id.clone();
        let token = register_cancel(&id);
        let cancel = token.flag.clone();
        tauri::async_runtime::spawn(async move {
            let _token = token; // see comment in attachment_add_files
            let r = if kind == "folder" {
                index_folder(app_clone, id_clone.clone(), cancel).await
            } else {
                index_attachment(app_clone, id_clone.clone(), cancel).await
            };
            if let Err(e) = r {
                log_warn!("reindex-stale failed for {id_clone}: {e}");
            }
        });
    }
    Ok(n)
}
