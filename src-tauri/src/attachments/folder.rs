// SPDX-License-Identifier: MIT

//! Folder attachment pipeline: walker + add_folder command + index_folder
//! with incremental reindex.
//!
//! A folder attachment turns a directory into a chunk corpus. The walker
//! applies the extension filter + ignore-dir list, caps at FOLDER_MAX_FILES,
//! and emits progress events as each file is embedded so the chip shows
//! "(N/M indexed)" live.

use crate::attachments::cancel::register_cancel;
use crate::attachments::config::{current_embedding_model, current_folder_exts, current_folder_ignore};
use crate::attachments::pipeline::{
    chunk_text, emit_attachment_phase, emit_folder_progress, pack_embedding,
    set_attachment_file_count, set_attachment_status,
};
use crate::attachments::types::{
    AttachmentRow, ATTACHMENT_MAX_BYTES, FOLDER_MAX_FILES,
};
use crate::db::{ensure_chat_row, gen_id, mtime_unix_from_meta, now_unix, DbState};
use crate::log::log_warn;
use crate::ollama::ollama_embed;
use crate::text_extract::extract_text_from_file;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

/// Files coalesced into a single `/api/embed` round-trip + a single DB
/// transaction during folder indexing. Tuned for the common case of small
/// text files (markdown / source / configs): 8 files × ~5 chunks each ≈ 40
/// texts per HTTP call, which Ollama handles well and keeps the embedding
/// memory ceiling per batch modest. Larger batches save more HTTP overhead
/// but pay for it in tail-latency: a single slow file would stall progress
/// for the whole batch.
const FOLDER_INDEX_BATCH_FILES: usize = 8;

/// Max concurrent extract+chunk tasks within a single batch. PDF extraction
/// is CPU-bound and goes through `spawn_blocking` internally, so running
/// multiple in parallel uses multiple cores; but each holds the file's full
/// extracted text in memory, so the ceiling is `PDF_EXTRACT_CONCURRENCY ×
/// max-per-file-text`. 2 balances ~2× wall-clock speedup on multi-core with
/// a memory ceiling that stays predictable even on folders of large PDFs.
/// FOLDER_INDEX_BATCH_FILES (8) parallelism is rejected: pathological cases
/// (folder of 100MB PDFs) could spike to multi-GB peaks.
const PDF_EXTRACT_CONCURRENCY: usize = 2;

/// Decide whether a directory should be entered. Case-insensitive match
/// against the caller-provided ignore list. Hidden directories (leading
/// `.`) are also skipped — they're almost always config / VCS dirs the
/// user doesn't want.
fn should_skip_dir(name: &str, ignore: &[String]) -> bool {
    let lower = name.to_ascii_lowercase();
    if ignore.iter().any(|s| s == &lower) {
        return true;
    }
    name.starts_with('.')
}

/// Decide whether a file should be indexed. Extension must match the
/// caller-provided allow-list AND the file must be within the per-file
/// size cap. Hidden files (leading `.`) are also skipped.
fn should_index_file(name: &str, ext: &str, bytes: u64, exts: &[String]) -> bool {
    if name.starts_with('.') {
        return false;
    }
    if bytes > ATTACHMENT_MAX_BYTES {
        return false;
    }
    exts.iter().any(|e| e == ext)
}

/// Recursively walk a directory, collecting eligible (path, bytes, mtime)
/// tuples. Symlinks are skipped entirely (cycles are too easy to introduce
/// otherwise). Bails out when FOLDER_MAX_FILES is reached — returns what it
/// has plus a flag so the caller can surface the cap to the user. `exts`
/// and `ignore` are passed in so callers can read settings once and reuse.
/// `(absolute path, byte size, mtime-as-unix-seconds)`.
type WalkEntry = (String, u64, i64);

fn walk_folder(
    root: &Path,
    exts: &[String],
    ignore: &[String],
) -> (Vec<WalkEntry>, bool) {
    let mut out: Vec<WalkEntry> = Vec::new();
    let mut hit_cap = false;
    // Iterative stack-based DFS to avoid recursion blowing the stack on
    // very deep trees.
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            // permission denied / I/O — skip silently
            continue;
        };
        for entry in entries.flatten() {
            // symlink_metadata reads the link itself, not its target — so a
            // symlink-to-dir doesn't get followed (avoids cycles).
            let Ok(meta) = entry.metadata() else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let name_s = match name.to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            let p = entry.path();
            if meta.is_dir() {
                if !should_skip_dir(&name_s, ignore) {
                    stack.push(p);
                }
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            let bytes = meta.len();
            if !should_index_file(&name_s, &ext, bytes, exts) {
                continue;
            }
            // Unreadable mtime → 0 so the indexer treats the file as stale
            // and reindexes. See `db::file_mtime_unix` doc for fallback
            // semantics rationale.
            let mtime = mtime_unix_from_meta(&meta).unwrap_or(0);
            out.push((p.to_string_lossy().to_string(), bytes, mtime));
            if out.len() >= FOLDER_MAX_FILES {
                hit_cap = true;
                return (out, hit_cap);
            }
        }
    }
    (out, hit_cap)
}

#[tauri::command]
pub(crate) fn attachment_add_folder(
    app: tauri::AppHandle,
    chat_id: String,
    path: String,
) -> Result<AttachmentRow, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    let now = now_unix();
    let id = gen_id("att_dir");
    let label = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&path)
        .to_string();
    {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        ensure_chat_row(&db, &chat_id, now)?;
        db.execute(
            "INSERT INTO attachments \
             (id, chat_id, kind, path, label, bytes, added_at, status, file_count) \
             VALUES (?1, ?2, 'folder', ?3, ?4, 0, ?5, 'indexing', 0)",
            (&id, &chat_id, &path, &label, now),
        )
        .map_err(|e| e.to_string())?;
    }
    let row = AttachmentRow {
        id: id.clone(),
        chat_id: chat_id.clone(),
        kind: "folder".to_string(),
        path: path.clone(),
        label,
        bytes: 0,
        added_at: now,
        status: "indexing".to_string(),
        error: None,
        file_count: 0,
    };
    // Spawn the walker + indexing task. The cancel flag lets a detach mid-
    // walk abort the run before more chunks land against a row that's
    // about to be deleted. Token lifetime carries through to the spawned
    // task so registry cleanup survives panics in the walker / embedder.
    let app_clone = app.clone();
    let id_for_spawn = row.id.clone();
    let token = register_cancel(&id_for_spawn);
    let cancel = token.flag.clone();
    tauri::async_runtime::spawn(async move {
        let _token = token;
        if let Err(e) = index_folder(app_clone, id_for_spawn, cancel).await {
            log_warn!("folder index failed: {e}");
        }
    });
    Ok(row)
}

/// Background pipeline for a folder attachment: walk → for each eligible
/// file (chunk → embed → write source + chunks) → emit progress. Errors on
/// individual files are recorded but don't abort the run; the folder still
/// transitions to 'ready' with whatever was successfully indexed. A
/// totally-empty folder produces a soft 'error' status so the user knows
/// nothing was indexed.
pub(crate) async fn index_folder(
    app: tauri::AppHandle,
    id: String,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) { return Ok(()); }
    let folder_path = {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        db.query_row(
            "SELECT path FROM attachments WHERE id = ?1",
            [&id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
    };
    let root = Path::new(&folder_path).to_path_buf();
    // Read settings once and pass into the (blocking) walker. Settings
    // changed mid-walk won't take effect — the walker uses a snapshot.
    let exts = current_folder_exts(&app);
    let ignore = current_folder_ignore(&app);
    // Emit a "walking" phase event so the chip can show feedback during
    // the walk itself, which can take several seconds on a deep tree.
    emit_attachment_phase(&app, &id, "walking");
    // 1. Walk. Off-thread so a huge tree doesn't stall the async runtime.
    let (entries, hit_cap) = tauri::async_runtime::spawn_blocking(move || {
        walk_folder(&root, &exts, &ignore)
    })
        .await
        .map_err(|e| e.to_string())?;
    if cancel.load(Ordering::Relaxed) { return Ok(()); }
    if entries.is_empty() {
        let _ = set_attachment_status(&app, &id, "error", Some("No matching files in folder"));
        return Err("No matching files in folder".to_string());
    }
    // 2. Diff against existing sources for incremental reindex. A source
    //    is considered fresh when: (a) its mtime matches what's on disk
    //    now AND (b) it has at least one chunk embedded with the current
    //    model. Anything else needs re-embedding. Sources that no longer
    //    appear in the walker output (deleted files) get removed.
    let embed_model_now = current_embedding_model(&app);
    // existing: path → (source_id, mtime, has_fresh_chunks)
    let existing: std::collections::HashMap<String, (String, i64, bool)> = {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = db
            .prepare(
                "SELECT s.id, s.path, s.mtime, \
                        EXISTS (SELECT 1 FROM attachment_chunks c \
                                 WHERE c.source_id = s.id AND c.embed_model = ?2) \
                 FROM attachment_sources s WHERE s.attachment_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map((&id, embed_model_now.as_str()), |row| {
                let sid: String = row.get(0)?;
                let path: String = row.get(1)?;
                let mtime: i64 = row.get(2)?;
                let fresh: i64 = row.get(3)?;
                Ok((path, (sid, mtime, fresh != 0)))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows.into_iter().collect()
    };
    let total = entries.len() as u32;
    let mut done: u32 = 0;
    emit_folder_progress(&app, &id, done, total);
    let mut indexed_count: i64 = 0;
    let mut reused_count: u32 = 0;
    let mut had_any_error = false;
    let mut last_error: Option<String> = None;
    let mut visited_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 3. Classify each walked entry into either a Reuse (mtime unchanged +
    //    chunks already exist under the current embedding model) or a
    //    Process (extract+chunk+embed required). Reuse is handled inline in
    //    one transaction below; Process entries get coalesced into batches.
    //
    // The classifier itself is a pure function — see `classify_walk_entries`
    // — so the decision logic can be unit-tested without an Ollama / DB
    // round-trip. Cancellation is checked once before we hand the entries
    // off rather than per-entry; classifying 1000 entries against a
    // pre-built HashMap is microsecond-scale.
    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }
    let att_prefix: String = id[4..].chars().take(8).collect();
    let Classification {
        reuse_updates,
        to_process,
        visited_paths: classifier_visited,
    } = classify_walk_entries(&entries, &existing, &att_prefix);
    visited_paths.extend(classifier_visited);
    // 3a. Apply all reuse byte-size updates in one transaction. Fast even on
    //     a folder with 1000 unchanged files — one fsync instead of N. Failures
    //     here are non-fatal; the byte field is cosmetic relative to the chunk
    //     payload that actually serves retrieval.
    if !reuse_updates.is_empty() {
        let state = app.state::<DbState>();
        if let Ok(mut conn) = state.0.lock() {
            if let Ok(tx) = conn.transaction() {
                for (sid, bytes) in &reuse_updates {
                    if let Err(e) = tx.execute(
                        "UPDATE attachment_sources SET bytes = ?1 WHERE id = ?2",
                        (i64::try_from(*bytes).unwrap_or(i64::MAX), sid),
                    ) {
                        // Non-fatal: byte count is cosmetic vs. the chunk
                        // payload that actually serves retrieval. Log + continue.
                        log_warn!("folder reuse byte-update for {sid} failed: {e}");
                    }
                }
                if let Err(e) = tx.commit() {
                    log_warn!("folder reuse tx commit failed (byte counts stale): {e}");
                }
            }
        }
        let reuse_n = u32::try_from(reuse_updates.len()).unwrap_or(u32::MAX);
        indexed_count += i64::from(reuse_n);
        reused_count += reuse_n;
        done += reuse_n;
        let _ = set_attachment_file_count(&app, &id, indexed_count);
        emit_folder_progress(&app, &id, done, total);
    }
    // 3b. Drain `to_process` in batches. Each batch is one /api/embed
    //     round-trip and one DB transaction — the two operations that
    //     dominate folder-indexing wall time. Within a batch, per-file
    //     extraction failures are recorded but don't fail siblings; a
    //     batch-level embed failure (e.g. Ollama down) bubbles up as the
    //     batch's `last_error` and all files in that batch are counted as
    //     failed, but subsequent batches still run.
    for batch in to_process.chunks(FOLDER_INDEX_BATCH_FILES) {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let batch_len = u32::try_from(batch.len()).unwrap_or(u32::MAX);
        let (succeeded, err) = process_file_batch(&app, &id, &embed_model_now, batch).await;
        let succeeded_u32 = u32::try_from(succeeded).unwrap_or(u32::MAX);
        let failed = batch_len.saturating_sub(succeeded_u32);
        indexed_count += i64::from(succeeded_u32);
        if failed > 0 {
            had_any_error = true;
        }
        if let Some(e) = err {
            last_error = Some(e);
        }
        done += batch_len;
        let _ = set_attachment_file_count(&app, &id, indexed_count);
        // Throttle progress events to match the prior per-file behaviour:
        // for small folders show every batch, for larger ones every 4 files
        // worth of progress or the final batch.
        if total <= 50 || done.is_multiple_of(4) || done == total {
            emit_folder_progress(&app, &id, done, total);
        }
    }
    // Removed files: anything in `existing` that wasn't visited this walk
    // is gone from disk (or filtered out by new settings). Delete those
    // sources — chunks cascade. No-op on fresh adds (existing is empty).
    {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        for (path, (sid, _, _)) in existing.iter() {
            if !visited_paths.contains(path) {
                if let Err(e) =
                    db.execute("DELETE FROM attachment_sources WHERE id = ?1", [sid])
                {
                    // Non-fatal: orphan source row + its cascaded chunks.
                    // Stale chunks still ship to retrieval (they reference a
                    // file that's no longer in the walk). Logged so a pattern
                    // is visible.
                    log_warn!("folder gc DELETE attachment_sources {sid} failed: {e}");
                }
            }
        }
    }
    if reused_count > 0 {
        log_warn!("Folder {id}: reused {reused_count} unchanged file(s), reindexed {}", done - reused_count);
    }
    emit_folder_progress(&app, &id, done, total);
    let final_status = if indexed_count == 0 { "error" } else { "ready" };
    let error_msg = if final_status == "error" {
        Some(last_error.unwrap_or_else(|| "All files failed to index".to_string()))
    } else if hit_cap {
        Some(format!(
            "Folder cap reached ({FOLDER_MAX_FILES} files). Anything past the limit was skipped."
        ))
    } else if had_any_error {
        last_error.map(|e| format!("Some files failed: {e}"))
    } else {
        None
    };
    let _ = set_attachment_status(&app, &id, final_status, error_msg.as_deref());
    Ok(())
}

/// One per-file unit of work emitted by the classifier in `index_folder`.
/// `is_new` distinguishes "INSERT a source row" from "UPDATE the existing
/// source row + DELETE its old chunks". The string fields are owned (not
/// borrowed) so plans can sit in a `Vec` across the embedding round-trip
/// without lifetimes getting tangled with the entries iterator. `Clone` is
/// derived so `process_file_batch` can hand owned copies to per-file
/// extraction tasks running concurrently under a semaphore.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessPlan {
    source_id: String,
    is_new: bool,
    file_path: String,
    bytes: u64,
    mtime: i64,
}

/// Output of `classify_walk_entries`. Three independent buckets that the
/// caller (`index_folder`) then drains: reuse updates land in one fast
/// transaction, process plans drive the batched embed pipeline, and
/// visited paths feed the "remove deleted files" pass.
struct Classification {
    /// `(source_id, bytes)` pairs for files whose mtime + embed_model
    /// hasn't changed since the last index — only the cosmetic byte count
    /// needs refreshing.
    reuse_updates: Vec<(String, u64)>,
    /// Files that need extract + chunk + embed work. Includes both
    /// brand-new sources (`is_new: true`) and existing sources whose
    /// content changed under them (`is_new: false`).
    to_process: Vec<ProcessPlan>,
    /// Every path the walker emitted this run. The caller compares against
    /// `existing` to spot sources that disappeared from disk and should be
    /// pruned.
    visited_paths: std::collections::HashSet<String>,
}

/// Pure classifier — given the walker's output and the existing-sources
/// snapshot, decide what each entry needs. Pulled out of `index_folder`
/// so the decision logic can be unit-tested in isolation; the function
/// touches no I/O and holds no locks.
///
/// `att_prefix` is the short id stem (first 8 chars of the attachment id
/// after the `att_` prefix) used to mint source ids of the form
/// `src_<att_prefix>_<counter>`. The counter increments per NEW source —
/// not per loop iteration — so reindexes don't mint nondeterministic ids
/// across runs that happen to walk reuse + new in different orders.
fn classify_walk_entries(
    entries: &[WalkEntry],
    existing: &std::collections::HashMap<String, (String, i64, bool)>,
    att_prefix: &str,
) -> Classification {
    let mut reuse_updates: Vec<(String, u64)> = Vec::new();
    let mut to_process: Vec<ProcessPlan> = Vec::new();
    let mut visited_paths: std::collections::HashSet<String> =
        std::collections::HashSet::with_capacity(entries.len());
    let mut new_source_counter: usize = 0;
    for (file_path, bytes, mtime) in entries {
        visited_paths.insert(file_path.clone());
        let existing_for_path = existing.get(file_path);
        let reuse = existing_for_path
            .is_some_and(|(_, e_mtime, fresh)| *e_mtime == *mtime && *fresh);
        if reuse {
            if let Some((sid, _, _)) = existing_for_path {
                reuse_updates.push((sid.clone(), *bytes));
            }
        } else if let Some((sid, _, _)) = existing_for_path {
            to_process.push(ProcessPlan {
                source_id: sid.clone(),
                is_new: false,
                file_path: file_path.clone(),
                bytes: *bytes,
                mtime: *mtime,
            });
        } else {
            let new_sid = format!("src_{att_prefix}_{new_source_counter}");
            new_source_counter += 1;
            to_process.push(ProcessPlan {
                source_id: new_sid,
                is_new: true,
                file_path: file_path.clone(),
                bytes: *bytes,
                mtime: *mtime,
            });
        }
    }
    Classification {
        reuse_updates,
        to_process,
        visited_paths,
    }
}

/// A `ProcessPlan` after extraction + chunking has succeeded. Sits in the
/// batch's "ready" list until the embed call lands; then writes happen all
/// at once inside the cohort transaction.
struct ChunkedFile {
    source_id: String,
    is_new: bool,
    file_path: String,
    bytes: u64,
    mtime: i64,
    chunks: Vec<(usize, usize, String)>,
}

/// Extract + chunk a single file. Returns Err on empty content, an
/// unreadable file, or zero chunks after splitting — these are the same
/// per-file failure modes the old `index_one_folder_file` reported.
async fn chunk_one_file(plan: &ProcessPlan) -> Result<ChunkedFile, String> {
    let text = extract_text_from_file(Path::new(&plan.file_path)).await?;
    if text.trim().is_empty() {
        return Err("empty file".to_string());
    }
    let chunks = chunk_text(&text);
    if chunks.is_empty() {
        return Err("no chunks".to_string());
    }
    Ok(ChunkedFile {
        source_id: plan.source_id.clone(),
        is_new: plan.is_new,
        file_path: plan.file_path.clone(),
        bytes: plan.bytes,
        mtime: plan.mtime,
        chunks,
    })
}

/// Process a batch of `ProcessPlan` entries: extract + chunk every file
/// (sequentially — embedding is the actual bottleneck), then issue ONE
/// `ollama_embed` call covering every chunk in the batch, then commit all
/// source + chunk writes in ONE SQLite transaction. Returns
/// `(succeeded_count, last_error)` so the caller can advance counters
/// without aborting the whole run on a single bad batch.
///
/// Per-file failures (extract / chunk) drop that file from the batch but
/// don't fail siblings. A batch-level embed failure dooms every file in
/// the batch — typically Ollama is unreachable or the model isn't pulled,
/// in which case downstream batches will fail identically and the run will
/// finalise with status='error' via the `indexed_count == 0` check.
///
/// **Crash-consistency**: the DELETE of any prior chunks for a reindexed
/// source happens INSIDE the transaction, AFTER the embed call returns
/// successfully. So an embed failure leaves the existing chunks untouched
/// (a strict improvement over the per-file pipeline this replaces, which
/// deleted-then-embedded and could orphan a source with zero chunks if the
/// embed call failed mid-run).
async fn process_file_batch(
    app: &tauri::AppHandle,
    attachment_id: &str,
    embed_model: &str,
    batch: &[ProcessPlan],
) -> (usize, Option<String>) {
    // 1. Extract + chunk each file with bounded concurrency. PDF extraction
    //    is CPU-bound (goes through `spawn_blocking` inside
    //    `extract_text_from_file`) so parallel tasks use multiple cores;
    //    `PDF_EXTRACT_CONCURRENCY` caps simultaneous in-flight extractions
    //    so memory stays bounded at `concurrency × max-per-file-text`. See
    //    that const for the rationale on why 2 and not FOLDER_INDEX_BATCH_FILES.
    //
    //    Ordering: results are collected by index so the embed batch (and
    //    therefore chunk numbering) is deterministic regardless of which
    //    task finishes first. Per-file failures don't fail siblings.
    let semaphore = Arc::new(tokio::sync::Semaphore::new(PDF_EXTRACT_CONCURRENCY));
    let mut handles = Vec::with_capacity(batch.len());
    for (idx, plan) in batch.iter().enumerate() {
        let sem = semaphore.clone();
        let plan_owned = plan.clone();
        let handle = tauri::async_runtime::spawn(async move {
            // Permit lives across the await so at most PDF_EXTRACT_CONCURRENCY
            // tasks are mid-extraction concurrently. `expect` is safe here:
            // the only way `acquire` fails is if the semaphore is closed,
            // which we never do.
            let _permit = sem.acquire().await.expect("semaphore should not be closed");
            (idx, chunk_one_file(&plan_owned).await)
        });
        handles.push(handle);
    }
    let mut indexed: Vec<Option<ChunkedFile>> = (0..batch.len()).map(|_| None).collect();
    let mut last_error: Option<String> = None;
    for handle in handles {
        match handle.await {
            Ok((idx, Ok(cf))) => indexed[idx] = Some(cf),
            Ok((_, Err(e))) => last_error = Some(e),
            Err(e) => last_error = Some(format!("extract task join failed: {e}")),
        }
    }
    let ready: Vec<ChunkedFile> = indexed.into_iter().flatten().collect();
    if ready.is_empty() {
        return (0, last_error);
    }

    // 2. Flatten every chunk's text into one buffer, with a per-file
    //    boundary table so we can slice the returned embeddings back into
    //    file-shaped groups after the call.
    let total_chunks: usize = ready.iter().map(|cf| cf.chunks.len()).sum();
    let mut texts: Vec<String> = Vec::with_capacity(total_chunks);
    let mut boundaries: Vec<usize> = Vec::with_capacity(ready.len() + 1);
    for cf in &ready {
        boundaries.push(texts.len());
        for (_, _, t) in &cf.chunks {
            texts.push(t.clone());
        }
    }
    boundaries.push(texts.len()); // sentinel — boundaries[i+1] is end-exclusive

    // 3. One /api/embed round-trip for the whole batch.
    let embeddings = match ollama_embed(embed_model, &texts).await {
        Ok(v) => v,
        Err(e) => return (0, Some(e)),
    };
    if embeddings.len() != texts.len() {
        return (
            0,
            Some(format!(
                "embedding count mismatch ({} texts → {} embeddings)",
                texts.len(),
                embeddings.len()
            )),
        );
    }

    // 4. One transaction: source row insert/update, prior-chunks DELETE,
    //    and new-chunks INSERT for every ready file. Pre-pack the BLOBs
    //    OUTSIDE the lock to keep the critical section short — the lock
    //    is std::sync::Mutex (sync) and any work done inside stalls every
    //    other DB consumer.
    let packed: Vec<Vec<u8>> = embeddings.iter().map(|e| pack_embedding(e)).collect();

    let state = app.state::<DbState>();
    let mut conn = match state.0.lock() {
        Ok(g) => g,
        Err(e) => return (0, Some(e.to_string())),
    };
    let tx = match conn.transaction() {
        Ok(t) => t,
        Err(e) => return (0, Some(e.to_string())),
    };

    let mut succeeded: usize = 0;
    let mut tx_error: Option<String> = None;
    for (i, cf) in ready.iter().enumerate() {
        let bytes_i64 = i64::try_from(cf.bytes).unwrap_or(i64::MAX);
        // Source row.
        let source_step = if cf.is_new {
            tx.execute(
                "INSERT INTO attachment_sources (id, attachment_id, path, mtime, bytes) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                (&cf.source_id, attachment_id, &cf.file_path, cf.mtime, bytes_i64),
            )
        } else {
            // Update first, then nuke old chunks. Both must land or this
            // file is skipped — the next loop iteration moves on.
            tx.execute(
                "UPDATE attachment_sources SET mtime = ?1, bytes = ?2 WHERE id = ?3",
                (cf.mtime, bytes_i64, &cf.source_id),
            )
            .and_then(|_| {
                tx.execute(
                    "DELETE FROM attachment_chunks WHERE source_id = ?1",
                    [&cf.source_id],
                )
            })
        };
        if let Err(e) = source_step {
            tx_error = Some(e.to_string());
            continue;
        }
        // Chunk rows for this file. Each chunk's embedding lives at
        // `packed[boundaries[i] + ord]`.
        let start = boundaries[i];
        let mut wrote_all = true;
        for (ord, (c_start, c_end, c_text)) in cf.chunks.iter().enumerate() {
            let blob = &packed[start + ord];
            let ord_i64 = i64::try_from(ord).unwrap_or(i64::MAX);
            let cs_i64 = i64::try_from(*c_start).unwrap_or(i64::MAX);
            let ce_i64 = i64::try_from(*c_end).unwrap_or(i64::MAX);
            if let Err(e) = tx.execute(
                "INSERT INTO attachment_chunks \
                 (attachment_id, source_id, ordinal, text, embedding, embed_model, char_start, char_end) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                (
                    attachment_id,
                    &cf.source_id,
                    ord_i64,
                    c_text,
                    blob.as_slice(),
                    embed_model,
                    cs_i64,
                    ce_i64,
                ),
            ) {
                tx_error = Some(e.to_string());
                wrote_all = false;
                break;
            }
        }
        if wrote_all {
            succeeded += 1;
        }
    }
    if let Err(e) = tx.commit() {
        return (0, Some(e.to_string()));
    }
    (succeeded, tx_error.or(last_error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Helper: build an `existing` map entry. Mirrors what the DB query in
    /// `index_folder` produces — `(source_id, mtime, has_fresh_chunks)`.
    fn make_existing(
        pairs: &[(&str, &str, i64, bool)],
    ) -> HashMap<String, (String, i64, bool)> {
        pairs
            .iter()
            .map(|(path, sid, mtime, fresh)| {
                ((*path).to_string(), ((*sid).to_string(), *mtime, *fresh))
            })
            .collect()
    }

    fn entry(path: &str, bytes: u64, mtime: i64) -> WalkEntry {
        (path.to_string(), bytes, mtime)
    }

    #[test]
    fn classify_empty_input_yields_empty_buckets() {
        let entries: Vec<WalkEntry> = Vec::new();
        let existing = HashMap::new();
        let out = classify_walk_entries(&entries, &existing, "abc12345");
        assert!(out.reuse_updates.is_empty());
        assert!(out.to_process.is_empty());
        assert!(out.visited_paths.is_empty());
    }

    #[test]
    fn classify_all_new_files_become_process_plans_with_minted_ids() {
        // No prior sources — every walked entry is brand-new. Source ids
        // must be deterministic, sequential, and prefixed with att_prefix.
        let entries = vec![
            entry("/a.md", 10, 100),
            entry("/b.md", 20, 200),
            entry("/c.md", 30, 300),
        ];
        let existing = HashMap::new();
        let out = classify_walk_entries(&entries, &existing, "deadbeef");
        assert!(out.reuse_updates.is_empty());
        assert_eq!(out.to_process.len(), 3);
        // Source ids increment per NEW source, starting at 0.
        assert_eq!(out.to_process[0].source_id, "src_deadbeef_0");
        assert_eq!(out.to_process[1].source_id, "src_deadbeef_1");
        assert_eq!(out.to_process[2].source_id, "src_deadbeef_2");
        // Every plan is flagged is_new so the batch processor INSERTs (no UPDATE).
        for plan in &out.to_process {
            assert!(plan.is_new, "expected is_new=true for new sources");
        }
        // visited_paths covers every entry.
        assert_eq!(out.visited_paths.len(), 3);
    }

    #[test]
    fn classify_fresh_unchanged_files_route_to_reuse_updates() {
        // Existing sources with matching mtime AND fresh chunks → reuse path.
        // No process plans should be emitted.
        let entries = vec![entry("/a.md", 10, 100), entry("/b.md", 20, 200)];
        let existing = make_existing(&[
            ("/a.md", "src_old_0", 100, true),
            ("/b.md", "src_old_1", 200, true),
        ]);
        let out = classify_walk_entries(&entries, &existing, "ignored");
        assert!(out.to_process.is_empty());
        assert_eq!(out.reuse_updates.len(), 2);
        // The source_id from `existing` is reused — no new id is minted.
        assert_eq!(out.reuse_updates[0].0, "src_old_0");
        assert_eq!(out.reuse_updates[1].0, "src_old_1");
        // Byte counts from the walker propagate through (cosmetic refresh).
        assert_eq!(out.reuse_updates[0].1, 10);
        assert_eq!(out.reuse_updates[1].1, 20);
    }

    #[test]
    fn classify_stale_mtime_triggers_reindex_keeping_source_id() {
        // mtime changed since last index → file content changed → reindex.
        // The existing source_id must be preserved (chunks cascade-delete
        // by source_id, so the row stays addressable) and is_new must be
        // false so the batch processor takes the UPDATE+DELETE path.
        let entries = vec![entry("/changed.md", 50, 999)];
        let existing = make_existing(&[("/changed.md", "src_x_0", 100, true)]);
        let out = classify_walk_entries(&entries, &existing, "x");
        assert_eq!(out.to_process.len(), 1);
        assert!(out.reuse_updates.is_empty());
        let p = &out.to_process[0];
        assert_eq!(p.source_id, "src_x_0");
        assert!(!p.is_new);
        assert_eq!(p.mtime, 999); // new mtime, not old
    }

    #[test]
    fn classify_stale_embed_model_triggers_reindex_even_with_matching_mtime() {
        // mtime matches but `fresh: false` (i.e. no chunks exist under the
        // current embedding model). Same routing as stale-mtime: UPDATE
        // path, source_id preserved.
        let entries = vec![entry("/same.md", 50, 100)];
        let existing = make_existing(&[("/same.md", "src_y_0", 100, false)]);
        let out = classify_walk_entries(&entries, &existing, "y");
        assert_eq!(out.to_process.len(), 1);
        let p = &out.to_process[0];
        assert!(!p.is_new);
        assert_eq!(p.source_id, "src_y_0");
    }

    #[test]
    fn classify_mixed_inputs_route_correctly_and_only_new_files_consume_counter() {
        // A reuse + a reindex + two new files. Counter only ticks for the
        // genuinely-new entries — so the new ids are 0 and 1, not (say) 2
        // and 3. This is the key invariant that keeps source ids stable
        // across reindex runs that happen to walk files in a different
        // order than they were originally added.
        let entries = vec![
            entry("/reuse.md", 10, 100),
            entry("/stale.md", 20, 200),
            entry("/new1.md", 30, 300),
            entry("/new2.md", 40, 400),
        ];
        let existing = make_existing(&[
            ("/reuse.md", "src_old_a", 100, true),
            ("/stale.md", "src_old_b", 99, true), // mtime mismatch → reindex
        ]);
        let out = classify_walk_entries(&entries, &existing, "mix");
        assert_eq!(out.reuse_updates.len(), 1);
        assert_eq!(out.reuse_updates[0].0, "src_old_a");
        assert_eq!(out.to_process.len(), 3);
        let plans: HashMap<_, _> = out
            .to_process
            .iter()
            .map(|p| (p.file_path.as_str(), p))
            .collect();
        // The reindexed entry keeps its old id.
        assert_eq!(plans["/stale.md"].source_id, "src_old_b");
        assert!(!plans["/stale.md"].is_new);
        // The new entries get freshly minted, sequentially-numbered ids
        // — the counter does NOT skip past 0/1 to 2/3 just because there
        // were two existing entries already in the walk.
        assert_eq!(plans["/new1.md"].source_id, "src_mix_0");
        assert_eq!(plans["/new2.md"].source_id, "src_mix_1");
        assert!(plans["/new1.md"].is_new);
        assert!(plans["/new2.md"].is_new);
    }

    #[test]
    fn classify_visited_paths_reflects_every_walked_entry() {
        // The caller uses `visited_paths` to identify deleted files
        // (entries in `existing` not in `visited_paths`). Every walked
        // entry — regardless of reuse/reindex/new disposition — must end
        // up in the set.
        let entries = vec![
            entry("/a", 1, 1),
            entry("/b", 1, 1),
            entry("/c", 1, 1),
        ];
        let existing = make_existing(&[("/a", "src_old_0", 1, true)]);
        let out = classify_walk_entries(&entries, &existing, "v");
        assert!(out.visited_paths.contains("/a"));
        assert!(out.visited_paths.contains("/b"));
        assert!(out.visited_paths.contains("/c"));
        // Removed file (one in existing but not in entries) is NOT in the
        // visited set — that's how the caller spots it for pruning.
        let existing_with_extra = make_existing(&[
            ("/a", "src_old_0", 1, true),
            ("/gone.md", "src_old_1", 1, true),
        ]);
        let out2 = classify_walk_entries(&entries, &existing_with_extra, "v");
        assert!(!out2.visited_paths.contains("/gone.md"));
    }
}
