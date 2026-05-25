// SPDX-License-Identifier: MIT

//! Database state, schema, and low-level helpers used across the rest of the crate.
//!
//! The connection is wrapped in a `std::sync::Mutex` and stored as Tauri-managed
//! state; commands grab the lock for the duration of their query and release.
//! Long-running async tasks must NOT hold the lock across `.await` (the mutex
//! is sync and would block the executor thread) — see CLAUDE.md "DB lock held
//! across await deadlocks".

use rusqlite::Connection;
use std::sync::Mutex;

pub(crate) struct DbState(pub(crate) Mutex<Connection>);

pub(crate) const SCHEMA: &str = "
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    -- Absolute path the chat is allowed to write to via the write_file
    -- tool. NULL = no folder picked yet; first write_file call surfaces
    -- the permission modal in the UI. Empty string '' is the sentinel
    -- for 'blocked always' — modal won't reappear.
    output_dir TEXT,
    -- Multi-model comparison mode (see CLAUDE.md, Multi-model panel):
    --   NULL or 'single'      -- ordinary single-model chat
    --   'multi-pending'       -- compare-mode chat awaiting a pick on
    --                            its first assistant turn; the panel
    --                            layout is in effect
    --   'single-from-multi'   -- user has picked; chat now behaves as
    --                            a normal single-model chat but retains
    --                            unpicked variant rows for the
    --                            N-alternatives disclosure
    tab_type TEXT,
    -- For 'multi-pending' / 'single-from-multi' chats: JSON-encoded
    -- array of the model ids being compared, e.g.
    -- '[''gemma4:26b'',''llama3:70b'',''qwen2.5:32b'']'. NULL for
    -- single-mode. Capped at 3 entries by the UI per the v1 column-
    -- count decision.
    multi_models TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    -- 'user' / 'assistant' / 'system' / 'tool' (tool-call response rows).
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    model TEXT,
    time TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    tokens_ms INTEGER,
    prompts_json TEXT,
    -- JSON array of attachment citations the assistant message drew on:
    -- [{ id, label, path, kind, citationIndex }, ...]. Null when the
    -- message had no attachments at send time. User messages keep this
    -- null — sources are conceptually a property of the assistant reply.
    sources_json TEXT,
    -- JSON array of tool_calls emitted by an assistant turn (one per
    -- call). NULL on regular turns; kept so a reloaded chat preserves
    -- tool-call history for any future re-send.
    tool_calls_json TEXT,
    -- For role='tool' rows: the id of the call this is the response to.
    -- Matches the model-supplied id from the corresponding tool_calls
    -- entry on the preceding assistant row. NULL otherwise.
    tool_call_id TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    -- Multi-model fan-out: groups every assistant row produced in
    -- parallel for a single user turn. All N variant rows share the
    -- same value (a chat-scoped opaque id). NULL on single-mode chats
    -- and on user/system/tool rows.
    variant_group_id TEXT,
    -- For variant rows:
    --   1     -- the chosen response (canonical history, visible by
    --            default in the chat scroll)
    --   0     -- an unpicked sibling (hidden by default; surfaced via
    --            the alternatives disclosure under the picked row)
    --   NULL  -- single-mode row OR multi-pending row that the user
    --            hasn't acted on yet (still streaming, or all variants
    --            are still equal candidates and the panel layout
    --            renders them all)
    is_picked INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, seq);

-- ── Full-text search on message content ────────────────────────────────────
-- FTS5 virtual table mirrors messages.content for fast keyword search across
-- chat history. UNINDEXED columns are stored alongside but not tokenised so
-- search results can return chat/message metadata in one query without
-- needing a follow-up join through SQLite. Default tokenizer (unicode61
-- with diacritic stripping) gives case-insensitive matching across English
-- and accented Latin text without the cost of stemming.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    msg_id UNINDEXED,
    chat_id UNINDEXED,
    role UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 1'
);

-- Sync triggers: keep messages_fts in lockstep with messages. Using the
-- source row's integer rowid as the FTS rowid lets us join back without a
-- secondary lookup on msg_id. The UPDATE trigger filters to content-only
-- changes — bumping tokens_in/out doesn't need to re-tokenize the row.
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, msg_id, chat_id, role)
    VALUES (new.rowid, new.content, new.id, new.chat_id, new.role);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
    UPDATE messages_fts SET content = new.content WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.rowid;
END;

-- ── Prompts (file-system backed) ───────────────────────────────────────────
-- Prompt content lives in Markdown files under the user-configured prompts
-- directory (default: ~/Documents/Ekorbia/Prompts). The filename (without
-- .md) is the prompt slug (its id). Frontmatter holds name + tags so the
-- file is portable / version-controllable on its own.
--
-- This table holds only the *local* UI preferences that should NOT travel
-- with a shared file: favorite-color marker, pinned state, last-used time.
-- Joined to file data at read time, keyed by slug.
CREATE TABLE IF NOT EXISTS prompt_meta (
    slug TEXT PRIMARY KEY,
    favorite TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER
);

-- Simple key/value store for app-wide settings that don't deserve their own
-- table. First user: `prompts_dir` (the directory the file-system prompt
-- store reads from) and `builtins_seeded_v1` (one-shot stamp so we don't
-- re-copy built-in prompts on every launch).
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ── Watch ──────────────────────────────────────────────────────────────────
-- A `watch` is a configured source → notes pipeline. Three kinds:
--   folder  — scan a directory for new supported files (PDF/TXT/MD).
--   rss     — fetch an Atom/RSS feed, enumerate new entries.
--   url     — fetch a page, detect content change vs. last snapshot.
-- A single background task in lib.rs polls every enabled row at its own
-- cadence, summarises via Ollama, and appends to notes_path.
CREATE TABLE IF NOT EXISTS watches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    -- For kind='folder' this is the directory to scan. For 'rss'/'url'
    -- it's typically empty — the source URL is in source_url instead.
    -- Kept NOT NULL (legacy) and stored as '' for non-folder kinds.
    folder_path TEXT NOT NULL,
    notes_path TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'gemma4:latest',
    -- Optional reference to a prompt slug (Markdown file in the user's
    -- prompts directory). When set, the prompt's body is used as the
    -- system message for summarisation; when NULL, a built-in default
    -- instruction is used instead.
    prompt_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    -- Discriminator for the source type: 'folder' (default) / 'rss' / 'url'.
    -- run_watch() dispatches to the right pipeline based on this.
    kind TEXT NOT NULL DEFAULT 'folder',
    -- Feed URL (rss) or page URL (url). NULL for folder kind.
    source_url TEXT,
    -- Per-watch poll cadence. Defaults: folder=30s, rss=600s, url=1800s.
    -- The poller skips a watch where now - last_polled_at < this.
    interval_secs INTEGER NOT NULL DEFAULT 30,
    -- Pipeline-owned: unix timestamp of the last poll attempt. Stamped
    -- by run_watch regardless of whether items were found, so a noisy
    -- feed doesn't re-hit the network every 30s tick.
    last_polled_at INTEGER NOT NULL DEFAULT 0,
    -- Pipeline-owned (URL kind only): most recently extracted page text.
    -- Used as the change-detector AND the diff baseline. Capped at
    -- ~200KB on write so a single bloated page can't fatten the row.
    last_content TEXT,
    -- URL kind only: optional CSS selector narrowing extraction to a
    -- sub-tree (e.g. 'article', 'main', '#content'). NULL = whole body.
    url_selector TEXT,
    -- URL kind only: 'snapshot' (full new page sent to model on change)
    -- or 'diff' (only the unified line diff vs last_content). NULL is
    -- treated as 'snapshot' at runtime.
    url_diff_mode TEXT,
    -- v1 notifications: per-watch opt-in for OS notifications on events.
    -- Default 0 = off.
    notify INTEGER NOT NULL DEFAULT 0,
    -- Pipeline-owned: 'success' / 'error' — the last notify status fired
    -- for this watch. Drives recovery dedup so a permanently-failing
    -- watch only notifies on the first error after a success; the next
    -- success fires as a recovery. NULL = no notification yet.
    last_notified_status TEXT,
    -- Pipeline-owned: unix timestamp of last notification. Reserved for
    -- future rate-limiting / coalescing across cycles (v2).
    last_notified_at INTEGER NOT NULL DEFAULT 0
);

-- One row per processed file. Doubles as the already-seen memo: the
-- polling loop skips any (watch_id, file_path) that already has a done row.
CREATE TABLE IF NOT EXISTS watch_events (
    id TEXT PRIMARY KEY,
    watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    status TEXT NOT NULL,           -- 'processing' | 'done' | 'error'
    summary TEXT,
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_watch_events_watch ON watch_events(watch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_events_seen ON watch_events(watch_id, file_path, status);

-- Chat attachments (Phase 1: per-file, content read on send).
-- kind:
--   'text'   — .txt/.md/.pdf, contents inlined into the next system message
--   'image'  — .png/.jpg/.jpeg/.webp, base64-encoded into the user message's
--              `images` array when the active model has vision capability
-- ON DELETE CASCADE from chats so removing a chat clears its attachments.
-- Phase 2 will add attachment_sources + attachment_chunks for folder/RAG.
CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    -- kind:
    --   'text'   — one file, txt/md/pdf
    --   'image'  — one file, png/jpg/jpeg/webp (vision-routed)
    --   'folder' — recursive directory, multiple indexed files via
    --              attachment_sources
    kind        TEXT NOT NULL,
    path        TEXT NOT NULL,
    label       TEXT NOT NULL,
    bytes       INTEGER NOT NULL DEFAULT 0,
    added_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    -- Phase 2 indexing lifecycle:
    --   'ready'    — usable in send (small text inlined; image; or chunks ready)
    --   'indexing' — embedding pipeline running, chunks not yet written
    --   'error'    — pipeline failed, see `error` for the message
    -- Small text files (< threshold) skip the pipeline entirely and land
    -- directly in 'ready'. Only files large enough to benefit from
    -- retrieval ever pass through 'indexing'. Folder attachments always
    -- pass through 'indexing' since the walker takes time.
    status      TEXT NOT NULL DEFAULT 'ready',
    error       TEXT,
    -- Phase 3: number of files actually indexed under a folder attachment.
    -- Stays 0 for file/image attachments. Updated by the walker as it
    -- progresses so the UI can show progress without a sources JOIN.
    file_count  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_attachments_chat ON attachments(chat_id, added_at);

-- Phase 3 per-file rows under a folder attachment. Single-file attachments
-- never get a row here — the attachment.path is itself the source. For
-- folder attachments, each indexed file gets one row capturing its mtime
-- for incremental re-index. ON DELETE CASCADE chains through chunks too.
CREATE TABLE IF NOT EXISTS attachment_sources (
    id            TEXT PRIMARY KEY,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    path          TEXT NOT NULL,
    mtime         INTEGER NOT NULL DEFAULT 0,
    bytes         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sources_attachment ON attachment_sources(attachment_id);

-- Phase 2 chunked-retrieval store. One row per chunk produced from a large
-- text attachment or one file inside a folder attachment. The embedding is
-- stored as a packed f32 little-endian BLOB; cosine similarity is computed
-- in Rust at query time (no SQLite extension needed). embed_model is
-- recorded so a future settings change doesn't silently mix dimensions —
-- retrieval filters to the current model. source_id is NULL for single-file
-- attachments (the attachment IS the source); non-null for folder files.
CREATE TABLE IF NOT EXISTS attachment_chunks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    source_id     TEXT REFERENCES attachment_sources(id) ON DELETE CASCADE,
    ordinal       INTEGER NOT NULL,
    text          TEXT NOT NULL,
    embedding     BLOB NOT NULL,
    embed_model   TEXT NOT NULL,
    char_start    INTEGER,
    char_end      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chunks_attachment ON attachment_chunks(attachment_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON attachment_chunks(source_id);
-- Retrieval hot path: `retrieve_chunks` joins attachments → attachment_chunks
-- filtered by both attachment_id (via the chat) AND embed_model (so a model
-- change doesn't silently mix dimensions). A composite index on those two
-- columns lets the filter happen as an index range scan instead of a per-
-- attachment row sweep. Leading column is attachment_id so the index also
-- covers single-attachment lookups; embed_model trails so a model change
-- still resolves quickly without rebuilding.
CREATE INDEX IF NOT EXISTS idx_chunks_lookup ON attachment_chunks(attachment_id, embed_model);

-- ── Chat-generated files (tool use) ─────────────────────────────────────────
-- Durable per-save log for every file the write_file tool has produced.
-- Disk keeps only the latest copy (per chat_id + rel_path); this table
-- keeps full history so the UI can show 'v3 of index.html'. message_id
-- ON DELETE SET NULL so deleting the originating message doesn't drop
-- the file record. version auto-increments per (chat_id, rel_path) at
-- insert time inside the same SQLite transaction (don't pre-compute
-- on the JS side — races with concurrent saves).
CREATE TABLE IF NOT EXISTS chat_files (
    id          TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL REFERENCES chats(id)    ON DELETE CASCADE,
    message_id  TEXT          REFERENCES messages(id) ON DELETE SET NULL,
    rel_path    TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    saved_at    INTEGER NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('tool','manual')),
    version     INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_chat_files_chat ON chat_files(chat_id);
";

/// Apply column-add migrations to a connection AFTER `execute_batch(SCHEMA)`.
///
/// The SCHEMA const uses `CREATE TABLE IF NOT EXISTS`, which is a no-op when
/// the table already exists on an upgraded user's DB — so any columns we add
/// to SCHEMA in a later release would never appear on those DBs and the
/// first query that names them would fail with "no such column".
///
/// Each migration uses `add_column_if_missing` (PRAGMA-introspection based)
/// so this function is idempotent and safe to call on every launch — fresh
/// installs, upgraded installs, and re-launches all converge on the same
/// final shape. Order matters only if a later migration depends on the
/// presence of a column added by an earlier one; group such pairs together
/// in this function and document the dependency.
///
/// Add new migrations at the END of this function. Never reorder or remove
/// existing migrations — that would break upgrade paths from intermediate
/// versions.
///
/// **Indices on migration-added columns must be created HERE, after the
/// ALTER TABLE that adds them.** Putting `CREATE INDEX … ON t(new_col)` in
/// SCHEMA would fail on upgrade installs because the index runs before the
/// ALTER TABLE — see the CLAUDE.md gotcha on migration ordering.
pub(crate) fn apply_migrations(conn: &Connection) -> Result<(), String> {
    // ── Phase 1 (multi-model panel) ─────────────────────────────────────
    // Four nullable columns: NULL is the well-defined sentinel for "this
    // chat / message predates compare-mode". The Rust ChatRow/MessageRow
    // structs use Option<T> for each.
    add_column_if_missing(conn, "chats", "tab_type", "TEXT")?;
    add_column_if_missing(conn, "chats", "multi_models", "TEXT")?;
    add_column_if_missing(conn, "messages", "variant_group_id", "TEXT")?;
    add_column_if_missing(conn, "messages", "is_picked", "INTEGER")?;
    Ok(())
}

/// Idempotent `ALTER TABLE … ADD COLUMN`. Reads `PRAGMA table_info(table)`
/// to enumerate existing columns; if `column` is absent, issues the ALTER.
///
/// Why introspection vs. try-and-swallow-the-error: the failure mode for a
/// duplicate column is SQLite's "duplicate column name: X" error, which is
/// a string match that couples to SQLite's error formatting. PRAGMA-based
/// detection is one extra prepare/query but stays explicit and survives
/// any future SQLite error-text changes.
///
/// `type_def` is appended verbatim — pass nullable types without NOT NULL,
/// since `ALTER TABLE ADD COLUMN` rejects NOT NULL without a default. The
/// helper does NOT enforce this at compile time; if you violate it you'll
/// see a clear SQLite error on the first launch with the new code.
///
/// `table` and `column` are interpolated into SQL via `format!`. Both are
/// expected to be hardcoded identifiers in the migration list above —
/// never user-supplied — so SQL injection is not a concern. The helper
/// is `fn`, not `pub`, to keep that contract local.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    type_def: &str,
) -> Result<(), String> {
    let already_present: bool = {
        // PRAGMA table_info row shape: (cid, name, type, notnull, dflt_value, pk).
        // We only need column 1 (name). Collect into a Vec so the
        // borrow on stmt ends before this block does — letting .any()
        // hold the borrow into the block tail trips NLL temporary-drop
        // rules ("stmt dropped here while still borrowed").
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| format!("PRAGMA table_info({table}): {e}"))?;
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("PRAGMA table_info({table}) query: {e}"))?
            .filter_map(Result::ok)
            .collect();
        names.iter().any(|name| name == column)
    };
    if !already_present {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {type_def}"),
            [],
        )
        .map_err(|e| format!("ALTER TABLE {table} ADD COLUMN {column} {type_def}: {e}"))?;
    }
    Ok(())
}

/// Unix epoch seconds (truncated). Returns 0 on the (impossible) clock-
/// before-epoch case rather than panicking — call sites use this as a
/// timestamp, never as a duration, so 0 is a graceful sentinel.
pub(crate) fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// Nanoseconds since UNIX epoch. Saturates to 0 on the (impossible) clock-
/// before-epoch case. Used as a low-collision seed for `gen_id` and for
/// batch-id sites that disambiguate concurrent inserts with an index suffix
/// (see `attachment_add_files`).
pub(crate) fn nanos_since_epoch() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Generate a hex-encoded id like `"cf-7a3b1c..."` for a given prefix.
/// Nanosecond resolution makes collisions vanishingly unlikely for serial
/// callers, but two calls in a tight loop on the same thread CAN return the
/// same value on platforms whose `SystemTime` resolution is coarser. For
/// batch inserts, use `nanos_since_epoch()` once and append an index.
pub(crate) fn gen_id(prefix: &str) -> String {
    format!("{prefix}-{:x}", nanos_since_epoch())
}

/// File mtime as unix seconds. Returns `None` if metadata is unreadable,
/// `.modified()` is unsupported by the filesystem, or the mtime predates
/// UNIX_EPOCH. Callers pick their own fallback semantics:
///   - "treat unreadable as fresh" → `.unwrap_or_else(now_unix)`
///     (prompt library uses this so a broken file still sorts as recent)
///   - "treat unreadable as stale" → `.unwrap_or(0)`
///     (folder indexer uses this so it always reindexes)
pub(crate) fn file_mtime_unix(path: &std::path::Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| mtime_unix_from_meta(&m))
}

/// Same as `file_mtime_unix` but operates on already-fetched metadata —
/// folder walkers have a `Metadata` in hand from `is_file()` checks and
/// shouldn't pay for a second `fs::metadata` call.
pub(crate) fn mtime_unix_from_meta(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// Insert a placeholder chats row if one doesn't already exist, so FK
/// references from `attachments.chat_id` / `messages.chat_id` hold while
/// the user is still staging content in the sidebar. Used by
/// `attachment_add_files` and `attachment_add_folder`.
///
/// **Uses `INSERT OR IGNORE` deliberately.** Two alternatives are wrong here:
///   - `INSERT OR REPLACE` cascades DELETE on FK children — wipes any
///     existing chat's messages/attachments. Same landmine as `db_upsert_chat`
///     before its rewrite. (See CLAUDE.md "Pre-send chat rows in sidebar".)
///   - `ON CONFLICT(id) DO UPDATE SET title=..., model=...` would clobber a
///     real chat's title and model with the `'New chat' / ''` placeholder
///     values — exactly the opposite of the intent. The placeholder is only
///     supposed to materialize when the row is absent.
pub(crate) fn ensure_chat_row(db: &Connection, chat_id: &str, now: i64) -> Result<(), String> {
    db.execute(
        "INSERT OR IGNORE INTO chats (id, title, model, created_at, updated_at) \
         VALUES (?1, 'New chat', '', ?2, ?2)",
        (chat_id, now),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Read a chat's configured output_dir.
///
/// Return shape (matches `chats.output_dir` sentinel semantics in CLAUDE.md):
///   - `Ok(Some("/abs/path"))` — user has allowed; auto-write inside it
///   - `Ok(Some(""))` — user has blocked; tool calls return `user_blocked`
///   - `Ok(None)` — never asked OR row missing; permission modal should fire
///   - `Err(_)` — genuine DB error (NOT row-missing, which folds into `Ok(None)`)
///
/// **Sandbox boundary**: this helper returns the directory *only*. Callers
/// MUST route any user/model-provided filename through
/// `crate::files::sandbox::resolve_within(dir, requested)` before touching the
/// filesystem. Do NOT add a `with_filename` variant here — that would bypass
/// the sandbox chokepoint. Every file-handling tool path goes through
/// `sandbox::resolve_within`; this stays a pure read.
pub(crate) fn get_chat_output_dir(
    db: &Connection,
    chat_id: &str,
) -> Result<Option<String>, String> {
    match db.query_row(
        "SELECT output_dir FROM chats WHERE id = ?",
        rusqlite::params![chat_id],
        |r| r.get::<_, Option<String>>(0),
    ) {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Slugify a display string into `[a-z0-9-]+`. Collapses runs of non-alphanum
/// to single dashes; trims leading/trailing dashes. Returns the empty string
/// if nothing alphanumeric survives — callers pick their own fallback
/// (the prompt library uses "prompt"; the chat output-dir suggester uses
/// "chat-{id}").
///
/// When `max_len` is `Some(n)`, the result is truncated to `n` chars and any
/// resulting trailing dash is trimmed off. ASCII-only by design — we want
/// stable filenames across platforms, and non-ASCII letters drop out via
/// the `is_ascii_alphanumeric()` filter (silent but consistent with prior
/// behavior of both pre-unification implementations).
pub(crate) fn slugify(s: &str, max_len: Option<usize>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = true;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let mut trimmed = out.trim_matches('-').to_string();
    if let Some(n) = max_len {
        if trimmed.len() > n {
            trimmed.truncate(n);
            trimmed = trimmed.trim_end_matches('-').to_string();
        }
    }
    trimmed
}

/// Read a string from the `app_settings` key/value store. Returns None when
/// the key is absent OR the read fails — callers fall back to their default.
pub(crate) fn get_setting(db: &Connection, key: &str) -> Option<String> {
    db.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// Write a string to the `app_settings` key/value store. Upserts via
/// `INSERT OR REPLACE` (the table has no FK children, so REPLACE's cascade
/// behaviour is harmless here).
pub(crate) fn set_setting(db: &Connection, key: &str, value: &str) -> Result<(), String> {
    db.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        (key, value),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA)
            .expect("SCHEMA must apply cleanly");
        conn
    }

    #[test]
    fn schema_applies_cleanly() {
        // First-launch smoke test: every CREATE TABLE / TRIGGER / INDEX in
        // SCHEMA must succeed on a fresh DB. Catches FTS5 trigger syntax
        // errors, dangling FK references, index-on-missing-column, etc.
        let _ = fresh_db();
    }

    #[test]
    fn schema_includes_expected_tables() {
        // Lightweight inventory check. If a table name in SCHEMA drifts
        // out of sync with the rest of the codebase, this fires.
        let conn = fresh_db();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .filter(|n| !n.starts_with("sqlite_") && !n.contains("_fts_"))
            .collect();
        for expected in [
            "app_settings",
            "attachment_chunks",
            "attachment_sources",
            "attachments",
            "chat_files",
            "chats",
            "messages",
            "messages_fts",
            "prompt_meta",
            "watch_events",
            "watches",
        ] {
            assert!(
                names.iter().any(|n| n == expected),
                "table {expected:?} missing from SCHEMA; got {names:?}"
            );
        }
    }

    #[test]
    fn upsert_chat_preserves_messages() {
        // REGRESSION TEST for the bug that bit chat history hard.
        //
        // SQLite implements `INSERT OR REPLACE` on a PK conflict as
        // DELETE + INSERT. The DELETE cascades through every FK with
        // `ON DELETE CASCADE` — including `messages.chat_id`. So a
        // chat-row "upsert" via OR REPLACE silently wipes every message
        // in that chat.
        //
        // `INSERT … ON CONFLICT(id) DO UPDATE SET …` updates in place
        // without firing the DELETE path. This test pins that contract.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO chats (id, title, model) VALUES ('c1', 'orig', 'm')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, chat_id, role, content, seq) \
             VALUES ('m1', 'c1', 'user', 'hello', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, chat_id, role, content, seq) \
             VALUES ('m2', 'c1', 'assistant', 'hi back', 2)",
            [],
        )
        .unwrap();

        // The correct upsert pattern used in `db_upsert_chat`.
        conn.execute(
            "INSERT INTO chats (id, title, model) VALUES ('c1', 'renamed', 'm') \
             ON CONFLICT(id) DO UPDATE SET title = excluded.title",
            [],
        )
        .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE chat_id = 'c1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 2,
            "ON CONFLICT DO UPDATE must not cascade-delete child messages"
        );
        // Title was updated in place.
        let title: String = conn
            .query_row("SELECT title FROM chats WHERE id = 'c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "renamed");
    }

    #[test]
    fn or_replace_on_chats_does_wipe_messages_demonstrating_the_landmine() {
        // Companion to the test above. This pins the *wrong* pattern's
        // behaviour so anyone tempted to "simplify" the upsert to
        // `INSERT OR REPLACE` sees the bug reified in a test.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO chats (id, title, model) VALUES ('c1', 'orig', 'm')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, chat_id, role, content, seq) \
             VALUES ('m1', 'c1', 'user', 'hello', 1)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT OR REPLACE INTO chats (id, title, model) VALUES ('c1', 'renamed', 'm')",
            [],
        )
        .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE chat_id = 'c1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // This is the bug: messages are gone. If a future SQLite version
        // ever changes OR REPLACE semantics to not cascade, this test
        // fails — and we'd want to know.
        assert_eq!(
            count, 0,
            "INSERT OR REPLACE on FK parent should cascade-delete children \
             (this is the landmine the ON CONFLICT pattern avoids)"
        );
    }

    // ── slugify ────────────────────────────────────────────────────────────
    //
    // Most slugify cases are already covered by `prompts::tests` (via the
    // wrapper). These additional cases target the new `max_len` parameter
    // (previously a tools.rs-only behavior with zero tests) and lock in the
    // empty-string return contract that lets callers pick their own fallback.

    #[test]
    fn slugify_returns_empty_string_on_no_alphanumerics() {
        // Both callers depend on this: prompts wraps empty→"prompt",
        // tools wraps empty→"chat-{id}". Don't change the bare-empty contract
        // without updating both call sites.
        assert_eq!(slugify("", None), "");
        assert_eq!(slugify("!!!", None), "");
        assert_eq!(slugify("🎉", None), "");
    }

    #[test]
    fn slugify_max_len_truncates_to_exactly_n_chars() {
        let long = "a".repeat(200);
        assert_eq!(slugify(&long, Some(60)).len(), 60);
    }

    #[test]
    fn slugify_max_len_trims_trailing_dash_after_truncation() {
        // "foo-bar-baz" truncated at 4 → "foo-" → trimmed → "foo".
        // Without the post-truncate trim we'd ship a dash-terminated slug.
        assert_eq!(slugify("foo bar baz", Some(4)), "foo");
    }

    #[test]
    fn slugify_max_len_none_disables_truncation() {
        let long = "a".repeat(200);
        assert_eq!(slugify(&long, None).len(), 200);
    }

    #[test]
    fn slugify_max_len_larger_than_input_is_noop() {
        assert_eq!(slugify("hello", Some(60)), "hello");
    }

    #[test]
    fn slugify_handles_unicode_lowercase_by_dropping_non_ascii() {
        // Documented contract: ASCII-only output. Non-ASCII letters drop
        // out via `is_ascii_alphanumeric` — both pre-unification impls had
        // this behavior, just through different paths (prompts via
        // `to_lowercase + filter`, tools via direct `to_ascii_lowercase`).
        assert_eq!(slugify("Café", None), "caf");
    }

    // ── Multi-model panel (Phase 1: schema + persistence) ─────────────────
    //
    // These pin the wire shape of compare-mode chats: a `chats` row carries
    // `tab_type` + `multi_models` (JSON array), and a single user turn
    // produces N assistant rows that share a `variant_group_id` and start
    // with `is_picked = NULL`. The "pick" UI flips one row to 1 and the
    // siblings to 0; the canonical-load filter (`is_picked IS NULL OR
    // is_picked = 1`) then surfaces the chosen reply alongside any
    // pre-existing single-mode rows.

    #[test]
    fn multimodel_chat_persists_tab_type_and_models_list() {
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO chats (id, title, model, tab_type, multi_models) \
             VALUES ('c1', 'Compare opening', '', 'multi-pending', \
                     '[\"gemma4:26b\",\"llama3:70b\",\"qwen2.5:32b\"]')",
            [],
        )
        .unwrap();

        let (tab_type, models): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT tab_type, multi_models FROM chats WHERE id = 'c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(tab_type.as_deref(), Some("multi-pending"));
        assert_eq!(
            models.as_deref(),
            Some("[\"gemma4:26b\",\"llama3:70b\",\"qwen2.5:32b\"]")
        );
    }

    #[test]
    fn multimodel_variant_group_round_trips_and_pick_filter_works() {
        // End-to-end shape: one user message followed by three assistant
        // variants that share a `variant_group_id`. Initially all three
        // are unpicked (is_picked IS NULL — multi-pending). After the
        // user picks one, the chosen row's is_picked=1 and the siblings'
        // is_picked=0. The default canonical-load filter (NULL or 1)
        // surfaces only the picked row + the original user message.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO chats (id, title, model, tab_type, multi_models) \
             VALUES ('c1', 'Compare', '', 'multi-pending', \
                     '[\"a\",\"b\",\"c\"]')",
            [],
        )
        .unwrap();

        // User message (seq=1). variant_group_id stays NULL on user rows.
        conn.execute(
            "INSERT INTO messages (id, chat_id, role, content, seq) \
             VALUES ('u1', 'c1', 'user', 'Start my adventure', 1)",
            [],
        )
        .unwrap();

        // Three parallel assistant variants. Share seq=2 (same turn) AND
        // variant_group_id='v1'. is_picked stays NULL until the user
        // picks. The model column distinguishes them.
        for (id, model, body) in [
            ("a1", "a", "Response from A"),
            ("a2", "b", "Response from B"),
            ("a3", "c", "Response from C"),
        ] {
            conn.execute(
                "INSERT INTO messages (id, chat_id, role, content, model, seq, variant_group_id) \
                 VALUES (?1, 'c1', 'assistant', ?2, ?3, 2, 'v1')",
                rusqlite::params![id, body, model],
            )
            .unwrap();
        }

        // Sanity: all three load with the panel-layout (unfiltered) query.
        let all: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages \
                 WHERE chat_id = 'c1' AND role = 'assistant'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(all, 3, "all three variants must round-trip");

        // Simulate the user picking variant 'b' (a2):
        //   • a2 → is_picked = 1
        //   • a1, a3 → is_picked = 0
        // In production this comes from db_upsert_message; here we hit
        // the table directly so the test isn't coupled to the command.
        conn.execute("UPDATE messages SET is_picked = 1 WHERE id = 'a2'", [])
            .unwrap();
        conn.execute(
            "UPDATE messages SET is_picked = 0 WHERE id IN ('a1', 'a3')",
            [],
        )
        .unwrap();

        // Canonical-load filter the UI applies post-pick: NULL (single-
        // mode or pre-pick) OR is_picked = 1 (canonical). Should yield
        // exactly the user message + the picked assistant variant.
        let canonical: Vec<(String, String, Option<String>)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, role, model FROM messages \
                     WHERE chat_id = 'c1' \
                       AND (is_picked IS NULL OR is_picked = 1) \
                     ORDER BY seq ASC, id ASC",
                )
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        assert_eq!(canonical.len(), 2, "canonical view = user + 1 assistant");
        assert_eq!(canonical[0].0, "u1");
        assert_eq!(canonical[1].0, "a2");
        assert_eq!(canonical[1].2.as_deref(), Some("b"));

        // The unpicked siblings ARE still in the DB — the alternatives
        // disclosure relies on this. A focused query for is_picked = 0
        // within the same variant_group_id returns the two cousins.
        let unpicked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages \
                 WHERE chat_id = 'c1' AND variant_group_id = 'v1' AND is_picked = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unpicked, 2, "unpicked siblings must be retained");
    }

    // ── Column-add migrations (apply_migrations) ──────────────────────────
    //
    // These pin the upgrade-safety contract. Ekorbia has a public release on
    // GitHub, so any column we add to SCHEMA in a later version would never
    // appear on existing users' DBs (CREATE TABLE IF NOT EXISTS skips when
    // the table exists). apply_migrations runs after execute_batch(SCHEMA)
    // and idempotently adds any missing columns via ALTER TABLE.

    fn columns_of(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    /// Build a pre-multimodel DB shape: just enough columns for a chats +
    /// messages round trip from the version BEFORE Phase 1 landed. Used by
    /// the legacy-DB migration tests below. Keep this minimal — adding
    /// columns here would defeat the test by skipping the ALTER path.
    fn legacy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE chats (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
                output_dir TEXT
             );
             CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                model TEXT,
                time TEXT,
                tokens_in INTEGER,
                tokens_out INTEGER,
                tokens_ms INTEGER,
                prompts_json TEXT,
                sources_json TEXT,
                tool_calls_json TEXT,
                tool_call_id TEXT,
                seq INTEGER NOT NULL DEFAULT 0
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn migrations_no_op_on_fresh_db() {
        // Fresh-install path: SCHEMA already creates every Phase 1 column.
        // apply_migrations should find each one present and not error.
        // Running it twice in a row is a stricter idempotency check.
        let conn = fresh_db();
        apply_migrations(&conn).expect("first run on fresh DB");
        apply_migrations(&conn).expect("second run on fresh DB");

        let chat_cols = columns_of(&conn, "chats");
        assert!(chat_cols.iter().any(|c| c == "tab_type"));
        assert!(chat_cols.iter().any(|c| c == "multi_models"));
        let msg_cols = columns_of(&conn, "messages");
        assert!(msg_cols.iter().any(|c| c == "variant_group_id"));
        assert!(msg_cols.iter().any(|c| c == "is_picked"));
    }

    #[test]
    fn migrations_add_columns_to_legacy_db() {
        // Upgrade path. Construct a legacy DB (Phase 1 columns absent),
        // confirm they're missing, run apply_migrations, confirm they're
        // present. This is the test that would have caught the original
        // bug — a user upgrading from an old release would hit this exact
        // shape before the first launch finishes opening the DB.
        let conn = legacy_db();

        assert!(!columns_of(&conn, "chats").iter().any(|c| c == "tab_type"));
        assert!(!columns_of(&conn, "chats")
            .iter()
            .any(|c| c == "multi_models"));
        assert!(!columns_of(&conn, "messages")
            .iter()
            .any(|c| c == "variant_group_id"));
        assert!(!columns_of(&conn, "messages")
            .iter()
            .any(|c| c == "is_picked"));

        apply_migrations(&conn).expect("migrating legacy DB");

        assert!(columns_of(&conn, "chats").iter().any(|c| c == "tab_type"));
        assert!(columns_of(&conn, "chats")
            .iter()
            .any(|c| c == "multi_models"));
        assert!(columns_of(&conn, "messages")
            .iter()
            .any(|c| c == "variant_group_id"));
        assert!(columns_of(&conn, "messages")
            .iter()
            .any(|c| c == "is_picked"));
    }

    #[test]
    fn migrations_let_phase1_writes_round_trip_on_legacy_db() {
        // The strongest integrated check: after migrating a legacy DB, the
        // Phase 1 multi-model round trip from `multimodel_variant_group_
        // round_trips_and_pick_filter_works` should succeed end-to-end. If
        // ALTER TABLE somehow produced a column with the wrong type or
        // shape, this test fails. (Test isolated from the fresh-DB version
        // by going through the legacy → migrate → write path explicitly.)
        let conn = legacy_db();
        apply_migrations(&conn).expect("migrate legacy DB");

        // A real legacy user might have pre-existing single-mode chats.
        // Seed one to make sure the migration doesn't disturb them.
        conn.execute(
            "INSERT INTO chats (id, title, model) VALUES ('legacy1', 'old', 'm')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, chat_id, role, content, seq) \
             VALUES ('lm1', 'legacy1', 'user', 'hi from before', 1)",
            [],
        )
        .unwrap();

        // Now use the new columns on a brand-new chat — same shape as the
        // confirmCompareModels flow in the UI.
        conn.execute(
            "INSERT INTO chats (id, title, model, tab_type, multi_models) \
             VALUES ('c1', 'Compare', '', 'multi-pending', \
                     '[\"a\",\"b\",\"c\"]')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, chat_id, role, content, seq) \
             VALUES ('u1', 'c1', 'user', 'go', 1)",
            [],
        )
        .unwrap();
        for (id, model) in [("a1", "a"), ("a2", "b"), ("a3", "c")] {
            conn.execute(
                "INSERT INTO messages (id, chat_id, role, content, model, seq, variant_group_id) \
                 VALUES (?1, 'c1', 'assistant', 'r', ?2, 2, 'v1')",
                rusqlite::params![id, model],
            )
            .unwrap();
        }

        // Legacy chat unchanged.
        let legacy_msg_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE chat_id = 'legacy1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(legacy_msg_count, 1, "legacy chats survive migration");

        // New compare-mode chat round-trips correctly.
        let (tab_type, models): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT tab_type, multi_models FROM chats WHERE id = 'c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(tab_type.as_deref(), Some("multi-pending"));
        assert_eq!(models.as_deref(), Some("[\"a\",\"b\",\"c\"]"));
        let variants: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages \
                 WHERE chat_id = 'c1' AND variant_group_id = 'v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(variants, 3);
    }

    #[test]
    fn multimodel_columns_default_to_null_for_legacy_single_mode_rows() {
        // Pre-existing single-mode chats and messages must keep working
        // without any code changes elsewhere. The new columns default
        // to NULL on insert, and the UI treats NULL tab_type as 'single'
        // and NULL is_picked as canonical-visible.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO chats (id, title, model) VALUES ('c1', 'Legacy', 'm')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, chat_id, role, content, seq) \
             VALUES ('u1', 'c1', 'user', 'hi', 1)",
            [],
        )
        .unwrap();

        let (tab_type, multi_models): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT tab_type, multi_models FROM chats WHERE id = 'c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(tab_type.is_none(), "legacy chats default to NULL tab_type");
        assert!(
            multi_models.is_none(),
            "legacy chats default to NULL multi_models"
        );

        let (vgid, picked): (Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT variant_group_id, is_picked FROM messages WHERE id = 'u1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(
            vgid.is_none(),
            "legacy messages default to NULL variant_group_id"
        );
        assert!(
            picked.is_none(),
            "legacy messages default to NULL is_picked"
        );
    }
}
