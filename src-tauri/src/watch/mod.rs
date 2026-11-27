// SPDX-License-Identifier: MIT

//! Watch pipeline: background work that summarises new files in a folder
//! into a notes file, with the model that answers chats.
//!
//! A watch follows a **folder**. (Feeds and web pages could be watched too
//! until the redesign; they were the app's only background network traffic
//! and were removed. A row of kind `rss` or `url` left in the table by an
//! older version is listed, never run, and can only be deleted.)
//!
//! The processing tail: extract → process_item → summarise → append to the
//! notes file → emit `watch:event_changed`.
//!
//! Module layout:
//! - `mod`       — shared types (`Watch`, `WatchEvent`) + cadence defaults + commands
//! - `commands`  — public Tauri commands (watch_list/create/delete/set_enabled/events_list/run_once/notes_read)
//! - `pipeline`  — shared infra: `process_item`, dispatcher (`run_watch`),
//!   poller, event log helpers, prompt body fetch, notes append
//! - `folder`    — `run_folder_watch` + `process_file` + supported extensions

pub(crate) mod cancel;
pub(crate) mod commands;
pub(crate) mod folder;
pub(crate) mod pipeline;

use serde::{Deserialize, Serialize};

/// Polling-loop tick. Each watch additionally gates itself by
/// `interval_secs`, so a 30-min URL watch doesn't fire on every 30s wake.
pub(crate) const WATCH_POLL_SECS: u64 = 30;

/// Extensions the folder-kind pipeline will pick up for processing.
/// Compared case-insensitively.
pub(crate) const WATCH_SUPPORTED_EXTENSIONS: &[&str] = &["pdf", "txt", "md", "markdown"];

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Watch {
    pub(crate) id: String,
    pub(crate) name: String,
    /// For `kind='folder'` this is the directory to scan. For `kind='rss'`
    /// or `kind='url'` it's typically empty — the source URL is in
    /// `source_url` instead. We keep the column NOT NULL (legacy) and just
    /// store "" for non-folder kinds.
    pub(crate) folder_path: String,
    pub(crate) notes_path: String,
    pub(crate) model: String,
    /// Optional reference to a prompt in the prompts table. When set, that
    /// prompt's `body` is used as the system message for summarisation.
    pub(crate) prompt_id: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) created_at: i64,
    /// 'folder' (default), 'rss', or 'url'. Discriminates the source type
    /// so `run_watch()` can dispatch to the right pipeline.
    #[serde(default = "default_watch_kind")]
    pub(crate) kind: String,
    /// Feed URL (RSS kind) or page URL (URL kind). NULL/None for folder.
    #[serde(default)]
    pub(crate) source_url: Option<String>,
    /// Polling cadence for THIS watch. Folder defaults 30s; RSS 600s; URL
    /// 1800s. The poller skips a watch where `now - last_polled_at < this`.
    #[serde(default = "default_interval_secs")]
    pub(crate) interval_secs: i64,
    /// Unix timestamp of the last poll attempt. Updated by `run_watch`
    /// regardless of whether items were found, so a noisy feed doesn't
    /// re-hit the network every tick.
    #[serde(default)]
    pub(crate) last_polled_at: i64,
    /// URL kind only: the most recently extracted page text. Used to
    /// detect "no change" (skip summarisation) and as the baseline for
    /// line diffing in Phase 3. NULL/None on first fetch.
    #[serde(default)]
    pub(crate) last_content: Option<String>,
    /// URL kind only: optional CSS selector narrowing the extracted
    /// region (e.g. `article`, `main`, `#content`). NULL/None means
    /// extract from the whole document body.
    #[serde(default)]
    pub(crate) url_selector: Option<String>,
    /// URL kind only: `'snapshot'` (default — summarise the whole new
    /// page on change) or `'diff'` (summarise only the unified line diff
    /// vs the prior `last_content`). NULL/None is treated as
    /// `'snapshot'` so pre-Phase-3 rows keep their old behavior.
    #[serde(default)]
    pub(crate) url_diff_mode: Option<String>,
    /// v1 notifications: per-watch opt-in for OS notifications on events.
    /// Default false; user flips via the WatchModal "Notify on events"
    /// toggle. Permission is requested lazily — the first time a
    /// `notify=true` watch is about to fire.
    #[serde(default)]
    pub(crate) notify: bool,
    /// Pipeline-owned: last notification status seen for this watch,
    /// either `'success'` or `'error'`. Drives recovery dedup so a
    /// permanently-failing watch only notifies on the *first* error
    /// after success, then stays quiet until it recovers. None means
    /// no notification has been fired yet.
    #[serde(default)]
    pub(crate) last_notified_status: Option<String>,
    /// Pipeline-owned: unix timestamp of the last notification fired
    /// for this watch. Reserved for future rate-limiting / coalescing
    /// (v2). Currently set but not read on the dedup path.
    #[serde(default)]
    pub(crate) last_notified_at: i64,
    /// Folder kind: skip files whose mtime (unix secs) is below this
    /// cutoff. Set to "now" by the Downloads recipe so a fresh folder
    /// watch doesn't summarise pre-existing files. None = process all.
    /// User-set (not pipeline-owned), but `watch_create` preserves an
    /// existing value when the form omits it (COALESCE) so editing a
    /// watch never resurrects the backlog.
    #[serde(default)]
    pub(crate) ignore_before: Option<i64>,
}

pub(crate) fn default_watch_kind() -> String {
    "folder".to_string()
}
pub(crate) fn default_interval_secs() -> i64 {
    30
}

/// SQL column list for `SELECT … FROM watches`, in field-declaration order.
/// `map_watch_row` depends on this ordering. **Keep this string and the
/// `map_watch_row` body in sync with the `Watch` struct field list above** —
/// drift between any two of those three will silently misread columns into
/// the wrong fields (e.g. an `Option<String>` would accept the i64 from an
/// adjacent column without erroring at runtime).
///
/// ## Pipeline-owned columns
///
/// When adding a column to this list, decide whether it's **user-set**
/// (settable via the WatchModal form, persisted on `watch_create` save) or
/// **pipeline-owned** (mutated only by the background watch poller).
///
/// Currently pipeline-owned: `last_polled_at`, `last_content`,
/// `last_notified_status`, `last_notified_at`. These appear in this SELECT
/// list (the runtime needs them) but MUST NOT appear in
/// `watch_create`'s `ON CONFLICT DO UPDATE SET` clause — otherwise re-saving
/// the form would wipe diff baselines, reset recovery dedup, or break the
/// cadence gate. See `watch_create` for the canonical SET list + comment.
pub(crate) const WATCH_COLUMNS: &str =
    "id, name, folder_path, notes_path, model, prompt_id, enabled, created_at, \
     kind, source_url, interval_secs, last_polled_at, last_content, url_selector, \
     url_diff_mode, notify, last_notified_status, last_notified_at, ignore_before";

/// Materialize a `Watch` from a row whose columns match `WATCH_COLUMNS` in
/// order. Bool columns are stored as INTEGER 0/1 (SQLite has no native bool)
/// and unpacked here. Used by `watch_list` (Tauri command) and
/// `load_enabled_watches` (poller).
pub(crate) fn map_watch_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Watch> {
    Ok(Watch {
        id: row.get(0)?,
        name: row.get(1)?,
        folder_path: row.get(2)?,
        notes_path: row.get(3)?,
        model: row.get(4)?,
        prompt_id: row.get(5)?,
        enabled: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
        kind: row.get(8)?,
        source_url: row.get(9)?,
        interval_secs: row.get(10)?,
        last_polled_at: row.get(11)?,
        last_content: row.get(12)?,
        url_selector: row.get(13)?,
        url_diff_mode: row.get(14)?,
        notify: row.get::<_, i64>(15)? != 0,
        last_notified_status: row.get(16)?,
        last_notified_at: row.get(17)?,
        ignore_before: row.get(18)?,
    })
}

/// Default poll interval, in seconds, when a watch is created without one.
/// (The parameter is kept for the callers; only folders are watched now.)
pub(crate) fn default_interval_for_kind(_kind: &str) -> i64 {
    30
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchEvent {
    pub(crate) id: String,
    pub(crate) watch_id: String,
    pub(crate) file_path: String,
    pub(crate) status: String,
    pub(crate) summary: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) created_at: i64,
}
