# Changelog

All notable changes to Ekorbia are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ekorbia/ekorbia-desktop/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ekorbia/ekorbia-desktop/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ekorbia/ekorbia-desktop/releases/tag/v0.1.0
