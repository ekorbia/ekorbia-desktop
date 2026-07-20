# Settings

Open settings from the **gear icon** in the bottom-left of the sidebar, or with the keyboard shortcut shown there on hover.

Settings is organized into four tabs.

<!-- TODO: screenshot of the Settings modal with the General tab active -->

## General

The General tab covers the app's appearance and hotkey configuration.

| Setting | What it does |
|---|---|
| **Theme** | Pick from five themes — see [Themes](./themes.md). |
| **Density** | Adjusts spacing for the chat pane (Comfortable / Compact). |
| **Show status bar** | Toggle the bottom status strip on/off. |
| **Overlay hotkey** | Global shortcut to open the [quick-query overlay](./overlay.md). |
| **Screenshot hotkey** | Global shortcut to invoke macOS region capture. See [Screenshot capture](./screenshots.md). |
| **Help → Show tour again** | Re-runs the first-launch onboarding tour. |

To set a hotkey, click the current shortcut value and press the new combination. Press `Esc` to cancel a recording without changing it.

## Prompts

Settings for the [Prompts library](./prompts.md).

| Setting | What it does |
|---|---|
| **Prompts folder** | Where your `.md` prompt files live. Defaults to `~/Documents/Ekorbia/Prompts/`. |
| **Browse** | Open the folder picker to choose a different location. |
| **Reveal in Finder** | Open the current prompts folder in Finder. |
| **Reset to default** | Point the prompts folder back to `~/Documents/Ekorbia/Prompts/`. The current folder is **not** deleted. |
| **Restore built-in prompts** | Re-copy the 28 shipped prompts into the prompts folder (overwrites existing files with the same name). |

## Memory

Settings for the [Memory file](./memory.md).

| Setting | What it does |
|---|---|
| **Memory file path** | Path to the Markdown file injected at the start of every chat. Defaults to `~/Documents/Ekorbia/memory.md`. |
| **Choose file…** | Open the file picker to point at a different file. |
| **Reset to default** | Point the path back to the default. The current file is **not** deleted. |
| **Edit memory** | Open the current memory file in your OS default text editor. |

## Attachments

Settings that apply to [files](./attachments/files.md), [folders](./attachments/folders.md), and embeddings.

| Setting | What it does |
|---|---|
| **Embedding model** | Which model produces the embeddings used for chunk retrieval. Defaults to `nomic-embed-text`. Changing this (or switching backend) triggers the Stale-Embeddings banner. |
| **Top-k chunks** | How many top-ranked chunks Ekorbia retrieves on each send. Defaults to 6. Higher = more context, slower, more tokens. |
| **Folder file types** | Comma-separated list of file extensions the folder walker includes. Defaults to `.md, .txt, .pdf`. |
| **Folder ignore patterns** | Comma-separated list of directory names the folder walker skips. Defaults to `.git, node_modules, target, dist, build, .venv, .next, .cache`. |

### Re-indexing after an embedding-model change

If you change the embedding model, existing chunks become unusable (different models produce non-comparable vectors). A yellow **Stale-Embeddings banner** appears above the chat with a one-click **Re-index all** button. Use it to re-embed every attachment with the new model.

You can also re-index a single folder anytime via the **↻ refresh icon** on its chip.

## Persisted UI state

These are saved automatically (not in the Settings panel — they update as you use the app):

- Sidebar width
- Right-panel width
- Prompt-list column width
- Panel open/closed state
- Right-panel selected tab (Prompts / Watches / Files)
- Selected model (per-window for main, separately for the overlay)
- Active theme
- Folder filters (in case you've customized them)

All of this survives across launches.

## Related pages

- [Themes](./themes.md)
- [Keyboard shortcuts](./keyboard-shortcuts.md)
- [Prompts library](./prompts.md)
- [Memory file](./memory.md)
