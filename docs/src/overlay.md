# Quick-query overlay

The **quick-query overlay** is a Spotlight-style panel that pops up over any app. It's for short, throwaway questions you don't want to interrupt your work for — quick lookups, definitions, "how do I…" questions.

Press **⌘⇧Space** (default) anywhere on your Mac to open it. Press **Esc** or click elsewhere to dismiss.

<!-- TODO: screenshot of the overlay floating over another app -->

## Why it exists separately

Switching to the main Ekorbia window for a 10-second question is friction. The overlay is designed to:

- **Never steal focus** from whatever you were doing — the cursor stays where it was
- **Auto-hide on blur** — click anywhere outside the overlay and it vanishes
- **Have its own model preference** — keep a small, fast model in the overlay and a heavy reasoning model in the main window
- **Stream responses inline** — see the answer as it's generated

The overlay isn't meant for long multi-turn chats. When a question grows into a real conversation, the **"Send to main"** button promotes the session into a full chat tab in the main window so you can continue from there.

## What's in the overlay

Top to bottom:

- **Search box / composer** — type your question
- **Model picker** (small button) — pick which model the overlay uses (separate from the main window's model)
- **Prompt picker** (small button) — attach a single system prompt if you want
- **Send button** — fires the query

After you send:

- The model's reply streams in below the composer
- **Send to main** appears — clicking it opens a new tab in the main Ekorbia window with the same conversation, so you can continue with attachments, edits, etc.
- **Clear** — empties the overlay for the next question

## Customizing the hotkey

Open **Settings → General → Overlay hotkey** and click the current shortcut. Press the new combination — it's recorded immediately. The shortcut is registered globally (works in any app).

Pick something that doesn't collide with macOS or another app you use. Combinations involving **Cmd + Shift + Space** (default), **Cmd + Option + …**, or **Cmd + Ctrl + …** tend to be safe.

## Limitations vs the main window

The overlay is deliberately small:

- **No attachments** — no paperclip or folder buttons. If you need file context, use the main window.
- **No multi-turn history** — each overlay session is one question, one answer. Send to main if you want to continue.
- **No tabs** — only one conversation at a time.
- **No saved files panel** — the overlay can't save files to disk.

Everything in the overlay is in-memory only. Closing it discards the conversation (unless you sent it to main first).

## Related pages

- [Settings](./settings.md) — for the overlay hotkey and model
- [Screenshot capture](./screenshots.md) — a sibling hotkey-driven feature
- [Private chats](./private-chats.md) — for similarly ephemeral conversations in the main window
