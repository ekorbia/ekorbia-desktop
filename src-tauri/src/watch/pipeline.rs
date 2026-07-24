// SPDX-License-Identifier: MIT

//! Watch pipeline shared infrastructure:
//! - event log helpers (`insert_event`, `already_processed`, `gen_event_id`)
//! - cadence-gate state (`load_enabled_watches`, `mark_watch_polled`)
//! - prompt + notes plumbing (`fetch_prompt_body`, `append_to_notes`)
//! - generic processor (`process_item`) used by every kind
//! - dispatcher (`run_watch`) + outer loop (`run_all_watches_inner`, `watch_poller`)

use crate::db::{now_unix, DbState};
use crate::llm::chat as llm_chat;
use crate::log::log_warn;
use crate::prompts::{parse_prompt_file, resolve_prompts_dir};
use crate::watch::cancel::register_cancel;
use crate::watch::folder::run_folder_watch;
use crate::watch::rss::run_rss_watch;
use crate::watch::url::run_url_watch;
use crate::watch::{map_watch_row, Watch, WATCH_COLUMNS, WATCH_POLL_SECS};
use std::io::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// Body used on the per-item event row when the user cancels mid-cycle.
/// Surfaces in the activity feed (red error row) so the user has clear
/// confirmation the toggle-off took effect on the in-flight item.
pub(crate) const WATCH_CANCELLED_MSG: &str = "Cancelled by user";

/// Convenience wrapper around the relaxed load. Inlined by the compiler;
/// reads at one site so changing the ordering (if we ever need acq/rel
/// for some piggybacked state) is a single edit.
#[inline]
pub(crate) fn is_cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::Relaxed)
}

/// Cap on notification body characters. OS banners truncate aggressively
/// (~256 on macOS); 280 leaves a small margin for OS-side ellipsis. We
/// `chars().take(...)` rather than byte-slice so multibyte glyphs aren't cut.
const NOTIFICATION_BODY_CAP: usize = 280;

/// Prompt-side cap on the text we feed to `ollama_chat` for a watch event.
/// Ollama's context window varies by model; ~12k chars is a safe envelope
/// for most 8k-token models without spending tokens we can't use.
const OLLAMA_PROMPT_CHAR_CAP: usize = 12_000;

pub(crate) fn gen_event_id() -> String {
    crate::db::gen_id("we")
}

/// Load every enabled watch. We re-read each polling tick so add/remove/
/// toggle take effect on the next iteration without restarting the task.
pub(crate) fn load_enabled_watches(app: &tauri::AppHandle) -> Result<Vec<Watch>, String> {
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let sql = format!("SELECT {WATCH_COLUMNS} FROM watches WHERE enabled = 1");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_watch_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Record `now` as the latest poll attempt for this watch. Called from
/// `run_watch` regardless of whether items were found — the cadence gate
/// in `run_all_watches` consults this column to decide whether to fire.
pub(crate) fn mark_watch_polled(app: &tauri::AppHandle, watch_id: &str) {
    let db = app.state::<DbState>();
    let Ok(conn) = db.0.lock() else {
        log_warn!("mark_watch_polled({watch_id}): lock poisoned");
        return;
    };
    if let Err(e) = conn.execute(
        "UPDATE watches SET last_polled_at = ?1 WHERE id = ?2",
        (now_unix(), watch_id),
    ) {
        // Non-fatal: the poller will retry on the next tick. If updates
        // start failing persistently, this watch will hammer the network
        // (its cadence gate breaks), so the log is the first signal.
        log_warn!("mark_watch_polled({watch_id}): update failed: {e}");
    }
}

/// True if (watch_id, file_path) has a 'done' event in the log already.
pub(crate) fn already_processed(
    app: &tauri::AppHandle,
    watch_id: &str,
    file_path: &str,
) -> Result<bool, String> {
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT 1 FROM watch_events \
             WHERE watch_id = ?1 AND file_path = ?2 AND status = 'done' LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    stmt.exists((watch_id, file_path))
        .map_err(|e| e.to_string())
}

pub(crate) fn insert_event(
    app: &tauri::AppHandle,
    event_id: &str,
    watch_id: &str,
    file_path: &str,
    status: &str,
    summary: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO watch_events \
         (id, watch_id, file_path, status, summary, error, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (
            event_id,
            watch_id,
            file_path,
            status,
            summary,
            error,
            now_unix(),
        ),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Shared "source-level fetch failed" handler for RSS + URL kinds. (Folder
/// kind has no fetch step — failures are per-file inside `process_file`.)
///
/// Three side effects in order:
///   1. Insert an `error` event into `watch_events` so the activity feed
///      shows it. Failure to insert is logged but non-fatal — the notify
///      batch is the user-visible signal.
///   2. Emit `watch:event_changed` so the UI's event list re-renders
///      without a full reload.
///   3. Push an entry into the caller's `notify_batch` so it coalesces with
///      any other outcomes in this cycle. Callers still flush the batch
///      themselves — this helper deliberately doesn't flush so multi-item
///      flows (RSS feed-fetch + per-entry follow) can accumulate.
///
/// `item_id` is the dedup key written to `watch_events.file_path` (typically
/// the feed URL or page URL for fetch-level failures). `item_label` is the
/// human-readable label shown in the OS notification.
pub(crate) fn record_fetch_error(
    app: &tauri::AppHandle,
    watch_id: &str,
    item_id: &str,
    item_label: &str,
    error: &str,
    notify_batch: &mut NotifyBatch,
) {
    let event_id = gen_event_id();
    if let Err(e) = insert_event(
        app,
        &event_id,
        watch_id,
        item_id,
        "error",
        None,
        Some(error),
    ) {
        crate::log::log_warn!("record_fetch_error: insert_event failed for {watch_id}: {e}");
    }
    let _ = app.emit("watch:event_changed", &event_id);
    notify_batch.push(NotifyEntry {
        success: false,
        item_label: item_label.to_string(),
        detail: error.to_string(),
    });
}

/// Look up a prompt's body by slug. Returns Ok(None) when the file is
/// missing (e.g. the user deleted the prompt after wiring it to a watch) so
/// callers can fall back to the default instruction without panicking.
/// Reads from the configured prompts directory and parses the same
/// frontmatter+body format used everywhere else.
fn fetch_prompt_body(app: &tauri::AppHandle, slug: &str) -> Result<Option<String>, String> {
    let dir = resolve_prompts_dir(app);
    let path = dir.join(format!("{slug}.md"));
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Read prompt {}: {e}", path.display()))?;
    let (_fm, body) = parse_prompt_file(&text);
    Ok(Some(body))
}

const DEFAULT_SUMMARY_PROMPT: &str = "Summarise the user's document in 3-5 concise bullet points. \
     Be specific; cite numbers and names where present. \
     Output Markdown bullets only — no preamble.";

/// Resolve the system message for one watch cycle. Reads the prompt file +
/// settings DB once at the top of `run_*_watch`; the resulting `String` is
/// then threaded through `process_item` for every entry. Previously this
/// ran on every entry — a 50-entry RSS feed did 50 disk reads + 50 DB
/// queries even though the answer is identical per cycle.
pub(crate) fn resolve_system_msg(app: &tauri::AppHandle, watch: &Watch) -> String {
    match &watch.prompt_id {
        Some(pid) => fetch_prompt_body(app, pid)
            .ok()
            .flatten()
            .unwrap_or_else(|| DEFAULT_SUMMARY_PROMPT.to_string()),
        None => DEFAULT_SUMMARY_PROMPT.to_string(),
    }
}

/// Append a summary block to the notes file in markdown form. Creates the
/// file (and any missing parent directories) if it doesn't exist.
fn append_to_notes(notes_path: &Path, filename: &str, summary: &str) -> Result<(), String> {
    if let Some(parent) = notes_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(notes_path)
        .map_err(|e| format!("Open notes file: {e}"))?;
    let ts = now_unix();
    let block = format!("\n## {filename}\n_{ts} (unix)_\n\n{summary}\n\n---\n",);
    f.write_all(block.as_bytes())
        .map_err(|e| format!("Write notes file: {e}"))
}

/// Persist the latest notify status + timestamp for this watch. Drives the
/// recovery dedup so a permanently-failing watch only notifies on the first
/// error after a success; the next success is logged as a recovery.
fn update_notify_state(app: &tauri::AppHandle, watch_id: &str, status: &str) {
    let db = app.state::<DbState>();
    let Ok(conn) = db.0.lock() else {
        log_warn!("update_notify_state({watch_id}): lock poisoned");
        return;
    };
    if let Err(e) = conn.execute(
        "UPDATE watches SET last_notified_status = ?1, last_notified_at = ?2 WHERE id = ?3",
        (status, now_unix(), watch_id),
    ) {
        // Non-fatal but observable: failing to persist notify state means
        // recovery dedup misfires (next success won't be flagged as recovery,
        // or repeated error notifications fire).
        log_warn!("update_notify_state({watch_id}, {status}): update failed: {e}");
    }
}

/// True if the main window is currently focused. Used to suppress OS
/// notifications when the user is already looking at Ekorbia — the in-window
/// WatchPanel UI updates simultaneously and the OS banner is redundant. We
/// still update `last_notified_status` so the next background event applies
/// dedup correctly.
fn main_window_focused(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}

/// One processed item's notification payload. Collected in a `NotifyBatch`
/// (a `Vec<NotifyEntry>`) by `process_item` and flushed once per poll cycle
/// by `flush_notify_batch` — that's how 8 files dropped at once produce a
/// single "8 new items" banner instead of 8 separate ones.
pub(crate) struct NotifyEntry {
    /// True for a 'done' event (item processed + summarised + appended to
    /// notes). False for any error path inside `process_item` or `process_file`.
    pub(crate) success: bool,
    /// Short human label (filename, RSS title, page URL). Shown verbatim in
    /// the coalesced banner body.
    pub(crate) item_label: String,
    /// On success, the AI summary. On error, the error message. The flusher
    /// extracts the first non-empty line for single-item banners and uses
    /// just the label for multi-item ones.
    pub(crate) detail: String,
}

pub(crate) type NotifyBatch = Vec<NotifyEntry>;

/// Convenience: build a fresh batch. Caller owns it for the duration of
/// the kind's run function.
pub(crate) fn new_notify_batch() -> NotifyBatch {
    Vec::new()
}

/// Fire coalesced OS notifications for everything `process_item` and
/// `process_file` accumulated in this poll cycle. Up to two banners per
/// cycle: one for successes (always when any), one for errors (subject to
/// recovery dedup). Foreground-suppressed when the main window is focused.
/// Silently no-ops on every plugin error — a failing notification must
/// never break the pipeline.
///
/// Dedup rules (applied per-cycle, not per-item):
/// - **Successes** always banner; the title flips to "recovered" if the
///   last notified status was 'error'.
/// - **Errors** banner only when the previous cycle's status wasn't
///   already 'error'. A permanently-broken watch surfaces once, then
///   stays quiet until it recovers.
///
/// State invariant: if both successes and errors occurred this cycle, the
/// new `last_notified_status` is 'success' — successes mean the watch is
/// healthy at cycle's end, so the next error cycle fires as a fresh alert.
pub(crate) fn flush_notify_batch(app: &tauri::AppHandle, watch: &Watch, batch: &[NotifyEntry]) {
    if !watch.notify || batch.is_empty() {
        return;
    }
    let successes: Vec<&NotifyEntry> = batch.iter().filter(|e| e.success).collect();
    let errors: Vec<&NotifyEntry> = batch.iter().filter(|e| !e.success).collect();
    let prev_status = watch.last_notified_status.as_deref();

    // Persist the new dedup state regardless of whether banners actually
    // show (foreground suppression doesn't reset dedup). Prefer 'success'
    // when both happened — see the doc comment.
    let new_status = if !successes.is_empty() {
        "success"
    } else {
        "error"
    };
    update_notify_state(app, &watch.id, new_status);

    // Foreground suppression: dedup state above is already up to date.
    if main_window_focused(app) {
        return;
    }

    // ── Success banner ──────────────────────────────────────────────────
    if !successes.is_empty() {
        let title = if prev_status == Some("error") {
            if successes.len() == 1 {
                format!("{} recovered", watch.name)
            } else {
                format!("{} recovered — {} new items", watch.name, successes.len())
            }
        } else if successes.len() == 1 {
            format!("Watch: {}", watch.name)
        } else {
            format!("{} — {} new items", watch.name, successes.len())
        };

        let body = if successes.len() == 1 {
            // Single item: label + first non-empty line of the summary.
            let e = successes[0];
            let first_line = e
                .detail
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("");
            if first_line.is_empty() {
                e.item_label.clone()
            } else {
                format!("{} — {}", e.item_label, first_line)
            }
        } else {
            // Multi-item: preview the first 3 labels.
            let preview: Vec<&str> = successes
                .iter()
                .take(3)
                .map(|e| e.item_label.as_str())
                .collect();
            if successes.len() > 3 {
                format!("{} (+ {} more)", preview.join(", "), successes.len() - 3)
            } else {
                preview.join(", ")
            }
        };

        emit_notification(app, &watch.id, &title, &body);
    }

    // ── Error banner (recovery dedup) ──────────────────────────────────
    if !errors.is_empty() && prev_status != Some("error") {
        let title = if errors.len() == 1 {
            format!("{} failed", watch.name)
        } else {
            format!("{} — {} failures", watch.name, errors.len())
        };

        let body = if errors.len() == 1 {
            let e = errors[0];
            format!("{}: {}", e.item_label, e.detail)
        } else {
            let preview: Vec<String> = errors
                .iter()
                .take(3)
                .map(|e| format!("{}: {}", e.item_label, e.detail))
                .collect();
            if errors.len() > 3 {
                format!("{} (+ {} more)", preview.join("; "), errors.len() - 3)
            } else {
                preview.join("; ")
            }
        };

        emit_notification(app, &watch.id, &title, &body);
    }
}

/// Fire one OS notification banner. Wraps the body-cap + focus-hint + plugin
/// call so the success/error paths in `flush_notify_batch` stay readable.
///
/// The focus hint lets the JS side detect "user just clicked this notification"
/// when a window-focus event arrives within a short window after — see the
/// matching listener in `main.jsx`. We emit per banner (rather than per cycle)
/// so the JS picks up the most recent watch in mixed success+error cycles.
fn emit_notification(app: &tauri::AppHandle, watch_id: &str, title: &str, body: &str) {
    // OS notification banners truncate aggressively (~256 chars on macOS).
    // Cap on a char boundary to avoid mid-multibyte cuts.
    let body_short: String = body.chars().take(NOTIFICATION_BODY_CAP).collect();
    let _ = app.emit("watch:focus_hint", watch_id);
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(&body_short)
        .show();
}

/// Process a single item end-to-end: insert a 'processing' event, summarise
/// the supplied text, append to notes, update the event, emit Tauri events
/// to keep the UI in sync.
///
/// `item_id`    — stable dedup key. For folder watches, the file path; for
///                RSS, the entry GUID; for URL, a snapshot key. Stored in
///                `watch_events.file_path`.
/// `item_label` — short human-readable label for the notes section header
///                (e.g. filename, RSS entry title, URL).
/// `text`       — the body to summarise. Caller is responsible for
///                extraction (file → text, RSS → entry/article text, URL
///                → page text or diff).
// 8 args trips the clippy cap of 7, but every one carries distinct
// pipeline state (app handle, watch row, system msg, dedup key, label,
// body text, mutable batch, cancel flag). Grouping any two into a struct
// would just spread the same fields across one more boundary without
// reducing call-site complexity, so we accept the cap.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn process_item(
    app: &tauri::AppHandle,
    watch: &Watch,
    system_msg: &str,
    item_id: &str,
    item_label: &str,
    text: String,
    notify_batch: &mut NotifyBatch,
    // Cancel flag for this cycle. We read it twice:
    //   1. After inserting the 'processing' row but before the LLM call —
    //      the LLM is the long pole, so checking here saves the most time
    //      when the user toggles off mid-cycle.
    //   2. After the LLM returns but before the notes append — if the
    //      user cancelled while the model was thinking, we don't want to
    //      write a stale summary to disk.
    cancel: &AtomicBool,
) -> Result<(), String> {
    let event_id = gen_event_id();

    insert_event(app, &event_id, &watch.id, item_id, "processing", None, None)?;
    let _ = app.emit("watch:event_changed", &event_id);

    // Pre-LLM cancel check. Rewrite the just-inserted 'processing' row to
    // 'error' so the user sees a definitive end-state in the activity feed
    // (rather than a row stuck in 'processing' forever).
    if is_cancelled(cancel) {
        let msg = WATCH_CANCELLED_MSG.to_string();
        insert_event(
            app,
            &event_id,
            &watch.id,
            item_id,
            "error",
            None,
            Some(&msg),
        )?;
        let _ = app.emit("watch:event_changed", &event_id);
        notify_batch.push(NotifyEntry {
            success: false,
            item_label: item_label.to_string(),
            detail: msg.clone(),
        });
        return Err(msg);
    }

    if text.trim().is_empty() {
        let msg = "No text to summarise (source returned empty)".to_string();
        insert_event(
            app,
            &event_id,
            &watch.id,
            item_id,
            "error",
            None,
            Some(&msg),
        )?;
        let _ = app.emit("watch:event_changed", &event_id);
        notify_batch.push(NotifyEntry {
            success: false,
            item_label: item_label.to_string(),
            detail: msg.clone(),
        });
        return Err(msg);
    }

    // Cap the prompt — see OLLAMA_PROMPT_CHAR_CAP for rationale.
    let snippet = if text.len() > OLLAMA_PROMPT_CHAR_CAP {
        &text[..OLLAMA_PROMPT_CHAR_CAP]
    } else {
        text.as_str()
    };

    let summary = match llm_chat(&watch.model, system_msg, snippet).await {
        Ok(s) => s,
        Err(e) => {
            insert_event(app, &event_id, &watch.id, item_id, "error", None, Some(&e))?;
            let _ = app.emit("watch:event_changed", &event_id);
            notify_batch.push(NotifyEntry {
                success: false,
                item_label: item_label.to_string(),
                detail: e.clone(),
            });
            return Err(e);
        }
    };

    // Post-LLM cancel check. The model just returned (maybe after minutes
    // of work) but the user toggled off in the meantime. Drop the summary
    // on the floor rather than writing it to the notes file — toggling
    // off should mean "I don't want any more output from this watch".
    if is_cancelled(cancel) {
        let msg = WATCH_CANCELLED_MSG.to_string();
        insert_event(
            app,
            &event_id,
            &watch.id,
            item_id,
            "error",
            None,
            Some(&msg),
        )?;
        let _ = app.emit("watch:event_changed", &event_id);
        notify_batch.push(NotifyEntry {
            success: false,
            item_label: item_label.to_string(),
            detail: msg.clone(),
        });
        return Err(msg);
    }

    if let Err(e) = append_to_notes(Path::new(&watch.notes_path), item_label, &summary) {
        insert_event(
            app,
            &event_id,
            &watch.id,
            item_id,
            "error",
            Some(&summary),
            Some(&e),
        )?;
        let _ = app.emit("watch:event_changed", &event_id);
        notify_batch.push(NotifyEntry {
            success: false,
            item_label: item_label.to_string(),
            detail: e.clone(),
        });
        return Err(e);
    }

    insert_event(
        app,
        &event_id,
        &watch.id,
        item_id,
        "done",
        Some(&summary),
        None,
    )?;
    let _ = app.emit("watch:event_changed", &event_id);
    notify_batch.push(NotifyEntry {
        success: true,
        item_label: item_label.to_string(),
        detail: summary,
    });
    Ok(())
}

/// Dispatch one tick of a single watch by kind. Always stamps
/// `last_polled_at` afterwards so the cadence gate in `run_all_watches`
/// works correctly regardless of whether the pipeline found new items.
///
/// Registers a cancel token for this cycle so a concurrent
/// `cancel_watch` (fired by `watch_set_enabled(false)` or by toggling the
/// watch off in the UI) flips the per-cycle flag the runners check at
/// each item boundary. The token's Drop impl cleans up the registry
/// entry when this function returns, so a subsequent re-enable starts
/// with a fresh, unflipped flag.
pub(crate) async fn run_watch(app: &tauri::AppHandle, watch: &Watch) {
    // One cycle per watch at a time. The poller and the two "Run now"
    // commands can each fire a cycle for the same watch; register_cancel
    // returns None when one is already in flight, so we skip the overlap
    // rather than start a second cycle (which would spuriously "Cancel" the
    // first — see register_cancel). The in-flight cycle stamps
    // last_polled_at when it finishes, so cadence stays correct without a
    // mark here.
    let Some(token) = register_cancel(&watch.id) else {
        return;
    };
    let flag = token.flag.clone();
    match watch.kind.as_str() {
        "folder" | "" => run_folder_watch(app, watch, &flag).await,
        "rss" => run_rss_watch(app, watch, &flag).await,
        "url" => run_url_watch(app, watch, &flag).await,
        other => log_warn!("watch '{}': unsupported kind '{other}'", watch.name),
    }
    mark_watch_polled(app, &watch.id);
    // Token drops here, removing the registry entry. Explicit for clarity
    // and to silence any future "unused token" lint.
    drop(token);
}

/// Run every enabled watch once, subject to its per-watch cadence. Used
/// by both the polling loop and the "Run now" command — `force=true`
/// bypasses the gate so the manual button always fires immediately.
pub(crate) async fn run_all_watches_inner(app: &tauri::AppHandle, force: bool) {
    let watches = match load_enabled_watches(app) {
        Ok(w) => w,
        Err(e) => {
            log_warn!("watch: load_enabled failed: {e}");
            return;
        }
    };
    let now = now_unix();
    for w in watches {
        if !force && (now - w.last_polled_at) < w.interval_secs {
            continue;
        }
        run_watch(app, &w).await;
    }
}

async fn run_all_watches(app: &tauri::AppHandle) {
    run_all_watches_inner(app, false).await;
}

/// Background polling loop. One global task, spawned once at startup.
/// The loop tick is the *minimum* cadence — individual watches gate
/// themselves further via `interval_secs` so a 30-min URL watch doesn't
/// fire on every 30-second wake.
pub(crate) async fn watch_poller(app: tauri::AppHandle) {
    let interval = std::time::Duration::from_secs(WATCH_POLL_SECS);
    // Give the rest of setup() a moment to settle before the first scan.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    loop {
        run_all_watches(&app).await;
        tokio::time::sleep(interval).await;
    }
}
