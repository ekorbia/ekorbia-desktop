# Exporting chats

Sometimes you want a conversation outside of Ekorbia — to paste into a doc, share with a colleague, archive for later, or round-trip into another tool. Ekorbia exports any chat to either Markdown or JSON.

## How to export

Click the **kebab menu** (`⋯`) in the top-right of the chat pane. You'll see two options:

- **Export to Markdown** — clean, human-readable transcript
- **Export to JSON** — full structured data including tool calls and timestamps

A save dialog opens; pick where to write the file.

<!-- TODO: screenshot of the kebab menu open -->

> **The kebab is hidden on private chats.** There's nothing on disk to export from an ephemeral session. See [Private chats](../private-chats.md).

## Markdown export

The Markdown export reads like a conversation, not a debug transcript:

```markdown
## You

How do I install Ekorbia?

## Assistant

Download the latest DMG from the website...
```

Each message is tagged with its role as a level-2 heading, then the body verbatim. Assistant replies keep their full Markdown formatting (headings, lists, code blocks), so the export renders correctly when you open it in any Markdown viewer.

**Tool-call internals are filtered out.** Messages from the assistant invoking a tool (`role: tool`) are noise to a human reader, so Markdown exports drop them. You see the conversation as you'd remember it, not as the model would.

## JSON export

The JSON export preserves **every** row in the conversation, including:

- System messages (memory file, attached prompts, citation injection)
- User messages
- Assistant messages
- Tool calls (function name, arguments)
- Tool results (the response the model received from the tool)
- Timestamps
- Source attribution (whether a file save came from a tool call or a manual code-block save)

This format is the right pick if you want to round-trip into another tool or post-process programmatically.

## What you can do with an export

- **Paste a Markdown export into Notion / Obsidian / your wiki** as a clean writeup
- **Email a Markdown export** to a colleague — most mail clients render it
- **Pipe a JSON export through `jq`** to extract specific messages or build a dataset
- **Diff two JSON exports** to see how a conversation evolved if you re-ran with a different prompt

The export is read-only — your chat in Ekorbia stays untouched.

## Related pages

- [Markdown and code blocks](./markdown-and-code.md) — what Markdown exports preserve
- [Private chats](../private-chats.md) — why exports are disabled in ephemeral mode
