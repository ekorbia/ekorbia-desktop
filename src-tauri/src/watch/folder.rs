// SPDX-License-Identifier: MIT

//! Folder-kind pipeline: scan one watch's directory for new supported
//! files and process each. Errors per-file are logged but don't stop the
//! rest of the scan.

use crate::log::log_warn;
use crate::text_extract::extract_text_from_file;
use crate::watch::pipeline::{
    already_processed, flush_notify_batch, gen_event_id, insert_event, is_cancelled,
    new_notify_batch, process_item, resolve_system_msg, NotifyBatch, NotifyEntry,
};
use crate::watch::{Watch, WATCH_SUPPORTED_EXTENSIONS};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use tauri::Emitter;

/// Wrap `extract_text_from_file` with folder-specific error annotation: a
/// scanned/encrypted PDF yields no text, and we'd rather surface that
/// reason to the user than the generic "no text to summarise" message
/// inside `process_item`. Errors found at this layer (extraction failure,
/// empty PDF) push into `notify_batch` directly so they coalesce with
/// downstream successes/failures from `process_item` at cycle's end.
pub(crate) async fn process_file(
    app: &tauri::AppHandle,
    watch: &Watch,
    system_msg: &str,
    file_path: &Path,
    notify_batch: &mut NotifyBatch,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let path_str = file_path.to_string_lossy().to_string();
    let filename = file_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| path_str.clone());

    let text = match extract_text_from_file(file_path).await {
        Ok(t) if t.trim().is_empty() => {
            let msg = "No text extracted (PDF may be scanned/encrypted, \
                       or the file is empty)"
                .to_string();
            let event_id = gen_event_id();
            insert_event(app, &event_id, &watch.id, &path_str, "error", None, Some(&msg))?;
            let _ = app.emit("watch:event_changed", &event_id);
            notify_batch.push(NotifyEntry {
                success: false,
                item_label: filename.clone(),
                detail: msg.clone(),
            });
            return Err(msg);
        }
        Ok(t) => t,
        Err(e) => {
            let event_id = gen_event_id();
            insert_event(app, &event_id, &watch.id, &path_str, "error", None, Some(&e))?;
            let _ = app.emit("watch:event_changed", &event_id);
            notify_batch.push(NotifyEntry {
                success: false,
                item_label: filename.clone(),
                detail: e.clone(),
            });
            return Err(e);
        }
    };

    process_item(
        app, watch, system_msg, &path_str, &filename, text, notify_batch, cancel,
    )
    .await
}

pub(crate) async fn run_folder_watch(app: &tauri::AppHandle, watch: &Watch, cancel: &AtomicBool) {
    if watch.folder_path.is_empty() {
        log_warn!("watch '{}': folder kind has empty folder_path", watch.name);
        return;
    }
    let entries = match std::fs::read_dir(&watch.folder_path) {
        Ok(e) => e,
        Err(e) => {
            log_warn!("watch '{}': cannot read {}: {e}", watch.name, watch.folder_path);
            return;
        }
    };
    // Resolve the prompt body once per cycle — it's identical for every
    // entry, but `fetch_prompt_body` reads from disk + queries the DB. On
    // a folder watch with N new files this is the difference between one
    // disk read and N. See `resolve_system_msg`'s comment for context.
    let system_msg = resolve_system_msg(app, watch);

    // One batch per poll cycle — every process_file / process_item call
    // pushes into it; flush_notify_batch fires the coalesced banner(s)
    // after the directory scan completes.
    let mut notify_batch = new_notify_batch();
    for entry in entries.flatten() {
        // Per-item cancel check. Skips the remaining files entirely so a
        // folder with 100 new PDFs doesn't keep chewing through them
        // after the user toggled the watch off. Cheaper than the post-
        // dispatch check in `process_item` because we haven't even
        // extracted text yet.
        if is_cancelled(cancel) {
            break;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        let supported = ext
            .as_deref()
            .map(|e| WATCH_SUPPORTED_EXTENSIONS.contains(&e))
            .unwrap_or(false);
        if !supported {
            continue;
        }
        let path_str = path.to_string_lossy().to_string();
        match already_processed(app, &watch.id, &path_str) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => {
                log_warn!("watch '{}': memo lookup failed: {e}", watch.name);
                continue;
            }
        }
        if let Err(e) = process_file(app, watch, &system_msg, &path, &mut notify_batch, cancel).await {
            log_warn!("watch '{}': process_file {path_str}: {e}", watch.name);
        }
    }
    flush_notify_batch(app, watch, &notify_batch);
}
