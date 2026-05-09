# Ekorbia — CLAUDE.md

> **What this file is.** An architectural guide written for AI coding
> assistants working in this repository. It's the authoritative reference
> for the codebase's invariants, gotchas, and "why is it this way"
> rationale. Human contributors are welcome to read it for context, but
> aren't required to memorise it — [`CONTRIBUTING.md`](CONTRIBUTING.md)
> is the human-oriented entry point.

Local AI desktop app. **Tauri v2** + **React 18 (no bundler)** + **Ollama** backend.

## Dev workflow

```bash
cargo tauri dev                       # run (must be in src-tauri/ or use --manifest-path)
cargo check                           # fast type-check without running

# Test suites (see "Testing rule" below for when these MUST run)
cd src-tauri && cargo test --lib      # Rust unit tests (~0.01s, 64 tests)
./scripts/run-ui-tests.sh             # Node helpers + Playwright (~21s, 65 tests)
./scripts/run-all-tests.sh            # everything (~22s, 129 tests, combined summary)
```

No npm / no bundler **for production**. The UI is plain JSX in `ui/`, loaded via Babel-standalone script tags in `ui/index.html`. **No `import`/`export`** — everything is global scope; `function` declarations in each `text/babel` script are hoisted onto `window` automatically. All UI source is in `ui/`; all Rust source is in `src-tauri/src/`. Read `lib.rs` for the Rust module list and `index.html` for script-tag order (`main.jsx` must load last — it mounts the React tree and references components defined in all the preceding files).

A `package.json` + `node_modules/` exists ONLY for the Playwright test runner (see "Testing" below). The production UI never reads it; the no-bundler rule still applies to everything under `ui/`.

The codebase was split from monoliths into domain files in May 2026. It is a **moves-only refactor** — every function kept its original name and signature. If you're looking for a component or command, check `lib.rs` (Rust module list) or `index.html` (UI file list).

## Testing rule

**Before declaring code work complete**, run the suite that covers what changed:

| Touched | Run |
|---|---|
| any file under `src-tauri/src/` | `cd src-tauri && cargo test --lib` |
| any file under `ui/` (except `*.md` / CSS-only in `index.html`) | `./scripts/run-ui-tests.sh` |
| both, or unsure | `./scripts/run-all-tests.sh` |
| only `README.md` / `CLAUDE.md` / `docs/` / other prose | no test run required |

If a test fails, **fix it before reporting work done**. Don't ship a red suite. Skipping the run because "the change was small" is how the Phase 6 Rules-of-Hooks crash shipped — the regression test that would have caught it now exists (`tests/e2e/onboarding.spec.js`), but only catches the bug if the suite is actually run.

Coverage map (so you know what each suite is responsible for):

- **`cargo test --lib`** — sandbox path-traversal rejection, FTS5 sanitizer, prompt YAML parsing, chunker boundaries, FK-cascade regression (`INSERT … ON CONFLICT` vs `OR REPLACE`), schema smoke, HTML-to-text + CSS selector fallback, UTF-8 truncation safety. Inline `#[cfg(test)] mod tests` blocks in each `*.rs`.
- **`./scripts/run-ui-tests.sh`** — two stages:
    1. Node tests for pure helpers in `ui/utils.js` (`formatHotkey`, `parseFencedBlocks`, `escapeHtml`, etc.) via Node's built-in `--test` runner.
    2. Playwright component smokes via WebKit. Mocked `window.__TAURI__`; tests live under `tests/e2e/*.spec.js`. The Rules-of-Hooks regression is `onboarding.spec.js:41`. The XSS regressions are `markdown.spec.js`. The real Rust ↔ UI IPC is **not** exercised here — that's what the Rust suite covers separately.

If you add a new pure helper to a JSX file, extract it to `ui/utils.js` (dual-export pattern; see existing entries) and add a `node:test` case for it. If you add a new component or modal, add at minimum one mount smoke in `tests/e2e/` so the next Rules-of-Hooks-class bug fails the suite instead of shipping.

## User documentation (`docs/`)

The `docs/` folder is an **mdBook** site — user-facing documentation (NOT developer docs). Source is Markdown; output is static HTML deployed manually to the ekorbia website.

```
docs/
├── book.toml                 # mdBook config (theme, search, etc.)
├── src/                      # Markdown source — committed
│   ├── SUMMARY.md            # left-nav structure (REQUIRED for new pages)
│   ├── introduction.md
│   ├── getting-started/
│   ├── chat/
│   ├── attachments/
│   ├── images/               # screenshots — committed
│   └── *.md                  # per-feature pages
├── theme/css/ekorbia.css     # palette overrides (mirrors ui/tokens.jsx)
└── book/                     # build output — GITIGNORED
```

**Build**: `./scripts/build-docs.sh` (supports `--open`, `--serve` for live-reload, `--clean`). Requires `mdbook` (`cargo install mdbook`).

**Deploy**: not automated. Run a build, then upload `docs/book/` to the website by hand.

**Not bundled in the app**. Docs are website-only — no in-app Help menu link, no `tauri://docs/` scheme. Keep it that way unless explicitly asked otherwise.

**Tone**: user-facing. No SQLite schemas, no Rust crate names, no FK-cascade gotchas — those belong in this file (CLAUDE.md) and the README. The docs talk about what users see and click ("the **paperclip** button in the composer attaches a file"), not what happens internally.

**Adding a new page**:
1. Write the `.md` file under `docs/src/` (or a subfolder).
2. Add it to `docs/src/SUMMARY.md` — pages NOT listed there are excluded from the nav and the search index.
3. Rebuild and spot-check via `./scripts/build-docs.sh --open`.

**Internal links** should be relative paths to the source `.md` file (mdBook rewrites them to `.html` automatically). `[Settings](./settings.md)` is correct; `[Settings](./settings.html)` is not.

**Screenshot placeholders**: scattered `<!-- TODO: screenshot of X -->` comments mark spots that want a visual. Drop `.png` files into `docs/src/images/` and replace the comment with a Markdown image reference.

Doc-only changes do NOT require test runs (per the table above).

## Key dependencies & naming gotchas

| What | Crate name in Cargo.toml | Notes |
|------|--------------------------|-------|
| Window vibrancy | `window-vibrancy = "0.7"` | NOT `tauri-plugin-window-vibrancy` — that doesn't exist |
| Global shortcut | `tauri-plugin-global-shortcut = "2"` | standard plugin |
| Dialog (file picker) | `tauri-plugin-dialog = "2"` | both file + directory pickers go through this |
| Shell (open files) | `tauri-plugin-shell = "2"` | used by Sources footer; see gotcha below re: bare paths |
| OS notifications | `tauri-plugin-notification = "2"` | macOS UNUserNotification / Linux libnotify / Windows toast |
| PDF extraction | `pdf-extract = "0.7"` | shared by watch pipeline AND attachment pipeline |
| HTTP to Ollama | `reqwest = "0.12"` with `rustls-tls` | no OpenSSL dependency |
| SQLite | `rusqlite = "0.31"` with `bundled` feature | FTS5 ships with bundled SQLite |
| YAML (frontmatter) | `serde_yaml = "0.9"` | parse `.md` prompt frontmatter |
| Home dir resolution | `dirs = "5"` | resolves `~/Documents` for default prompts dir |
| Base64 (attachments) | `base64 = "0.22"` | encodes image bytes for Ollama `images: [...]` |
| RSS/Atom parsing | `feed-rs = "2"` | unified parser for RSS 1.0/2.0 + Atom |
| HTML parsing | `scraper = "0.20"` | CSS selectors for RSS link-follow + URL `url_selector` |
| Text diffing | `similar = "2"` | line-level unified diffs for URL diff-mode payloads |

`macos-private-api` feature on `tauri` + `macOSPrivateApi: true` in `tauri.conf.json` are required for the transparent overlay window.

## Key design rules

**Schema**: read `src/db.rs` `SCHEMA` const directly — don't trust any copy elsewhere. No migration block: solo-dev app, wipe the DB between schema changes. If real-user migrations are ever needed, reintroduce `ALTER TABLE` blocks in `setup()` *after* `execute_batch(SCHEMA)`, and note the index-ordering gotcha below.

**Upsert pattern**: always `INSERT … ON CONFLICT(id) DO UPDATE SET …`, never `INSERT OR REPLACE`. SQLite implements OR REPLACE as DELETE + INSERT; the DELETE cascades FK children. Affects `chats` (children: `messages`, `attachments`), `watches` (children: `watch_events`), and any future table with ON DELETE CASCADE children.

**Pipeline-owned columns** are deliberately excluded from upsert SET clauses. For URL watches: `last_content` (diff baseline), `last_polled_at` (cadence gate), `last_notified_status`, `last_notified_at`. Overwriting them on a form-save would erase pipeline state and re-fire summaries/notifications on the next poll.

**`chats.output_dir` sentinel values**: `NULL` = never asked (permission modal fires on next tool call); `""` = user blocked (no more modals, tool returns `user_blocked`); `"/abs/path"` = allowed. Easy to conflate NULL and "".

**Watch dedup**: `watch_events.file_path` doubles as the already-seen memo. Folder + RSS use the real path or entry GUID — skipped if a row already exists. URL uses `{url}#{unix_ts}` (unique-per-snapshot) so events are never deduped; the real change-detector is `last_content == extracted`.

**Prompt slug = filename**: the `.md` filename (without extension) is the prompt's stable ID. Display name lives in frontmatter; the file never moves on rename. Local-only metadata (favorite color) lives in the `prompt_meta` SQLite table so it doesn't travel with shared `.md` files.

**Sandbox chokepoint**: every file-system path from a model or tool call MUST go through `sandbox::resolve_within(output_dir, requested)` in `src/files/sandbox.rs`. It rejects `..`, absolute paths, NUL bytes, and symlink escapes. Unit tests cover all rejection paths — extend them if you add a new file-handling tool.

## Things that have bitten us before

- **`INSERT OR REPLACE` on a row referenced by FK ON DELETE CASCADE silently nukes children.** SQLite implements OR REPLACE as DELETE + INSERT; the DELETE cascades. Bit chat history badly — `db_upsert_chat` was wiping all but the last exchange on every send. Always use `INSERT … ON CONFLICT(id) DO UPDATE SET …` for upserts of rows that have FK children. Currently affects `chats` (via `messages`, `attachments`), `watches` (via `watch_events`), and any future tables with cascade children.
- **`window-vibrancy` crate name**: it's NOT `tauri-plugin-window-vibrancy`.
- **`tokio::spawn` in setup()**: panics "no reactor running" — use `tauri::async_runtime::spawn`.
- **Component identity in modals**: defining components inside render functions causes focus loss on keystroke (new identity every render). Always hoist to module scope.
- **`use tauri::Emitter`**: must be imported explicitly for `app.emit()` / `handle.emit()` to compile.
- **Format strings**: `eprintln!("msg {}", val)` — every `{}` needs an arg; implicit positionals cause compile errors.
- **`_virtual` prompt filtering**: filter at the PromptLibrary boundary (`prompts.filter(p => !p._virtual)`), not throughout state.
- **Overlay corners**: vibrancy radius in `lib.rs` `apply_vibrancy` call (currently `18.0`) must match CSS `border-radius` on the root div in `overlay.jsx` (currently `18px`). They clip independently; a mismatch shows as a rectangle leak at the corners.
- **Welcome tab id collision**: the welcome tab MUST use a freshly generated id each launch (stored in a `useRef`). A literal id like `'welcome'` collides with previously-saved chats and the in-memory `loaded: true` flag shadows the DB load, making clicked-from-sidebar reopens appear empty.
- **Control-character sentinels in `Edit` tool calls**: FTS5 snippet markers are U+0001/U+0002 (literal control bytes). The Edit tool may strip them from displayed strings — verify with `od -c` if a regex split appears to lose its delimiters.
- **Component scripts load BEFORE `main.jsx`**: helpers defined in `main.jsx` (e.g. `usePersistedState`) are NOT in scope when any of the component files parse. Inline the pattern locally where needed — see `prompts-library.jsx`'s `LIST_WIDTH_KEY` block for the canonical example.
- **Do not add ES `import`/`export` to the UI**: there's no bundler; Babel-standalone in `text/babel` mode will silently break script-scope hoisting if you switch to `type="module"`. Top-level `function` declarations are automatically on `window` in the current setup.
- **FTS5 `MATCH` is finicky with raw user input**: dashes, parens, quotes, and colons are all reserved. Sanitise to alphanumeric + whitespace, tokenize, and append `*` per token in `sanitize_fts_query()`. Treat any MATCH error as "no results" rather than surfacing.
- **Migration ordering — indices vs ALTER TABLE**: *(migrations removed; moot while the app is solo-dev and the DB is wiped between schema changes.)* When migrations existed, SCHEMA ran first and `CREATE INDEX … ON table(new_column)` would fail on upgrade installs if the column was only added by a later `ALTER TABLE`. Rule to restore: **indices on migration-added columns must live in the migration block, AFTER their ALTER TABLE.**
- **Doc comments on Tauri command parameters fail to compile**: `#[tauri::command]` macro doesn't allow `///` on individual params — they get parsed as attributes. Put the docs above the function.
- **Embedding-model change invalidates chunks silently**: `retrieve_chunks` filters by `c.embed_model = current_model`. After a Settings change, old chunks vanish from results until reindexed. The Stale-Embeddings banner surfaces this; `attachment_reindex_stale` is the one-click fix.
- **Cancellation registry leak**: every `register_cancel(&id)` MUST be paired with `clear_cancel(&id)` on the task's exit path (and `cancel_index` on external abort). Otherwise the `HashMap<String, Arc<AtomicBool>>` grows without bound across many attachments.
- **DB lock held across `await` deadlocks**: `std::sync::Mutex` is sync — it blocks the executor thread. Never hold the DbState lock across an `.await` (especially Ollama embed calls). Pattern: scope the lock to a block that ends with `};`, then await outside.
- **Pre-send chat rows in sidebar**: `attachment_add_files` / `attachment_add_folder` `INSERT OR IGNORE` a chats row before the user has sent anything, so the FK on `attachments.chat_id` holds. Closing without sending leaves "New chat" entries; the startup cleanup sweep removes truly-empty ones but preserves attachment-only "pending" chats. Don't `INSERT OR REPLACE` here either — it'd cascade-wipe a chat that already had content.
- **Folder walker symlinks + cycles**: `walk_folder` checks `file_type().is_symlink()` and skips. `read_dir` itself doesn't follow symlinks for directory entries, but a symlinked-to-directory inside a normal dir would otherwise get recursed. Defensive: always skip symlinks outright.
- **Pipeline-owned columns must NOT appear in `ON CONFLICT DO UPDATE` SET clauses**: URL watches own `last_content` (snapshot) and `last_polled_at` (cadence gate). Re-saving a watch via the form would erase both — wiping the diff baseline and re-firing a full-page summary on the next poll. Same family of bug as `INSERT OR REPLACE` on FK parents, just at the column level.
- **URL first-fetch always falls back to snapshot in diff mode**: there's no prior `last_content` to diff against on the first poll. Diff payloads only kick in from the second poll onward.
- **CSS selector fallback over silent empty content**: `html_to_text_with_selector(html, Some(sel))` falls back to whole-page extraction when the selector is invalid OR matches zero elements. A typo silently producing a whole-page summary is easier to diagnose than a typo producing empty content.
- **`url_diff_mode` value normalisation in `watch_create`**: coerce anything outside `{'snapshot', 'diff'}` to `NULL`; the runtime treats `NULL` as `'snapshot'`. Prevents a corrupt value from sticking a watch in an unrecognised state.
- **Always stamp `last_polled_at` even on dispatch failures**: `run_watch` calls `mark_watch_polled` after the kind-specific function returns, regardless of outcome. Without this, a permanently-broken URL would fire on every 30s poller tick instead of respecting its 30-min `interval_secs`.
- **`write_file` tool argument shape is model-dependent**: Ollama wraps tool args as either an object or a JSON-encoded string depending on the model. `handleSend` defensively runs `if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = {}; } }`. Don't assume either shape.
- **All tool-call paths must go through `sandbox::resolve_within`**: not just `tool_write_file`. Any future tool that touches the filesystem MUST chokepoint here. There are unit tests for every rejection path — extend them if you add a new file-handling tool.
- **Sentinel for "user blocked file saves" is the empty string, not NULL**: `chats.output_dir = NULL` means "never asked" (modal fires); `output_dir = ""` means "user blocked" (no modal, immediate error). Easy to conflate.
- **Pipeline-owned columns rule applies to `chat_files` too**: the `version` column auto-increments per `(chat_id, rel_path)` inside the SQLite transaction — don't ever pass a JS-supplied version.
- **`MAX_TOOL_ITERATIONS = 8` is a hard cap, not a budget**: the loop breaks as soon as the model returns without `tool_calls`. The cap guards against misbehaving models; typical runs finish in 1–3 iterations.
- **Don't try to stream `tool_calls` progressively**: Ollama includes `message.tool_calls` only in the final chunk where `done: true`. Read them post-stream.
- **`tauri-plugin-shell` `open` API rejects bare filesystem paths**: its default capability scope only allows `mailto:`, `tel:`, and `https?://` URLs. Use native Tauri commands (`chat_file_open`, `chat_file_reveal`, `chat_output_dir_reveal` in `src/files/commands.rs`) that spawn `open`/`xdg-open`/`explorer.exe` directly. JS passes a `chat_files` id; Rust re-resolves the absolute path through the DB so a fabricated id can't open arbitrary paths.
- **Tool-role messages are persisted but filtered from the chat UI**: `db_load_messages` returns `role='tool'` rows, but `openChatInTab` drops them — they're noise to the human reader but needed as model context on continuation. The saved-file chip strip is rebuilt from `chat_files_list` at chat-open time, not from these rows.
