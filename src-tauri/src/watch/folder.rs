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
            insert_event(
                app,
                &event_id,
                &watch.id,
                &path_str,
                "error",
                None,
                Some(&msg),
            )?;
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
            insert_event(
                app,
                &event_id,
                &watch.id,
                &path_str,
                "error",
                None,
                Some(&e),
            )?;
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
        app,
        watch,
        system_msg,
        &path_str,
        &filename,
        text,
        notify_batch,
        cancel,
    )
    .await
}

/// Decide whether a file should be processed given its mtime and the
/// watch's optional `ignore_before` cutoff. A file at or after the cutoff
/// processes; an older one skips. No cutoff, or an unreadable mtime, → process
/// (fail open). Pulled out as a pure fn so the cutoff logic is unit-testable
/// without an AppHandle / real directory.
fn passes_ignore_before(mtime_secs: Option<i64>, ignore_before: Option<i64>) -> bool {
    match (ignore_before, mtime_secs) {
        (Some(cutoff), Some(m)) => m >= cutoff,
        _ => true,
    }
}

pub(crate) async fn run_folder_watch(app: &tauri::AppHandle, watch: &Watch, cancel: &AtomicBool) {
    if watch.folder_path.is_empty() {
        log_warn!("watch '{}': folder kind has empty folder_path", watch.name);
        return;
    }
    let entries = match std::fs::read_dir(&watch.folder_path) {
        Ok(e) => e,
        Err(e) => {
            log_warn!(
                "watch '{}': cannot read {}: {e}",
                watch.name,
                watch.folder_path
            );
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
        // Skip files that predate the watch's ignore_before cutoff — keeps a
        // brand-new folder watch (e.g. the Downloads recipe) from summarising
        // the entire pre-existing backlog on its first scan. Fail OPEN: if we
        // can't read the mtime, process the file rather than silently drop it.
        let mtime_secs = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        if !passes_ignore_before(mtime_secs, watch.ignore_before) {
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
        if let Err(e) =
            process_file(app, watch, &system_msg, &path, &mut notify_batch, cancel).await
        {
            log_warn!("watch '{}': process_file {path_str}: {e}", watch.name);
        }
    }
    flush_notify_batch(app, watch, &notify_batch);
}

#[cfg(test)]
mod tests {
    use super::passes_ignore_before;

    #[test]
    fn no_cutoff_processes_everything() {
        assert!(passes_ignore_before(Some(100), None));
        assert!(passes_ignore_before(None, None));
    }

    #[test]
    fn unreadable_mtime_fails_open() {
        // Better to over-summarise one file than silently skip it.
        assert!(passes_ignore_before(None, Some(1000)));
    }

    #[test]
    fn skips_files_older_than_cutoff_keeps_newer() {
        let cutoff = Some(1000);
        assert!(!passes_ignore_before(Some(999), cutoff)); // pre-existing → skip
        assert!(passes_ignore_before(Some(1000), cutoff)); // exactly at cutoff → keep
        assert!(passes_ignore_before(Some(1001), cutoff)); // arrived after → keep
    }
}
