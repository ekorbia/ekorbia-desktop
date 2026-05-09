# Private chats

A **private chat** is an ephemeral session. Nothing about it touches the database — messages, attachments, file saves never persist. The conversation lives only in memory and disappears when you close the tab.

To start one, click the **lock icon** beside the **+ New chat** button in the sidebar.

<!-- TODO: screenshot of a private chat with the lock glyph on the tab + banner -->

## Visual indicators

A private chat is never visually confused with a normal one:

- The **tab** in the tab strip shows a lock glyph next to the title
- A **banner** above the composer reminds you the conversation is private and ephemeral
- The export kebab (`⋯`) is **hidden** — there's nothing on disk to export
- The **paperclip** and **folder icons** in the composer are hidden — attachments would persist to disk via the attachment store, defeating the purpose

## What's still there

You can still:

- Send and receive messages
- See streaming responses, stop generation mid-stream
- Edit and retry messages within the session
- Switch models mid-conversation
- Use Markdown rendering and code blocks (with Copy)
- Have multiple private chats open simultaneously in different tabs

## What's NOT there

- **No chat history** in the sidebar (the chat doesn't appear in the History list at all)
- **No attachments** — paperclip and folder buttons are hidden
- **No file saves** — even tool-capable models can't write files in a private chat
- **No export** — Markdown and JSON exports are hidden
- **No search index** — private messages aren't indexed for [Chat search](./chat/search.md)

## Switching tabs while a private chat is open

Switching the active tab **away** from a private chat doesn't destroy it. The conversation stays in memory until the **tab itself** is closed. So you can have a sensitive scratch conversation open in one tab, do something in another, and come back to the private chat exactly where you left it.

What does destroy a private chat:

- Closing its tab (× button)
- Quitting Ekorbia

## When to use a private chat

Good fits:

- **Quick scratch work** — exploring an idea you don't want cluttering your history
- **Sensitive prompts** — anything you'd be uncomfortable having stored locally (even encrypted at rest on your machine)
- **Test prompts** — iterating on a system prompt to see what works without polluting your real chats
- **One-offs you don't need to find later** — drafts, throwaway translations, fact lookups

Bad fits:

- **Real work you might want to find again** — there's no history, no search, no export
- **Conversations with attachments** — attachments are disabled
- **Tool-using sessions where the model writes files** — file saves are disabled

## The memory file still applies

A private chat **does** include your [Memory file](./memory.md) as a system message — that's part of your standing context, not part of any specific conversation, and it stays consistent regardless of whether the chat persists.

## Related pages

- [The chat window](./chat/composer.md) — for the normal-chat composer
- [Exporting chats](./chat/export.md) — for why export is hidden in private mode
- [Memory file](./memory.md) — still applies even in private chats
