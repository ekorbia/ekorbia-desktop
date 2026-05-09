// SPDX-License-Identifier: MIT

//! Embedding + chunk pipeline for single-file attachments + retrieval.
//!
//! Folder pipeline lives in `super::folder` because the walker + per-file
//! diff has its own shape; this module covers the single-file path
//! (`index_attachment`) plus the shared lower-level helpers (chunking,
//! embedding packing, cosine search) used by both.

use crate::attachments::cancel::register_cancel;
use crate::attachments::config::current_embedding_model;
use crate::attachments::types::{
    AttachmentStatusEvent, RetrievedChunk, CHUNK_OVERLAP_CHARS, CHUNK_TARGET_CHARS,
    SMALL_TEXT_THRESHOLD,
};
use crate::db::DbState;
use crate::log::log_warn;
use crate::ollama::ollama_embed;
use crate::text_extract::extract_text_from_file;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// Maximum chars `chunk_text` will look back from `target_end` searching for a
/// paragraph / sentence / whitespace boundary. A larger value gives nicer
/// breaks but risks chunks well under `CHUNK_TARGET_CHARS` when prose has
/// long unbroken runs (URLs, base64, code). 200 is the empirical sweet spot.
const CHUNK_BOUNDARY_LOOKBACK: usize = 200;

/// Split UTF-8 text into overlapping chunks suitable for embedding. Tries to
/// break on paragraph (double-newline), then on sentence punctuation, then
/// on word boundaries; falls back to a hard char cut if no boundary is near.
/// Returns `(char_start, char_end, text)` triples using BYTE offsets (the
/// embedding never sees offsets, but they're useful for highlighting back to
/// the source file in a future v2 feature).
pub(crate) fn chunk_text(text: &str) -> Vec<(usize, usize, String)> {
    // Work in chars to keep all arithmetic safe across multi-byte UTF-8.
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let total = chars.len();
    let mut out: Vec<(usize, usize, String)> = Vec::new();
    let mut start_idx: usize = 0;
    while start_idx < total {
        let target_end = (start_idx + CHUNK_TARGET_CHARS).min(total);
        let end_idx = if target_end == total {
            total
        } else {
            // Look back from target_end for a paragraph break, then a
            // sentence end, then a word boundary — see CHUNK_BOUNDARY_LOOKBACK.
            let lookback_floor = target_end.saturating_sub(CHUNK_BOUNDARY_LOOKBACK);
            let slice = &chars[lookback_floor..target_end];
            let mut best: Option<usize> = None;
            // Prefer paragraph breaks (\n\n).
            for i in (0..slice.len()).rev() {
                if slice[i].1 == '\n' && i > 0 && slice[i - 1].1 == '\n' {
                    best = Some(lookback_floor + i + 1);
                    break;
                }
            }
            // Then sentence-ending punctuation followed by whitespace.
            if best.is_none() {
                for i in (0..slice.len()).rev() {
                    let c = slice[i].1;
                    let next_ws = slice.get(i + 1).map(|(_, c)| c.is_whitespace()).unwrap_or(true);
                    if matches!(c, '.' | '!' | '?') && next_ws {
                        best = Some(lookback_floor + i + 1);
                        break;
                    }
                }
            }
            // Then plain whitespace.
            if best.is_none() {
                for i in (0..slice.len()).rev() {
                    if slice[i].1.is_whitespace() {
                        best = Some(lookback_floor + i + 1);
                        break;
                    }
                }
            }
            best.unwrap_or(target_end)
        };
        let byte_start = chars[start_idx].0;
        let byte_end = if end_idx < total {
            chars[end_idx].0
        } else {
            text.len()
        };
        let chunk = text[byte_start..byte_end].trim().to_string();
        if !chunk.is_empty() {
            out.push((byte_start, byte_end, chunk));
        }
        if end_idx >= total {
            break;
        }
        // Advance with overlap. Subtract overlap from end_idx; clamp so we
        // always make forward progress (defensive against tiny chunks).
        let next = end_idx.saturating_sub(CHUNK_OVERLAP_CHARS).max(start_idx + 1);
        start_idx = next;
    }
    out
}

/// Pack an f32 slice to a SQLite BLOB. Brute-force cosine search reads
/// these back in the same layout — no padding, no header. Matches the
/// column declared as `BLOB NOT NULL` in the schema.
///
/// `bytemuck::cast_slice` reinterprets the `&[f32]` as `&[u8]` in NATIVE
/// byte order, then we copy into a `Vec<u8>`. Every platform Ekorbia
/// targets (x86_64, aarch64-darwin, aarch64-linux) is little-endian, so
/// the on-disk BLOB stays effectively LE. If a big-endian port ever lands
/// the round-trip is still self-consistent because `unpack_embedding`
/// reads in matching byte order (see below).
pub(crate) fn pack_embedding(v: &[f32]) -> Vec<u8> {
    bytemuck::cast_slice(v).to_vec()
}

/// Reverse of `pack_embedding`. SQLite hands back the BLOB as a `Vec<u8>`
/// with 1-byte alignment, so we cannot use `bytemuck::cast_slice::<u8, f32>`
/// directly — it would panic on the alignment mismatch. The `chunks_exact(4)`
/// loop reads four bytes at a time without requiring any alignment, and
/// `f32::from_le_bytes` keeps the byte order explicitly little-endian to
/// match `pack_embedding` on every host we currently build for. Trailing
/// bytes (`b.len() % 4 != 0`) are dropped silently — a corrupt BLOB would
/// have to be wrong by exactly 1-3 bytes to hit this path, and degrading
/// gracefully beats a panic mid-search.
///
/// Test-only since the score-in-place retrieval path (`cosine_blob_with_query`)
/// folds bytes directly without ever building a `Vec<f32>`. Kept around as
/// the reference implementation that the test suite uses to validate the
/// in-place path's results.
#[cfg(test)]
pub(crate) fn unpack_embedding(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Test-only reference cosine. Production scoring goes through
/// `cosine_blob_with_query`; this is the unallocated-vector oracle that the
/// test suite cross-validates against.
#[cfg(test)]
pub(crate) fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0_f32;
    let mut na = 0.0_f32;
    let mut nb = 0.0_f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

/// Sum of squares (L2 norm squared) of an `f32` slice. Pulled out so the
/// retrieval hot path can compute the query magnitude ONCE per call and
/// reuse it for every candidate, instead of recomputing inside the cosine
/// loop. Returning the squared norm (not the sqrt) lets the caller defer
/// the sqrt to denominator-time, which keeps the math identical to
/// `cosine_similarity` to within float rounding.
pub(crate) fn norm_squared(v: &[f32]) -> f32 {
    let mut s = 0.0_f32;
    for x in v {
        s += x * x;
    }
    s
}

/// Cosine similarity between a query vector `q` (already in memory as `f32`)
/// and a candidate vector stored as a little-endian f32 BLOB. Folds the BLOB
/// bytes inline — no intermediate `Vec<f32>` allocation. The query's squared
/// norm is precomputed by the caller and passed in so it's not recomputed
/// per row.
///
/// Returns `None` on dimension mismatch (candidate vs query) so a single
/// stray row with the wrong dimensionality doesn't poison rankings. The
/// retrieval query already filters by `embed_model`, so a mismatch here
/// implies corrupt data, but defensive is cheap.
pub(crate) fn cosine_blob_with_query(
    q: &[f32],
    q_norm_sq: f32,
    blob: &[u8],
) -> Option<f32> {
    if q.is_empty() {
        return None;
    }
    let mut dot = 0.0_f32;
    let mut na = 0.0_f32;
    let mut count: usize = 0;
    for c in blob.chunks_exact(4) {
        if count >= q.len() {
            // Candidate has more floats than the query — dimension mismatch.
            return None;
        }
        let x = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        dot += q[count] * x;
        na += x * x;
        count += 1;
    }
    if count != q.len() {
        return None;
    }
    let denom = na.sqrt() * q_norm_sq.sqrt();
    if denom == 0.0 {
        Some(0.0)
    } else {
        Some(dot / denom)
    }
}

// ── Status events ───────────────────────────────────────────────────────────

/// Update an attachment's status (and optional error). Emits an
/// `attachment:status_changed` Tauri event so the chip can re-render
/// without polling. Status is one of: 'ready' | 'indexing' | 'error'.
///
/// Returns `Result<(), String>` for the one caller that propagates the
/// error (`pipeline.rs::index_attachment` short-circuits on early status
/// failures). All other callers fire-and-forget with `let _ = ...`;
/// for those, internal `log_warn!` ensures the failure surfaces in stderr
/// even when the Result is dropped.
pub(crate) fn set_attachment_status(
    app: &tauri::AppHandle,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| {
            log_warn!("set_attachment_status({id}, {status}): lock poisoned: {e}");
            e.to_string()
        })?;
        db.execute(
            "UPDATE attachments SET status = ?1, error = ?2 WHERE id = ?3",
            (status, error, id),
        )
        .map_err(|e| {
            log_warn!("set_attachment_status({id}, {status}): db update failed: {e}");
            e.to_string()
        })?;
    }
    let _ = app.emit(
        "attachment:status_changed",
        &AttachmentStatusEvent {
            id: id.to_string(),
            status: status.to_string(),
            error: error.map(|s| s.to_string()),
            ..Default::default()
        },
    );
    Ok(())
}

/// Folder-progress variant of set_attachment_status. Doesn't touch the DB —
/// just emits a fresh event so the UI's "(N/M indexed)" counter updates.
/// The chunks/sources rows already track the real state; this is a hint to
/// the UI for live progress.
pub(crate) fn emit_folder_progress(app: &tauri::AppHandle, id: &str, done: u32, total: u32) {
    let _ = app.emit(
        "attachment:status_changed",
        &AttachmentStatusEvent {
            id: id.to_string(),
            status: "indexing".to_string(),
            done: Some(done),
            total: Some(total),
            phase: Some("embedding".to_string()),
            ..Default::default()
        },
    );
}

/// Emit a phase-only event (no done/total) so the chip can show transient
/// labels like "walking…" before the walker has counted files. Doesn't
/// touch the DB.
pub(crate) fn emit_attachment_phase(app: &tauri::AppHandle, id: &str, phase: &str) {
    let _ = app.emit(
        "attachment:status_changed",
        &AttachmentStatusEvent {
            id: id.to_string(),
            status: "indexing".to_string(),
            phase: Some(phase.to_string()),
            ..Default::default()
        },
    );
}

/// Update file_count on a folder attachment. Called incrementally during
/// the walk so reopening a chat shows accurate counts even mid-index. Bound
/// to a separate function so we don't accidentally clobber other columns.
/// All callers `let _ =` this; failures log internally via `log_warn!` so
/// they're not silently swallowed.
pub(crate) fn set_attachment_file_count(
    app: &tauri::AppHandle,
    id: &str,
    count: i64,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let db = state.0.lock().map_err(|e| {
        log_warn!("set_attachment_file_count({id}): lock poisoned: {e}");
        e.to_string()
    })?;
    db.execute(
        "UPDATE attachments SET file_count = ?1 WHERE id = ?2",
        (count, id),
    )
    .map_err(|e| {
        log_warn!("set_attachment_file_count({id}): db update failed: {e}");
        e.to_string()
    })?;
    Ok(())
}

// ── Index pipeline (single-file) ────────────────────────────────────────────

/// Background indexing task: extract → chunk → embed → write chunks. Errors
/// route to the attachment's `error` column and flip status to 'error' so
/// the UI can surface them. Always emits an `attachment:status_changed`
/// event on completion (success or failure).
pub(crate) async fn index_attachment(
    app: tauri::AppHandle,
    id: String,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    // Helper: check cancellation and short-circuit. We sprinkle this at
    // every async boundary — extraction, embedding, DB write — so a
    // detach during indexing aborts within a few hundred ms at worst.
    // Relaxed ordering: one-shot publish/poll, no piggybacked data — see
    // `cancel_index`'s comment.
    macro_rules! check_cancelled {
        () => {
            if cancel.load(Ordering::Relaxed) { return Ok(()); }
        };
    }

    check_cancelled!();
    // 1. Read path + kind from DB (small read; release the lock immediately).
    let (path, kind) = {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        db.query_row(
            "SELECT path, kind FROM attachments WHERE id = ?1",
            [&id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?
    };
    if kind != "text" {
        // Nothing to do — images stay 'ready' and never come through here.
        return Ok(());
    }
    check_cancelled!();
    // 2. Extract text from the file using the shared helper.
    let text = match extract_text_from_file(Path::new(&path)).await {
        Ok(s) => s,
        Err(e) => {
            check_cancelled!();
            let _ = set_attachment_status(&app, &id, "error", Some(&format!("Extract failed: {e}")));
            return Err(e);
        }
    };
    check_cancelled!();
    // 3. Chunk. If the extracted text turns out small (e.g. an image-heavy
    //    PDF that only has a few words), skip the embedding round-trip and
    //    just flip status back to 'ready' so the file gets inlined at send.
    if text.len() <= SMALL_TEXT_THRESHOLD {
        // Clear any chunks an earlier index attempt may have written.
        // Non-fatal if it errors — stale chunks would just stick around
        // and get overwritten by the next index. Logged so persistent
        // failures are visible.
        {
            let state = app.state::<DbState>();
            let db = state.0.lock().map_err(|e| e.to_string())?;
            if let Err(e) =
                db.execute("DELETE FROM attachment_chunks WHERE attachment_id = ?1", [&id])
            {
                log_warn!("clear-chunks for {id} failed: {e}");
            }
        }
        let _ = set_attachment_status(&app, &id, "ready", None);
        return Ok(());
    }
    let chunks = chunk_text(&text);
    if chunks.is_empty() {
        let _ = set_attachment_status(&app, &id, "error", Some("Nothing to index"));
        return Err("Nothing to index".to_string());
    }
    check_cancelled!();
    // 4. Embed all chunks in one batched call.
    let texts: Vec<String> = chunks.iter().map(|(_, _, s)| s.clone()).collect();
    let embed_model = current_embedding_model(&app);
    let embeddings = match ollama_embed(&embed_model, &texts).await {
        Ok(v) => v,
        Err(e) => {
            check_cancelled!();
            let _ = set_attachment_status(&app, &id, "error", Some(&e));
            return Err(e);
        }
    };
    check_cancelled!();
    if embeddings.len() != chunks.len() {
        let msg = format!(
            "Embedding count mismatch ({} chunks → {} embeddings)",
            chunks.len(),
            embeddings.len()
        );
        let _ = set_attachment_status(&app, &id, "error", Some(&msg));
        return Err(msg);
    }
    // 5. Write chunks. Clear any prior chunks for this attachment first so a
    //    re-index doesn't accumulate duplicates. Wrap in a transaction so a
    //    mid-write failure doesn't leave partial state.
    {
        let state = app.state::<DbState>();
        let mut db = state.0.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM attachment_chunks WHERE attachment_id = ?1", [&id])
            .map_err(|e| e.to_string())?;
        for (i, ((start, end, chunk_text), emb)) in chunks.iter().zip(embeddings.iter()).enumerate() {
            let blob = pack_embedding(emb);
            tx.execute(
                "INSERT INTO attachment_chunks \
                 (attachment_id, ordinal, text, embedding, embed_model, char_start, char_end) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                (
                    &id,
                    i as i64,
                    chunk_text,
                    blob,
                    &embed_model,
                    *start as i64,
                    *end as i64,
                ),
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    let _ = set_attachment_status(&app, &id, "ready", None);
    Ok(())
}

// ── Retrieval ────────────────────────────────────────────────────────────────

/// Retrieve the top-k chunks across all ready, embedded attachments for a
/// chat. Uses brute-force cosine over BLOBs — fine for tens of thousands of
/// chunks; if a future user hits scale issues we'll swap in sqlite-vec.
pub(crate) async fn retrieve_chunks(
    app: &tauri::AppHandle,
    chat_id: &str,
    query: &str,
    top_k: usize,
) -> Result<Vec<RetrievedChunk>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    // Pull all chunks for the chat under lock, then drop lock before doing
    // any network I/O (the embed call below). LEFT JOIN on attachment_sources
    // so single-file attachments (source_id = NULL) still come back with a
    // NULL source_path rather than getting filtered out. Filtered by the
    // CURRENT embedding model so a settings change doesn't silently mix
    // dimensions — stale chunks become invisible until reindexed. The
    // `(attachment_id, embed_model)` composite index covers the JOIN +
    // filter pair so we don't scan attachment_chunks linearly.
    //
    // We materialise the embedding column as a raw `Vec<u8>` (the bytes
    // rusqlite already allocated for us) rather than parsing it into a
    // `Vec<f32>` up front. That parse is deferred to the scoring loop
    // below, which folds the bytes directly into the cosine accumulators
    // — saving one full-sized allocation per row (peak DB-side memory
    // halves on a query against a folder of tens of thousands of chunks).
    let embed_model = current_embedding_model(app);
    type CandidateRow = (String, Option<String>, String, Vec<u8>, i64, i64);
    let candidates: Vec<CandidateRow> = {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = db
            .prepare(
                "SELECT c.attachment_id, s.path, c.text, c.embedding, c.char_start, c.char_end \
                 FROM attachment_chunks c \
                 JOIN attachments a ON a.id = c.attachment_id \
                 LEFT JOIN attachment_sources s ON s.id = c.source_id \
                 WHERE a.chat_id = ?1 \
                   AND c.embed_model = ?2 \
                   AND a.status = 'ready'",
            )
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map((chat_id, embed_model.as_str()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        it.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    // Embed the query and precompute its squared norm. The norm goes into
    // every cosine call below; computing it once here saves N×D float ops
    // across the loop.
    let q_embed = match ollama_embed(&embed_model, &[query.to_string()]).await {
        Ok(mut v) => v.pop().ok_or("Empty query embedding")?,
        Err(e) => return Err(e),
    };
    let q_norm_sq = norm_squared(&q_embed);
    // Score and rank. Rows whose stored embedding dimensionality doesn't
    // match the query's are dropped silently — this can only happen if a
    // chunk row sneaks past the `embed_model` filter (e.g. corrupted BLOB
    // or an old row written before the dimensionality was locked to model).
    let mut scored: Vec<RetrievedChunk> = candidates
        .into_iter()
        .filter_map(|(attachment_id, source_path, text, blob, char_start, char_end)| {
            cosine_blob_with_query(&q_embed, q_norm_sq, &blob).map(|score| RetrievedChunk {
                attachment_id,
                source_path,
                text,
                score,
                char_start,
                char_end,
            })
        })
        .collect();
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_k);
    Ok(scored)
}

/// **Async safety**: the `DbState` lock is held only in the kind-lookup
/// block (ending with `};`); subsequent `set_attachment_status` + spawn
/// calls each take their own short-lived lock and release before any await.
/// See CLAUDE.md "DB lock held across await deadlocks".
#[tauri::command]
pub(crate) async fn attachment_reindex(app: tauri::AppHandle, id: String) -> Result<(), String> {
    // Lookup kind so we know which pipeline to drive. Default to file
    // pipeline on any read failure — index_attachment is no-op on images.
    let kind = {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        db.query_row(
            "SELECT kind FROM attachments WHERE id = ?1",
            [&id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "text".to_string())
    };
    set_attachment_status(&app, &id, "indexing", None)?;
    // Reindex registers a fresh cancel flag (overwriting any prior one
    // from the original add). The token's Drop clears the entry when
    // this function returns — covers the panic path inline too.
    let token = register_cancel(&id);
    let cancel = token.flag.clone();
    let result = if kind == "folder" {
        crate::attachments::folder::index_folder(app, id.clone(), cancel).await
    } else {
        index_attachment(app, id.clone(), cancel).await
    };
    drop(token); // explicit for clarity — would happen at end of scope anyway
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── chunk_text ─────────────────────────────────────────────────────────

    #[test]
    fn chunk_text_empty_returns_empty() {
        assert!(chunk_text("").is_empty());
    }

    #[test]
    fn chunk_text_short_text_single_chunk() {
        // Under CHUNK_TARGET_CHARS (1000) → exactly one chunk, full text.
        let text = "Hello, world. This is a short test.";
        let chunks = chunk_text(text);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].2, text);
        // Byte offsets cover the whole string.
        assert_eq!(chunks[0].0, 0);
        assert_eq!(chunks[0].1, text.len());
    }

    #[test]
    fn chunk_text_prefers_paragraph_boundary() {
        // Build text that crosses CHUNK_TARGET_CHARS with a paragraph break
        // inside the 200-char lookback window. The first chunk must end at
        // the paragraph break, not at the hard target.
        let para_a = "a".repeat(CHUNK_TARGET_CHARS - 50);
        let para_b = "b".repeat(200);
        let text = format!("{para_a}\n\n{para_b}");
        let chunks = chunk_text(&text);
        assert!(chunks.len() >= 2, "expected ≥2 chunks, got {}", chunks.len());
        // First chunk should be just `aaaa…` — the paragraph break is the
        // boundary, so no `b` characters leak in.
        assert!(
            !chunks[0].2.contains('b'),
            "first chunk leaked across paragraph break: {:?}",
            &chunks[0].2[..40.min(chunks[0].2.len())]
        );
    }

    #[test]
    fn chunk_text_falls_back_to_hard_cut_when_no_boundary() {
        // No paragraph, no sentence, no whitespace in the 200-char lookback
        // → hand-rolled fallback uses target_end as a hard cut. This means
        // the chunker still makes forward progress on pathological input.
        let text = "x".repeat(CHUNK_TARGET_CHARS + 500);
        let chunks = chunk_text(&text);
        assert!(chunks.len() >= 2, "expected ≥2 chunks");
        // Forward progress: every chunk has non-zero length.
        for (i, (s, e, t)) in chunks.iter().enumerate() {
            assert!(e > s, "chunk {i} has empty byte range");
            assert!(!t.is_empty(), "chunk {i} text is empty");
        }
    }

    #[test]
    fn chunk_text_handles_multibyte_utf8() {
        // Mostly-emoji text — char counting must drive boundaries, byte
        // offsets must land on char boundaries. Failure mode would be a
        // panic from slicing mid-codepoint.
        let text = "🦀".repeat(CHUNK_TARGET_CHARS + 100);
        let chunks = chunk_text(&text);
        assert!(!chunks.is_empty());
        // Every reported byte range must slice into valid UTF-8.
        for (s, e, _) in &chunks {
            let slice = &text[*s..*e];
            assert!(std::str::from_utf8(slice.as_bytes()).is_ok());
        }
    }

    // ── pack / unpack embedding ────────────────────────────────────────────

    #[test]
    fn pack_unpack_round_trip() {
        let v = vec![1.0_f32, -2.5, 0.0, std::f32::consts::PI, f32::MIN, f32::MAX];
        let packed = pack_embedding(&v);
        assert_eq!(packed.len(), v.len() * 4);
        let unpacked = unpack_embedding(&packed);
        assert_eq!(unpacked, v);
    }

    #[test]
    fn pack_empty_is_empty() {
        assert!(pack_embedding(&[]).is_empty());
        assert!(unpack_embedding(&[]).is_empty());
    }

    // ── cosine_similarity ──────────────────────────────────────────────────

    #[test]
    fn cosine_identical_vectors_is_one() {
        let v = vec![1.0, 2.0, 3.0];
        // Floating-point — compare within epsilon.
        assert!((cosine_similarity(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_orthogonal_vectors_is_zero() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        assert!(cosine_similarity(&a, &b).abs() < 1e-6);
    }

    #[test]
    fn cosine_opposite_vectors_is_negative_one() {
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![-1.0, -2.0, -3.0];
        assert!((cosine_similarity(&a, &b) - (-1.0)).abs() < 1e-6);
    }

    #[test]
    fn cosine_mismatched_lengths_returns_zero() {
        let a = vec![1.0, 2.0];
        let b = vec![1.0, 2.0, 3.0];
        // Defensive contract: must not panic and must not return a bogus
        // similarity from an undefined dot product.
        assert_eq!(cosine_similarity(&a, &b), 0.0);
    }

    #[test]
    fn cosine_empty_returns_zero() {
        let v: Vec<f32> = vec![];
        assert_eq!(cosine_similarity(&v, &v), 0.0);
    }

    #[test]
    fn cosine_zero_vector_returns_zero() {
        // Denominator is zero → guard avoids NaN. Caller treats this as
        // "no signal" which is correct for an all-zero embedding.
        let a = vec![0.0, 0.0, 0.0];
        let b = vec![1.0, 2.0, 3.0];
        assert_eq!(cosine_similarity(&a, &b), 0.0);
    }

    // ── norm_squared / cosine_blob_with_query ──────────────────────────────

    #[test]
    fn norm_squared_matches_manual_sum_of_squares() {
        let v = vec![3.0_f32, 4.0]; // 3² + 4² = 25
        assert!((norm_squared(&v) - 25.0).abs() < 1e-6);
        assert_eq!(norm_squared(&[]), 0.0);
    }

    #[test]
    fn cosine_blob_matches_reference_cosine_on_round_trip() {
        // The score-in-place path must agree with the reference cosine
        // implementation (the production scoring oracle). Pick a vector
        // with mixed signs and non-trivial magnitude so we exercise both
        // dot and norm accumulation.
        let q = vec![0.5_f32, -1.0, 2.0, 3.5];
        let cand = vec![1.0_f32, 1.0, -1.0, 4.0];
        let packed = pack_embedding(&cand);
        let q_norm_sq = norm_squared(&q);
        let inline = cosine_blob_with_query(&q, q_norm_sq, &packed)
            .expect("matching dimensions should yield a score");
        let reference = cosine_similarity(&q, &cand);
        // 1e-5 not 1e-6 — the two implementations sum in different orders
        // (the in-place path doesn't carry a separate q-norm accumulator)
        // so rounding bits can differ by a few ULPs even on simple inputs.
        assert!(
            (inline - reference).abs() < 1e-5,
            "in-place {inline} != reference {reference}"
        );
    }

    #[test]
    fn cosine_blob_dimension_mismatch_returns_none() {
        // Candidate has 3 floats, query has 4 → defensive return None so
        // a single mis-dimensioned row can't poison the ranking. (In
        // practice the `embed_model` filter prevents this; the guard
        // covers corrupt-BLOB edge cases.)
        let q = vec![1.0_f32, 2.0, 3.0, 4.0];
        let cand = vec![1.0_f32, 2.0, 3.0];
        let packed = pack_embedding(&cand);
        let q_norm_sq = norm_squared(&q);
        assert!(cosine_blob_with_query(&q, q_norm_sq, &packed).is_none());

        // Candidate longer than query → also None.
        let cand_long = vec![1.0_f32, 2.0, 3.0, 4.0, 5.0];
        let packed_long = pack_embedding(&cand_long);
        assert!(cosine_blob_with_query(&q, q_norm_sq, &packed_long).is_none());
    }

    #[test]
    fn cosine_blob_zero_query_returns_zero_not_nan() {
        // q has zero magnitude → denominator is zero. The function must
        // emit Some(0.0), not None (it's not a dimension issue) and not
        // NaN (the early-return guards the divide).
        let q = vec![0.0_f32, 0.0, 0.0];
        let cand = vec![1.0_f32, 2.0, 3.0];
        let packed = pack_embedding(&cand);
        let q_norm_sq = norm_squared(&q); // == 0.0
        let score = cosine_blob_with_query(&q, q_norm_sq, &packed);
        assert_eq!(score, Some(0.0));
    }

    #[test]
    fn cosine_blob_empty_query_returns_none() {
        // An empty query embedding has no semantic meaning — return None
        // so the row is filtered out of the score list entirely.
        let q: Vec<f32> = vec![];
        let cand = vec![1.0_f32, 2.0, 3.0];
        let packed = pack_embedding(&cand);
        assert!(cosine_blob_with_query(&q, 0.0, &packed).is_none());
    }

    #[test]
    fn cosine_blob_identical_vectors_score_one() {
        // Sanity: identical vectors → cosine of 1, regardless of magnitude.
        let v = vec![2.0_f32, -3.0, 5.0, 1.0];
        let packed = pack_embedding(&v);
        let n = norm_squared(&v);
        let score = cosine_blob_with_query(&v, n, &packed)
            .expect("identical dims should score");
        assert!(
            (score - 1.0).abs() < 1e-5,
            "expected ~1.0 for identical vectors, got {score}"
        );
    }
}
