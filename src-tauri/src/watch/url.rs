// SPDX-License-Identifier: MIT

//! URL-kind pipeline: fetch a page, apply the optional CSS selector, and
//! summarise either the whole new page (snapshot mode) or a unified line
//! diff against the prior snapshot (diff mode). Snapshot content is
//! persisted to `watches.last_content` after `process_item` succeeds.

use crate::db::DbState;
use crate::log::log_warn;
use crate::watch::http::{fetch_url_html, html_to_text_with_selector};
use crate::watch::pipeline::{
    flush_notify_batch, is_cancelled, new_notify_batch, process_item, record_fetch_error,
    resolve_system_msg,
};
use crate::watch::Watch;
use std::sync::atomic::AtomicBool;
use tauri::Manager;

/// `last_content` is capped at ~200KB so a single bloated page can't
/// fatten the watches row to multi-MB. Truncation cuts on a char
/// boundary; for diff purposes this means the very end of huge pages
/// is invisible — a fine tradeoff at this scale.
const URL_CONTENT_STORE_CAP: usize = 200_000;

/// Cap on the diff payload sent to the model. Either limit triggers
/// truncation, whichever first. We pick 200KB to match the storage cap
/// (a full-page replacement diff can't realistically exceed it twice over)
/// and 500 lines to keep the model's attention bounded even when the diff
/// is dense (e.g. a JSON file with one change per line).
const DIFF_PAYLOAD_CAP_BYTES: usize = 200_000;
const DIFF_PAYLOAD_CAP_LINES: usize = 500;

fn truncate_for_storage(s: &str) -> String {
    if s.len() <= URL_CONTENT_STORE_CAP {
        return s.to_string();
    }
    // Find the largest char boundary ≤ cap so we don't split a multi-byte
    // codepoint. `floor_char_boundary` is unstable; do it by hand.
    let mut end = URL_CONTENT_STORE_CAP;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Persist a freshly-extracted URL snapshot. Capped at
/// `URL_CONTENT_STORE_CAP` so the watches row stays small even if the
/// page is huge. Returning `()` because a failed store is non-fatal —
/// the next poll will just re-detect a change and try again.
fn update_watch_content(app: &tauri::AppHandle, watch_id: &str, content: &str) {
    let stored = truncate_for_storage(content);
    let db = app.state::<DbState>();
    let Ok(conn) = db.0.lock() else {
        return;
    };
    if let Err(e) = conn.execute(
        "UPDATE watches SET last_content = ?1 WHERE id = ?2",
        (&stored, watch_id),
    ) {
        log_warn!("watch '{watch_id}': update last_content failed: {e}");
    }
}

/// Build the text we send to the model in URL diff mode. A unified diff
/// with 3 lines of context, prefixed with a one-line orienting header so
/// the model knows it's reading "what changed" rather than a fresh page.
///
/// Capped at `DIFF_PAYLOAD_CAP_BYTES` / `DIFF_PAYLOAD_CAP_LINES` (whichever
/// hits first). When truncated, a `[diff truncated …]` marker is appended
/// so the model knows it's reading a partial diff rather than a complete
/// before/after picture.
fn build_diff_payload(page_url: &str, prev: &str, current: &str) -> String {
    use similar::TextDiff;
    use std::fmt::Write as _;
    let diff = TextDiff::from_lines(prev, current);
    let mut buf = String::new();
    let _ = write!(
        buf,
        "The watched URL ({page_url}) has changed since the last poll. \
         Below is a unified line diff of the visible page text — lines \
         starting with `-` were removed, lines starting with `+` were \
         added, and unchanged context lines show without prefix. \
         Summarise what was added, removed, or otherwise changed.\n\n"
    );
    let mut lines_emitted: usize = 0;
    let mut truncated = false;
    for hunk in diff.unified_diff().context_radius(3).iter_hunks() {
        let hunk_text = format!("{hunk}\n");
        let hunk_lines = hunk_text.lines().count();
        if buf.len() + hunk_text.len() > DIFF_PAYLOAD_CAP_BYTES
            || lines_emitted + hunk_lines > DIFF_PAYLOAD_CAP_LINES
        {
            truncated = true;
            break;
        }
        buf.push_str(&hunk_text);
        lines_emitted += hunk_lines;
    }
    if truncated {
        let _ = write!(
            buf,
            "\n[diff truncated — limits: {DIFF_PAYLOAD_CAP_BYTES} bytes / \
             {DIFF_PAYLOAD_CAP_LINES} lines. Some changes are not shown.]\n"
        );
    }
    buf
}

/// URL-kind pipeline. Fetches the page, applies the optional CSS selector,
/// and only summarises when the extracted text differs from the previously
/// stored `last_content`. The dedup key for `watch_events` is
/// `{url}#{timestamp}` so each successful run creates a fresh row in the
/// activity feed; `already_processed` is intentionally bypassed because
/// content-hash comparison (via `last_content`) is the real change-detector.
pub(crate) async fn run_url_watch(app: &tauri::AppHandle, watch: &Watch, cancel: &AtomicBool) {
    let Some(page_url) = watch.source_url.as_deref().filter(|s| !s.is_empty()) else {
        log_warn!("watch '{}': URL kind has no source_url", watch.name);
        return;
    };
    // Pre-fetch cancel check. The URL fetch + extraction is quick relative
    // to the LLM call, but if the user already toggled off there's no
    // point spending bandwidth either.
    if is_cancelled(cancel) {
        return;
    }

    // One batch per poll cycle. URL kind only produces 0 or 1 entries per
    // cycle, but we keep the batch/flush pattern for uniformity (and so
    // fetch-level errors still feed the coalesced banner).
    let mut notify_batch = new_notify_batch();

    let html = match fetch_url_html(page_url).await {
        Ok(h) => h,
        Err(e) => {
            log_warn!("watch '{}': fetch URL: {e}", watch.name);
            record_fetch_error(app, &watch.id, page_url, page_url, &e, &mut notify_batch);
            flush_notify_batch(app, watch, &notify_batch);
            return;
        }
    };

    let extracted = html_to_text_with_selector(&html, watch.url_selector.as_deref());

    if extracted.trim().is_empty() {
        log_warn!(
            "watch '{}': URL extraction empty for {page_url}",
            watch.name
        );
        return;
    }

    // Snapshot dedup: compare against the previously stored content.
    // On first fetch (last_content = None) we always proceed so the
    // user gets an initial summary.
    if let Some(prev) = watch.last_content.as_deref() {
        if prev == extracted {
            return;
        }
    }

    // Unique per-snapshot ID. We never want `already_processed` to
    // short-circuit a URL run (the real change-detector is content
    // diffing), so suffix with `now` to guarantee a fresh memo row.
    let item_id = format!("{page_url}#{}", crate::db::now_unix());
    let label = page_url.to_string();

    // Diff mode decision:
    //   • 'diff' AND there's a prior snapshot → send the unified diff
    //   • everything else (incl. first fetch in diff mode) → send the
    //     full page so the user gets a useful baseline summary.
    let mode = watch
        .url_diff_mode
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("snapshot");

    let text_for_model = match (mode, watch.last_content.as_deref()) {
        ("diff", Some(prev)) => build_diff_payload(page_url, prev, &extracted),
        _ => extracted.clone(),
    };

    // URL kind only fires once per cycle, but use the shared resolver for
    // symmetry with folder/RSS — keeps the pipeline-API call shape uniform.
    let system_msg = resolve_system_msg(app, watch);

    if let Err(e) = process_item(
        app,
        watch,
        &system_msg,
        &item_id,
        &label,
        text_for_model,
        &mut notify_batch,
        cancel,
    )
    .await
    {
        log_warn!("watch '{}': process_item URL {page_url}: {e}", watch.name);
        // On model failure don't update `last_content` — that way the next
        // poll re-detects the change and retries. Same applies to a
        // cancelled cycle: leaving `last_content` unchanged means the
        // next poll re-detects the diff and re-summarises.
        flush_notify_batch(app, watch, &notify_batch);
        return;
    }

    update_watch_content(app, &watch.id, &extracted);
    flush_notify_batch(app, watch, &notify_batch);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_for_storage_short_string_unchanged() {
        let s = "hello world";
        assert_eq!(truncate_for_storage(s), s);
    }

    #[test]
    fn truncate_for_storage_at_cap_unchanged() {
        let s: String = "a".repeat(URL_CONTENT_STORE_CAP);
        assert_eq!(truncate_for_storage(&s).len(), URL_CONTENT_STORE_CAP);
    }

    #[test]
    fn truncate_for_storage_over_cap_truncates() {
        let s: String = "a".repeat(URL_CONTENT_STORE_CAP + 50);
        let out = truncate_for_storage(&s);
        assert!(out.len() <= URL_CONTENT_STORE_CAP, "got len {}", out.len());
    }

    #[test]
    fn truncate_for_storage_respects_char_boundary() {
        // 'é' is two UTF-8 bytes. Build a string whose byte length straddles
        // the cap so a naive slice would split mid-codepoint. The hand-rolled
        // boundary walk must back off to a safe boundary.
        let prefix_len = URL_CONTENT_STORE_CAP - 1; // 1 byte short of cap
        let mut s = "a".repeat(prefix_len);
        s.push('é'); // pushes 2 bytes — now s.len() == cap + 1
        s.push_str("xyz"); // pad past the cap
        assert!(s.len() > URL_CONTENT_STORE_CAP);
        let out = truncate_for_storage(&s);
        // Must not panic, must be at or under cap, and must be valid UTF-8.
        assert!(out.len() <= URL_CONTENT_STORE_CAP);
        // Sanity: re-parsing the bytes is a no-op for a &str (already valid),
        // but std::str::from_utf8 on the bytes proves no codepoint was split.
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }

    #[test]
    fn build_diff_payload_includes_header_and_diff() {
        let prev = "line one\nline two\nline three\n";
        let cur = "line one\nline TWO\nline three\n";
        let out = build_diff_payload("https://example.com", prev, cur);
        assert!(
            out.contains("https://example.com"),
            "header missing url: {out}"
        );
        assert!(out.contains("unified line diff"), "header missing: {out}");
        // Both the removed and added lines should appear in the hunk.
        assert!(out.contains("-line two"), "removed line missing: {out}");
        assert!(out.contains("+line TWO"), "added line missing: {out}");
    }

    #[test]
    fn build_diff_payload_no_changes_still_emits_header() {
        // Edge: identical input. We don't expect run_url_watch to call this
        // (it short-circuits on equal extracted text) but the helper itself
        // should still produce a coherent payload rather than panic.
        let s = "line one\nline two\n";
        let out = build_diff_payload("https://example.com", s, s);
        assert!(out.contains("https://example.com"));
    }

    #[test]
    fn build_diff_payload_small_diff_not_truncated() {
        // A handful of changes should never trigger the cap, and the
        // truncation marker must not be present.
        let prev = "alpha\nbeta\ngamma\n";
        let cur = "alpha\nBETA\ngamma\n";
        let out = build_diff_payload("https://example.com", prev, cur);
        assert!(
            !out.contains("[diff truncated"),
            "small diff should not truncate, got: {out}"
        );
    }

    #[test]
    fn build_diff_payload_caps_by_line_count() {
        // Build a `current` text with many distinct lines so the diff has
        // far more than DIFF_PAYLOAD_CAP_LINES hunks. (`from_lines` will
        // emit each as a separate addition.)
        let prev = String::new();
        let cur: String = (0..DIFF_PAYLOAD_CAP_LINES * 2)
            .map(|i| format!("line {i}\n"))
            .collect();
        let out = build_diff_payload("https://example.com", &prev, &cur);
        assert!(
            out.contains("[diff truncated"),
            "expected truncation marker in oversized diff"
        );
        // The marker must mention both caps so a debugging maintainer
        // immediately sees the policy.
        assert!(out.contains("bytes"));
        assert!(out.contains("lines"));
    }

    #[test]
    fn build_diff_payload_truncated_diff_still_includes_header() {
        // Even when the very first hunk exceeds the cap (e.g. empty → big
        // file = one giant addition hunk), the orienting header must still
        // be present so the model knows what the truncation marker refers
        // to. Without the header, the model would just see "[diff truncated]"
        // with no context.
        let prev = String::new();
        let cur: String = (0..DIFF_PAYLOAD_CAP_LINES * 2)
            .map(|i| format!("line {i}\n"))
            .collect();
        let out = build_diff_payload("https://example.com", &prev, &cur);
        assert!(
            out.contains("[diff truncated"),
            "expected truncation marker"
        );
        // The orienting header must come before the truncation marker.
        let header_pos = out
            .find("unified line diff")
            .expect("header missing from truncated payload");
        let marker_pos = out.find("[diff truncated").unwrap();
        assert!(
            header_pos < marker_pos,
            "header must precede truncation marker"
        );
    }
}
