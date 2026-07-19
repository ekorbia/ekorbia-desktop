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
./scripts/dev.sh                      # run the dev app — safe from any directory
cargo tauri dev                       # equivalent, but ONLY from src-tauri/ (see below)
cargo check                           # fast type-check without running
./scripts/fetch-llama-server.sh       # one-time: build the bundled engine sidecar
                                      # (pinned llama.cpp source → src-tauri/binaries/,
                                      # gitignored; dev.sh refuses to start without it
                                      # because tauri.conf.json's externalBin requires it)

# Test suites (see "Testing rule" below for when these MUST run)
cd src-tauri && cargo test --lib      # Rust unit tests (~0.5s, 188 tests)
./scripts/run-ui-tests.sh             # Node helpers + Playwright (~90s, 155 tests)
./scripts/run-all-tests.sh            # everything (combined summary)

# CI parity: clippy must be run with --all-targets (CI lints test code;
# bare `cargo clippy` doesn't and will pass locally while CI fails)
cd src-tauri && cargo clippy --lib --all-targets -- -D warnings
```

No npm / no bundler **for production**. The UI is plain JSX in `ui/`, loaded via Babel-standalone script tags in `ui/index.html` with `data-presets="react"` (JSX-only transpile — `const`/`let`/TDZ semantics are REAL; see the forward-references gotcha below). **No `import`/`export`** — everything is global scope; `function` declarations in each `text/babel` script are hoisted onto `window` automatically, while top-level `const`/`let` are global *lexical* bindings — visible cross-file as bare identifiers but NOT `window` properties (anything read via `window.X` needs an explicit export assignment; existing pattern in `data.jsx` / `tokens.jsx` / `icons.jsx`). All UI source is in `ui/`; all Rust source is in `src-tauri/src/`. Read `lib.rs` for the Rust module list and `index.html` for script-tag order (`main.jsx` must load last — it mounts the React tree and references components defined in all the preceding files).

A `package.json` + `node_modules/` exists ONLY for the Playwright test runner (see "Testing" below). The production UI never reads it; the no-bundler rule still applies to everything under `ui/`.

The codebase was split from monoliths into domain files in May 2026. It is a **moves-only refactor** — every function kept its original name and signature. If you're looking for a component or command, check `lib.rs` (Rust module list) or `index.html` (UI file list).

## Testing rule

**Before declaring code work complete**, run the suite that covers what changed:

| Touched | Run |
|---|---|
| any file under `src-tauri/src/` | `cd src-tauri && cargo fmt && cargo test --lib` |
| any file under `ui/` (except `*.md` / CSS-only in `index.html`) | `./scripts/run-ui-tests.sh` |
| both, or unsure | `cd src-tauri && cargo fmt && cd .. && ./scripts/run-all-tests.sh` |
| only `README.md` / `CLAUDE.md` / `docs/` / other prose | no test run required |

`cargo fmt` is mandatory after touching Rust — CI runs `cargo fmt --check` and a deviation fails the build. It's idempotent and sub-second; run it even on one-line edits. (The fmt-deviation backlog was cleared in May 2026; keep the tree clean from here on.)

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

**Schema**: read `src/db.rs` `SCHEMA` const directly — don't trust any copy elsewhere. SCHEMA defines the shape for **fresh installs**. Ekorbia has a public release, so any column added to SCHEMA in a later version would never appear on an upgraded user's DB (`CREATE TABLE IF NOT EXISTS` is a no-op when the table exists). Wire upgrades through `apply_migrations()` in `db.rs`, which runs in `setup()` immediately after `execute_batch(SCHEMA)`. Each migration uses `add_column_if_missing` (PRAGMA-introspection based) so it's idempotent — fresh installs no-op through it, upgraded installs gain the columns. Add new migrations at the END of `apply_migrations`; never reorder or remove existing ones (that breaks upgrade paths from intermediate versions). See the index-ordering gotcha below.

**Upsert pattern**: always `INSERT … ON CONFLICT(id) DO UPDATE SET …`, never `INSERT OR REPLACE`. SQLite implements OR REPLACE as DELETE + INSERT; the DELETE cascades FK children. Affects `chats` (children: `messages`, `attachments`), `watches` (children: `watch_events`), and any future table with ON DELETE CASCADE children.

**Pipeline-owned columns** are deliberately excluded from upsert SET clauses. For URL watches: `last_content` (diff baseline), `last_polled_at` (cadence gate), `last_notified_status`, `last_notified_at`. For `chats`: `space_id` (owned by `db_move_chat_to_space`). Overwriting any of these on a form-save would erase pipeline state — re-firing summaries/notifications, ejecting chats from their Space.

**Historical note**: a Phase 1 build between 0.2.0 and 0.4.0 also had `chats.group_id` for a lightweight "sidebar folder" concept. The `migrate_groups_to_spaces` + `drop_chat_groups_artifacts` migrations in `db.rs` transfer any group filings to Space filings and remove both the column and the `chat_groups` table on first launch of 0.4.0. Don't add `group_id` back — Spaces serve the lightweight-folder use case too (a Space with no pins / no memory file behaves as a pure organisational bucket).

**Spaces (workspace bundles)**: `chats.space_id` is `NULL` for chats not in any Space ("All chats" view). The FK declares `ON DELETE SET NULL` for fresh installs; upgrade installs lack the FK so `spaces::space_delete` does the unfile in a transaction before dropping the row (mirror of `db_delete_group`). `spaces.slug` is set once at create time and is **NOT updatable** via `space_update` — the slug is the stable identifier for the Space's default memory-file path (`~/Documents/Ekorbia/Spaces/<slug>/memory.md`); changing it would orphan the file on disk. Display name is freely editable. Pinned prompts are referenced by slug (no FK to the file-system prompt library); read-time joins silently drop orphan slugs the same way the library handles missing files. Pinned attachments are instantiated on every new chat in the Space via the existing `attachment_add_files` / `attachment_add_folder` pipeline (Phase 4 dispatcher in `ui/utils.js`). Space memory is injected at send time in `handleSend` — Space memory wraps in `<space_memory>…</space_memory>` and lands AFTER the global `<user_memory>` block. Compare-mode deliberately omits memory injection (Space and global) — symmetric with how compare-mode handles global memory today; revisit when compare-mode RAG lands. **Locked pinned prompts**: `space_prompts.locked` (INTEGER, 0/1) flags pins that should always be attached to new chats AND have their composer chip's × suppressed at render time — `main.jsx` builds a `lockedSlugsBySpace` map from `space_prompts_list` per Space, threads the active chat's locked-slug Set to `Composer` as `lockedPromptSlugs`, and the chip render swaps the × for an `I.Lock` glyph on matched slugs. The lock check happens **at render time, not at chat-create time**: unlocking a pin via Space settings immediately flows through to every open chat on the next render. There is no longer a separate `spaces.system_prompt` column — its enforcement role is covered by locked pinned prompts, which have the additional benefit of being visible as chips on user messages (audit visibility).

**`chats.output_dir` sentinel values**: `NULL` = never asked (permission modal fires on next tool call); `""` = user blocked (no more modals, tool returns `user_blocked`); `"/abs/path"` = allowed. Easy to conflate NULL and "".

**Watch dedup**: `watch_events.file_path` doubles as the already-seen memo. Folder + RSS use the real path or entry GUID — skipped if a row already exists. URL uses `{url}#{unix_ts}` (unique-per-snapshot) so events are never deduped; the real change-detector is `last_content == extracted`.

**Prompt slug = filename**: the `.md` filename (without extension) is the prompt's stable ID. Display name lives in frontmatter; the file never moves on rename. Local-only metadata (favorite color) lives in the `prompt_meta` SQLite table so it doesn't travel with shared `.md` files.

**Theming**: `THEMES` in `main.jsx` is the palette source of truth — each theme defines bg0..bg4, fg..fg3, borders, the FULL accent set (`amber..red` — light themes carry darker accents for contrast), and optionally `light: true` (softens the elevation shadows). `App()` mutates `T` via `Object.assign` every render; the defaults in `tokens.jsx` MUST mirror `THEMES.one_dark` because the overlay window never mounts `App()` and renders straight off those defaults. The default `one_dark` palette intentionally matches ekorbia.com's site tokens; `warm_dark` preserves the pre-0.6 look. Three mechanisms to know: (1) static CSS in `index.html` (markdown links, inline code, citations, stream border) can't read `T` — an effect in `App()` mirrors the accent onto `--ek-accent`/`--ek-accent-rgb`/`--ek-accent-hover`/`--ek-accent-ink` CSS vars (helpers `hexToRgbTriplet`/`lightenHex` in `utils.js`); the `:root` defaults in `index.html` must also match `one_dark`. (2) Elevation lives in tokens — `T.shadowSm`/`T.shadowLg`/`T.shadowPop`/`T.insetHi` plus the `panelGrad()` **function** (reads `T` at call time so it stays theme-reactive; don't snapshot it into a const). Don't hand-roll `rgba(0,0,0,…)` box-shadows on new surfaces. (3) Translucent accent fills use the hex-alpha concat idiom (`T.amber + "40"`), never `rgba(r,g,b,a)` literals — literals go stale when the palette moves. `FAVORITE_COLORS` (data.jsx) and `MODEL_COLORS` (overlays.jsx) are deliberately static hexes (stable identity across theme switches) but should stay visually in the brand family. `docs/theme/css/ekorbia.css` mirrors the palette for the docs site — update it when THEMES changes. Wave-2 additions: `T.isLight` flags light themes for decorative branching (ambient tints, glow strength); primary CTAs pair an inline accent-glow `boxShadow` with `className="ek-btn-primary"` (the class carries ONLY motion — hover lift/brighten — so `:hover` needs no JS state; fill and glow stay inline where they can read `T`); menus/popovers animate in via `ek-pop-in` keyed on their existing data-attributes (`div[data-menu]`, `[data-model-picker]`, `[data-prompt-picker]`, `[data-space-overflow-menu]`, `[data-space-color-popover]`, `[role="menu"]`) — modals are deliberately excluded because several center with `translate(-50%,-50%)` which an animated transform would fight; both honor `prefers-reduced-motion`. `BrandMark` (atoms.jsx) is the site's gradient diamond — its gradient stops are brand constants, only its punch-out core reads `T.bg0`. **Anti-flash contract**: `body`'s background is `var(--ek-bg0)`; an inline `<script>` at the top of `index.html`'s `<head>` sets that var from the persisted theme BEFORE first paint, and `tauri.conf.json`'s main window sets `backgroundColor` for the pre-WebView frame. The script duplicates each theme's `bg0` hex — when adding or retuning a theme in `THEMES`, update that map too, or its users get a one-frame flash back.

**Sandbox chokepoint**: every file-system path from a model or tool call MUST go through `sandbox::resolve_within(output_dir, requested)` in `src/files/sandbox.rs`. It rejects `..`, absolute paths, NUL bytes, and symlink escapes. Unit tests cover all rejection paths — extend them if you add a new file-handling tool.

**Provider seam (no-Ollama plan — Phase 0 seam, Phase 1 dispatch, Phase 2 bundled engine)**: the UI and internal pipelines speak ONLY the neutral surface in `src/llm.rs` — `llm_list_models` / `llm_loaded_models` / `llm_warmup` / `llm_capabilities` / `llm_embed_model_check` / `llm_chat_stream(+_cancel)` commands, plus `llm::chat` / `llm::embed` / `llm::model_has_vision` for the watch + attachment pipelines. Adapters live in `src/providers/`: `ollama.rs` (default engine; ALL Ollama HTTP), `openai_compat.rs` (any /v1 server — LM Studio, llama-server, vLLM; translates the Ollama-shaped request body and its SSE responses), and `engine.rs` (the bundled llama-server sidecar — delegates ALL wire work to openai_compat with a supervisor-minted per-process EndpointCfg; process management lives in `src/engine/`). `providers/mod.rs` owns the shared cancel registry. Dispatch: `llm.rs` BackendConfig from settings keys `llm_backend` ("ollama" default | "openai" | "engine"), `llm_base_url` (Ollama: optional override; OpenAI: REQUIRED, normalized — no trailing slash or `/v1`; engine: ignored), `llm_api_key` — loaded at startup, switched live by `llm_backend_config_set` (Settings → Backend tab, `BackendSettings` in settings.jsx). The streaming channel carries the tagged `StreamEvent` contract (`{type: delta|toolCalls|done|error|status}`, promptTokens/outputTokens on done); EVERY adapter must uphold the pinned guarantees (each has golden tests): `toolCalls` at most once per stream, before `done`; `function.arguments` ALWAYS a JSON object; the UI's three consumers (handleSend, compare fan-out, overlay) switch on `ev.type` and never see provider-raw chunks. `status` events are OPTIONAL pre-first-delta progress (only the engine emits them: "loading gemma…", "waiting for model…"); consumers render them as ephemeral placeholder text (`m.statusText` in handleSend — transient, cleared by the first delta, NEVER persisted). BYO capability defaults are deliberate (tools ON, vision/thinking OFF — no portable probe; see openai_compat docs); the ENGINE's capabilities are real (tools ON via `--jinja`, vision = `<stem>.mmproj.gguf` sibling exists, thinking reported OFF because it's suppressed server-side). Ollama-*lifecycle* commands (`start_ollama`, `ollama_pull(_cancel)`, `ollama_delete`) keep their names — they manage that engine's install, not "an LLM" — and the UI hides them on BYO and the bundled engine. The IPv4 `OLLAMA_BASE` regression test is unchanged.

**Bundled engine (Phase 2 — `src/engine/` + `providers/engine.rs`)**: Ekorbia ships a STATIC `llama-server` (pinned llama.cpp source build via `scripts/fetch-llama-server.sh`; `src-tauri/binaries/` is gitignored) and supervises at most **1 chat + 1 embed process**. Invariants to preserve:
- **Distribution model — the sidecar is a BUILD-machine artifact, never a user-side step.** `externalBin` lives in `tauri.macos.conf.json` (a macOS-only overlay merged over tauri.conf.json), NOT the base config: the engine is macOS-arm64-first, and a global externalBin would fail the Linux/Windows release legs on a binary they don't ship. The release workflow's macOS job runs the fetch script before `cargo tauri build`; the bundler copies the binary into `Ekorbia.app/Contents/MacOS/llama-server`, which is exactly where `engine::resolve_binary`'s exe-adjacent probe finds it. End users just get the DMG. When Phase 6 adds Linux/Windows engine builds, add per-platform overlay files + release steps — don't move externalBin back to the base config until every release leg produces a sidecar.
- **No orphans, ever — the deliberate OPPOSITE of `start_ollama`'s detach.** Three layers: process-group TERM→KILL on `RunEvent::Exit` (`engine::shutdown_sync`, pgid registry, lock-free), a `/bin/sh` watchdog wrapper per spawn that polls the app pid every 2s (covers `kill -9` / Force-Quit — verified live), and RAII shutdown+reap on swap/idle. Never spawn an engine process any other way.
- **Never evict mid-stream.** Streams hold an RAII `Lease` (refcount) for their FULL duration; swaps wait on refcount 0 (Notify + 1s re-check; `enable()` before releasing the slot guard — lost-wakeup safe). New leases are only minted under the slot guard, so guard+refcount==0 proves eviction is safe. Compare mode serializes through this naturally — no special casing.
- **Security posture**: loopback bind + per-process random `--api-key` (/dev/urandom). llama-server auth-exempts `/health` + `/v1/models` by design; inference endpoints 401 without the key (pinned by the ignored `engine_real_spawn_smoke` test).
- **`--reasoning off` at spawn is the thinking-tax fix** (the Ollama-/v1 tax documented in the plan notes: 379 tok vs 38 tok for one summary). Field-verified: 37 tok/1.3s on gemma4-12b. If a user-facing thinking toggle ever ships, it becomes a per-spawn flag — do NOT remove the default.
- **Chat ctx is pinned to 8192** (`-c`); `-c 0` would allocate the model's native (up to 128K) KV cache. Embed spawns use model-native ctx.
- **Model ids are file stems** under `<app_data>/models/*.gguf` (symlinks fine); ALWAYS route ids through `engine::validate_model_name` / `model_path` (separator/NUL/leading-dot rejection) before touching the filesystem. Crash-loop backoff: 3 consecutive spawn/health failures pause retries for 60s and surface the process log tail.
- Scheduler changes MUST keep the spawner-mocked supervisor tests green (`engine/supervisor.rs` — never-evict-mid-stream, swap-on-idle, backoff, reap-idle); they are the hermetic pin for all of the above.
- **Catalog + downloader (Phase 3, `engine/downloads.rs`)**: `catalog.json` is baked in via `include_str!` and PINNED — every file carries an https URL, byte size, and sha256 (HF LFS oids ARE content sha256s; the live smoke pins that assumption). Never resolve catalog contents at runtime; bumping models = regenerate the JSON from the HF tree API, re-run the pin tests. Downloads stream to `<dest>.partial` with **incremental sha256 + Range resume** (cancel KEEPS the partial — that's the resume story; the hash is rebuilt from the partial on resume so it stays truthful across the boundary). A checksum mismatch deletes the evidence — nothing half-broken can look installed. Progress chunks are DELIBERATELY Ollama-`/api/pull`-shaped (`downloading <dest>` + `digest` + totals, `{"status":"success"}` last) so the UI's `accumulatePullProgress` + pull store render engine downloads unchanged — don't invent a second progress schema. Cancel ids share the providers/ registry under the `dl:` namespace. Model deletion goes through `supervisor.evict_idle_model` first (refuses mid-stream; unloads a resident-but-idle model) — never delete a GGUF a live server has open. The `engine_real_download_smoke` ignored test proves cancel→resume→hash against the real HF CDN; run it when touching the downloader.

## Things that have bitten us before

- **`INSERT OR REPLACE` on a row referenced by FK ON DELETE CASCADE silently nukes children.** SQLite implements OR REPLACE as DELETE + INSERT; the DELETE cascades. Bit chat history badly — `db_upsert_chat` was wiping all but the last exchange on every send. Always use `INSERT … ON CONFLICT(id) DO UPDATE SET …` for upserts of rows that have FK children. Currently affects `chats` (via `messages`, `attachments`), `watches` (via `watch_events`), and any future tables with cascade children.
- **`cargo tauri dev` is CWD-sensitive — from the repo root it silently runs OLD UI**: `frontendDist: "../ui"` is resolved by the tauri CLI against the invocation directory, not tauri.conf.json. From `src-tauri/` it hits `<repo>/ui` (live sources, correct); from the repo root it hits `<repo>/../ui` (nonexistent) and the app falls back to the frontend snapshot embedded at an earlier compile — no error, just weeks-stale UI. This burned a full debugging round during the Phase-0 verify (fixes "not appearing" that were simply not being served). Use `./scripts/dev.sh`, which cd's for you and passes args through.
- **`tokio::spawn` in setup()**: panics "no reactor running" — use `tauri::async_runtime::spawn`.
- **Component identity in modals**: defining components inside render functions causes focus loss on keystroke (new identity every render). Always hoist to module scope.
- **`use tauri::Emitter`**: must be imported explicitly for `app.emit()` / `handle.emit()` to compile.
- **Format strings**: `eprintln!("msg {}", val)` — every `{}` needs an arg; implicit positionals cause compile errors.
- **`_virtual` prompt filtering**: filter at the PromptLibrary boundary (`prompts.filter(p => !p._virtual)`), not throughout state.
- **Overlay corners**: vibrancy radius in `lib.rs` `apply_vibrancy` call (currently `18.0`) must match CSS `border-radius` on the root div in `overlay.jsx` (currently `18px`). They clip independently; a mismatch shows as a rectangle leak at the corners.
- **Welcome tab id collision**: the welcome tab MUST use a freshly generated id each launch (stored in a `useRef`). A literal id like `'welcome'` collides with previously-saved chats and the in-memory `loaded: true` flag shadows the DB load, making clicked-from-sidebar reopens appear empty.
- **Control-character sentinels in `Edit` tool calls**: FTS5 snippet markers are U+0001/U+0002 (literal control bytes). The Edit tool may strip them from displayed strings — verify with `od -c` if a regex split appears to lose its delimiters.
- **Component scripts load BEFORE `main.jsx`**: helpers defined in `main.jsx` (e.g. `usePersistedState`) are NOT in scope when any of the component files parse. Inline the pattern locally where needed — see `prompts-library.jsx`'s `LIST_WIDTH_KEY` block for the canonical example.
- **Forward references inside `App()` now THROW — they used to silently read `undefined`**: until 2026-07 the `text/babel` tags carried no `data-presets`, so Babel-standalone defaulted to `["react","env"]`, and untargeted `env` downlevelled `const`/`let` to `var` — no TDZ, so a derived value or effect dep placed ABOVE the state declaration it read evaluated to `undefined` on every render. That kept the TOOL/VISION capability badges dark and the model-capability mount probe inert (dep array frozen at `[undefined]`) from the day they shipped; closures (event handlers) masked it by reading the same names correctly at call time. Since `data-presets="react"` (JSX-only transpile, 2026-07-17), the same mistake throws `ReferenceError: Cannot access 'x' before initialization` at first render, so any mount smoke catches it. Still declare derived consts and effects BELOW every piece of state they read — a TDZ throw only fires on paths that actually execute, so a forward ref behind a rarely-true conditional can still hide. `tests/e2e/capability-badges.spec.js` pins the Composer half of the badge chain; the guard comments at the `modelId` block in `main.jsx` describe the pre-change era.
- **`data-presets="react"` is load-bearing on EVERY `text/babel` tag** — in `ui/index.html` AND `tests/e2e/fixtures/playwright.html`; keep them in sync. A tag without it silently reverts that file to `env`'s ES5/var semantics (and drops `env`'s injected `"use strict"` — which is why every `*.jsx` now opens with an explicit `'use strict';` banner; keep it in new files). The un-lowered syntax (`?.`, `??`) is fine because `minimumSystemVersion: "11.0"` means Safari-14+ WebKit — don't lower that floor without revisiting. Two consequences of real `const`/`let` to respect: (1) the test harness mounts by `window[componentName]`, so components must stay plain `function` declarations (those still land on `window`; top-level `const`/`let` don't). (2) Duplicate top-level `const`/`let` names ACROSS files are a load-time `SyntaxError` that kills the second script — audited clean 2026-07-17; keep new top-level names unique across `ui/*.jsx` + `utils.js`.
- **Do not add ES `import`/`export` to the UI**: there's no bundler; Babel-standalone in `text/babel` mode will silently break script-scope hoisting if you switch to `type="module"`. Top-level `function` declarations are automatically on `window` in the current setup.
- **FTS5 `MATCH` is finicky with raw user input**: dashes, parens, quotes, and colons are all reserved. Sanitise to alphanumeric + whitespace, tokenize, and append `*` per token in `sanitize_fts_query()`. Treat any MATCH error as "no results" rather than surfacing.
- **Migration ordering — indices vs ALTER TABLE**: SCHEMA runs first (`execute_batch`) and `apply_migrations` runs second. So `CREATE INDEX … ON table(new_column)` in SCHEMA would fail on upgrade installs — the column doesn't exist yet at the moment SCHEMA runs, because the ALTER TABLE happens later in `apply_migrations`. **Indices on migration-added columns must be created INSIDE `apply_migrations`, after the corresponding `add_column_if_missing` call**, never in SCHEMA. Fresh installs are fine either way (SCHEMA creates both column and index in one batch), but upgrade installs only work when the index lives in the migration block.
- **Doc comments on Tauri command parameters fail to compile**: `#[tauri::command]` macro doesn't allow `///` on individual params — they get parsed as attributes. Put the docs above the function.
- **tauri-build validates `externalBin` existence at COMPILE time — for every cargo invocation, not just bundling**: on macOS, `cargo clippy`/`cargo check`/`cargo test` all fail with "resource path binaries/llama-server-… doesn't exist" if the sidecar file is absent (the check lives in tauri-build's build script, which merges tauri.macos.conf.json). Dev machines get the real binary from the fetch script; ci.yml's macOS job creates a ZERO-BYTE stub (existence is all that's checked) because lint/test jobs never bundle. Broke CI once the day the sidecar shipped.
- **The engine's spawn path is unix-only — annotate its helpers `#[cfg_attr(not(unix), allow(dead_code))]`, don't cfg-gate them away**: on Windows, `spawn_real` is a stub, so everything reachable only through it (build_args, SpawnSpec fields, CHAT_CTX, TERM_GRACE, LOG_TAIL, register_pgid) is dead code to Windows' clippy `-D warnings`. cfg-gating the items themselves would break the platform-neutral unit tests; the scoped allow keeps unix builds honest while Windows compiles clean. Same-day lesson: **CI's `dtolnay/rust-toolchain@stable` tracks latest stable, which can be AHEAD of the local toolchain** — new clippy lints (e.g. 1.97's `large_enum_variant` on `Handle`) fire in CI but not locally. Before pushing lint-sensitive changes, mirror CI with `rustup toolchain install <ci-version>` + `cargo +<ci-version> clippy --lib --all-targets -- -D warnings`, or keep the default toolchain current with `rustup update stable`.
- **The tool loop needs the assistant PLACEHOLDER row**: `chat_files.message_id` has an enforced FK to `messages(id)` (SCHEMA opens with `PRAGMA foreign_keys = ON`), and `tool_write_file` logs its row DURING the stream — before the post-loop assistant persist. `handleSend` therefore upserts an empty assistant placeholder (same id + seq as the final persist; awaited, not fire-and-forget) right after the user message. Remove it and the first model-initiated save of every send fails with "FOREIGN KEY constraint failed" after the file already hit disk. Manual Save buttons never trip this (their messages are already persisted), which is exactly why the bug shipped unnoticed.
- **Capability probe races Ollama's own startup**: `probeModelCapabilities` first fires at mount, but the app frequently STARTS Ollama after mount (gate / start_ollama) — a one-shot probe loses that race and the TOOL/VISION chips, tool injection, and `think:false` gating all silently stay off until the model is switched away and back (symptom: a tools-capable model says "I cannot create or save files"). Two-layer fix (July 2026): the probe retries with backoff while a model's capability is unknown, AND `handleSend` does a just-in-time probe, using the resolved local values (NOT the render-scope maps — a setState from the probe isn't visible to the in-flight closure). Keep both layers if you touch this code.
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
- **`write_file` tool argument shape WAS model-dependent — now adapter-owned**: Ollama wraps tool args as either an object or a JSON-encoded string depending on the model. Since the Phase 0 provider seam, `StreamNorm::normalize_tool_call` in the ollama.rs adapter coerces `function.arguments` to always-an-object (unparseable → `{}`) BEFORE it crosses the channel; `handleSend` no longer parses strings. If you add a provider adapter, it must uphold the same guarantee — golden tests in ollama.rs pin it for the Ollama path.
- **All tool-call paths must go through `sandbox::resolve_within`**: not just `tool_write_file`. Any future tool that touches the filesystem MUST chokepoint here. There are unit tests for every rejection path — extend them if you add a new file-handling tool.
- **Sentinel for "user blocked file saves" is the empty string, not NULL**: `chats.output_dir = NULL` means "never asked" (modal fires); `output_dir = ""` means "user blocked" (no modal, immediate error). Easy to conflate.
- **Pipeline-owned columns rule applies to `chat_files` too**: the `version` column auto-increments per `(chat_id, rel_path)` inside the SQLite transaction — don't ever pass a JS-supplied version.
- **`MAX_TOOL_ITERATIONS = 8` is a hard cap, not a budget**: the loop breaks as soon as the model returns without `tool_calls`. The cap guards against misbehaving models; typical runs finish in 1–3 iterations.
- **Don't try to stream `tool_calls` progressively**: Ollama includes `message.tool_calls` only in the final chunk where `done: true`. Post-stream reads are now structural: the adapter accumulates and emits ONE `toolCalls` StreamEvent immediately before `done`, even if a model ever streamed calls early.
- **`tauri-plugin-shell` `open` API rejects bare filesystem paths**: its default capability scope only allows `mailto:`, `tel:`, and `https?://` URLs. Use native Tauri commands (`chat_file_open`, `chat_file_reveal`, `chat_output_dir_reveal` in `src/files/commands.rs`) that spawn `open`/`xdg-open`/`explorer.exe` directly. JS passes a `chat_files` id; Rust re-resolves the absolute path through the DB so a fabricated id can't open arbitrary paths.
- **Tool-role messages are persisted but filtered from the chat UI**: `db_load_messages` returns `role='tool'` rows, but `openChatInTab` drops them — they're noise to the human reader but needed as model context on continuation. The saved-file chip strip is rebuilt from `chat_files_list` at chat-open time, not from these rows.
