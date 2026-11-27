// SPDX-License-Identifier: MIT

//! The one gate every outbound connection goes through.
//!
//! Ekorbia's promise is that work stays on this Mac. This module is how a
//! person can check that instead of taking it on trust:
//!
//!   * **The record.** Before the app connects to anything that is not this
//!     Mac, the code asks [`allow`]. The gate notes the day, the purpose, the
//!     host, how much came back and how it ended. It never sees or stores
//!     what was sent or received.
//!   * **The lock.** With the offline lock on, [`allow`] refuses every such
//!     connection before it opens, and notes the refusal.
//!   * **The report.** Settings → Privacy shows the record; "Save report…"
//!     writes it as one page, with the installed models and their checksums.
//!
//! "This Mac" means a loopback address (`localhost`, `127.x.x.x`, `::1`).
//! Anything else counts as another machine — including this Mac's own LAN
//! name or address, which errs on the side of saying more went out.
//!
//! What the gate cannot see: other apps, macOS itself, and a separate Ollama
//! install, which fetches models on its own. The pane and the report say so.
//!
//! # For anyone adding a network call
//!
//! ```ignore
//! let pass = crate::net::allow(Purpose::ModelLookup, "", &url)?;
//! let resp = client.get(&url).send().await.map_err(..)?;   // `?` → recorded as failed
//! pass.done(bytes);
//! ```
//!
//! A `Pass` that is dropped without `done` / `verified` / `stopped` records
//! the connection as failed, so an early return cannot leave it unrecorded.
//! `net_gate_covers_every_client` (below) fails the build's tests if a file
//! builds an HTTP client without going through here.

use crate::db::{get_setting, now_unix, set_setting, DbState};
use crate::log::log_warn;
use rusqlite::Connection;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{Emitter, Manager};

/// `app_settings` keys.
const LOCK_KEY: &str = "offline_lock";
const LOCK_SINCE_KEY: &str = "offline_lock_since";

/// Emitted (no payload) whenever the record or the lock changes, so an open
/// Privacy pane and the status line can re-read.
pub(crate) const CHANGED_EVENT: &str = "privacy:changed";

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static LOCKED: AtomicBool = AtomicBool::new(false);

/// Why a connection is being made. The key is what the record stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Purpose {
    /// A chat model (or the document-search model) being downloaded.
    ModelDownload,
    /// Asking a model host what files a repository holds.
    ModelLookup,
    /// The dictation (speech-to-text) model being downloaded.
    DictationModel,
    /// A chat sent to a server on another machine.
    Chat,
    /// Document text sent to a server on another machine to be indexed.
    Documents,
    /// Housekeeping with a server on another machine: listing its models,
    /// warming one up, counting tokens.
    Server,
}

impl Purpose {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Purpose::ModelDownload => "model_download",
            Purpose::ModelLookup => "model_lookup",
            Purpose::DictationModel => "dictation_model",
            Purpose::Chat => "chat",
            Purpose::Documents => "documents",
            Purpose::Server => "server",
        }
    }
}

// ── What counts as this Mac ────────────────────────────────────────────────

/// The host a URL points at, lower-cased, without port. Empty when the URL
/// cannot be read (which the gate then treats as another machine).
pub(crate) fn host_of(url: &str) -> String {
    let raw = url.trim();
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    reqwest::Url::parse(&with_scheme)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h.trim_matches(['[', ']']).to_ascii_lowercase())
        })
        .unwrap_or_default()
}

/// Is this host this Mac itself?
pub(crate) fn host_is_this_mac(host: &str) -> bool {
    let h = host.trim().trim_matches(['[', ']']).to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    h.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

/// Does this URL point at this Mac? (The gate works on the host; this is
/// the same question asked of a whole URL, for the tests.)
#[cfg(test)]
pub(crate) fn is_on_this_mac(url: &str) -> bool {
    host_is_this_mac(&host_of(url))
}

// ── The record (SQLite) ────────────────────────────────────────────────────
//
// One row per (day, purpose, detail, host, result), counted. A Watch that
// polls a feed every fifteen minutes is one row a day, not ninety-six; a
// model download is its own row because `detail` names the model.

/// Note one connection. `at` is unix seconds; the day is taken in local time.
pub(crate) fn record(
    conn: &Connection,
    at: i64,
    purpose: &str,
    detail: &str,
    host: &str,
    result: &str,
    bytes: u64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO net_log (day, purpose, detail, host, result, count, bytes, first_at, last_at) \
         VALUES (strftime('%Y-%m-%d', ?1, 'unixepoch', 'localtime'), ?2, ?3, ?4, ?5, 1, ?6, ?1, ?1) \
         ON CONFLICT(day, purpose, detail, host, result) DO UPDATE SET \
           count = count + 1, bytes = bytes + excluded.bytes, last_at = excluded.last_at",
        rusqlite::params![
            at,
            purpose,
            detail,
            host,
            result,
            i64::try_from(bytes).unwrap_or(i64::MAX)
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetRow {
    pub(crate) day: String,
    pub(crate) purpose: String,
    pub(crate) detail: String,
    pub(crate) host: String,
    /// done | verified | failed | refused | stopped
    pub(crate) result: String,
    pub(crate) count: i64,
    pub(crate) bytes: i64,
    pub(crate) first_at: i64,
    pub(crate) last_at: i64,
}

/// The record, most recent first.
pub(crate) fn list(conn: &Connection, limit: i64) -> Result<Vec<NetRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT day, purpose, detail, host, result, count, bytes, first_at, last_at \
             FROM net_log ORDER BY last_at DESC, rowid DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |r| {
            Ok(NetRow {
                day: r.get(0)?,
                purpose: r.get(1)?,
                detail: r.get(2)?,
                host: r.get(3)?,
                result: r.get(4)?,
                count: r.get(5)?,
                bytes: r.get(6)?,
                first_at: r.get(7)?,
                last_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    /// Connections that were allowed to open (however they ended).
    pub(crate) made: i64,
    /// Connections the lock refused.
    pub(crate) refused: i64,
    /// Chats sent to a server on another machine.
    pub(crate) chats_sent: i64,
    /// Requests that sent document text (to index it, or to search it) to
    /// a server on another machine.
    pub(crate) documents_sent: i64,
    /// Every host a connection was made to, most used first.
    pub(crate) hosts: Vec<String>,
}

pub(crate) fn summary(conn: &Connection) -> Result<Summary, String> {
    let sum = |sql: &str| -> i64 {
        conn.query_row(sql, [], |r| r.get::<_, Option<i64>>(0))
            .ok()
            .flatten()
            .unwrap_or(0)
    };
    let mut hosts: Vec<String> = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT host FROM net_log WHERE result != 'refused' \
         GROUP BY host ORDER BY SUM(count) DESC, host ASC",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            hosts = rows.filter_map(Result::ok).collect();
        }
    }
    Ok(Summary {
        made: sum("SELECT SUM(count) FROM net_log WHERE result != 'refused'"),
        refused: sum("SELECT SUM(count) FROM net_log WHERE result = 'refused'"),
        // A chat that failed part-way may still have left this Mac: count it.
        chats_sent: sum(
            "SELECT SUM(count) FROM net_log WHERE purpose = 'chat' AND result != 'refused'",
        ),
        documents_sent: sum(
            "SELECT SUM(count) FROM net_log WHERE purpose = 'documents' AND result != 'refused'",
        ),
        hosts,
    })
}

// ── The gate ───────────────────────────────────────────────────────────────

/// Remember the app (for the database and for events) and load the lock.
/// Called once at startup, before anything can connect.
pub(crate) fn init(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
    let db = app.state::<DbState>();
    if let Ok(conn) = db.0.lock() {
        LOCKED.store(
            get_setting(&conn, LOCK_KEY).as_deref() == Some("1"),
            Ordering::SeqCst,
        );
    };
}

pub(crate) fn is_locked() -> bool {
    LOCKED.load(Ordering::SeqCst)
}

/// What a caller is told when the lock refuses a connection.
pub(crate) fn refusal_message(host: &str) -> String {
    let to = if host.is_empty() {
        "another machine".to_string()
    } else {
        host.to_string()
    };
    format!(
        "The offline lock is on, so Ekorbia did not connect to {to}. \
         Turn the lock off in Settings → Privacy to allow it."
    )
}

fn note(purpose: Purpose, detail: &str, host: &str, result: &str, bytes: u64) {
    let Some(app) = APP.get() else {
        return;
    };
    {
        let db = app.state::<DbState>();
        let Ok(conn) = db.0.lock() else {
            return;
        };
        if let Err(e) = record(
            &conn,
            now_unix(),
            purpose.key(),
            detail,
            host,
            result,
            bytes,
        ) {
            log_warn!("net: could not record a connection to {host}: {e}");
        }
    }
    let _ = app.emit(CHANGED_EVENT, ());
}

/// Permission to make one connection, and the duty to say how it ended.
/// For a connection to this Mac it is empty and records nothing.
#[must_use = "say how the connection ended: done(), verified() or stopped()"]
pub(crate) struct Pass(Option<PassInner>);

struct PassInner {
    purpose: Purpose,
    detail: String,
    host: String,
}

impl Pass {
    fn local() -> Self {
        Pass(None)
    }

    fn finish(&mut self, result: &str, bytes: u64) {
        if let Some(p) = self.0.take() {
            note(p.purpose, &p.detail, &p.host, result, bytes);
        }
    }

    /// It completed. `bytes` is how much came back (0 when not known).
    pub(crate) fn done(mut self, bytes: u64) {
        self.finish("done", bytes);
    }

    /// It completed and what came back matched its published checksum.
    pub(crate) fn verified(mut self, bytes: u64) {
        self.finish("verified", bytes);
    }

    /// The person stopped it part-way.
    pub(crate) fn stopped(mut self, bytes: u64) {
        self.finish("stopped", bytes);
    }
}

impl Drop for Pass {
    fn drop(&mut self) {
        // Not finished by the caller: it failed (an early `?`, a panic).
        self.finish("failed", 0);
    }
}

/// Ask before connecting to `url`.
///
/// * On this Mac → an empty pass; nothing is recorded.
/// * Another machine, lock off → a pass to finish.
/// * Another machine, lock on → `Err`, and the refusal is recorded.
///
/// `detail` identifies the thing fetched when that is not private — a model's
/// id. Leave it empty for anything that would describe the person's work.
pub(crate) fn allow(purpose: Purpose, detail: &str, url: &str) -> Result<Pass, String> {
    let host = host_of(url);
    if host_is_this_mac(&host) {
        return Ok(Pass::local());
    }
    allow_host(purpose, detail, &host)
}

/// As [`allow`], for a connection this Mac does not open itself but causes:
/// asking a local Ollama to pull a model makes Ollama fetch it. `host` names
/// where that goes.
pub(crate) fn allow_host(purpose: Purpose, detail: &str, host: &str) -> Result<Pass, String> {
    if is_locked() {
        note(purpose, detail, host, "refused", 0);
        return Err(refusal_message(host));
    }
    Ok(Pass(Some(PassInner {
        purpose,
        detail: detail.to_string(),
        host: host.to_string(),
    })))
}

// ── Commands ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrivacyStatus {
    locked: bool,
    /// Unix seconds the lock was last turned on, when it is on.
    locked_since: Option<i64>,
    summary: Summary,
}

fn status_from(conn: &Connection) -> Result<PrivacyStatus, String> {
    let locked = get_setting(conn, LOCK_KEY).as_deref() == Some("1");
    let locked_since = if locked {
        get_setting(conn, LOCK_SINCE_KEY).and_then(|s| s.parse::<i64>().ok())
    } else {
        None
    };
    Ok(PrivacyStatus {
        locked,
        locked_since,
        summary: summary(conn)?,
    })
}

#[tauri::command]
pub(crate) fn privacy_status(state: tauri::State<'_, DbState>) -> Result<PrivacyStatus, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    status_from(&conn)
}

/// Turn the offline lock on or off. Takes effect for the very next
/// connection; anything already in flight is not cut off.
#[tauri::command]
pub(crate) fn privacy_set_lock(app: tauri::AppHandle, on: bool) -> Result<PrivacyStatus, String> {
    let status = {
        let db = app.state::<DbState>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        set_lock(&conn, on, now_unix())?;
        status_from(&conn)?
    };
    LOCKED.store(on, Ordering::SeqCst);
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(status)
}

fn set_lock(conn: &Connection, on: bool, at: i64) -> Result<(), String> {
    let was = get_setting(conn, LOCK_KEY).as_deref() == Some("1");
    set_setting(conn, LOCK_KEY, if on { "1" } else { "0" })?;
    // "On since" is when it was last switched on — not re-stamped by a
    // second "on" while it is already on.
    if on && !was {
        set_setting(conn, LOCK_SINCE_KEY, &at.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn privacy_log(
    state: tauri::State<'_, DbState>,
    limit: Option<i64>,
) -> Result<Vec<NetRow>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    list(&conn, limit.unwrap_or(200).clamp(1, 2000))
}

// ── The saved report ───────────────────────────────────────────────────────

/// How an installed model came to be here, as far as the record knows.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Provenance {
    /// Downloaded, and it matched its published checksum (local date).
    Verified(String),
    /// Downloaded; there was no published checksum to compare (local date).
    Downloaded(String),
    /// No download on record: installed before the record began, or put in
    /// the folder by hand.
    Unrecorded,
}

/// One installed model, as the report lists it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ModelEntry {
    /// What to call it ("Balanced · Gemma 4 12B", or the file's own name).
    pub(crate) label: String,
    pub(crate) file: String,
    pub(crate) bytes: i64,
    pub(crate) provenance: Provenance,
}

/// What the record says about how a model (`detail` = its id) arrived.
///
/// The report does NOT read the model files. A download is checked against
/// its published checksum as it arrives (engine/downloads.rs) and the record
/// keeps the outcome; hashing tens of gigabytes again to repeat that made
/// saving the report take many minutes.
pub(crate) fn provenance(conn: &Connection, purpose: &str, detail: &str) -> Provenance {
    let latest = |result: &str| -> Option<String> {
        conn.query_row(
            "SELECT strftime('%Y-%m-%d', MAX(last_at), 'unixepoch', 'localtime') \
             FROM net_log WHERE purpose = ?1 AND detail = ?2 AND result = ?3",
            rusqlite::params![purpose, detail, result],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    };
    if let Some(day) = latest("verified") {
        return Provenance::Verified(day);
    }
    if let Some(day) = latest("done") {
        return Provenance::Downloaded(day);
    }
    Provenance::Unrecorded
}

/// Dictation model files in a folder: (name, bytes), e.g. ("base.en", …).
pub(crate) fn dictation_model_files(dir: &std::path::Path) -> Vec<(String, u64)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, u64)> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let file = e.file_name().to_str()?.to_string();
            if !(file.starts_with("ggml-") && file.ends_with(".bin")) {
                return None;
            }
            let bytes = e.metadata().ok()?.len();
            let name = file
                .trim_start_matches("ggml-")
                .trim_end_matches(".bin")
                .to_string();
            Some((name, bytes))
        })
        .collect();
    out.sort();
    out
}

/// The installed models with what the record knows of each. `engine` is
/// (model id, bytes) — a model's image reader is part of it, not a row of
/// its own; `dictation` is (name, bytes). `labels` maps a model id to the
/// name the app shows for it.
pub(crate) fn installed_models(
    conn: &Connection,
    engine: &[(String, u64)],
    dictation: &[(String, u64)],
    labels: &std::collections::HashMap<String, String>,
) -> Vec<ModelEntry> {
    let catalog = crate::engine::downloads::catalog();
    let size = |b: u64| i64::try_from(b).unwrap_or(i64::MAX);
    let mut out: Vec<ModelEntry> = engine
        .iter()
        .map(|(id, bytes)| {
            let label = labels.get(id).cloned().unwrap_or_else(|| {
                catalog
                    .models
                    .iter()
                    .find(|m| &m.id == id)
                    .map(|m| m.label.clone())
                    .unwrap_or_else(|| id.clone())
            });
            ModelEntry {
                label,
                file: format!("{id}.gguf"),
                bytes: size(*bytes),
                provenance: provenance(conn, "model_download", id),
            }
        })
        .collect();
    out.extend(dictation.iter().map(|(name, bytes)| ModelEntry {
        label: format!("Dictation · {name}"),
        file: format!("ggml-{name}.bin"),
        bytes: size(*bytes),
        provenance: provenance(conn, "dictation_model", name),
    }));
    out
}

/// Everything the page prints.
pub(crate) struct ReportData {
    /// "2026-11-23 09:30", local time.
    pub(crate) generated: String,
    pub(crate) app_version: String,
    /// "Mac, 36 GB of memory".
    pub(crate) machine: String,
    pub(crate) locked: bool,
    /// "2026-11-22 14:20", when the lock is on.
    pub(crate) locked_since: Option<String>,
    /// Which engine answers chats, in words ("The built-in engine, on this Mac").
    pub(crate) answers_with: String,
    pub(crate) summary: Summary,
    pub(crate) models: Vec<ModelEntry>,
    /// (when, row) — `when` already formatted in local time.
    pub(crate) rows: Vec<(String, NetRow)>,
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// "7.2 GB", "274 MB", "12 KB"; empty for zero.
pub(crate) fn human_bytes(bytes: i64) -> String {
    if bytes <= 0 {
        return String::new();
    }
    let b = bytes as f64;
    const KB: f64 = 1000.0;
    if b >= KB * KB * KB {
        format!("{:.1} GB", b / (KB * KB * KB))
    } else if b >= KB * KB {
        format!("{:.0} MB", b / (KB * KB))
    } else if b >= KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{bytes} bytes")
    }
}

/// The record's purposes in words. `detail` is a model id where there is one.
pub(crate) fn purpose_words(purpose: &str, detail: &str) -> String {
    let with = |base: &str| {
        if detail.is_empty() {
            base.to_string()
        } else {
            format!("{base}: {detail}")
        }
    };
    match purpose {
        "model_download" => with("Model download"),
        "model_lookup" => "Looking up a model's files".to_string(),
        "dictation_model" => with("Dictation model"),
        // Recorded by versions that could watch feeds and pages.
        "watch_feed" => "A feed a Watch followed".to_string(),
        "watch_page" => "A page a Watch followed".to_string(),
        "chat" => "Chat sent to a server".to_string(),
        "documents" => "Text sent to a server for document search".to_string(),
        "server" => "Checking with a server".to_string(),
        other => other.to_string(),
    }
}

pub(crate) fn result_words(result: &str) -> &'static str {
    match result {
        "done" => "Done",
        "verified" => "Verified",
        "failed" => "Failed",
        "refused" => "Refused",
        "stopped" => "Stopped",
        _ => "Unknown",
    }
}

/// How much left this Mac, as the headline says it.
pub(crate) fn sent_off_words(s: &Summary) -> String {
    let mut parts: Vec<String> = Vec::new();
    if s.chats_sent > 0 {
        parts.push(format!(
            "{} chat{}",
            s.chats_sent,
            if s.chats_sent == 1 { "" } else { "s" }
        ));
    }
    if s.documents_sent > 0 {
        // Indexing a document and searching the documents both send text to
        // the server; each such request is counted.
        parts.push(format!(
            "{} document-search request{}",
            s.documents_sent,
            if s.documents_sent == 1 { "" } else { "s" }
        ));
    }
    if parts.is_empty() {
        "None".to_string()
    } else {
        // Dictation is always transcribed on this Mac.
        format!("{}; no dictation", parts.join(", "))
    }
}

/// The saved page: plain HTML with no scripts and nothing fetched, so it
/// opens anywhere and prints on one or two sheets.
pub(crate) fn build_report_html(d: &ReportData) -> String {
    let lock = if d.locked {
        match &d.locked_since {
            Some(since) => format!("On since {}", esc(since)),
            None => "On".to_string(),
        }
    } else {
        "Off".to_string()
    };
    let made = if d.summary.made == 0 {
        "None".to_string()
    } else if d.summary.hosts.len() == 1 {
        format!("{}, all to {}", d.summary.made, esc(&d.summary.hosts[0]))
    } else {
        format!(
            "{}, to {}",
            d.summary.made,
            d.summary
                .hosts
                .iter()
                .map(|h| esc(h))
                .collect::<Vec<String>>()
                .join(", ")
        )
    };

    let mut models = String::new();
    if d.models.is_empty() {
        models.push_str("<p class=\"quiet\">No model files were found.</p>");
    } else {
        models.push_str("<table>");
        for m in &d.models {
            let how = match &m.provenance {
                Provenance::Verified(day) => format!(
                    "<span class=\"ok\">Matched its published checksum when downloaded, {}</span>",
                    esc(day)
                ),
                Provenance::Downloaded(day) => {
                    format!("Downloaded {}; no published checksum to compare", esc(day))
                }
                Provenance::Unrecorded => {
                    "<span class=\"quiet\">No download on record</span>".to_string()
                }
            };
            let mut file = esc(&m.file);
            let size = human_bytes(m.bytes);
            if !size.is_empty() {
                file.push_str(&format!(", {size}"));
            }
            models.push_str(&format!(
                "<tr><td><b>{}</b><br><span class=\"quiet\">{}</span></td><td>{}</td></tr>",
                esc(&m.label),
                file,
                how
            ));
        }
        models.push_str("</table>");
    }

    let mut rows = String::new();
    if d.rows.is_empty() {
        rows.push_str(
            "<p class=\"quiet\">Ekorbia has not connected to anything other than this Mac.</p>",
        );
    } else {
        rows.push_str("<table>");
        for (when, r) in &d.rows {
            let mut what = esc(&purpose_words(&r.purpose, &r.detail));
            let size = human_bytes(r.bytes);
            if !size.is_empty() {
                what.push_str(&format!(", {size}"));
            }
            if r.count > 1 {
                // A model and its image reader are two files, so two
                // connections; so is a retry.
                what.push_str(&format!(" ({} connections that day)", r.count));
            }
            rows.push_str(&format!(
                "<tr><td class=\"when\">{}</td><td>{}<br><span class=\"quiet\">{}</span></td><td class=\"res\">{}</td></tr>",
                esc(when),
                what,
                esc(&r.host),
                result_words(&r.result)
            ));
        }
        rows.push_str("</table>");
    }

    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\
<title>Ekorbia privacy report</title>\
<style>\
body{{font:14px/1.5 -apple-system,BlinkMacSystemFont,\"Helvetica Neue\",Arial,sans-serif;color:#1d1f23;max-width:720px;margin:40px auto;padding:0 24px}}\
h1{{font-size:24px;margin:0 0 2px}}h2{{font-size:15px;margin:28px 0 8px;padding-bottom:5px;border-bottom:1px solid #d9dbe0}}\
.sub,.quiet{{color:#6a6e76}}.sub{{margin:0 0 6px}}\
table{{width:100%;border-collapse:collapse}}td{{padding:6px 10px 6px 0;vertical-align:top;border-bottom:1px solid #eceef1}}\
td.when{{white-space:nowrap;color:#6a6e76;width:1%}}td.res{{white-space:nowrap;text-align:right;width:1%}}\
dl{{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:0}}dt{{color:#6a6e76}}dd{{margin:0;font-weight:600}}\
.ok{{color:#2f7d32}}\
@media print{{body{{margin:0 auto}}}}\
</style></head><body>\
<h1>Ekorbia privacy report</h1>\
<p class=\"sub\">{generated} · Ekorbia {version} · {machine}</p>\
<h2>Summary</h2>\
<dl>\
<dt>Offline lock</dt><dd>{lock}</dd>\
<dt>Chats are answered by</dt><dd>{answers}</dd>\
<dt>Chats, documents and dictation sent off this Mac</dt><dd>{sent}</dd>\
<dt>Connections made</dt><dd>{made}</dd>\
<dt>Connections refused</dt><dd>{refused}</dd>\
</dl>\
<h2>Models installed</h2>\
{models}\
<h2>Connections</h2>\
{rows}\
<h2>What this report covers</h2>\
<p>Connections made by Ekorbia itself to anything other than this Mac, since this record began. \
It records the day, the purpose, the host, the size and the result of each, and never what was sent or received. \
It does not cover other apps, macOS, or a separate Ollama install, which downloads models on its own. \
A model is checked against its published checksum as it is downloaded; the files were not read again for this report. \
A model with no download on record was installed before this record began, or was added by hand.</p>\
</body></html>\n",
        generated = esc(&d.generated),
        version = esc(&d.app_version),
        machine = esc(&d.machine),
        lock = lock,
        answers = esc(&d.answers_with),
        sent = esc(&sent_off_words(&d.summary)),
        made = made,
        refused = d.summary.refused,
        models = models,
        rows = rows,
    )
}

/// Give download rows the names the person knows their models by: the
/// record holds a model's id ("gemma4-12b"); `labels` maps it to what the
/// app calls it ("Balanced · Gemma 4 12B"). Anything else is left as it is.
pub(crate) fn name_download_rows(
    rows: Vec<NetRow>,
    labels: &std::collections::HashMap<String, String>,
) -> Vec<NetRow> {
    rows.into_iter()
        .map(|mut r| {
            if r.purpose == "model_download" {
                if let Some(name) = labels.get(&r.detail) {
                    r.detail = name.clone();
                }
            }
            r
        })
        .collect()
}

/// Local "YYYY-MM-DD HH:MM" for a unix time, via SQLite (no date crate).
fn local_stamp(conn: &Connection, at: i64) -> String {
    conn.query_row(
        "SELECT strftime('%Y-%m-%d %H:%M', ?1, 'unixepoch', 'localtime')",
        [at],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_default()
}

/// Write the report to `path`. `labels` (model id → printed name) and
/// `answersWith` come from the UI, which already knows the plain names; the
/// numbers and the record are read here. Nothing here is slow: the model
/// folders are listed, not read.
#[tauri::command]
pub(crate) async fn privacy_report_save(
    app: tauri::AppHandle,
    path: String,
    labels: Option<std::collections::HashMap<String, String>>,
    answers_with: Option<String>,
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("no file chosen".into());
    }
    let labels = labels.unwrap_or_default();

    // 1. List the model files (names and sizes only; no lock held).
    let engine_files: Vec<(String, u64)> = crate::engine::models_dir()
        .ok()
        .map(|dir| {
            crate::engine::scan_models(&dir)
                .into_iter()
                .map(|m| (m.name, m.size_bytes))
                .collect()
        })
        .unwrap_or_default();
    let dictation_files = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| dictation_model_files(&d.join("whisper-models")))
        .unwrap_or_default();

    // 2. Read the record (quick; under the lock).
    let data = {
        let db = app.state::<DbState>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let status = status_from(&conn)?;
        let models = installed_models(&conn, &engine_files, &dictation_files, &labels);
        let rows = name_download_rows(list(&conn, 2000)?, &labels)
            .into_iter()
            .map(|r| (local_stamp(&conn, r.last_at), r))
            .collect();
        let ram = crate::system::total_ram_gb();
        ReportData {
            generated: local_stamp(&conn, now_unix()),
            app_version: app.package_info().version.to_string(),
            machine: match ram {
                Some(gb) => format!("Mac, {gb} GB of memory"),
                None => "Mac".to_string(),
            },
            locked: status.locked,
            locked_since: status.locked_since.map(|t| local_stamp(&conn, t)),
            answers_with: answers_with
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "Not stated".to_string()),
            summary: status.summary,
            models,
            rows,
        }
    };

    // 3. Write the page.
    std::fs::write(&path, build_report_html(&data)).map_err(|e| format!("write {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn
    }

    // 2026-11-22 12:00:00 UTC, and a day later. Noon keeps both on distinct
    // local days in every time zone.
    const DAY1: i64 = 1_795_348_800;
    const DAY2: i64 = DAY1 + 86_400;

    // ── this Mac ───────────────────────────────────────────────────────────

    #[test]
    fn loopback_addresses_are_this_mac() {
        for url in [
            "http://localhost:11434/api/tags",
            "http://127.0.0.1:8080/v1/chat/completions",
            "http://127.9.9.9/",
            "http://[::1]:1234/health",
            "http://engine.localhost:9000",
            "LOCALHOST:11434",
        ] {
            assert!(is_on_this_mac(url), "{url}");
        }
    }

    #[test]
    fn everything_else_is_another_machine() {
        for url in [
            "https://huggingface.co/api/models/x/tree/main",
            "http://192.168.1.50:11434",
            "http://office-mac.local:8080/v1",
            "http://10.0.0.2",
            "http://0.0.0.0:8080",
            // A name that merely contains "localhost".
            "http://localhost.example.com",
            "http://notlocalhost",
            // Unreadable → not assumed local.
            "",
            "http://",
        ] {
            assert!(!is_on_this_mac(url), "{url}");
        }
    }

    #[test]
    fn host_of_drops_scheme_port_and_path() {
        assert_eq!(
            host_of("https://HuggingFace.co/api/models"),
            "huggingface.co"
        );
        assert_eq!(
            host_of("http://office-mac.local:8080/v1"),
            "office-mac.local"
        );
        assert_eq!(host_of("192.168.1.50:11434"), "192.168.1.50");
        assert_eq!(host_of("http://[::1]:1234/x"), "::1");
        assert_eq!(host_of("not a url"), "");
    }

    // ── the record ─────────────────────────────────────────────────────────

    #[test]
    fn the_same_thing_on_the_same_day_is_one_counted_row() {
        let conn = db();
        for i in 0..3 {
            record(
                &conn,
                DAY1 + i * 900,
                "watch_feed",
                "",
                "example.com",
                "done",
                1000,
            )
            .unwrap();
        }
        let rows = list(&conn, 50).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].count, 3);
        assert_eq!(rows[0].bytes, 3000);
        assert_eq!(rows[0].first_at, DAY1);
        assert_eq!(rows[0].last_at, DAY1 + 1800);
    }

    #[test]
    fn a_different_day_model_host_or_result_is_its_own_row() {
        let conn = db();
        record(
            &conn,
            DAY1,
            "model_download",
            "gemma4-12b",
            "huggingface.co",
            "verified",
            7,
        )
        .unwrap();
        record(
            &conn,
            DAY1,
            "model_download",
            "gemma4-e4b",
            "huggingface.co",
            "verified",
            6,
        )
        .unwrap();
        record(
            &conn,
            DAY1,
            "model_download",
            "gemma4-12b",
            "huggingface.co",
            "failed",
            0,
        )
        .unwrap();
        record(
            &conn,
            DAY2,
            "model_download",
            "gemma4-12b",
            "huggingface.co",
            "verified",
            7,
        )
        .unwrap();
        record(
            &conn,
            DAY2,
            "model_download",
            "gemma4-12b",
            "example.org",
            "verified",
            7,
        )
        .unwrap();
        assert_eq!(list(&conn, 50).unwrap().len(), 5);
    }

    #[test]
    fn list_is_most_recent_first_and_capped() {
        let conn = db();
        record(&conn, DAY1, "model_lookup", "", "huggingface.co", "done", 0).unwrap();
        record(
            &conn,
            DAY2,
            "dictation_model",
            "base.en",
            "huggingface.co",
            "done",
            142,
        )
        .unwrap();
        let rows = list(&conn, 50).unwrap();
        assert_eq!(rows[0].purpose, "dictation_model");
        assert_eq!(rows[1].purpose, "model_lookup");
        assert_eq!(list(&conn, 1).unwrap().len(), 1);
    }

    #[test]
    fn summary_counts_made_refused_and_what_left_this_mac() {
        let conn = db();
        assert_eq!(summary(&conn).unwrap(), Summary::default());

        record(
            &conn,
            DAY1,
            "model_download",
            "gemma4-12b",
            "huggingface.co",
            "verified",
            7,
        )
        .unwrap();
        record(
            &conn,
            DAY1,
            "model_download",
            "gemma4-e4b",
            "huggingface.co",
            "refused",
            0,
        )
        .unwrap();
        record(&conn, DAY1, "chat", "", "office-mac.local", "done", 0).unwrap();
        record(&conn, DAY1, "chat", "", "office-mac.local", "done", 0).unwrap();
        // A chat that failed may still have gone out.
        record(&conn, DAY1, "chat", "", "office-mac.local", "failed", 0).unwrap();
        // One the lock stopped did not.
        record(&conn, DAY1, "chat", "", "office-mac.local", "refused", 0).unwrap();
        record(&conn, DAY1, "documents", "", "office-mac.local", "done", 0).unwrap();
        record(&conn, DAY1, "server", "", "office-mac.local", "done", 0).unwrap();

        let s = summary(&conn).unwrap();
        assert_eq!(s.made, 6);
        assert_eq!(s.refused, 2);
        assert_eq!(s.chats_sent, 3);
        assert_eq!(s.documents_sent, 1);
        // Most used first; a host only ever refused is not "connected to".
        assert_eq!(
            s.hosts,
            vec!["office-mac.local".to_string(), "huggingface.co".to_string()]
        );
    }

    // ── the lock ───────────────────────────────────────────────────────────

    #[test]
    fn the_lock_remembers_when_it_was_turned_on() {
        let conn = db();
        assert!(!status_from(&conn).unwrap().locked);
        set_lock(&conn, true, DAY1).unwrap();
        let s = status_from(&conn).unwrap();
        assert!(s.locked);
        assert_eq!(s.locked_since, Some(DAY1));
        // "On" again while on does not move the date.
        set_lock(&conn, true, DAY2).unwrap();
        assert_eq!(status_from(&conn).unwrap().locked_since, Some(DAY1));
        // Off, then on: a new date.
        set_lock(&conn, false, DAY2).unwrap();
        let off = status_from(&conn).unwrap();
        assert!(!off.locked);
        assert_eq!(off.locked_since, None);
        set_lock(&conn, true, DAY2).unwrap();
        assert_eq!(status_from(&conn).unwrap().locked_since, Some(DAY2));
    }

    // The gate's own switch is process-wide; these two tests share it, so
    // they run as one.
    #[test]
    fn the_gate_passes_local_refuses_remote_when_locked() {
        LOCKED.store(false, Ordering::SeqCst);
        // Lock off: both are allowed; only the remote one carries a duty.
        let local = allow(Purpose::Server, "", "http://127.0.0.1:8080/v1/models").unwrap();
        assert!(local.0.is_none());
        local.done(0);
        let remote = allow(
            Purpose::ModelLookup,
            "",
            "https://huggingface.co/api/models/x",
        )
        .unwrap();
        assert!(remote.0.is_some());
        remote.done(10);

        LOCKED.store(true, Ordering::SeqCst);
        // Lock on: this Mac still works — the built-in engine is unaffected.
        assert!(allow(
            Purpose::Chat,
            "",
            "http://localhost:9000/v1/chat/completions"
        )
        .is_ok());
        let err = allow(
            Purpose::ModelDownload,
            "gemma4-12b",
            "https://huggingface.co/x.gguf",
        )
        .err()
        .expect("refused");
        assert!(err.contains("offline lock is on"), "{err}");
        assert!(err.contains("huggingface.co"), "{err}");
        assert!(err.contains("Settings → Privacy"), "{err}");
        // A connection another program would make on our behalf, too.
        assert!(allow_host(Purpose::ModelDownload, "llama3", "ollama.com").is_err());
        // An address that cannot be read is not waved through.
        assert!(allow(Purpose::Server, "", "").is_err());
        LOCKED.store(false, Ordering::SeqCst);
    }

    // ── words ──────────────────────────────────────────────────────────────

    #[test]
    fn sent_off_words_say_none_or_count_honestly() {
        let mut s = Summary::default();
        assert_eq!(sent_off_words(&s), "None");
        s.chats_sent = 1;
        assert_eq!(sent_off_words(&s), "1 chat; no dictation");
        s.chats_sent = 42;
        s.documents_sent = 3;
        assert_eq!(
            sent_off_words(&s),
            "42 chats, 3 document-search requests; no dictation"
        );
    }

    #[test]
    fn human_bytes_reads_like_a_download_size() {
        assert_eq!(human_bytes(0), "");
        assert_eq!(human_bytes(900), "900 bytes");
        assert_eq!(human_bytes(12_000), "12 KB");
        assert_eq!(human_bytes(274_000_000), "274 MB");
        assert_eq!(human_bytes(7_200_000_000), "7.2 GB");
    }

    #[test]
    fn purposes_and_results_have_words() {
        assert_eq!(
            purpose_words("model_download", "gemma4-12b"),
            "Model download: gemma4-12b"
        );
        assert_eq!(purpose_words("model_download", ""), "Model download");
        assert_eq!(purpose_words("chat", "ignored"), "Chat sent to a server");
        for p in [
            Purpose::ModelDownload,
            Purpose::ModelLookup,
            Purpose::DictationModel,
            Purpose::Chat,
            Purpose::Documents,
            Purpose::Server,
        ] {
            // Every purpose the code can record reads as words, not a key.
            assert_ne!(purpose_words(p.key(), ""), p.key(), "{:?}", p);
        }
        for r in ["done", "verified", "failed", "refused", "stopped"] {
            assert_ne!(result_words(r), "Unknown");
        }
    }

    // ── the report ─────────────────────────────────────────────────────────

    fn sample() -> ReportData {
        ReportData {
            generated: "2026-11-23 09:30".into(),
            app_version: "0.9.0".into(),
            machine: "Mac, 36 GB of memory".into(),
            locked: true,
            locked_since: Some("2026-11-22 14:20".into()),
            answers_with: "The built-in engine, on this Mac".into(),
            summary: Summary {
                made: 4,
                refused: 1,
                chats_sent: 0,
                documents_sent: 0,
                hosts: vec!["huggingface.co".into()],
            },
            models: vec![
                ModelEntry {
                    label: "Balanced · Gemma 4 12B".into(),
                    file: "gemma4-12b.gguf".into(),
                    bytes: 7_200_000_000,
                    provenance: Provenance::Verified("2026-11-22".into()),
                },
                ModelEntry {
                    label: "my-own".into(),
                    file: "my-own.gguf".into(),
                    bytes: 4_100_000_000,
                    provenance: Provenance::Downloaded("2026-11-20".into()),
                },
                ModelEntry {
                    label: "Dictation · base.en".into(),
                    file: "ggml-base.en.bin".into(),
                    bytes: 142_000_000,
                    provenance: Provenance::Unrecorded,
                },
            ],
            rows: vec![(
                "2026-11-22 13:58".into(),
                NetRow {
                    day: "2026-11-22".into(),
                    purpose: "model_download".into(),
                    detail: "Balanced".into(),
                    host: "huggingface.co".into(),
                    result: "verified".into(),
                    count: 2,
                    bytes: 7_200_000_000,
                    first_at: DAY1,
                    last_at: DAY1,
                },
            )],
        }
    }

    #[test]
    fn the_report_states_the_lock_the_headline_and_its_limits() {
        let html = build_report_html(&sample());
        assert!(html.contains("<h1>Ekorbia privacy report</h1>"));
        assert!(html.contains("2026-11-23 09:30 · Ekorbia 0.9.0 · Mac, 36 GB of memory"));
        assert!(html.contains("On since 2026-11-22 14:20"));
        assert!(html.contains("<dd>None</dd>"), "nothing sent off this Mac");
        assert!(html.contains("4, all to huggingface.co"));
        assert!(html.contains("Balanced · Gemma 4 12B"));
        assert!(html.contains("gemma4-12b.gguf, 7.2 GB"));
        assert!(html.contains("Matched its published checksum when downloaded, 2026-11-22"));
        assert!(html.contains("Downloaded 2026-11-20; no published checksum to compare"));
        assert!(html.contains("No download on record"));
        // It says the files were not read again, and what "no record" means.
        assert!(html.contains("the files were not read again for this report"));
        assert!(html.contains("installed before this record began, or was added by hand"));
        // No checksum is printed: none was computed.
        assert!(!html.contains("sha256"));
        assert!(html.contains("Model download: Balanced, 7.2 GB (2 connections that day)"));
        assert!(html.contains(">Verified<"));
        // It says what it cannot speak for.
        assert!(html.contains("It does not cover other apps, macOS, or a separate Ollama install"));
        assert!(html.contains("never what was sent or received"));
    }

    #[test]
    fn the_report_is_a_plain_page_that_loads_nothing() {
        let html = build_report_html(&sample());
        for forbidden in ["<script", "<img", "<link", "http://", "https://", "url("] {
            assert!(
                !html.contains(forbidden),
                "report must not contain {forbidden}"
            );
        }
    }

    #[test]
    fn the_report_escapes_what_it_prints() {
        let mut d = sample();
        d.models[1].label = "<b>evil</b> & co".into();
        d.rows[0].1.host = "evil.example\"><script>".into();
        d.answers_with = "A server at <office>".into();
        let html = build_report_html(&d);
        assert!(!html.contains("<b>evil</b>"));
        assert!(html.contains("&lt;b&gt;evil&lt;/b&gt; &amp; co"));
        assert!(!html.contains("<script>"));
        assert!(html.contains("A server at &lt;office&gt;"));
    }

    #[test]
    fn a_report_with_nothing_to_list_says_so() {
        let mut d = sample();
        d.locked = false;
        d.locked_since = None;
        d.summary = Summary::default();
        d.models.clear();
        d.rows.clear();
        let html = build_report_html(&d);
        assert!(html.contains("<dd>Off</dd>"));
        assert!(html.contains("No model files were found."));
        assert!(html.contains("Ekorbia has not connected to anything other than this Mac."));
    }

    #[test]
    fn download_rows_take_the_models_plain_names() {
        let conn = db();
        record(
            &conn,
            DAY1,
            "model_download",
            "gemma4-12b",
            "huggingface.co",
            "verified",
            7,
        )
        .unwrap();
        record(
            &conn,
            DAY1,
            "model_download",
            "my-own",
            "example.org",
            "done",
            1,
        )
        .unwrap();
        // The same word as a model's id, but not a download: left alone.
        record(
            &conn,
            DAY1,
            "dictation_model",
            "gemma4-12b",
            "huggingface.co",
            "done",
            1,
        )
        .unwrap();
        let mut labels = std::collections::HashMap::new();
        labels.insert(
            "gemma4-12b".to_string(),
            "Balanced · Gemma 4 12B".to_string(),
        );
        let rows = name_download_rows(list(&conn, 50).unwrap(), &labels);
        let detail = |purpose: &str, host: &str| {
            rows.iter()
                .find(|r| r.purpose == purpose && r.host == host)
                .map(|r| r.detail.clone())
                .unwrap()
        };
        assert_eq!(
            detail("model_download", "huggingface.co"),
            "Balanced · Gemma 4 12B"
        );
        assert_eq!(detail("model_download", "example.org"), "my-own");
        assert_eq!(detail("dictation_model", "huggingface.co"), "gemma4-12b");
    }

    #[test]
    fn several_hosts_are_all_named() {
        let mut d = sample();
        d.summary.made = 9;
        d.summary.hosts = vec!["office-mac.local".into(), "huggingface.co".into()];
        assert!(build_report_html(&d).contains("9, to office-mac.local, huggingface.co"));
    }

    // ── the installed models ───────────────────────────────────────────────

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ekorbia-net-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn provenance_comes_from_the_record() {
        let conn = db();
        assert_eq!(
            provenance(&conn, "model_download", "gemma4-12b"),
            Provenance::Unrecorded
        );

        // From a bare link: downloaded, nothing to compare.
        record(
            &conn,
            DAY1,
            "model_download",
            "my-own",
            "example.org",
            "done",
            4,
        )
        .unwrap();
        assert!(matches!(
            provenance(&conn, "model_download", "my-own"),
            Provenance::Downloaded(_)
        ));

        // A failed or refused attempt is not a download.
        record(
            &conn,
            DAY1,
            "model_download",
            "gemma4-12b",
            "huggingface.co",
            "failed",
            0,
        )
        .unwrap();
        record(
            &conn,
            DAY1,
            "model_download",
            "gemma4-12b",
            "huggingface.co",
            "refused",
            0,
        )
        .unwrap();
        assert_eq!(
            provenance(&conn, "model_download", "gemma4-12b"),
            Provenance::Unrecorded
        );

        // Verified wins, and carries the day it happened.
        record(
            &conn,
            DAY2,
            "model_download",
            "gemma4-12b",
            "huggingface.co",
            "verified",
            7,
        )
        .unwrap();
        let Provenance::Verified(day) = provenance(&conn, "model_download", "gemma4-12b") else {
            panic!("expected verified");
        };
        assert_eq!(day.len(), 10, "a date: {day}");
        assert!(day.starts_with("2026-11-2"), "{day}");

        // The same id under another purpose is another thing.
        assert_eq!(
            provenance(&conn, "dictation_model", "gemma4-12b"),
            Provenance::Unrecorded
        );
    }

    #[test]
    fn installed_models_are_named_sized_and_traced() {
        let conn = db();
        let catalog = crate::engine::downloads::catalog();
        let known = catalog.models[0].clone();
        record(
            &conn,
            DAY1,
            "model_download",
            &known.id,
            "huggingface.co",
            "verified",
            7,
        )
        .unwrap();
        record(
            &conn,
            DAY1,
            "dictation_model",
            "base.en",
            "huggingface.co",
            "done",
            1,
        )
        .unwrap();

        let mut labels = std::collections::HashMap::new();
        labels.insert(known.id.clone(), "Balanced · Test".to_string());
        let engine = vec![
            (known.id.clone(), 7_200_000_000u64),
            ("my-own".to_string(), 10u64),
        ];
        let dictation = vec![("base.en".to_string(), 142_000_000u64)];
        let out = installed_models(&conn, &engine, &dictation, &labels);
        assert_eq!(out.len(), 3);

        assert_eq!(out[0].label, "Balanced · Test");
        assert_eq!(out[0].file, format!("{}.gguf", known.id));
        assert_eq!(out[0].bytes, 7_200_000_000);
        assert!(matches!(out[0].provenance, Provenance::Verified(_)));

        // One the app has no name for keeps its own, and has no record.
        assert_eq!(out[1].label, "my-own");
        assert_eq!(out[1].provenance, Provenance::Unrecorded);

        assert_eq!(out[2].label, "Dictation · base.en");
        assert_eq!(out[2].file, "ggml-base.en.bin");
        assert!(matches!(out[2].provenance, Provenance::Downloaded(_)));

        // Without a label from the app, a catalog model takes the catalog's name.
        let bare = installed_models(&conn, &engine, &[], &Default::default());
        assert_eq!(bare[0].label, known.label);
    }

    #[test]
    fn dictation_files_are_found_by_name_without_being_read() {
        let dir = tmpdir("voice");
        std::fs::write(dir.join("ggml-base.en.bin"), b"abc").unwrap();
        std::fs::write(dir.join("ggml-base.en.partial"), b"half").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        assert_eq!(
            dictation_model_files(&dir),
            vec![("base.en".to_string(), 3u64)]
        );
        assert!(dictation_model_files(&dir.join("missing")).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── the tripwire ───────────────────────────────────────────────────────

    /// Every source file that builds an HTTP client must go through the
    /// gate, and every place a request is sent must have its own call to it
    /// (or a `net-gate:` comment saying why it needs none). This cannot
    /// prove the right URL is checked, but it catches the common slip: a new
    /// request that never heard of this module.
    #[test]
    fn net_gate_covers_every_client() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().and_then(|x| x.to_str()) == Some("rs") {
                    out.push(p);
                }
            }
        }
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        walk(&src, &mut files);
        assert!(files.len() > 10, "found the source tree");

        let mut ungated = Vec::new();
        for f in files {
            if f.file_name().and_then(|n| n.to_str()) == Some("net.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&f).unwrap();
            // Only the code before the tests module counts.
            let code = text.split("#[cfg(test)]").next().unwrap_or("");
            let builds_client = code.contains("reqwest::Client::builder()")
                || code.contains("reqwest::Client::new()");
            // A `net-gate:` comment stands in for a call where none is
            // needed (a loopback health check; a client built here but used
            // by gated callers) and says why.
            let markers = code.matches("net-gate:").count();
            let calls = code.matches("crate::net::allow").count();
            let name = f.strip_prefix(&src).unwrap().display().to_string();
            if builds_client && calls + markers == 0 {
                ungated.push(format!("{name}: builds a client, never asks the gate"));
            }
            // reqwest's `.send()` takes no arguments; channel sends do.
            let sends = code.matches(".send()").count();
            if sends > calls + markers {
                ungated.push(format!(
                    "{name}: {sends} requests sent, {} gate calls",
                    calls + markers
                ));
            }
        }
        assert!(
            ungated.is_empty(),
            "network code that does not go through crate::net: {ungated:#?}"
        );
    }
}
