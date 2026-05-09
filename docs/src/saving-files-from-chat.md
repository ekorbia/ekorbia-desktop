# Saving files from chat

Some models can do more than just emit text — they can **call tools**, including a `write_file` tool that saves any content the model generates directly to disk. Ekorbia exposes this safely, with permission controls and a sandbox.

## When the feature is available

A model can save files when it supports **tool calls**. You'll see a **`TOOL`** badge next to the model name in the picker for any tool-capable model. Models known to support tools include:

- `gemma4` (any size)
- `llama3.1` and `llama3.2`
- `qwen2.5`
- `mistral-nemo`
- Most newer mid-and-large models

For models that don't support tools, you can still save individual code blocks manually — see the [fallback section](#fallback-saving-code-blocks-manually) below.

## First-save permission flow

The first time a model in a given chat tries to save a file, a modal appears:

<!-- TODO: screenshot of the first-save permission modal -->

You have three options:

- **Allow** — pick an output folder (pre-filled to `~/Library/Application Support/dev.ekorbia.desktop/Outputs/<chat-slug>/`). All future saves in this chat go to this folder.
- **Block** — prevents any saves for this chat. The model is told it can't save; subsequent tool calls return an error and no modal re-appears.
- **Not now** — skips this single write only. The modal will re-appear on the next attempt.

The choice **sticks** until you change it. You can change it later from the Files panel (see below).

## The Files panel

Open the **third tab** in the right sidebar (the document icon, alongside Prompts and Watches) to see every file the model saved in the current chat.

<!-- TODO: screenshot of the Files panel with several saved files -->

Each row shows:

- **Relative path** (relative to the output folder)
- **Byte size**
- **Age** (e.g. "2 minutes ago")
- **Version count** if the model has overwritten the file (`v3` means the model has saved this path 3 times)
- **Reveal** button — opens the file in Finder
- **Open** button — opens the file with your default application
- **Click the row** to scroll the chat to the message that produced the save

### Header buttons

In the Files panel header you can:

- **Change…** — pick a new output folder for this chat
- **Reveal** — open the current output folder in Finder
- **Block** — prevent any further saves for this chat

## Atomic writes

Every save is **atomic**: Ekorbia writes to a temporary file in the same directory, then renames it into place. If the app crashes mid-write, the previous version of the file stays intact. You never end up with a partially-written file.

## Sandbox

All saved files are **sandboxed** to the output folder you picked. Any path the model tries to write that:

- Contains `..` segments (e.g. `../etc/passwd`)
- Starts with `/` (absolute path)
- Resolves through a symlink outside the output folder
- Contains a NUL byte

…is **rejected**. The model receives an error from the tool and typically tries again with a corrected path, or gives up gracefully.

## Fallback: saving code blocks manually

For models that **don't** support tools, fenced code blocks in assistant messages get a per-block **Save** button (next to the Copy button).

Ekorbia infers a filename for the save:

1. From a comment hint inside the code block — `<!-- index.html -->`, `# main.py`, `// config.json`
2. Otherwise, from the fenced language tag — `python` → `untitled.py`, `html` → `untitled.html`

The save flows through the same permission modal and sandbox as the tool path. Files saved this way are tagged `manual` in the Files panel so you can distinguish them from tool-generated saves.

## Common use cases

- Have a model write a small Python script and save it where you can run it
- Generate an HTML mockup and have the model save it as `index.html` + `styles.css`
- Draft a few config files (`docker-compose.yml`, `nginx.conf`, …) in one go
- Take dictation into Markdown notes that go straight into a folder you sync elsewhere

## Related pages

- [Markdown and code blocks](./chat/markdown-and-code.md) — for the manual code-block Save button
- [Settings](./settings.md) — for output-folder defaults
- [Private chats](./private-chats.md) — saves are disabled in ephemeral mode
