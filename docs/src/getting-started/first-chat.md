# Your first chat

With at least one model installed (see [Choose a model](./choose-a-model.md)), you're ready to use Ekorbia.

## Launch the app

Open **Ekorbia** from your Applications folder. The main window appears with:

- **Sidebar** on the left — your history of chats, plus a search box and a **+ New chat** button at the top
- **Chat pane** in the middle — currently empty
- **Right panel** on the right with three tabs (📋 Prompts, 👁 Watches, 📄 Files)
- **Composer** at the bottom — where you type
- **Status bar** at the very bottom — shows the backend + model status and any background indexing

<!-- TODO: screenshot of the empty main window -->

## Pick your model

In the bottom-right of the composer there's a **model picker** showing the active model's name. Click it to see every installed model. Pick one.

Your choice **persists across launches** — Ekorbia remembers the last model you used and re-opens to it. If that model is no longer installed (e.g. you deleted it), Ekorbia silently falls back to the first available one.

> **Badges on the model name.** If the active model can use **tools** (write files automatically), a small `TOOL` badge appears next to its name. If you've attached an image to the chat, a `VISION` badge appears on the image chip when the model can see it.

## Send your first message

Click in the composer and type something — anything from "Hello" to a real question. Press **Enter** to send. (To insert a newline without sending, use **Shift+Enter**.)

The model's reply streams in token-by-token. While it's streaming, the **Send** button turns into a **Stop** button — see [Streaming and the Stop button](../chat/streaming-and-stop.md).

## Tabs

Click **+ New chat** in the top-left to open a second conversation in a new tab. Each tab has its own message history, model, and attachments. Switching tabs is instant.

<!-- TODO: screenshot showing two tabs in the tab strip -->

To rename a chat, click its title at the top of the chat pane. Press **Enter** to save, **Esc** to cancel. Renames flow through to the history sidebar.

## What's next

You now know enough to use Ekorbia for basic chat. The rest of this guide covers the features that make Ekorbia more than a chat front-end:

- [Attaching files](../attachments/files.md) and [folders](../attachments/folders.md) — ask questions over your own documents
- [The prompts library](../prompts.md) — reusable system prompts stored as Markdown files
- [Watches](../watches.md) — ambient background summarization of folders, feeds, and URLs
- [Quick-query overlay](../overlay.md) — Spotlight-style popup that works over any app
- [Screenshot capture](../screenshots.md) — region-select a screenshot straight into a vision chat
- [Saving files from chat](../saving-files-from-chat.md) — let the model write files directly to disk
- [Memory file](../memory.md) — personal context Ekorbia injects into every chat

If you ever want to re-run the in-app onboarding tour, head to **Settings → General → Help → Show tour again**.
