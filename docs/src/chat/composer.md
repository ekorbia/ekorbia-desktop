# The chat window

The chat window is the heart of Ekorbia. This page covers what every part of it does.

<!-- TODO: annotated screenshot of the chat window with callouts -->

## Layout

| Region | What it does |
|---|---|
| **Tab strip** (top) | One tab per open conversation. Click to switch, drag to reorder, × to close. |
| **Chat title** (top) | Click to rename — Enter saves, Esc cancels. |
| **Kebab menu** (top-right of chat pane) | Export menu (Markdown / JSON). Hidden on private chats. |
| **Messages area** (middle) | Scrollable message history. User messages appear plain; assistant messages are rendered as Markdown. |
| **Composer** (bottom) | Multi-line text input, model picker, attachment buttons, prompt attach, send button. |
| **Status bar** (very bottom) | Ollama status, current model state, indexing progress. |

## The composer in detail

Left to right, the composer has:

1. **Paperclip** (📎) — attach an individual file (`.txt`, `.md`, `.pdf`, or an image). See [Attaching files](../attachments/files.md).
2. **Folder icon** (📁) — attach a whole folder. See [Attaching folders](../attachments/folders.md).
3. **Prompt-attach button** (📋) — attach a system prompt from your library to this chat. See [Prompts library](../prompts.md).
4. **Textarea** — what you type. Multi-line, expands as you type. Enter sends, Shift+Enter inserts a newline.
5. **Model picker** — shows the active model's name. Click to see every installed model and switch mid-conversation.
6. **Send button** — turns into a **Stop** button while a reply is streaming.

Attached files, folders, and prompts appear as **chips** above the textarea. Click the × on any chip to detach it.

> **Private chats hide the attachment buttons.** Because attachments would normally persist to disk, private/ephemeral chats hide the paperclip and folder icons entirely. See [Private chats](../private-chats.md).

## Tabs

Every tab is independent: it has its own message history, model selection, attachments, and tool-call output directory. Switching tabs is instant — they're all kept in memory.

Tabs with attached files show a small paperclip plus a count in the tab strip, so you can see at a glance which conversations have context loaded.

## Model picker

Clicking the model name opens a dropdown listing every model currently installed in Ollama (queried live each time the picker opens, so a freshly-pulled model appears immediately).

The picker shows:

- The model's name
- Any capability badges — `TOOL` for tool-capable models, `VISION` for vision-capable models

Your selection sticks across launches. If the model you previously picked has been removed, Ekorbia silently falls back to the first available one.

The [quick-query overlay](../overlay.md) keeps a **separate** model preference, so you can have a heavy model in the main window for in-depth chats and a small fast model in the overlay for quick lookups.

## Status bar

The bottom strip tells you what's happening with the underlying systems:

- **Ollama not running** — start Ollama (Ekorbia will offer to do it for you)
- **Model not pulled** — the active model isn't installed; pull it with `ollama pull <name>` or pick a different one
- **Cold / Warming / Loaded** — Ollama load state of the active model
- **Indexing docs/ — 42/87** — appears when any attachment is currently being chunked and embedded; aggregates across all in-flight indexing jobs

The status bar can be hidden in **Settings → General**.

## Related pages

- [Streaming and the Stop button](./streaming-and-stop.md)
- [Edit and retry messages](./edit-and-retry.md)
- [Markdown and code blocks](./markdown-and-code.md)
- [Exporting chats](./export.md)
