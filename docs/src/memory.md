# Memory file

The **memory file** is a single user-edited Markdown file that Ekorbia injects as a system message at the start of every chat. It's the cleanest way to give the model habitual context you'd otherwise re-type into every prompt.

By default it lives at:

```
~/Documents/Ekorbia/memory.md
```

You can change the path in **Settings → Memory**.

<!-- TODO: screenshot of memory.md open in TextEdit -->

## What it's good for

Anything you find yourself repeating to the model:

- **Facts about you** — name, location, time zone, role, areas of expertise
- **Preferences** — writing style, formality level, code conventions, "answer in metric"
- **Project conventions** — naming patterns, tech stack, "we use Python 3.12 and FastAPI"
- **Standing instructions** — "always include a TL;DR at the top", "explain assumptions before answering"

Think of it like the model's prior context about *you*, separate from any individual conversation.

## How to edit it

In **Settings → Memory**, click **Edit memory**. Ekorbia opens the file in your OS default Markdown/text editor. If the file doesn't exist yet, Ekorbia creates it from a small template so you have something to edit.

Save the file in your editor and the changes take effect on the next message you send — no Ekorbia restart needed.

## Read-only from the model's perspective

This is deliberate and important: the **`write_file`** tool (used by tool-capable models — see [Saving files from chat](./saving-files-from-chat.md)) **cannot touch the memory file**. The model can read what's in it; only you can edit it externally.

The memory file is your shared context with the model. It is not something the model gets to rewrite on its own.

## Soft size cap

Ekorbia inlines the memory file into every chat send, so its content scales token cost linearly with size. There's a soft cap of about **10 KB** beyond which an inline warning appears.

For reference, 10 KB is roughly:

- 2,000 words
- 6 pages of prose
- A long-form bullet list of personal facts and preferences

If you find yourself wanting to put more than that in the memory file, consider using **attachments** for project-specific or per-topic context — those only contribute the chunks relevant to your current question, not the whole document on every send.

## Memory vs prompts vs attachments

Ekorbia gives you three places to put context. Use each for what it's best at:

| | Scope | Token cost | Edit flow |
|---|---|---|---|
| **Memory file** | Global, every chat | Inlined every send | Edit externally; loaded automatically |
| **Prompts library** | Per-attach, opt-in per chat | Inlined every send | Edit `.md` files; attach via button |
| **Attachments** | Per-chat, file/folder-scoped | Only relevant chunks per send | Drop in via paperclip/folder buttons |

**Memory file** is for "facts about me that should be in every chat."
**Prompts** are for "this conversation should have a specific persona or task."
**Attachments** are for "ask questions over this specific document or folder."

## Resetting

In **Settings → Memory**, **Reset to default** points the memory file path back to `~/Documents/Ekorbia/memory.md`. The existing file at the current path is **not** deleted — only the configured path is reset.

## Related pages

- [Prompts library](./prompts.md)
- [Saving files from chat](./saving-files-from-chat.md) — why the memory file is read-only to the model
- [Settings](./settings.md)
