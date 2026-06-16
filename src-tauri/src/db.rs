// SPDX-License-Identifier: MIT

//! Database state, schema, and low-level helpers used across the rest of the crate.
//!
//! The connection is wrapped in a `std::sync::Mutex` and stored as Tauri-managed
//! state; commands grab the lock for the duration of their query and release.
//! Long-running async tasks must NOT hold the lock across `.await` (the mutex
//! is sync and would block the executor thread) — see CLAUDE.md "DB lock held
//! across await deadlocks".

use rusqlite::{Connection, OptionalExtension};
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
    multi_models TEXT,
    -- Optional Space membership. A Space bundles a system prompt,
    -- default model, optional pinned attachments, optional pinned
    -- prompts, and an optional Space-scoped memory file. New chats
    -- created inside a Space inherit all of those. NULL = chat is not
    -- in any Space (the ''All chats'' view shows it regardless).
    --
    -- Fresh installs get the FK below; upgrade installs only get the
    -- bare column (ALTER TABLE can't add an FK), and `db_delete_space`
    -- does the cleanup in app code instead.
    --
    -- Note: an earlier 0.2.0 build also had `chats.group_id` for a
    -- simpler ''sidebar folder'' concept that Spaces replaced in 0.4.0.
    -- The `migrate_groups_to_spaces` + `drop_chat_groups_artifacts`
    -- migrations transfer any group filings to Space filings and drop
    -- the old column and table. Don't add group_id back — Spaces serve
    -- the lightweight-folder use case (a Space with no system prompt /
    -- no pins behaves as a pure organisational bucket).
    space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL
);

-- ── Spaces (workspace bundles) ─────────────────────────────────────────────
-- A Space is a named container for a related body of work. It bundles:
--   • a system prompt (prepended to every chat in the Space)
--   • a default model (preselected for new chats in the Space)
--   • optional pinned attachments (auto-attached to new chats — see
--     space_attachments below)
--   • optional pinned prompts (auto-attached to new chats — see
--     space_prompts below)
--   • an optional Space-scoped memory file (injected as system context
--     AFTER the global memory.md so Space memory overlays on top)
--
-- A chat sits in 0 or 1 Space at a time (chats.space_id). A Space with
-- no system prompt, no default model, no pinned attachments, and no
-- pinned prompts behaves identically to the lightweight sidebar-folder
-- concept Spaces replaced — the user gets organisation without context.
--
-- `slug` is the stable identifier used for the default Space memory file
-- path (~/Documents/Ekorbia/Spaces/<slug>/memory.md). Display name lives
-- in `name`; renaming the Space changes `name` only — the slug stays
-- pinned so the memory file doesn't move out from under the user.
--
-- `color` is a palette key (not a hex literal) — the UI maps it to the
-- active theme's accent colors so a Space tinted ''amber'' renders the
-- same conceptual color across themes. NULL = no color set (sidebar
-- falls back to the default fg color).
--
-- `default_model` / `memory_path` are nullable so a Space can be created
-- with just a name and filled in later. `sort_index` controls sidebar
-- ordering; ties break on created_at.
--
-- Note: an earlier 0.4.0 build had a `system_prompt TEXT` column here
-- for free-form Space framing. Replaced by ''locked pinned prompts''
-- (see space_prompts.locked) — a locked pin is a library .md file the
-- Space always attaches to new chats AND that the composer can''t
-- detach. The `drop_spaces_system_prompt` migration drops the old
-- column on upgrade installs. Don''t add it back.
CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    color TEXT,
    default_model TEXT,
    memory_path TEXT,
    sort_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Pinned files/folders for a Space. At new-chat-in-Space creation time
-- each row is instantiated as a real attachment on the chat (going
-- through the existing attachment pipeline — small files inlined, large
-- text + folders chunked + embedded). The Space row is the canonical
-- source; the per-chat attachments are derived copies the user can
-- detach without affecting the Space.
--
-- `kind` is the user's intent at pin time: ''file'' for a single file
-- (text/PDF/image — the attachment pipeline figures out which when
-- instantiated) or ''folder'' for a directory tree. Aligned with the
-- chooser UI (paperclip vs folder button) rather than with
-- attachments.kind (''text''/''image''/''folder'') because the latter
-- requires reading the file to decide, which we defer to instantiation.
CREATE TABLE IF NOT EXISTS space_attachments (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    added_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Pinned prompts for a Space. References the prompt by slug (its .md
-- filename without extension) — matches the prompt_meta join pattern
-- so the row is harmless if the underlying .md file is deleted; the
-- read-time JOIN against the live prompts library silently drops the
-- orphan, same as the library itself handles missing files.
--
-- UNIQUE(space_id, prompt_slug) prevents the same prompt from being
-- pinned twice to the same Space (would have no UI effect but would
-- clutter the list and double-attach on new chats).
--
-- `sort_index` controls the order pinned prompts attach to new chats
-- in the Space. Ties break on added_at.
--
-- `locked` (0 or 1) marks a pin as ''always attached, can''t be detached
-- per-chat''. Locked pins still surface as composer chips on the user
-- message (visibility / audit) but their × button is suppressed at
-- render time so the user can''t remove them from a chat in this Space.
-- Replaces the earlier free-form spaces.system_prompt field — see the
-- spaces table comment for why.
CREATE TABLE IF NOT EXISTS space_prompts (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    prompt_slug TEXT NOT NULL,
    sort_index INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL DEFAULT (unixepoch()),
    locked INTEGER NOT NULL DEFAULT 0,
    UNIQUE(space_id, prompt_slug)
);

-- Indices on the new tables' own columns are safe in SCHEMA — both
-- fresh and upgrade installs create the table and the index in the
-- same execute_batch pass. The chats(space_id) index is different:
-- it lives in apply_migrations because chats.space_id is a migration-
-- added column on upgrade installs.
CREATE INDEX IF NOT EXISTS idx_space_attachments_space
    ON space_attachments(space_id);
CREATE INDEX IF NOT EXISTS idx_space_prompts_space
    ON space_prompts(space_id, sort_index);

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
    last_notified_at INTEGER NOT NULL DEFAULT 0,
    -- Folder kind: files with mtime below this unix-secs cutoff are skipped
    -- on scan. Set to the creation time by the Downloads recipe (and the
    -- form skip-existing-files option) so a brand-new folder watch does not
    -- summarise the entire pre-existing backlog. NULL = process everything.
    ignore_before INTEGER
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

    // ── Spaces (workspace bundles) ──────────────────────────────────────
    // The `spaces`, `space_attachments`, and `space_prompts` tables
    // themselves live in SCHEMA (CREATE TABLE IF NOT EXISTS handles both
    // fresh and upgrade installs uniformly — the tables are new in this
    // version, so both code paths actually create them). The
    // `chats.space_id` column also lives in SCHEMA, but on upgrade
    // installs CREATE TABLE IF NOT EXISTS is a no-op for chats, so we
    // add the column here. ALTER TABLE can't add an FK, so upgrade DBs
    // get the bare column without the ON DELETE SET NULL action; the
    // `space_delete` command does that cleanup in app code instead.
    //
    // The chats(space_id) index lives HERE (not in SCHEMA) per the
    // migration-ordering gotcha: an index on a migration-added column
    // would fail on upgrade installs if it ran in SCHEMA before this
    // ALTER TABLE. The covering shape (space_id, updated_at DESC) lets
    // the sidebar filter-by-Space query — "show this Space's chats,
    // most-recent first" — resolve as a single index range scan.
    add_column_if_missing(conn, "chats", "space_id", "TEXT")?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chats_space ON chats(space_id, updated_at DESC)",
        [],
    )
    .map_err(|e| e.to_string())?;

    // ── Groups → Spaces conversion ──────────────────────────────────────
    // Spaces subsume chat groups: a Space is a richer container that adds
    // a system prompt, default model, pinned attachments/prompts, and an
    // optional memory file on top of what a group does. This one-shot
    // migration turns every existing chat_group into an equivalent Space
    // (no system prompt, no pins — same lightweight-folder behaviour) and
    // re-files chats accordingly.
    //
    // For each chat with group_id set:
    //   • If space_id is ALSO set (only possible from a dev DB that was
    //     opened with both features simultaneously — no public release
    //     ever exposed both axes), keep the Space filing and clear
    //     group_id. The explicit Space pick wins.
    //   • Otherwise, copy group_id into space_id and clear group_id.
    //
    // Gated on a settings key + per-Space existence check, so re-running
    // on an already-migrated DB is a no-op.
    migrate_groups_to_spaces(conn)?;

    // ── Drop chat_groups artifacts ──────────────────────────────────────
    // Now that every group is mirrored as a Space and every filed chat
    // points at a Space, the chat_groups table and chats.group_id column
    // are dead weight. Drop them — the data has already been migrated
    // above, and the UI no longer exposes group concepts. Idempotent
    // (DROP TABLE IF EXISTS, PRAGMA introspection before DROP COLUMN).
    drop_chat_groups_artifacts(conn)?;

    // ── Locked pinned prompts ───────────────────────────────────────────
    // Replace the old `spaces.system_prompt` free-form text field with
    // `space_prompts.locked` (a boolean on each pin). Locked pins are
    // always attached to new chats in the Space AND can''t be detached
    // per-chat in the composer. Decided dev-only — no migration of
    // existing system_prompt content; the column is just dropped. See
    // CLAUDE.md for the user-facing model.
    add_locked_to_space_prompts(conn)?;
    drop_spaces_system_prompt(conn)?;

    // Folder watches: skip files whose mtime predates this unix-secs cutoff.
    // Set to the creation time by the Downloads recipe (and the form's
    // skip-existing-files option) so a brand-new folder watch over a busy
    // directory like ~/Downloads doesn't summarise the entire pre-existing
    // backlog on its first scan. NULL = legacy process-everything.
    //
    // Guarded by table_exists because legacy unit-test fixtures build a
    // minimal DB without a `watches` table; real installs always have it
    // (SCHEMA's CREATE TABLE IF NOT EXISTS runs before this). Mirrors the
    // add_locked_to_space_prompts guard.
    if table_exists(conn, "watches")? {
        add_column_if_missing(conn, "watches", "ignore_before", "INTEGER")?;
    }

    Ok(())
}

/// One-shot migration: convert every `chat_groups` row into an equivalent
/// `spaces` row and transfer `chats.group_id` filings to `chats.space_id`.
///
/// Idempotent in two layers:
///   1. A settings-table flag (`groups_to_spaces_migrated_v1`) gates the
///      whole function — a second call returns immediately.
///   2. Per-Space existence check (`SELECT 1 FROM spaces WHERE id = ?`) so
///      even if the flag is somehow cleared, we don't double-insert.
///
/// Migrated Spaces are *minimal*: name + slug + sort_index + timestamps
/// copied from the group; color / system_prompt / default_model /
/// memory_path are all NULL. Equivalent to a Space the user just
/// created and never opened the settings dialog on — i.e. a folder.
fn migrate_groups_to_spaces(conn: &Connection) -> Result<(), String> {
    const FLAG_KEY: &str = "groups_to_spaces_migrated_v1";

    // Defence in depth: tolerate missing tables that we depend on.
    // In production SCHEMA's `CREATE TABLE IF NOT EXISTS` runs immediately
    // before apply_migrations, so `app_settings`, `chat_groups`, and
    // `spaces` are all guaranteed to exist. The guards exist for:
    //   • Legacy-shape unit tests that construct a minimal pre-SCHEMA
    //     DB to exercise the column-add migrations in isolation.
    //   • A theoretical "this migration runs against a partial DB"
    //     scenario which we can't prove impossible but should still
    //     fail gracefully (silently skip + run again on next launch
    //     when SCHEMA has caught up).
    if !table_exists(conn, "app_settings")? {
        // No place to record the flag, so we can't be idempotent. Skip
        // entirely; next launch (after SCHEMA runs) will retry.
        return Ok(());
    }
    if get_setting(conn, FLAG_KEY).is_some() {
        return Ok(());
    }
    if !table_exists(conn, "chat_groups")? || !table_exists(conn, "spaces")? {
        // Either pre-Phase-0.2 (no chat_groups) or pre-Spaces (no spaces).
        // Mark the migration done — there's nothing to migrate, and the
        // SCHEMA pass that creates these tables will run before this
        // function ever sees real data.
        set_setting(conn, FLAG_KEY, "1")?;
        return Ok(());
    }

    // Load every group row. We can't iterate + insert inside the same
    // prepared-stmt borrow without lifetime gymnastics, so collect first
    // then loop.
    let groups: Vec<(String, String, i64, i64)> = {
        let mut stmt = conn
            .prepare("SELECT id, name, sort_order, created_at FROM chat_groups")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let collected: Result<Vec<_>, _> = rows.collect();
        collected.map_err(|e| e.to_string())?
    };

    for (id, name, sort_order, created_at) in groups {
        // Existence check: if a Space with this id already exists (re-run
        // after the flag was cleared, or a dev DB where the same id was
        // used for both a group and a Space), skip. The flag will still
        // get set at the end, so subsequent runs no-op cleanly.
        let exists: bool = conn
            .query_row("SELECT 1 FROM spaces WHERE id = ?1", [&id], |_| Ok(true))
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(false);
        if exists {
            continue;
        }

        // Slug: slugify the name, fall back to "space" if it nukes to
        // empty (emoji-only names), then dedup against the existing
        // `spaces.slug` set. The UNIQUE constraint on `spaces.slug` is
        // the authoritative protector; this is the polite version.
        let base = slugify(&name, None);
        let base = if base.is_empty() {
            "space".to_string()
        } else {
            base
        };
        let slug = dedupe_slug_for_migration(conn, &base)?;

        // Updated_at = created_at — the group's last modification time
        // isn't tracked, and using `now_unix()` would make every
        // migrated Space look like it was just touched. Static
        // created_at = updated_at is the right shape for a row
        // imported from a model that didn't track updates.
        conn.execute(
            "INSERT INTO spaces \
                (id, name, slug, color, default_model, \
                 memory_path, sort_index, created_at, updated_at) \
             VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, ?5, ?5)",
            (&id, &name, &slug, sort_order, created_at),
        )
        .map_err(|e| e.to_string())?;
    }

    // Two-statement filing transfer. ORDER MATTERS — the first UPDATE
    // copies group_id into space_id for chats that are ONLY filed by
    // group. The second clears group_id on chats that had BOTH set
    // (dev DBs only; public users can't reach this state). Doing the
    // second statement first would silently lose the group_id before
    // the first statement could copy it.
    conn.execute(
        "UPDATE chats SET space_id = group_id, group_id = NULL \
         WHERE group_id IS NOT NULL AND space_id IS NULL",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE chats SET group_id = NULL \
         WHERE group_id IS NOT NULL AND space_id IS NOT NULL",
        [],
    )
    .map_err(|e| e.to_string())?;

    set_setting(conn, FLAG_KEY, "1")?;
    Ok(())
}

/// One-shot cleanup: drop the now-empty `chat_groups` table and the
/// `chats.group_id` column. Runs after `migrate_groups_to_spaces` has
/// transferred every group filing into a Space — so dropping is safe.
///
/// Idempotent in two layers:
///   1. `DROP TABLE IF EXISTS` no-ops on fresh installs where SCHEMA
///      never created the table, and on second-run upgrades where this
///      function already dropped it.
///   2. `chats.group_id` is dropped only after a PRAGMA introspection
///      confirms it exists — SQLite's `ALTER TABLE … DROP COLUMN`
///      doesn't support `IF EXISTS`. The rusqlite-bundled SQLite is
///      3.42+, well above the 3.35 cutoff that introduced DROP COLUMN.
///
/// A small unfile-before-drop pass clears any `space_id IS NULL AND
/// group_id IS NOT NULL` rows: this is the same case `migrate_groups_to_spaces`
/// handles, but a defence-in-depth UPDATE here guards against a partial
/// migration state (e.g. the previous migration aborted halfway). If the
/// group_id column doesn't exist, the UPDATE is skipped.
///
/// No settings flag: the operations themselves are conditional on
/// presence, so re-running is naturally a no-op.
fn drop_chat_groups_artifacts(conn: &Connection) -> Result<(), String> {
    // Defensive unfile pass for any chats still pointing at a group
    // (would only happen if migrate_groups_to_spaces aborted mid-way).
    // Only runs if the column still exists.
    let has_group_id = column_exists(conn, "chats", "group_id")?;
    if has_group_id {
        // Best-effort: copy any orphan group_id values into space_id
        // when space_id is null, then NULL them out. Matches the
        // migration's collision rule.
        conn.execute(
            "UPDATE chats SET space_id = group_id, group_id = NULL \
             WHERE group_id IS NOT NULL AND space_id IS NULL",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE chats SET group_id = NULL \
             WHERE group_id IS NOT NULL AND space_id IS NOT NULL",
            [],
        )
        .map_err(|e| e.to_string())?;
        // Drop the index first — leaving an index on a now-dropped
        // column would be invalid. DROP INDEX IF EXISTS is safe either
        // way (no-op on fresh installs where the index was never
        // created in the first place).
        conn.execute("DROP INDEX IF EXISTS idx_chats_group", [])
            .map_err(|e| e.to_string())?;
        // ALTER TABLE … DROP COLUMN was added in SQLite 3.35; rusqlite
        // bundles a much newer version. No `IF EXISTS` clause is
        // supported — guard above via PRAGMA introspection.
        conn.execute("ALTER TABLE chats DROP COLUMN group_id", [])
            .map_err(|e| e.to_string())?;
    }

    // Drop the chat_groups table. IF EXISTS handles both fresh installs
    // (table never existed) and re-runs after the table was already
    // dropped.
    conn.execute("DROP TABLE IF EXISTS chat_groups", [])
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Add `space_prompts.locked` if missing. Idempotent — fresh installs
/// no-op because SCHEMA already created the column; upgrade installs
/// from the brief "system_prompt + unlocked pins" build get the column
/// added here.
///
/// `INTEGER NOT NULL DEFAULT 0` means existing rows on upgrade installs
/// default to "not locked" — matches the old behaviour where every pin
/// was detachable from chats.
fn add_locked_to_space_prompts(conn: &Connection) -> Result<(), String> {
    // Tolerate a missing `space_prompts` table — possible only in legacy
    // unit-test fixtures, since SCHEMA creates it on every real install.
    if !table_exists(conn, "space_prompts")? {
        return Ok(());
    }
    add_column_if_missing(
        conn,
        "space_prompts",
        "locked",
        "INTEGER NOT NULL DEFAULT 0",
    )
}

/// Drop the `spaces.system_prompt` column (if it exists). Replaces the
/// earlier free-form "system prompt per Space" model with locked pinned
/// prompts (see `add_locked_to_space_prompts`). Idempotent via the
/// `column_exists` gate — DROP COLUMN doesn't support `IF EXISTS`.
///
/// No data migration: the column held dev-only test content, and the
/// user explicitly opted out of preserving it. Anyone who wants to
/// re-create the framing can do so as a locked pinned prompt from the
/// settings UI.
fn drop_spaces_system_prompt(conn: &Connection) -> Result<(), String> {
    if !table_exists(conn, "spaces")? {
        return Ok(());
    }
    if column_exists(conn, "spaces", "system_prompt")? {
        conn.execute("ALTER TABLE spaces DROP COLUMN system_prompt", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Cheap "does this column exist on `table`?" probe via PRAGMA
/// `table_info`. Mirrors the introspection shape `add_column_if_missing`
/// uses; lifted into its own helper because the groups-artifacts drop
/// needs the same primitive but for a *removal* gate rather than an
/// *insertion* gate.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| format!("PRAGMA table_info({table}): {e}"))?;
    let names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("PRAGMA table_info({table}) query: {e}"))?
        .filter_map(Result::ok)
        .collect();
    Ok(names.iter().any(|n| n == column))
}

/// Cheap "does this table exist?" probe via `sqlite_master`. Used by the
/// groups→Spaces migration to tolerate partial DB shapes (legacy test
/// fixtures, mid-upgrade weirdness) instead of erroring out.
fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |_| Ok(true),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|opt| opt.unwrap_or(false))
}

/// Slug dedup helper local to the migration. Mirrors
/// `spaces::dedupe_slug_in_db` so the migration is self-contained — the
/// spaces module is for the runtime command surface, not for migration
/// code, and a private copy here avoids a `pub(crate)` widening just for
/// one caller. Both helpers have the same contract: return `base` if
/// free, then `base-2`, `base-3`, ... up to 1000 tries, then stamp a
/// unix timestamp.
fn dedupe_slug_for_migration(conn: &Connection, base: &str) -> Result<String, String> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM spaces WHERE slug = ?1 LIMIT 1")
        .map_err(|e| e.to_string())?;
    if !stmt.exists([base]).map_err(|e| e.to_string())? {
        return Ok(base.to_string());
    }
    for n in 2..1000u32 {
        let cand = format!("{base}-{n}");
        if !stmt.exists([cand.as_str()]).map_err(|e| e.to_string())? {
            return Ok(cand);
        }
    }
    Ok(format!("{base}-{}", now_unix()))
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
            "space_attachments",
            "space_prompts",
            "spaces",
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

    // ── Spaces (workspace bundles) ─────────────────────────────────────────
    //
    // Same shape as the chat_groups tests above: pin the fresh-install
    // schema, the upgrade-install ALTER + index path, the FK semantics
    // (cascade for child rows, SET NULL for chat membership), the
    // upsert-doesn't-clobber-space_id contract, and the UNIQUE constraints
    // on `spaces.slug` and `space_prompts(space_id, prompt_slug)`.

    #[test]
    fn fresh_db_has_spaces_tables_and_chats_space_id_column() {
        let conn = fresh_db();

        // All three new tables exist with the expected columns.
        // (`system_prompt` was dropped in favour of `space_prompts.locked`
        // — see `drop_spaces_system_prompt` in apply_migrations.)
        let space_cols = columns_of(&conn, "spaces");
        for expected in [
            "id",
            "name",
            "slug",
            "color",
            "default_model",
            "memory_path",
            "sort_index",
            "created_at",
            "updated_at",
        ] {
            assert!(
                space_cols.iter().any(|c| c == expected),
                "spaces.{expected} missing; got {space_cols:?}"
            );
        }
        assert!(
            !space_cols.iter().any(|c| c == "system_prompt"),
            "spaces.system_prompt must not exist post-migration; got {space_cols:?}"
        );

        let attach_cols = columns_of(&conn, "space_attachments");
        for expected in ["id", "space_id", "kind", "path", "added_at"] {
            assert!(
                attach_cols.iter().any(|c| c == expected),
                "space_attachments.{expected} missing; got {attach_cols:?}"
            );
        }

        let prompt_cols = columns_of(&conn, "space_prompts");
        for expected in [
            "id",
            "space_id",
            "prompt_slug",
            "sort_index",
            "added_at",
            "locked",
        ] {
            assert!(
                prompt_cols.iter().any(|c| c == expected),
                "space_prompts.{expected} missing; got {prompt_cols:?}"
            );
        }

        // chats has the new column too.
        assert!(columns_of(&conn, "chats").iter().any(|c| c == "space_id"));
    }

    #[test]
    fn migrations_add_space_id_and_index_to_legacy_db() {
        // Upgrade-install path: legacy_db has no space_id, no spaces tables.
        // After SCHEMA + apply_migrations:
        //   • chats.space_id must be present (added via ALTER TABLE)
        //   • idx_chats_space must exist (created inside apply_migrations
        //     because chats.space_id is migration-added — putting the index
        //     in SCHEMA would fail on upgrade installs per the migration-
        //     ordering gotcha)
        //   • all three Spaces tables must exist (created by SCHEMA's
        //     CREATE TABLE IF NOT EXISTS — they're new tables, so the
        //     "no-op when table exists" behavior doesn't apply)
        let conn = legacy_db();
        assert!(!columns_of(&conn, "chats").iter().any(|c| c == "space_id"));

        conn.execute_batch(SCHEMA)
            .expect("SCHEMA must apply over legacy DB");
        apply_migrations(&conn).expect("apply_migrations over legacy DB");

        assert!(columns_of(&conn, "chats").iter().any(|c| c == "space_id"));

        let indices: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master \
                     WHERE type = 'index' AND tbl_name = 'chats'",
                )
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect()
        };
        assert!(
            indices.iter().any(|n| n == "idx_chats_space"),
            "idx_chats_space missing after migration; got {indices:?}"
        );

        // The new tables were created by SCHEMA's CREATE TABLE IF NOT EXISTS.
        for t in ["spaces", "space_attachments", "space_prompts"] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [t],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "table {t} missing after migration");
        }
    }

    #[test]
    fn deleting_a_space_cascades_to_its_attachments_and_prompts() {
        // FK ON DELETE CASCADE: deleting a Space wipes its space_attachments
        // and space_prompts rows. (Chats in the Space are handled by
        // db_delete_space in app code, not by FK — see the
        // deleting_a_space_unfiles_chats_without_deleting_them test below.)
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'Novel', 'novel')",
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
            "INSERT INTO space_attachments (id, space_id, kind, path) \
             VALUES ('sa2', 's1', 'file', '/style.md')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_prompts (id, space_id, prompt_slug, sort_index) \
             VALUES ('sp1', 's1', 'tone-reframer', 0)",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM spaces WHERE id = 's1'", [])
            .unwrap();

        let attach_left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM space_attachments WHERE space_id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let prompt_left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM space_prompts WHERE space_id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            attach_left, 0,
            "space_attachments must cascade on Space delete"
        );
        assert_eq!(prompt_left, 0, "space_prompts must cascade on Space delete");
    }

    #[test]
    fn deleting_a_space_unfiles_chats_without_deleting_them() {
        // Mirrors what `db_delete_space` will do in Phase 1. The chats.space_id
        // FK declares ON DELETE SET NULL on fresh installs, but upgrade
        // installs lack the FK (ALTER TABLE can't add one), so the command
        // does the cleanup in app code. This test reproduces that shape.
        //
        // On fresh installs the FK does the SET NULL automatically; we still
        // run the explicit UPDATE so the same transaction works on both DB
        // shapes (and the test doesn't care which path it's on).
        let mut conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'Novel', 'novel')",
            [],
        )
        .unwrap();
        for id in ["c1", "c2"] {
            conn.execute(
                "INSERT INTO chats (id, title, model, space_id) \
                 VALUES (?1, 'chat', 'm', 's1')",
                [id],
            )
            .unwrap();
        }
        // A control chat in NO Space — must not be touched.
        conn.execute(
            "INSERT INTO chats (id, title, model) VALUES ('c3', 'lone', 'm')",
            [],
        )
        .unwrap();

        let tx = conn.transaction().unwrap();
        tx.execute(
            "UPDATE chats SET space_id = NULL WHERE space_id = ?1",
            ["s1"],
        )
        .unwrap();
        tx.execute("DELETE FROM spaces WHERE id = ?1", ["s1"])
            .unwrap();
        tx.commit().unwrap();

        let chat_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chats", [], |r| r.get(0))
            .unwrap();
        assert_eq!(chat_count, 3, "deleting a Space must not delete chats");

        let still_filed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chats WHERE space_id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            still_filed, 0,
            "chats must be unfiled from the Space, not orphan-pointing"
        );

        let spaces_left: i64 = conn
            .query_row("SELECT COUNT(*) FROM spaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(spaces_left, 0);
    }

    #[test]
    fn space_slug_is_unique() {
        // The slug is what the default Space memory-file path is built from
        // (~/Documents/Ekorbia/Spaces/<slug>/memory.md). Two Spaces with the
        // same slug would collide on disk — UNIQUE on the column prevents it
        // at the DB layer so app code can rely on collision-free slugs.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'Novel', 'novel')",
            [],
        )
        .unwrap();
        let dup = conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s2', 'Novel 2', 'novel')",
            [],
        );
        assert!(
            dup.is_err(),
            "duplicate slug must be rejected by UNIQUE constraint"
        );
    }

    #[test]
    fn space_prompts_unique_per_space_per_slug() {
        // UNIQUE(space_id, prompt_slug) prevents double-pinning the same
        // prompt to one Space. Double-pinning would have no user-visible
        // effect but would double-attach the prompt to new chats in the
        // Space, which is a bug.
        //
        // Pinning the SAME slug to a DIFFERENT Space must still work.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'A', 'a')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s2', 'B', 'b')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_prompts (id, space_id, prompt_slug, sort_index) \
             VALUES ('sp1', 's1', 'tone-reframer', 0)",
            [],
        )
        .unwrap();

        // Same (space_id, slug) → rejected.
        let dup = conn.execute(
            "INSERT INTO space_prompts (id, space_id, prompt_slug, sort_index) \
             VALUES ('sp2', 's1', 'tone-reframer', 1)",
            [],
        );
        assert!(
            dup.is_err(),
            "duplicate (space_id, prompt_slug) must be rejected"
        );

        // Different space, same slug → allowed.
        let cross_space = conn.execute(
            "INSERT INTO space_prompts (id, space_id, prompt_slug, sort_index) \
             VALUES ('sp3', 's2', 'tone-reframer', 0)",
            [],
        );
        assert!(
            cross_space.is_ok(),
            "same slug across different Spaces must be allowed: {cross_space:?}"
        );
    }

    #[test]
    fn upsert_chat_does_not_clobber_space_id_on_update() {
        // Same contract pinned for group_id — `db_upsert_chat` MUST omit
        // `space_id` from the ON CONFLICT DO UPDATE SET clause. Space
        // membership is owned by a dedicated move-to-Space command (Phase 1
        // will name it `db_move_chat_to_space`); if a future refactor adds
        // `space_id = excluded.space_id` to the SET list, every chat save
        // would unfile chats whenever the JS ChatRow happens to be sent
        // with space_id = null.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'Novel', 'novel')",
            [],
        )
        .unwrap();
        // Initial INSERT with a space — like a freshly-created chat inside
        // an active Space.
        conn.execute(
            "INSERT INTO chats (id, title, model, created_at, updated_at, tab_type, multi_models, space_id) \
             VALUES ('c1', 'orig', 'm', 100, 100, NULL, NULL, 's1') \
             ON CONFLICT(id) DO UPDATE SET \
                title = excluded.title, \
                model = excluded.model, \
                updated_at = excluded.updated_at, \
                tab_type = excluded.tab_type, \
                multi_models = excluded.multi_models",
            [],
        )
        .unwrap();
        assert_eq!(
            conn.query_row("SELECT space_id FROM chats WHERE id = 'c1'", [], |r| r
                .get::<_, Option<
                String,
            >>(
                0
            ))
            .unwrap()
            .as_deref(),
            Some("s1")
        );

        // Now simulate a normal chat-save: same SQL, but space_id is NULL
        // (UI doesn't track Space membership on the ChatRow). The UPDATE
        // clause must NOT touch space_id.
        let none_id: Option<String> = None;
        conn.execute(
            "INSERT INTO chats (id, title, model, created_at, updated_at, tab_type, multi_models, space_id) \
             VALUES ('c1', 'renamed', 'm', 100, 200, NULL, NULL, ?1) \
             ON CONFLICT(id) DO UPDATE SET \
                title = excluded.title, \
                model = excluded.model, \
                updated_at = excluded.updated_at, \
                tab_type = excluded.tab_type, \
                multi_models = excluded.multi_models",
            [&none_id],
        )
        .unwrap();

        let (title, space_id): (String, Option<String>) = conn
            .query_row(
                "SELECT title, space_id FROM chats WHERE id = 'c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "renamed", "title should update");
        assert_eq!(
            space_id.as_deref(),
            Some("s1"),
            "space_id must be preserved across upsert"
        );
    }

    #[test]
    fn deleting_a_chat_does_not_delete_its_space() {
        // FK direction is chats → spaces. Deleting a chat must never take
        // its Space with it. (CASCADE on this FK would wipe Spaces when
        // their last chat was deleted; SET NULL on the chat side is
        // declared in SCHEMA for fresh installs and handled in app code
        // for upgrade installs.)
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug) VALUES ('s1', 'Novel', 'novel')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chats (id, title, model, space_id) \
             VALUES ('c1', 'chat', 'm', 's1')",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM chats WHERE id = 'c1'", [])
            .unwrap();
        let spaces: i64 = conn
            .query_row("SELECT COUNT(*) FROM spaces WHERE id = 's1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(spaces, 1, "Space must survive chat deletion");
    }

    #[test]
    fn migrations_no_op_on_fresh_db_for_spaces_columns() {
        // Idempotency for the Spaces migration block. Running
        // apply_migrations twice must not error and must converge on the
        // same column set. (Both the column add and the index creation use
        // IF NOT EXISTS / introspection-based gating, so this is just a
        // belt-and-braces pin.)
        let conn = fresh_db();
        apply_migrations(&conn).expect("first run on fresh DB");
        apply_migrations(&conn).expect("second run on fresh DB");

        assert!(columns_of(&conn, "chats").iter().any(|c| c == "space_id"));
        let indices: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master \
                     WHERE type = 'index' AND tbl_name = 'chats'",
                )
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect()
        };
        assert!(indices.iter().any(|n| n == "idx_chats_space"));
    }

    // ── Groups → Spaces migration ───────────────────────────────────────────
    //
    // These tests pin the contract documented at the top of
    // `migrate_groups_to_spaces` AND the cleanup pass in
    // `drop_chat_groups_artifacts`:
    //   • Fresh DB (no groups, no Spaces) → no-op + flag set
    //   • Groups present, Spaces empty → 1:1 conversion + chat filings
    //     transferred from group_id to space_id, then chat_groups +
    //     chats.group_id dropped
    //   • Group name collides with an existing Space name → slug dedup
    //     produces a unique row (UNIQUE constraint on spaces.slug)
    //   • Chat has BOTH group_id AND space_id (dev-only collision case)
    //     → space_id wins, group_id is cleared
    //   • Re-running on an already-migrated DB → no-op via the flag

    /// Helper: count rows in a single-column-COUNT query.
    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// Helper: read a chat's space_id. (`group_id` is dropped by the
    /// migration so the post-migration assertion only looks at space_id.)
    fn chat_space_id(conn: &Connection, chat_id: &str) -> Option<String> {
        conn.query_row("SELECT space_id FROM chats WHERE id = ?1", [chat_id], |r| {
            r.get(0)
        })
        .unwrap()
    }

    /// Construct an upgrade-install DB shape: 0.4.0 SCHEMA + the legacy
    /// `chat_groups` table + `chats.group_id` column added back via
    /// ALTER TABLE. This mirrors what a user upgrading from 0.2.0 / 0.3.0
    /// would land on at apply_migrations entry. Used by every migration
    /// test below.
    ///
    /// The fresh_db() helper already ran SCHEMA (which post-0.4.0 omits
    /// these artifacts), so we add them back here to simulate the
    /// pre-migration state.
    fn upgrade_install_db() -> Connection {
        let conn = fresh_db();
        conn.execute("ALTER TABLE chats ADD COLUMN group_id TEXT", [])
            .unwrap();
        conn.execute(
            "CREATE TABLE chat_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            )",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn migrate_groups_to_spaces_is_a_noop_on_fresh_db() {
        // Fresh-install DB: post-0.4.0 SCHEMA has no chat_groups table,
        // no chats.group_id column, no spaces rows. The migration's
        // table_exists guard short-circuits and sets the flag without
        // touching anything.
        let conn = fresh_db();
        apply_migrations(&conn).expect("apply_migrations on fresh db");

        // No Spaces created.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM spaces"), 0);
        // chat_groups table never existed on a fresh install (SCHEMA
        // doesn't create it post-0.4.0); the drop-artifacts pass leaves
        // that state unchanged.
        assert!(
            !table_exists(&conn, "chat_groups").unwrap(),
            "fresh install must not have chat_groups",
        );
        // Flag is set so a re-run skips at the top.
        assert_eq!(
            get_setting(&conn, "groups_to_spaces_migrated_v1").as_deref(),
            Some("1")
        );
    }

    #[test]
    fn migrate_groups_to_spaces_creates_spaces_and_transfers_filings() {
        // Upgrade-install DB with two groups and two chats, each filed
        // into a group. Spaces table is empty. Apply migrations; expect:
        //   • Two new Space rows mirroring the groups (same id, name,
        //     sort_index = group.sort_order)
        //   • Both chats now have space_id = original group_id
        //   • chats.group_id column and chat_groups table are dropped
        let conn = upgrade_install_db();
        conn.execute(
            "INSERT INTO chat_groups (id, name, sort_order, created_at) \
             VALUES ('g1', 'Work', 0, 100), ('g2', 'Novel', 1, 200)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chats (id, title, model, created_at, updated_at, group_id) \
             VALUES \
                ('c1', 'Q2 plan', 'm', 100, 100, 'g1'), \
                ('c2', 'Chapter 1', 'm', 200, 200, 'g2')",
            [],
        )
        .unwrap();

        apply_migrations(&conn).expect("apply_migrations");

        // Two Spaces materialised, same ids.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM spaces"), 2);
        let (work_name, work_sort): (String, i64) = conn
            .query_row(
                "SELECT name, sort_index FROM spaces WHERE id = 'g1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(work_name, "Work");
        assert_eq!(work_sort, 0, "sort_index = original sort_order");

        // Chat filings transferred.
        assert_eq!(
            chat_space_id(&conn, "c1").as_deref(),
            Some("g1"),
            "c1: space populated from migrated group",
        );
        assert_eq!(
            chat_space_id(&conn, "c2").as_deref(),
            Some("g2"),
            "c2: space populated from migrated group",
        );

        // Artifacts dropped.
        assert!(
            !columns_of(&conn, "chats").iter().any(|c| c == "group_id"),
            "chats.group_id must be dropped after migration",
        );
        assert!(
            !table_exists(&conn, "chat_groups").unwrap(),
            "chat_groups table must be dropped after migration",
        );
    }

    #[test]
    fn migrate_groups_to_spaces_dedupes_slug_on_name_collision() {
        // User has a Space called "Novel" (slug "novel") AND a chat group
        // also called "Novel". The migration should create a SECOND Space
        // row (not collide on UNIQUE slug). The new Space's slug must be
        // "novel-2" — first available suffix from `dedupe_slug_for_migration`.
        let conn = upgrade_install_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug, sort_index, created_at, updated_at) \
             VALUES ('existing-novel', 'Novel', 'novel', 0, 50, 50)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_groups (id, name, sort_order, created_at) \
             VALUES ('group-novel', 'Novel', 1, 100)",
            [],
        )
        .unwrap();

        apply_migrations(&conn).expect("apply_migrations");

        // Both Spaces present, distinct slugs.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM spaces"), 2);
        let new_slug: String = conn
            .query_row(
                "SELECT slug FROM spaces WHERE id = 'group-novel'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(new_slug, "novel-2", "dedup picks the next free suffix");
    }

    #[test]
    fn migrate_groups_to_spaces_keeps_space_id_on_collision() {
        // Dev-DB collision case (no public user can reach this state
        // because the additive UI was never released). A chat has BOTH
        // group_id and space_id set. The migration must keep the
        // space_id and clear the group_id — the explicit Space pick wins.
        let conn = upgrade_install_db();
        conn.execute(
            "INSERT INTO spaces (id, name, slug, sort_index, created_at, updated_at) \
             VALUES ('s-novel', 'Novel', 'novel', 0, 50, 50)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_groups (id, name, sort_order, created_at) \
             VALUES ('g-research', 'Research', 0, 100)",
            [],
        )
        .unwrap();
        // Chat is filed into BOTH the Novel space AND the Research group.
        conn.execute(
            "INSERT INTO chats (id, title, model, created_at, updated_at, group_id, space_id) \
             VALUES ('c1', 'Chapter draft', 'm', 100, 100, 'g-research', 's-novel')",
            [],
        )
        .unwrap();

        apply_migrations(&conn).expect("apply_migrations");

        // Space filing wins; group filing cleared.
        assert_eq!(
            chat_space_id(&conn, "c1").as_deref(),
            Some("s-novel"),
            "space_id preserved on collision (the explicit pick wins)",
        );
        // A Space for the migrated group still gets created — the
        // migration converts EVERY group to a Space, even if a chat
        // didn't end up filed into it (the user might re-file later).
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM spaces WHERE id = 'g-research'"),
            1
        );
    }

    #[test]
    fn migrate_groups_to_spaces_is_idempotent_via_flag() {
        // After a successful first migration, calling apply_migrations
        // again must NOT create duplicate Spaces or re-touch chat
        // filings. The settings-key flag is the primary guard; the
        // per-Space existence check is the secondary one.
        let conn = upgrade_install_db();
        conn.execute(
            "INSERT INTO chat_groups (id, name, sort_order, created_at) \
             VALUES ('g1', 'Work', 0, 100)",
            [],
        )
        .unwrap();

        // First run migrates.
        apply_migrations(&conn).expect("first migration");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM spaces"), 1);

        // Modify the migrated Space to detect accidental over-writes.
        conn.execute("UPDATE spaces SET name = 'Renamed' WHERE id = 'g1'", [])
            .unwrap();

        // Second run: same SQL chain. The migration must short-circuit
        // — both via the settings flag AND because the chat_groups table
        // is already gone (drop_chat_groups_artifacts dropped it on the
        // first run).
        apply_migrations(&conn).expect("second migration");
        let name: String = conn
            .query_row("SELECT name FROM spaces WHERE id = 'g1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Renamed", "second run must not overwrite Spaces");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM spaces"), 1);
    }

    #[test]
    fn migrate_groups_to_spaces_idempotent_even_without_flag() {
        // Defence-in-depth: if the settings flag is somehow cleared
        // (corruption, manual edit), re-running the migration must still
        // not produce duplicates. After the first run the chat_groups
        // table is dropped, so the migration's table_exists guard makes
        // the function fast-return + re-set the flag.
        let conn = upgrade_install_db();
        conn.execute(
            "INSERT INTO chat_groups (id, name, sort_order, created_at) \
             VALUES ('g1', 'Work', 0, 100)",
            [],
        )
        .unwrap();
        apply_migrations(&conn).expect("first migration");

        // Clear the flag to simulate corruption / manual reset.
        conn.execute(
            "DELETE FROM app_settings WHERE key = 'groups_to_spaces_migrated_v1'",
            [],
        )
        .unwrap();

        // Re-run. chat_groups is gone (dropped by the first run); the
        // table_exists guard inside migrate_groups_to_spaces should
        // short-circuit and re-set the flag.
        apply_migrations(&conn).expect("re-run after flag cleared");
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM spaces"),
            1,
            "re-run with chat_groups already dropped must not duplicate Spaces",
        );
        assert_eq!(
            get_setting(&conn, "groups_to_spaces_migrated_v1").as_deref(),
            Some("1")
        );
    }

    // ── Locked pinned prompts: schema migration ────────────────────────────

    #[test]
    fn fresh_install_has_no_system_prompt_and_has_locked_column() {
        // SCHEMA + apply_migrations on a fresh DB lands the modern shape:
        // spaces has no system_prompt column, space_prompts has the
        // locked column. The drop_spaces_system_prompt migration is a
        // no-op on a fresh install (column was never created by SCHEMA);
        // the add_locked_to_space_prompts migration is also a no-op
        // (SCHEMA already created the column). Both should still
        // converge on the right shape.
        let conn = fresh_db();
        apply_migrations(&conn).expect("apply_migrations on fresh db");

        let space_cols = columns_of(&conn, "spaces");
        assert!(
            !space_cols.iter().any(|c| c == "system_prompt"),
            "fresh install must not have spaces.system_prompt; got {space_cols:?}"
        );
        let prompt_cols = columns_of(&conn, "space_prompts");
        assert!(
            prompt_cols.iter().any(|c| c == "locked"),
            "fresh install must have space_prompts.locked; got {prompt_cols:?}"
        );
    }

    #[test]
    fn upgrade_install_drops_system_prompt_and_adds_locked() {
        // Construct an "intermediate 0.4.0 build" DB shape: SCHEMA-built
        // tables, then we add back `spaces.system_prompt` and remove
        // `space_prompts.locked` via raw ALTER. apply_migrations should
        // bring it back in line with the modern shape.
        let conn = fresh_db();
        // Add system_prompt back.
        conn.execute("ALTER TABLE spaces ADD COLUMN system_prompt TEXT", [])
            .unwrap();
        assert!(columns_of(&conn, "spaces")
            .iter()
            .any(|c| c == "system_prompt"));
        // Drop locked. (SQLite 3.35+ supports DROP COLUMN.)
        conn.execute("ALTER TABLE space_prompts DROP COLUMN locked", [])
            .unwrap();
        assert!(!columns_of(&conn, "space_prompts")
            .iter()
            .any(|c| c == "locked"));

        // Now run the migration — should converge.
        apply_migrations(&conn).expect("apply_migrations on intermediate-shape db");

        assert!(
            !columns_of(&conn, "spaces")
                .iter()
                .any(|c| c == "system_prompt"),
            "system_prompt must be dropped after migration"
        );
        assert!(
            columns_of(&conn, "space_prompts")
                .iter()
                .any(|c| c == "locked"),
            "locked must be added after migration"
        );
    }

    #[test]
    fn locked_migration_is_idempotent() {
        // Both `add_locked_to_space_prompts` (PRAGMA-gated) and
        // `drop_spaces_system_prompt` (column-existence gated) must be
        // safe to run twice. The locked-pin work has no settings flag
        // — it relies entirely on column-presence checks.
        let conn = fresh_db();
        apply_migrations(&conn).expect("first apply");
        apply_migrations(&conn).expect("second apply must not error");

        let space_cols = columns_of(&conn, "spaces");
        assert!(!space_cols.iter().any(|c| c == "system_prompt"));
        let prompt_cols = columns_of(&conn, "space_prompts");
        assert!(prompt_cols.iter().any(|c| c == "locked"));
    }
}
