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
    output_dir TEXT
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
    seq INTEGER NOT NULL DEFAULT 0
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
        conn.execute_batch(SCHEMA).expect("SCHEMA must apply cleanly");
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
}
