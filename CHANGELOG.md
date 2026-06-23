# Changelog

All notable changes to Ekorbia are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Voice input — push-to-talk dictation in the composer.** Click the mic
  button (between the prompt button and the model picker), speak, then click
  again to insert the transcript at your cursor; Esc cancels. Speech is
  transcribed entirely on your machine with
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp) — nothing is
  uploaded. First use downloads a small English model (`base.en`, ~142 MB;
  `tiny.en` and `small.en` are also offered) with a cancellable progress bar;
  manage them under **Settings → Voice**. Metal-accelerated on Apple Silicon
  (a few hundred milliseconds for a short dictation). macOS-first; the mic
  permission prompt appears the first time you record.
- **Voice input in the quick-query overlay** — the same mic button in the
  Spotlight-style overlay, so you can dictate a quick question without
  switching to the main window. Recording keeps the overlay open (it won't
  auto-dismiss mid-dictation).
- **Multilingual dictation + translate-to-English.** Alongside the English
  models, multilingual Whisper models (`base`, `small`, `large-v3-turbo`)
  cover 99 languages. **Settings → Voice** adds a language picker
  (auto-detect or a specific language) and a **Translate to English** toggle;
  both apply to multilingual models (English-only models always transcribe
  English).
- **Hands-free auto-stop.** Dictation can stop on its own a moment after you
  finish speaking (energy-based voice-activity detection) instead of needing a
  second click — toggle it under **Settings → Voice** ("Stop automatically
  when I pause," on by default).
- **Auto-send after dictation.** With this on (default), a finished dictation
  submits the message for you — speak and it sends, no Enter or click. Works in
  the composer and the overlay; Esc during recording still cancels without
  sending. Toggle under **Settings → Voice** ("Send automatically after
  dictation").

## [0.4.0] - 2026-06-16

A "works without a terminal" release: guided first-run, in-app model
management, watch recipes, and a fully-offline UI. macOS remains the
primary platform.

### Added

- **Guided first-run setup.** Launch with no model installed and Ekorbia
  detects your machine's memory, recommends a right-sized Gemma 4
  (`e2b` for ≤8 GB up to `31b` for 64 GB+), and downloads it — plus the
  `nomic-embed-text` embedding model if you want folder search — in-app
  with a progress bar. No terminal required.
- **In-app model manager — download and delete models without a
  terminal.** A new **Settings → Models** tab (also reachable via
  **Manage models…** in the composer's model picker, a **Download a
  model…** button when no models are installed, and from the startup
  "Model not found" dialog) lists installed models with their on-disk
  sizes, deletes them with a confirmation, and pulls new ones with a
  live, cancellable progress bar.
- **Watch recipes, a Today digest, and a Downloads watch.** Creating a
  watch now starts from one-click recipes — Summarise new downloads,
  Watch a price, Watch job listings, Follow a blog, or Custom — that
  pre-fill the form (kind, prompt, cadence, and a model picker that
  defaults to a model you actually have pulled). The Watches panel gained
  an **All / Today** toggle and a **Chat about today** button that opens a
  chat seeded with the last 24 hours of summaries. Folder watches can skip
  files already present, so pointing one at a busy folder like Downloads
  doesn't summarise the whole backlog at once.
- **Faster replies from reasoning models.** Ekorbia detects
  thinking-capable models (qwen3.x, deepseek-r1, gpt-oss, …) via Ollama's
  `/api/show` probe and sends `think: false` by default, so they answer
  right away instead of streaming a long hidden chain-of-thought first.

### Changed

- **Replaced chat groups with Spaces.** A Space is a named workspace
  that bundles a default model, optional pinned files and folders,
  optional pinned prompts (any of which can be **locked** to enforce
  always-attached + composer-undetachable status), and an optional
  Space-scoped memory file.
- **All UI assets are now vendored — the app runs fully offline.**
  React, ReactDOM, Babel-standalone, marked, highlight.js, DOMPurify,
  and the Inter / JetBrains Mono / Instrument Serif fonts now ship
  inside the app under `ui/vendor/` (pinned versions + checksums in
  `ui/vendor/README.md`) instead of loading from unpkg.com and Google
  Fonts at runtime. The only network traffic Ekorbia produces is to
  the local Ollama server on `127.0.0.1:11434`. React also moves from
  the development UMD build to the production build (smaller, faster;
  React errors now surface as minified error codes — see
  react.dev/errors). A new Playwright spec (`offline-boot.spec.js`)
  boots the UI with all non-localhost requests blocked and fails if
  any external request is even attempted.

## [0.3.0] - 2026-06-03

First release candidate for cross-platform support. macOS remains the
primary platform; Linux and Windows are new for this release.

### Added

- **Linux support** — `.deb` (Debian / Ubuntu / Mint), `.rpm`
  (Fedora / RHEL / openSUSE), and `.AppImage` (any modern x86_64
  distro) bundles published from the release pipeline. Built on Ubuntu
  22.04 for broad glibc compatibility. Full chat, attachments, folder
  RAG, watches, prompts, memory file, chat-tool file saves, OS
  notifications (libnotify), and full-text history search all work.
  See the [feature matrix](README.md#platform-feature-matrix) for
  what's deferred (overlay, screenshot capture).
- **Windows support** — `.msi` and NSIS `.exe` installers, both with
  the WebView2 bootstrapper embedded so Windows 10 systems without
  WebView2 still launch. Acrylic / Mica vibrancy on the overlay window
  via `window-vibrancy`. Same full feature set as Linux plus the
  Quick Query overlay; screenshot capture is the only deferred feature.
- **Platform-aware UI** — Quick-query overlay default hotkey is ⌘⇧Space
  on macOS and Alt+Space on Windows (Win-key combos are heavily
  reserved by the OS for input-method switching, so we follow the
  PowerToys Run / Raycast Windows convention). Cmd / Ctrl glyphs in
  inline hints (`⌘↵`, `⌘K`, `⌘N`, `⌘\`) flip to textual `Ctrl+...` on
  Linux and Windows. The onboarding tour adapts its slide-2 hotkey
  content to whichever hotkeys are actually wired up on the current
  platform.
- **Defensive hotkey registration** — global-shortcut registration
  failures (OS conflict, locked combination, system policy) are now
  logged and the slot left empty rather than killed inside `setup()`.
  Pre-W1 a registration failure would bubble out of setup() via `?`
  and crash the app on launch with a blank window flash — visible only
  to Windows testers where the (previously default) Win+Shift+Space
  combination is reserved.
- **Ollama transport routed through Rust backend** (Phase B). Every
  Ollama HTTP call — `/api/tags`, `/api/ps`, `/api/generate`,
  `/api/chat` (streaming) — now goes through a Tauri command instead
  of a direct `fetch()` from the WebView. The motivation is Windows:
  WebView2 enforces Chromium's Private Network Access preflight on
  any fetch from the app's `tauri://localhost` origin to 127.0.0.1,
  and Ollama doesn't reply with the required
  `Access-Control-Allow-Private-Network: true` header — so every
  fetch silently fails and Ekorbia would conclude "Ollama not
  running" even when it was. Routing through Rust bypasses the
  browser network stack entirely. As a side benefit, all network
  I/O is now in one place (Rust, via `reqwest`), the streaming chat
  loop becomes a Tauri `Channel<T>` rather than a `ReadableStream`,
  and mid-stream cancellation runs through a small per-request flag
  registry. Same behaviour on every platform; the Windows fix comes
  along for free.
- **Closing the main window now fully exits on Windows + Linux.** The
  hidden overlay window in `tauri.conf.json` was keeping Tauri's
  "exit when all windows close" rule from firing — clicking X on
  Windows would dismiss the visible UI but leave a "ghost"
  `ekorbia.exe` running in Task Manager (and a stray process on
  Linux). We now intercept the main window's close event and call
  `app.exit(0)` explicitly on non-macOS platforms. macOS keeps the
  Dock-stays-alive convention: close ≠ quit, Cmd+Q to fully exit.
- **Cross-platform CI matrix** — `ci.yml` now runs `cargo fmt --check`,
  clippy, and `cargo test --lib` on macOS, Ubuntu 22.04, and Windows.
  The UI test suite (Node helpers + Playwright WebKit) runs on macOS
  only since WebKit is the closest engine to WebKitGTK / WKWebView and
  duplicating it elsewhere adds no signal.
- **Three-stage release pipeline** — `release.yml` was restructured
  into create-draft → build matrix (3 OSes in parallel) →
  SHA256SUMS + publish. A single tag push produces a draft GitHub
  Release with all five bundles attached, then flips it to published
  once every build succeeds. Prerelease tags (any tag containing `-`)
  are automatically marked as pre-releases.

### Changed

- **App identifier in user-facing docs** — corrected `dev.ekorbia.desktop`
  → `com.ekorbia.desktop` in the README's local-storage section to
  match the real `tauri.conf.json` identifier. Linux and Windows data
  directory paths now also documented.
- **`README.md` install section** — split into per-OS subsections
  with platform-specific first-launch instructions (Gatekeeper on
  macOS, AppImage chmod / `.deb` install on Linux, SmartScreen on
  Windows). Build-from-source dependencies tabled per OS.

### Deferred (planned for later 0.3.x releases)

- Linux overlay (Phase L2) — transparent always-on-top window with
  Wayland support story.
- Linux screenshot capture (Phase L3) — `grim+slurp` / `gnome-screenshot`
  / `maim` runtime detection.
- Windows screenshot capture (Phase W3) — `ms-screenclip:` URI or
  the `xcap` crate.
- Windows code signing (Phase W4) — EV certificate or Azure Trusted
  Signing.

## [0.2.0] - 2026-05-25

### Added

- **Chat groups (sidebar folders)** — organise the history sidebar into
  user-defined folders that sit above the date buckets (Today / Yesterday /
  …). Click "+ New group" to create one; drag any chat onto a folder header
  to file it, or drag it back into the date sections to unfile. Right-click a
  chat for a context menu.
- **Compare 2-3 models side-by-side** — new comparison-chat mode. Pick 2 or 3
  installed models from the sidebar's columns button, send one prompt, see all
  responses stream into adjacent columns in parallel. Click "Keep this" on the
  preferred response to transition the chat to a normal single-model
  conversation with the kept model.
- **Model + tokens footer** on every assistant message — subtle monospace
  line showing which model produced the response and its token counts, so
  scrolling back through a chat where you switched models mid-conversation
  makes attribution obvious.
- **Database migrations** — new `apply_migrations()` step in `db.rs` runs
  after `execute_batch(SCHEMA)` to `ALTER TABLE ADD COLUMN` any new columns
  on upgraded installs. Idempotent via PRAGMA introspection; fresh installs
  no-op through it.

## [0.1.0] - 2026-05-23

First public release. Local-first AI desktop built on Tauri 2 + Ollama.

### Added

#### Chat
- Multi-tab chat with independent conversation history per tab.
- Private (ephemeral) chats — messages, attachments, and file saves
  never touch the database; the conversation lives in memory only and
  disappears when the tab closes.
- Streaming responses with a mid-generation Stop button that freezes
  partial output and marks the message as `Stopped`.
- Markdown rendering for assistant replies with syntax-highlighted code
  blocks (highlight.js github-dark) and per-block Copy buttons. User
  messages stay as plain text.
- Edit & retry: click the pencil on any past user message to edit and
  resend (truncates the conversation from that point); click the retry
  icon on the last assistant reply to regenerate.
- Chat export to Markdown (clean role-tagged sections) or JSON (full
  row preservation including tool calls).
- Click-to-rename chats inline in the chat header.

#### Attachments + local RAG
- File attachments: `.txt`, `.md`, `.pdf`, and images via the paperclip
  button.
- Folder attachments via the folder button — chunked, embedded locally
  with `nomic-embed-text` (or any embedding model you pull), and
  retrieved per-query.
- Incremental folder re-index — modify one file in a 500-file folder
  and only that file is re-embedded.
- Citations: assistant replies emit `[N]` markers that match a Sources
  footer of clickable file chips. Shift-click any chip to reveal in
  Finder.
- Vision routing: images route through vision-capable models (Gemma 4,
  llava, etc.) as base64; a `VISION` badge on the chip indicates the
  active model can see them.
- Stale-embeddings banner with one-click "Re-index all" when the
  embedding model changes in Settings.

#### Prompt library
- File-system-backed prompt store: prompts live as `.md` files with
  YAML frontmatter under `~/Documents/Ekorbia/Prompts/`. Git-friendly,
  shareable, editable in any editor.
- Configurable prompts folder via Settings (Browse / Reveal / Reset).
- Five colored Favorites for quick personal-bucket filtering.
- Flat free-text tag filters with full-text search across name, body,
  and tags.
- Sort by Recent / A→Z / Z→A / Favorite.
- 28 built-in prompts ship with the app; restorable via Settings.
- Slash-trigger picker in the composer.

#### Quick-query overlay
- Spotlight-style overlay (⌘⇧Space by default, customisable) that pops
  up over any app without stealing focus.
- Inline model + single-prompt pickers, with searchable prompt list.
- Streaming responses just like the main composer.
- "Send to main" continues an overlay session as a full multi-turn
  chat in the main window.
- Auto-hides on blur or Esc.

#### Screenshot capture
- ⌘⇧1 (customisable) invokes macOS's native region selector.
- Captured PNG opens in a fresh chat tab with the image attached as a
  vision attachment.
- Auto-switches to a vision-capable model when needed, with a toast
  notification.

#### Watch (ambient background work)
- Three watch kinds: **Folder** (poll a folder, summarise new files),
  **RSS** (poll a feed, summarise new entries with article-body
  link-follow), and **URL** (poll a page, summarise on change — both
  snapshot and diff modes).
- Per-watch poll cadence with sensible defaults (folder=30s, RSS=10min,
  URL=30min).
- Optional CSS selector on URL watches to narrow extraction past
  nav/footer noise.
- Test button in the watch form probes the source once and reports
  entry count or character count.
- Edit watches via the pencil icon — change name, prompt, model,
  cadence, or any field without delete-and-recreate.
- OS notifications opt-in per-watch (macOS Notification Center, Linux
  libnotify, Windows toast). Events coalesce per poll cycle.
- Activity feed in the right-side Watches tab with kind glyphs and
  live processing indicators.
- "Chat with notes" opens a new chat with accumulated notes as system
  context.
- Cancel-on-disable: toggling a watch off immediately stops any in-
  flight processing for that watch.
- "Create and run" / "Save and run" in the watch form to bypass the
  first poll-interval wait.

#### Files panel (chat-generated outputs)
- Tool-capable models can call a `write_file` tool to save outputs
  (HTML, CSS, JS, Python, scripts, configs) into a per-chat output
  directory.
- First-save permission modal lets you pick the output folder or block
  saves entirely for that chat.
- Files panel (third right-sidebar tab) lists every saved file grouped
  by path, with size, age, version count, and Reveal / Open buttons.

#### Memory file
- A single user-edited markdown file injected as a system message on
  every chat send. Read-only from the model's perspective.
- Configurable path in Settings; defaults to
  `~/Documents/Ekorbia/memory.md`.
- Soft cap at ~10 KB with an inline warning above that.

#### Search
- Full-text search across all chat history (BM25-ranked) via SQLite
  FTS5.
- Highlighted hits both in the sidebar results and in the parent chat
  when opened.

#### Model integration
- Live Ollama model picker — lists all locally pulled models, switch
  mid-session; selection sticks across launches and falls back to an
  installed model if the previous pick is no longer pulled.
- Capability detection: tool support and vision support inferred per
  model.

#### Onboarding
- First-launch tour highlighting the main UI elements.

#### Documentation
- mdBook-based user documentation under `docs/` (theme: One Light,
  Ekorbia-tinted), built via `./scripts/build-docs.sh` and uploaded
  manually to ekorbia.com.

[0.4.0]: https://github.com/ekorbia/ekorbia-desktop/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ekorbia/ekorbia-desktop/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ekorbia/ekorbia-desktop/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ekorbia/ekorbia-desktop/releases/tag/v0.1.0
