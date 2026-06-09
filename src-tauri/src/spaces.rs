// SPDX-License-Identifier: MIT

//! Spaces (workspace bundles): persistence commands for the `spaces`,
//! `space_attachments`, and `space_prompts` tables introduced in Phase 0.
#![allow(clippy::needless_pass_by_value)]
//!
//! A Space bundles a default model, optional pinned attachments,
//! optional pinned prompts (each of which can be marked `locked` to
//! make it always-attached / can't-be-detached from chats in the
//! Space), and an optional Space-scoped memory file. New chats inside
//! a Space inherit all of those at creation time. Chats outside any
//! Space behave exactly as before (`chats.space_id IS NULL`).
//!
//! Locked pinned prompts replaced an earlier `spaces.system_prompt`
//! field that did the same job worse — see `space_prompts.locked` in
//! db.rs SCHEMA and the `drop_spaces_system_prompt` migration.
//!
//! IMPORTANT — same `INSERT … ON CONFLICT DO UPDATE` rule as `chat.rs`:
//! `spaces` is an FK parent of both `space_attachments` and
//! `space_prompts` (ON DELETE CASCADE). `INSERT OR REPLACE` would
//! cascade-wipe both child tables before re-inserting the Space row —
//! pinned attachments and pinned prompts would silently disappear on
//! every Space-settings save. See CLAUDE.md "INSERT OR REPLACE on FK
//! cascade parents" and the Phase 0 migration tests.
//!
//! IMPORTANT — slug stability: `spaces.slug` is the stable identifier
//! used for the default Space memory-file path
//! (`~/Documents/Ekorbia/Spaces/<slug>/memory.md`). It is set once at
//! create time and is deliberately NOT updatable — changing it would
//! orphan the memory file on disk. The display name (`name`) is
//! freely editable.

use crate::db::{now_unix, slugify, DbState};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Max suffix attempts (`base-2`, `base-3`, …) before `dedupe_slug` gives
/// up and stamps a unix-timestamp suffix. Matches `prompts::SLUG_DEDUP_MAX_ATTEMPTS`
/// in spirit — high enough that a real user can't trip it but bounded so a
/// pathological DB doesn't spin forever.
const SLUG_DEDUP_MAX_ATTEMPTS: u32 = 1000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpaceRow {
    id: String,
    name: String,
    /// Stable identifier used for the default memory-file path and any
    /// future on-disk artefacts. Set once at create time; NOT updatable
    /// via `space_update` — see module docs.
    slug: String,
    /// Palette key (e.g. `"amber"`, `"blue"`) mapped by the UI to the
    /// active theme's accent colors. `None` = sidebar falls back to the
    /// default fg color.
    #[serde(default)]
    color: Option<String>,
    /// Model id preselected for new chats in this Space. `None` = new
    /// chats inherit the global default-model preference instead.
    #[serde(default)]
    default_model: Option<String>,
    /// Absolute path to a Space-scoped `memory.md`. `None` = no Space
    /// memory file (global `memory.md` still applies). When set, the
    /// Space memory injects AFTER the global memory so it overlays on
    /// top — see Phase 5 send-pipeline plan.
    #[serde(default)]
    memory_path: Option<String>,
    sort_index: i64,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpaceAttachmentRow {
    id: String,
    space_id: String,
    /// User's pin-time intent: `"file"` for a single file (the
    /// attachment pipeline determines text/PDF/image at instantiation
    /// time) or `"folder"` for a directory tree. Aligned with the
    /// chooser UI (paperclip vs folder button), not with
    /// `attachments.kind` — see SCHEMA comment.
    kind: String,
    path: String,
    added_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpacePromptRow {
    id: String,
    space_id: String,
    /// Filename-without-extension of the prompt's `.md` file. Read-time
    /// joins against the live prompts library silently drop orphans
    /// (file deleted on disk but pin row still present) — same pattern
    /// `prompt_meta` uses.
    prompt_slug: String,
    sort_index: i64,
    added_at: i64,
    /// "Always attached, can't be detached" flag (0/1 in SQLite). When
    /// true, the composer suppresses the chip's × button for chats in
    /// this Space so the user can't remove the prompt mid-conversation.
    /// Replaces the earlier `spaces.system_prompt` text field.
    #[serde(default)]
    locked: bool,
}

// ── Slug helpers ────────────────────────────────────────────────────────────

/// Slugify a Space's display name into `[a-z0-9-]+` with a safe fallback.
/// Thin wrapper over `db::slugify` — returns `"space"` when the input
/// slugifies to empty (only emoji / punctuation / non-ASCII) so a valid
/// filesystem-safe identifier is always produced.
fn slugify_space_name(name: &str) -> String {
    let v = slugify(name, None);
    if v.is_empty() {
        "space".into()
    } else {
        v
    }
}

/// Pick a non-colliding slug for a new Space. Queries the DB rather than
/// the filesystem (vs. `prompts::dedupe_slug`) because slug uniqueness is
/// enforced at the `spaces.slug` UNIQUE constraint — checking against the
/// live row set is the authoritative test. After `SLUG_DEDUP_MAX_ATTEMPTS`
/// exhausts, stamps a unix-timestamp suffix to guarantee progress.
fn dedupe_slug_in_db(conn: &Connection, base: &str) -> Result<String, String> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM spaces WHERE slug = ?1 LIMIT 1")
        .map_err(|e| e.to_string())?;
    if !stmt.exists([base]).map_err(|e| e.to_string())? {
        return Ok(base.to_string());
    }
    for n in 2..SLUG_DEDUP_MAX_ATTEMPTS {
        let cand = format!("{base}-{n}");
        if !stmt.exists([cand.as_str()]).map_err(|e| e.to_string())? {
            return Ok(cand);
        }
    }
    Ok(format!("{base}-{}", now_unix()))
}

// ── Spaces CRUD ─────────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) fn space_list(state: tauri::State<'_, DbState>) -> Result<Vec<SpaceRow>, String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT id, name, slug, color, default_model, memory_path, \
                    sort_index, created_at, updated_at \
             FROM spaces ORDER BY sort_index ASC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SpaceRow {
                id: row.get(0)?,
                name: row.get(1)?,
                slug: row.get(2)?,
                color: row.get(3)?,
                default_model: row.get(4)?,
                memory_path: row.get(5)?,
                sort_index: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn space_get(state: tauri::State<'_, DbState>, id: String) -> Result<SpaceRow, String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    db.query_row(
        "SELECT id, name, slug, color, default_model, memory_path, \
                sort_index, created_at, updated_at \
         FROM spaces WHERE id = ?1",
        [&id],
        |row| {
            Ok(SpaceRow {
                id: row.get(0)?,
                name: row.get(1)?,
                slug: row.get(2)?,
                color: row.get(3)?,
                default_model: row.get(4)?,
                memory_path: row.get(5)?,
                sort_index: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        },
    )
    .map_err(|e| format!("space not found: {e}"))
}

/// Create a new Space. The caller (JS) supplies the id, name, and optional
/// color; Rust derives the slug from the name and dedupes it against the
/// existing `spaces.slug` set. `sort_index` is set to MAX+1 so the new
/// Space appears at the bottom of the sidebar list — predictable and
/// avoids reshuffling other Spaces.
///
/// Returns the created SpaceRow so the caller doesn't need a follow-up
/// `space_get` to learn the final slug (which may differ from the
/// slugified name if it collided).
#[tauri::command]
pub(crate) fn space_create(
    state: tauri::State<'_, DbState>,
    id: String,
    name: String,
    color: Option<String>,
) -> Result<SpaceRow, String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let base = slugify_space_name(&name);
    let slug = dedupe_slug_in_db(&db, &base)?;
    let next_sort: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(sort_index), -1) + 1 FROM spaces",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let now = now_unix();
    db.execute(
        "INSERT INTO spaces \
            (id, name, slug, color, default_model, memory_path, \
             sort_index, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6, ?6)",
        (&id, &name, &slug, &color, next_sort, now),
    )
    .map_err(|e| e.to_string())?;
    Ok(SpaceRow {
        id,
        name,
        slug,
        color,
        default_model: None,
        memory_path: None,
        sort_index: next_sort,
        created_at: now,
        updated_at: now,
    })
}

/// Update an existing Space's editable fields. Deliberately does NOT
/// touch `slug` (stable identifier — see module docs), `id`, `created_at`,
/// or `sort_index` (owned by `space_reorder`). Uses
/// `INSERT … ON CONFLICT(id) DO UPDATE` rather than a bare UPDATE so the
/// same statement handles a race where a Space was deleted between the
/// UI's read and write — though in practice the UI guards against that.
///
/// The cascade rule applies in spirit: `spaces` has FK children
/// (`space_attachments`, `space_prompts`) so `INSERT OR REPLACE` would
/// silently wipe them. The ON CONFLICT pattern keeps the row in place
/// and the children untouched.
#[tauri::command]
pub(crate) fn space_update(
    state: tauri::State<'_, DbState>,
    space: SpaceRow,
) -> Result<(), String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO spaces \
            (id, name, slug, color, default_model, memory_path, \
             sort_index, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
         ON CONFLICT(id) DO UPDATE SET \
            name          = excluded.name, \
            color         = excluded.color, \
            default_model = excluded.default_model, \
            memory_path   = excluded.memory_path, \
            updated_at    = excluded.updated_at",
        (
            &space.id,
            &space.name,
            &space.slug,
            &space.color,
            &space.default_model,
            &space.memory_path,
            space.sort_index,
            space.created_at,
            space.updated_at,
        ),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a Space and unfile any chats that belonged to it (NULL out
/// their `space_id` rather than cascade-deleting the chats themselves).
/// Wrapped in a transaction so unfile + delete is atomic.
///
/// Fresh installs have the FK `ON DELETE SET NULL` action that would do
/// this automatically, but upgrade installs lack the FK (ALTER TABLE
/// can't add one). Doing it explicitly in app code makes both paths
/// behave identically — same shape as `db_delete_group`.
///
/// `space_attachments` and `space_prompts` are cascade-deleted via FK
/// (they're declared in SCHEMA on a fresh table, so both fresh and
/// upgrade installs have the FK on these child tables).
#[tauri::command]
pub(crate) fn space_delete(state: tauri::State<'_, DbState>, id: String) -> Result<(), String> {
    let mut db = state.0.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE chats SET space_id = NULL WHERE space_id = ?1",
        [&id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM spaces WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Re-write `sort_index` from a user-supplied ordered list of Space ids.
/// Wrapped in a transaction so the new ordering lands atomically. Unknown
/// ids in the list are silently ignored (the UPDATE just affects 0 rows).
/// Any Space not in the list keeps its existing sort_index — callers
/// should pass every Space id in the order they want.
///
/// Mirrors `db_reorder_groups` exactly.
#[tauri::command]
pub(crate) fn space_reorder(
    state: tauri::State<'_, DbState>,
    ids: Vec<String>,
) -> Result<(), String> {
    let mut db = state.0.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    for (idx, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE spaces SET sort_index = ?2 WHERE id = ?1",
            (id, idx as i64),
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Move a chat into a Space, or unfile it (pass `None` for `space_id`).
/// This is the ONLY write path for `chats.space_id` — `db_upsert_chat`
/// deliberately leaves the column alone on update so a normal chat-save
/// can't clobber the user's filing.
#[tauri::command]
pub(crate) fn db_move_chat_to_space(
    state: tauri::State<'_, DbState>,
    chat_id: String,
    space_id: Option<String>,
) -> Result<(), String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE chats SET space_id = ?2 WHERE id = ?1",
        (&chat_id, &space_id),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Pinned attachments ──────────────────────────────────────────────────────

#[tauri::command]
pub(crate) fn space_attachments_list(
    state: tauri::State<'_, DbState>,
    space_id: String,
) -> Result<Vec<SpaceAttachmentRow>, String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT id, space_id, kind, path, added_at \
             FROM space_attachments WHERE space_id = ?1 \
             ORDER BY added_at ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&space_id], |row| {
            Ok(SpaceAttachmentRow {
                id: row.get(0)?,
                space_id: row.get(1)?,
                kind: row.get(2)?,
                path: row.get(3)?,
                added_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Pin a file or folder to a Space. `kind` is `"file"` or `"folder"`;
/// anything else is rejected up front so a typo in the UI dispatch
/// doesn't silently land a malformed row. The instantiation pipeline
/// (Phase 4) will look the path up at chat-create time and route
/// through the existing attachment machinery — no validation of the
/// path itself here.
#[tauri::command]
pub(crate) fn space_attachment_add(
    state: tauri::State<'_, DbState>,
    id: String,
    space_id: String,
    kind: String,
    path: String,
) -> Result<(), String> {
    if kind != "file" && kind != "folder" {
        return Err(format!(
            "space_attachment kind must be 'file' or 'folder' (got {kind:?})"
        ));
    }
    let db = state.0.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO space_attachments (id, space_id, kind, path, added_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        (&id, &space_id, &kind, &path, now_unix()),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn space_attachment_remove(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM space_attachments WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Pinned prompts ──────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) fn space_prompts_list(
    state: tauri::State<'_, DbState>,
    space_id: String,
) -> Result<Vec<SpacePromptRow>, String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT id, space_id, prompt_slug, sort_index, added_at, locked \
             FROM space_prompts WHERE space_id = ?1 \
             ORDER BY sort_index ASC, added_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&space_id], |row| {
            // SQLite booleans are integers; row.get::<_, i64>(5) > 0 is
            // the canonical "is true" check. rusqlite supports
            // row.get::<_, bool>(5) too but is stricter about type
            // codes (TEXT/REAL legacy rows would fail). Going via i64
            // is the safer pattern.
            let locked: i64 = row.get(5)?;
            Ok(SpacePromptRow {
                id: row.get(0)?,
                space_id: row.get(1)?,
                prompt_slug: row.get(2)?,
                sort_index: row.get(3)?,
                added_at: row.get(4)?,
                locked: locked != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Pin a prompt to a Space. `sort_index` is auto-assigned to MAX+1 for the
/// Space so the new pin lands at the end of the list — predictable and
/// matches the "added to bottom" pattern used by groups + Spaces themselves.
///
/// The UNIQUE(space_id, prompt_slug) constraint catches double-pins; we
/// treat that as a silent no-op rather than an error so the UI can call
/// this idempotently on a "ensure pinned" code path without checking first.
/// (Distinguishing the UNIQUE constraint failure from other SQLite errors
/// goes through the extended error code — we match on the substring
/// "UNIQUE constraint" since SQLite's error texts are stable and the
/// alternative is pulling in `rusqlite::ErrorCode` matching that brings
/// no clarity here.)
#[tauri::command]
pub(crate) fn space_prompt_add(
    state: tauri::State<'_, DbState>,
    id: String,
    space_id: String,
    prompt_slug: String,
    locked: Option<bool>,
) -> Result<(), String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let next_sort: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(sort_index), -1) + 1 \
             FROM space_prompts WHERE space_id = ?1",
            [&space_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    // Default to unlocked when the caller didn't supply a value — matches
    // the SCHEMA DEFAULT 0 and lets older JS code call the command without
    // a `locked` field.
    let locked_i: i64 = locked.unwrap_or(false).into();
    let res = db.execute(
        "INSERT INTO space_prompts (id, space_id, prompt_slug, sort_index, added_at, locked) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (
            &id,
            &space_id,
            &prompt_slug,
            next_sort,
            now_unix(),
            locked_i,
        ),
    );
    match res {
        Ok(_) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("UNIQUE constraint") {
                // Already pinned — silent no-op.
                Ok(())
            } else {
                Err(msg)
            }
        }
    }
}

/// Toggle the `locked` flag on a single pinned-prompt row. The settings
/// modal calls this when the user clicks the lock icon next to a pinned
/// row. Idempotent — flipping a row to the value it already has is just
/// a 0-row UPDATE, not an error.
#[tauri::command]
pub(crate) fn space_prompt_set_locked(
    state: tauri::State<'_, DbState>,
    id: String,
    locked: bool,
) -> Result<(), String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    let locked_i: i64 = locked.into();
    db.execute(
        "UPDATE space_prompts SET locked = ?2 WHERE id = ?1",
        (&id, locked_i),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn space_prompt_remove(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let db = state.0.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM space_prompts WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Re-write `sort_index` from a user-supplied ordered list of `space_prompts`
/// row ids (drag-reorder). Wrapped in a transaction so the new ordering
/// lands atomically. Unknown ids no-op (UPDATE affects 0 rows). Rows not
/// in the list keep their existing sort_index.
///
/// Mirrors `space_reorder` / `db_reorder_groups` — same pattern.
#[tauri::command]
pub(crate) fn space_prompt_reorder(
    state: tauri::State<'_, DbState>,
    ids: Vec<String>,
) -> Result<(), String> {
    let mut db = state.0.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    for (idx, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE space_prompts SET sort_index = ?2 WHERE id = ?1",
            (id, idx as i64),
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SCHEMA;
    use rusqlite::Connection;

    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA)
            .expect("SCHEMA must apply cleanly");
        conn
    }

    /// 9-tuple shape returned by SELECTing every column from `spaces`.
    /// Used by the two round-trip tests below — factored out to satisfy
    /// clippy::type_complexity (the tuple is shared and inlining it
    /// twice triggers the lint on both sites).
    ///
    /// Column order matches the SELECT statement: `id, name, slug,
    /// color, default_model, memory_path, sort_index, created_at,
    /// updated_at`. Nullable columns are `Option<String>`; integer
    /// columns are `i64`.
    type SpaceRowTuple = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
        i64,
        i64,
    );

    // ── Slug helpers ────────────────────────────────────────────────────────

    #[test]
    fn slugify_space_name_falls_back_to_space_on_empty() {
        // CLAUDE.md "Local-only state" rule: the slug becomes a filesystem
        // path segment. The empty-string contract has to produce a usable
        // identifier so the memory-file path is always well-formed.
        assert_eq!(slugify_space_name(""), "space");
        assert_eq!(slugify_space_name("!!!"), "space");
        assert_eq!(slugify_space_name("🎉"), "space");
    }

    #[test]
    fn slugify_space_name_passes_through_for_normal_input() {
        assert_eq!(slugify_space_name("Novel Writing"), "novel-writing");
        assert_eq!(slugify_space_name("Q4 plans"), "q4-plans");
    }

    #[test]
    fn dedupe_slug_returns_base_when_free() {
        let conn = fresh_db();
        let slug = dedupe_slug_in_db(&conn, "fresh").unwrap();
        assert_eq!(slug, "fresh");
    }

    #[test]
    fn dedupe_slug_appends_2_on_collision() {
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'A', 'taken')",
            [],
        )
        .unwrap();
        let slug = dedupe_slug_in_db(&conn, "taken").unwrap();
        assert_eq!(slug, "taken-2");
    }

    #[test]
    fn dedupe_slug_appends_3_when_2_also_taken() {
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'A', 'taken')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s2', 'B', 'taken-2')",
            [],
        )
        .unwrap();
        let slug = dedupe_slug_in_db(&conn, "taken").unwrap();
        assert_eq!(slug, "taken-3");
    }

    // ── Direct SQL CRUD round-trips ─────────────────────────────────────────
    //
    // Mirrors the chat.rs test pattern: hit the SQL the command would
    // emit, rather than wiring up tauri::State (which is more ceremony
    // than payoff for a DB-shape regression check). The Tauri command
    // surface is exercised through Playwright end-to-end in Phase 2.

    #[test]
    fn space_row_round_trips_via_create_and_list_sql() {
        // SQL shape matches `space_create` + `space_list`. Confirms a
        // freshly-created Space loads back with NULL defaults for the
        // editable fields and the supplied id/name/color.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces \
                (id, name, slug, color, default_model, memory_path, \
                 sort_index, created_at, updated_at) \
             VALUES ('s1', 'Novel', 'novel', 'amber', NULL, NULL, 0, 100, 100)",
            [],
        )
        .unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT id, name, slug, color, default_model, memory_path, \
                        sort_index, created_at, updated_at \
                 FROM spaces ORDER BY sort_index ASC, created_at ASC",
            )
            .unwrap();
        let rows: Vec<SpaceRowTuple> = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                ))
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.0, "s1");
        assert_eq!(r.1, "Novel");
        assert_eq!(r.2, "novel");
        assert_eq!(r.3.as_deref(), Some("amber"));
        assert!(r.4.is_none(), "default_model defaults to NULL");
        assert!(r.5.is_none(), "memory_path defaults to NULL");
        assert_eq!(r.6, 0);
    }

    #[test]
    fn space_update_changes_name_color_model_memory_not_slug() {
        // The space_update SET clause deliberately omits `slug`, `id`,
        // `created_at`, and `sort_index`. This test pins that contract:
        // an UPDATE through the command's SQL shape must leave the slug
        // unchanged even when the payload tries to set a different one.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces \
                (id, name, slug, color, sort_index, created_at, updated_at) \
             VALUES ('s1', 'orig', 'orig-slug', 'amber', 0, 100, 100)",
            [],
        )
        .unwrap();

        // Same SQL as `space_update`. Payload tries to rename, recolor,
        // set a default model + memory path, AND change the slug.
        conn.execute(
            "INSERT INTO spaces \
                (id, name, slug, color, default_model, memory_path, \
                 sort_index, created_at, updated_at) \
             VALUES ('s1', 'renamed', 'attempted-new-slug', 'blue', \
                     'gemma4:latest', '/tmp/mem.md', \
                     0, 100, 200) \
             ON CONFLICT(id) DO UPDATE SET \
                name          = excluded.name, \
                color         = excluded.color, \
                default_model = excluded.default_model, \
                memory_path   = excluded.memory_path, \
                updated_at    = excluded.updated_at",
            [],
        )
        .unwrap();

        let (
            id,
            name,
            slug,
            color,
            default_model,
            memory_path,
            sort_index,
            created_at,
            updated_at,
        ): SpaceRowTuple = conn
            .query_row(
                "SELECT id, name, slug, color, default_model, memory_path, \
                        sort_index, created_at, updated_at FROM spaces WHERE id = 's1'",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(id, "s1");
        assert_eq!(name, "renamed", "name should update");
        assert_eq!(
            slug, "orig-slug",
            "slug must NOT change on update — it's the stable memory-file identifier"
        );
        assert_eq!(color.as_deref(), Some("blue"));
        assert_eq!(default_model.as_deref(), Some("gemma4:latest"));
        assert_eq!(memory_path.as_deref(), Some("/tmp/mem.md"));
        assert_eq!(sort_index, 0, "sort_index untouched by update");
        assert_eq!(created_at, 100, "created_at preserved across update");
        assert_eq!(updated_at, 200, "updated_at refreshed");
    }

    #[test]
    fn space_update_does_not_cascade_wipe_children() {
        // Regression test for the cascade-on-OR-REPLACE landmine, this
        // time on the spaces table. If a future refactor switches
        // space_update from ON CONFLICT DO UPDATE to OR REPLACE, the
        // child rows (space_attachments + space_prompts) would silently
        // disappear on every Space-settings save. Same family of bug as
        // chat.rs `upsert_chat_preserves_messages`, just one table down.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces \
                (id, name, slug, color, sort_index, created_at, updated_at) \
             VALUES ('s1', 'orig', 'orig', NULL, 0, 100, 100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_attachments (id, space_id, kind, path) \
             VALUES ('sa1', 's1', 'folder', '/notes')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_prompts (id, space_id, prompt_slug, sort_index) \
             VALUES ('sp1', 's1', 'tone-reframer', 0)",
            [],
        )
        .unwrap();

        // The correct upsert pattern used in `space_update`.
        conn.execute(
            "INSERT INTO spaces \
                (id, name, slug, color, default_model, memory_path, \
                 sort_index, created_at, updated_at) \
             VALUES ('s1', 'renamed', 'orig', NULL, NULL, NULL, 0, 100, 200) \
             ON CONFLICT(id) DO UPDATE SET \
                name = excluded.name, \
                updated_at = excluded.updated_at",
            [],
        )
        .unwrap();

        let attach_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM space_attachments WHERE space_id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let prompt_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM space_prompts WHERE space_id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            attach_count, 1,
            "ON CONFLICT DO UPDATE must not cascade-delete pinned attachments"
        );
        assert_eq!(
            prompt_count, 1,
            "ON CONFLICT DO UPDATE must not cascade-delete pinned prompts"
        );
    }

    #[test]
    fn move_chat_to_space_round_trips() {
        // Mirrors `db_move_chat_to_space`'s SQL. Pin the round-trip so a
        // refactor of the column type (e.g. switching to TEXT NOT NULL by
        // accident) trips this.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'Novel', 'novel')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chats (id, title, model) VALUES ('c1', 'Q2 plan', 'm')",
            [],
        )
        .unwrap();

        let initial: Option<String> = conn
            .query_row("SELECT space_id FROM chats WHERE id = 'c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(initial.is_none(), "new chats start with NULL space_id");

        // File it into the Space.
        conn.execute("UPDATE chats SET space_id = ?2 WHERE id = ?1", ("c1", "s1"))
            .unwrap();
        let filed: Option<String> = conn
            .query_row("SELECT space_id FROM chats WHERE id = 'c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(filed.as_deref(), Some("s1"));

        // Unfile by binding NULL — same shape as db_move_chat_to_space
        // with `Option::None`.
        let none_id: Option<String> = None;
        conn.execute(
            "UPDATE chats SET space_id = ?2 WHERE id = ?1",
            ("c1", &none_id),
        )
        .unwrap();
        let unfiled: Option<String> = conn
            .query_row("SELECT space_id FROM chats WHERE id = 'c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(unfiled.is_none(), "passing None must NULL the column");
    }

    // ── Pinned prompts edge cases ───────────────────────────────────────────

    #[test]
    fn space_prompt_add_idempotent_on_duplicate() {
        // The command's no-op-on-UNIQUE-violation contract: pinning the
        // same prompt to the same Space twice must succeed silently.
        // This test exercises the SQL + error-string match path the
        // command relies on; if SQLite ever changes its UNIQUE error
        // message format the test will catch it before users do.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'A', 'a')",
            [],
        )
        .unwrap();

        // First insert succeeds.
        let r1 = conn.execute(
            "INSERT INTO space_prompts (id, space_id, prompt_slug, sort_index, added_at) \
             VALUES ('sp1', 's1', 'tone-reframer', 0, 100)",
            [],
        );
        assert!(r1.is_ok());

        // Second insert with a NEW id but the same (space_id, slug) pair
        // hits the UNIQUE constraint — and the error text contains the
        // substring "UNIQUE constraint" the command matches on.
        let r2 = conn.execute(
            "INSERT INTO space_prompts (id, space_id, prompt_slug, sort_index, added_at) \
             VALUES ('sp2', 's1', 'tone-reframer', 1, 200)",
            [],
        );
        let err = r2.expect_err("duplicate (space_id, slug) must fail at the DB layer");
        assert!(
            err.to_string().contains("UNIQUE constraint"),
            "SQLite error text changed — update space_prompt_add's match. got: {err}"
        );
    }

    #[test]
    fn space_prompt_orphan_slug_survives_missing_md_file() {
        // The pin row references the prompt by slug — a string, no FK to
        // any prompt table. If the user deletes the underlying .md from
        // disk, the pin row stays in the DB; the read-time JOIN against
        // the live prompts library (Phase 3) silently drops the orphan.
        //
        // This test pins the contract that the DB layer does NOT cascade
        // or invalidate the pin on its own. The orphan filter lives in
        // app code, not in the schema.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'A', 'a')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_prompts (id, space_id, prompt_slug, sort_index, added_at) \
             VALUES ('sp1', 's1', 'does-not-exist', 0, 100)",
            [],
        )
        .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM space_prompts WHERE space_id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "orphan-slug pin must persist at the DB layer");
    }

    // ── Pinned attachments ──────────────────────────────────────────────────

    #[test]
    fn space_attachments_list_orders_by_added_at_ascending() {
        // The space_attachments_list SQL orders ascending so the
        // user-visible list reflects pin order. This is what Phase 4
        // will use to drive the order pinned attachments are instantiated
        // onto new chats — predictable to the user.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'A', 'a')",
            [],
        )
        .unwrap();
        // Insert in non-chronological id order to make sure the ORDER BY
        // does the work (not just luck-of-the-id).
        conn.execute(
            "INSERT INTO space_attachments (id, space_id, kind, path, added_at) \
             VALUES ('sa-zzz', 's1', 'folder', '/zzz', 100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_attachments (id, space_id, kind, path, added_at) \
             VALUES ('sa-aaa', 's1', 'folder', '/aaa', 200)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_attachments (id, space_id, kind, path, added_at) \
             VALUES ('sa-mmm', 's1', 'file',   '/mmm', 150)",
            [],
        )
        .unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT path FROM space_attachments WHERE space_id = 's1' \
                 ORDER BY added_at ASC, id ASC",
            )
            .unwrap();
        let paths: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(paths, vec!["/zzz", "/mmm", "/aaa"]);
    }

    // ── Locked pinned prompts ───────────────────────────────────────────────

    #[test]
    fn locked_column_defaults_to_zero_on_fresh_insert() {
        // SCHEMA's `locked INTEGER NOT NULL DEFAULT 0` means an INSERT
        // that omits the column produces an unlocked pin. Required for
        // backward-compat with older JS code that may not supply the
        // field; `space_prompt_add`'s `locked: Option<bool>` also relies
        // on the DEFAULT.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'A', 'a')",
            [],
        )
        .unwrap();
        // Insert without the locked column.
        conn.execute(
            "INSERT INTO space_prompts (id, space_id, prompt_slug, sort_index) \
             VALUES ('sp1', 's1', 'tone-reframer', 0)",
            [],
        )
        .unwrap();
        let locked: i64 = conn
            .query_row(
                "SELECT locked FROM space_prompts WHERE id = 'sp1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(locked, 0, "fresh inserts must default to unlocked");
    }

    #[test]
    fn locked_round_trips_via_insert_and_update() {
        // Mirrors `space_prompt_add` (with locked=true) and
        // `space_prompt_set_locked`. Pin the two SQL shapes the
        // commands use.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'A', 'a')",
            [],
        )
        .unwrap();

        // Insert with locked=1 (mirrors space_prompt_add when called
        // with Some(true)).
        conn.execute(
            "INSERT INTO space_prompts (id, space_id, prompt_slug, sort_index, added_at, locked) \
             VALUES ('sp1', 's1', 'tone-reframer', 0, 100, 1)",
            [],
        )
        .unwrap();
        let locked: i64 = conn
            .query_row(
                "SELECT locked FROM space_prompts WHERE id = 'sp1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(locked, 1, "locked=true round-trips on INSERT");

        // Toggle off via UPDATE (mirrors space_prompt_set_locked).
        conn.execute("UPDATE space_prompts SET locked = 0 WHERE id = 'sp1'", [])
            .unwrap();
        let locked: i64 = conn
            .query_row(
                "SELECT locked FROM space_prompts WHERE id = 'sp1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(locked, 0, "set_locked(false) round-trips on UPDATE");
    }

    #[test]
    fn space_prompts_list_reads_locked_flag() {
        // The `space_prompts_list` command's row decode reads `locked`
        // as i64 then converts to bool. Pin the round-trip via the
        // exact SELECT shape the command uses, so a column-rename or
        // index drift trips this.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'A', 'a')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_prompts (id, space_id, prompt_slug, sort_index, added_at, locked) \
             VALUES \
                ('sp1', 's1', 'tone-reframer', 0, 100, 1), \
                ('sp2', 's1', 'brainstorm',    1, 200, 0)",
            [],
        )
        .unwrap();
        // Same SELECT shape as space_prompts_list.
        let mut stmt = conn
            .prepare(
                "SELECT id, space_id, prompt_slug, sort_index, added_at, locked \
                 FROM space_prompts WHERE space_id = ?1 \
                 ORDER BY sort_index ASC, added_at ASC",
            )
            .unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map(["s1"], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(5)?))
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(rows, vec![("sp1".into(), 1), ("sp2".into(), 0)]);
    }
}
