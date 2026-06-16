// SPDX-License-Identifier: MIT

//! Public Tauri commands for the Watch feature surface.
#![allow(clippy::needless_pass_by_value)]

use crate::db::DbState;
use crate::watch::cancel::cancel_watch;
use crate::watch::http::{fetch_url_html, html_to_text_with_selector};
use crate::watch::pipeline::{run_all_watches_inner, run_watch};
use crate::watch::rss::fetch_rss_feed;
use crate::watch::{default_interval_for_kind, map_watch_row, Watch, WatchEvent, WATCH_COLUMNS};
use tauri::Manager;

#[tauri::command]
pub(crate) fn watch_list(state: tauri::State<'_, DbState>) -> Result<Vec<Watch>, String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let sql = format!("SELECT {WATCH_COLUMNS} FROM watches ORDER BY created_at DESC");
    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_watch_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn watch_create(state: tauri::State<'_, DbState>, watch: Watch) -> Result<(), String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    // Same INSERT-OR-REPLACE-cascades-children trap as db_upsert_chat:
    // watch_events references watches(id) ON DELETE CASCADE, so REPLACE
    // would silently wipe a watch's event history every time the row is
    // re-saved. Use ON CONFLICT DO UPDATE to preserve the row.
    //
    // Normalise the cadence: a UI-side default of 0 (or anything below 10s)
    // means "pick the kind-appropriate default" — keeps the JS form simple
    // and prevents users from accidentally hammering remote servers.
    let kind = if watch.kind.is_empty() {
        "folder".to_string()
    } else {
        watch.kind.clone()
    };
    let interval = if watch.interval_secs < 10 {
        default_interval_for_kind(&kind)
    } else {
        watch.interval_secs
    };
    // Normalise the CSS selector: empty string from the form becomes NULL
    // in DB so `extract_url_text` can use a single check (Option::is_none)
    // for "use the whole body".
    let selector = watch
        .url_selector
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    // Normalise the diff mode: only 'snapshot' and 'diff' are valid.
    // Anything else (including blank / unset) is coerced to NULL, which
    // the runtime treats as 'snapshot'. This means a malformed JS payload
    // can't get the watch stuck in an unrecognised mode.
    let diff_mode = match watch.url_diff_mode.as_deref().map(|s| s.trim()) {
        Some("diff") => Some("diff".to_string()),
        Some("snapshot") => Some("snapshot".to_string()),
        _ => None,
    };
    // CRITICAL: `last_content`, `last_polled_at`, `last_notified_status`,
    // and `last_notified_at` are pipeline-owned and must NOT appear in the
    // DO UPDATE SET list — otherwise re-saving the form would wipe the
    // diff baseline (re-firing a full-page summary on the next poll) or
    // reset the recovery dedup (re-notifying for an error already shown).
    // Same family of bug as `INSERT OR REPLACE` on FK parents, just at
    // the column level.
    db.execute(
        "INSERT INTO watches \
         (id, name, folder_path, notes_path, model, prompt_id, enabled, created_at, \
          kind, source_url, interval_secs, last_polled_at, url_selector, url_diff_mode, notify, \
          ignore_before) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16) \
         ON CONFLICT(id) DO UPDATE SET \
            name = excluded.name, \
            folder_path = excluded.folder_path, \
            notes_path = excluded.notes_path, \
            model = excluded.model, \
            prompt_id = excluded.prompt_id, \
            enabled = excluded.enabled, \
            kind = excluded.kind, \
            source_url = excluded.source_url, \
            interval_secs = excluded.interval_secs, \
            url_selector = excluded.url_selector, \
            url_diff_mode = excluded.url_diff_mode, \
            notify = excluded.notify, \
            ignore_before = COALESCE(excluded.ignore_before, ignore_before)",
        // ignore_before uses COALESCE rather than a plain overwrite: it's
        // user-set at creation (the Downloads recipe / form sets it) but the
        // edit form doesn't surface it, so a form-save sends NULL — which
        // must PRESERVE the existing cutoff, not clear it. Clearing it would
        // re-expose the whole pre-existing folder on the next scan.
        (
            &watch.id,
            &watch.name,
            &watch.folder_path,
            &watch.notes_path,
            &watch.model,
            &watch.prompt_id,
            i64::from(watch.enabled),
            watch.created_at,
            &kind,
            &watch.source_url,
            interval,
            watch.last_polled_at,
            &selector,
            &diff_mode,
            i64::from(watch.notify),
            watch.ignore_before,
        ),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn watch_delete(state: tauri::State<'_, DbState>, id: String) -> Result<(), String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM watches WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn watch_set_enabled(
    state: tauri::State<'_, DbState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    {
        let db = state.0.lock().map_err(|e| e.to_string())?;
        db.execute(
            "UPDATE watches SET enabled = ?1 WHERE id = ?2",
            (i64::from(enabled), &id),
        )
        .map_err(|e| e.to_string())?;
        // Lock is dropped at the end of this block — important because
        // `cancel_watch` doesn't touch the DB but the in-flight cycle
        // it interrupts almost certainly does (insert_event, etc), and
        // we don't want to deadlock waiting on ourselves.
    }
    // Off-toggle is also a "stop right now" gesture: a watch can be
    // mid-LLM-call when the user flips it off, and they expect the
    // activity to actually stop rather than complete the current item
    // first. The cycle's runner sees the flag at its next per-item
    // check and bails. No-op when no cycle is in flight.
    if !enabled {
        cancel_watch(&id);
    }
    Ok(())
}

/// Build the `watch_events` SELECT with the WHERE clause matching whichever
/// filters are active, instead of hand-writing all four watch_id×since
/// combinations. Named params (:wid, :since, :limit) are bound by the caller.
fn build_events_query(filter_watch: bool, filter_since: bool) -> String {
    let mut sql = String::from(
        "SELECT id, watch_id, file_path, status, summary, error, created_at FROM watch_events",
    );
    let mut clauses: Vec<&str> = Vec::new();
    if filter_watch {
        clauses.push("watch_id = :wid");
    }
    if filter_since {
        clauses.push("created_at >= :since");
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY created_at DESC LIMIT :limit");
    sql
}

/// List watch events, newest first. `watch_id` filters to one watch (None =
/// all). `since` (unix secs) filters to events at/after that time — used by
/// the "Today" digest view. Both are optional; a missing `since` (the
/// pre-digest UI call shape) deserializes to None and returns everything,
/// so the change is backward compatible.
#[tauri::command]
pub(crate) fn watch_events_list(
    state: tauri::State<'_, DbState>,
    watch_id: Option<String>,
    limit: i64,
    since: Option<i64>,
) -> Result<Vec<WatchEvent>, String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let limit = limit.clamp(1, 500);

    let sql = build_events_query(watch_id.is_some(), since.is_some());
    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let mut params: Vec<(&str, &dyn rusqlite::ToSql)> = Vec::new();
    if let Some(ref wid) = watch_id {
        params.push((":wid", wid));
    }
    if let Some(ref s) = since {
        params.push((":since", s));
    }
    params.push((":limit", &limit));

    let events = stmt
        .query_map(params.as_slice(), |row| {
            Ok(WatchEvent {
                id: row.get(0)?,
                watch_id: row.get(1)?,
                file_path: row.get(2)?,
                status: row.get(3)?,
                summary: row.get(4)?,
                error: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(events)
}

/// Resolve sensible default paths for the watch-creation form / recipes:
/// the OS Downloads directory (for the Downloads recipe) and a default
/// notes directory under the user's Documents. Both may be absent only on
/// the most unusual setups; the UI falls back to letting the user pick.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchDefaultPaths {
    downloads_dir: Option<String>,
    default_notes_dir: String,
}

#[tauri::command]
pub(crate) fn watch_default_paths() -> WatchDefaultPaths {
    let downloads_dir = dirs::download_dir().map(|p| p.to_string_lossy().to_string());
    // Mirror memory.rs's resolution chain: Documents, else home, else "".
    let base = dirs::document_dir().or_else(dirs::home_dir);
    let default_notes_dir = base
        .map(|p| {
            p.join("Ekorbia")
                .join("watches")
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_default();
    WatchDefaultPaths {
        downloads_dir,
        default_notes_dir,
    }
}

/// Kick off an immediate one-shot scan of all enabled watches, ignoring
/// the poll interval AND the per-watch cadence gate. Useful for a "Run
/// now" button in the UI — the user explicitly asked, so they don't want
/// us deciding it's too soon.
#[tauri::command]
pub(crate) async fn watch_run_once(app: tauri::AppHandle) -> Result<(), String> {
    run_all_watches_inner(&app, true).await;
    Ok(())
}

/// Run a single watch immediately, bypassing both the cadence gate and
/// the `enabled` flag. Powers the "Create and run" / "Save and run"
/// buttons in WatchModal so the user gets immediate feedback rather
/// than waiting for the polling tick (which can be up to 30s) AND the
/// watch's own interval (up to a day for URL watches).
///
/// Loads the watch in a small lock scope before the await — holding
/// `DbState` across an await would block every other DB caller for the
/// duration of a potentially-minutes-long LLM call.
///
/// We intentionally don't gate on `enabled` here. The most common use
/// (from the modal) is a fresh create that *is* enabled, but even if a
/// user disabled the watch on save, "run" was their explicit choice —
/// no point silently no-op'ing.
#[tauri::command]
pub(crate) async fn watch_run_one(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let watch: Watch = {
        let state = app.state::<DbState>();
        let db = state.0.lock().map_err(|e| e.to_string())?;
        let sql = format!("SELECT {WATCH_COLUMNS} FROM watches WHERE id = ?1");
        db.query_row(&sql, [&id], map_watch_row)
            .map_err(|e| format!("watch_run_one: load {id}: {e}"))?
    };
    // Lock dropped above. Now safe to await on the pipeline (which will
    // re-acquire the lock for short scoped writes inside insert_event,
    // mark_watch_polled, etc).
    run_watch(&app, &watch).await;
    Ok(())
}

/// Probe a candidate watch source without persisting anything. Used by
/// the "Test" button in WatchModal so the user can validate a URL before
/// saving. Returns a short human-readable status string on success; an
/// error string with the underlying failure on failure.
#[tauri::command]
pub(crate) async fn watch_test_source(kind: String, source_url: String) -> Result<String, String> {
    match kind.as_str() {
        "rss" => {
            let feed = fetch_rss_feed(&source_url).await?;
            let count = feed.entries.len();
            let title = feed
                .title
                .as_ref()
                .map(|t| t.content.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "(untitled feed)".to_string());
            let plural = if count == 1 { "entry" } else { "entries" };
            Ok(format!("OK — {count} {plural} in \"{title}\""))
        }
        "url" => {
            // For URL kind we fetch the page (no selector — testing the
            // selector deserves its own field-test if/when we expose it)
            // and report extracted-text length so the user can sanity-
            // check that the page actually has body content. A page that
            // returns 0 chars usually means the content is JS-rendered.
            let html = fetch_url_html(&source_url).await?;
            let extracted = html_to_text_with_selector(&html, None);
            let chars = extracted.chars().count();
            if chars == 0 {
                Err("OK fetch but 0 characters extracted (JS-rendered page?)".to_string())
            } else {
                Ok(format!("OK — {chars} characters extracted"))
            }
        }
        other => Err(format!("Unsupported kind '{other}'")),
    }
}

/// Read a watch's notes file. Returns an empty string when the file doesn't
/// exist yet (no events have been processed), so the caller can treat
/// "missing" and "empty" the same way without an extra existence check.
/// Used by the "Chat with notes" button in WatchPanel.
///
/// **Sandbox**: the `path` argument is validated against the `watches.notes_path`
/// column before reading. Without this check, any caller of the Tauri invoke
/// bridge (UI today, but defense-in-depth against an XSS) could read arbitrary
/// filesystem paths the app process has access to. The UI always passes a
/// real watch row's `notes_path`, so the lookup succeeds in normal use.
#[tauri::command]
pub(crate) fn watch_notes_read(
    state: tauri::State<'_, DbState>,
    path: String,
) -> Result<String, String> {
    {
        let db = state.0.lock().map_err(|e| e.to_string())?;
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM watches WHERE notes_path = ?1",
                [&path],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("not a configured watch notes path".to_string());
        }
    }
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(p).map_err(|e| format!("Notes read failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SCHEMA;
    use rusqlite::Connection;

    #[test]
    fn build_events_query_includes_only_active_filters() {
        assert!(!build_events_query(false, false).contains("WHERE"));
        let w = build_events_query(true, false);
        assert!(w.contains("watch_id = :wid") && !w.contains("created_at >="));
        let s = build_events_query(false, true);
        // "watch_id" appears in the SELECT column list either way; assert on
        // the WHERE-clause fragment instead.
        assert!(s.contains("created_at >= :since") && !s.contains("watch_id = :wid"));
        let both = build_events_query(true, true);
        assert!(both.contains("watch_id = :wid AND created_at >= :since"));
    }

    /// The `since` filter must actually drop older rows. Exercises the real
    /// built query against an in-memory DB with the real schema.
    #[test]
    fn since_filter_drops_older_events() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO watches (id, name, folder_path, notes_path) VALUES ('w1','W','/tmp','/tmp/n.md')",
            [],
        )
        .unwrap();
        for (id, ts) in [("old", 1000_i64), ("new", 100_000_i64)] {
            conn.execute(
                "INSERT INTO watch_events (id, watch_id, file_path, status, created_at) \
                 VALUES (?1, 'w1', ?2, 'done', ?3)",
                (id, format!("/tmp/{id}"), ts),
            )
            .unwrap();
        }

        // since = 50_000 → only the "new" event (ts 100_000) survives.
        let sql = build_events_query(true, true);
        let mut stmt = conn.prepare(&sql).unwrap();
        let ids: Vec<String> = stmt
            .query_map(
                &[
                    (":wid", &"w1" as &dyn rusqlite::ToSql),
                    (":since", &50_000_i64),
                    (":limit", &500_i64),
                ],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(ids, vec!["new".to_string()]);

        // No since → both events.
        let sql_all = build_events_query(true, false);
        let mut stmt2 = conn.prepare(&sql_all).unwrap();
        let count = stmt2
            .query_map(
                &[
                    (":wid", &"w1" as &dyn rusqlite::ToSql),
                    (":limit", &500_i64),
                ],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
            .count();
        assert_eq!(count, 2);
    }

    /// ignore_before round-trips through create → list, and a form-save that
    /// omits it (None) PRESERVES the existing cutoff (COALESCE), rather than
    /// clearing it and re-exposing the backlog.
    #[test]
    fn ignore_before_persists_and_survives_form_resave() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        // Create with a cutoff (as the Downloads recipe would).
        conn.execute(
            "INSERT INTO watches (id, name, folder_path, notes_path, ignore_before) \
             VALUES ('w1','Downloads','/dl','/n.md', 12345)",
            [],
        )
        .unwrap();
        // Simulate a form re-save that omits ignore_before (NULL) using the
        // same COALESCE clause watch_create uses.
        conn.execute(
            "INSERT INTO watches (id, name, folder_path, notes_path, ignore_before) \
             VALUES ('w1','Downloads renamed','/dl','/n.md', NULL) \
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, \
             ignore_before = COALESCE(excluded.ignore_before, ignore_before)",
            [],
        )
        .unwrap();
        let got: (String, Option<i64>) = conn
            .query_row(
                "SELECT name, ignore_before FROM watches WHERE id='w1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(got.0, "Downloads renamed"); // edit applied
        assert_eq!(got.1, Some(12345)); // cutoff preserved
    }

    #[test]
    fn default_paths_resolve_a_notes_dir() {
        let p = watch_default_paths();
        // On any normal dev/CI machine a home/Documents dir resolves; tolerate
        // the (unusual) empty case but verify the shape when present.
        assert!(p.default_notes_dir.is_empty() || p.default_notes_dir.contains("Ekorbia"));
        if let Some(d) = p.downloads_dir.as_deref() {
            assert!(!d.is_empty());
        }
    }
}
