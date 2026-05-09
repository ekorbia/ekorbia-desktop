# Attaching folders

Click the **folder icon** in the composer to attach an entire directory tree to the current chat. Ekorbia walks the folder, filters to a configurable set of file types, indexes everything, and lets the model answer questions across the whole collection.

<!-- TODO: screenshot of a folder chip showing the walking → 42/387 → 87 files progression -->

## What gets included

By default, the folder walker includes:

- `.md` (Markdown)
- `.txt` (plain text)
- `.pdf` (PDFs — text extracted, page by page)

…and skips noise directories:

- `.git`, `node_modules`, `target`, `dist`, `build`, `.venv`, and several others

Both the file-type allow-list and the directory ignore-list are editable in **Settings → Attachments**. You can add `.org` or `.rst` to the allow-list, or add `vendor/` to the ignore-list, for example.

## Limits

- Up to **1000 files per folder** are indexed. Larger folders are truncated with a warning chip; narrow the scope or attach a sub-folder.
- Symlinks are **not followed** — to keep the walker safe from cycles.
- Hidden files (starting with `.`) are skipped by default along with the standard ignore-dirs.

## Watching the chip

Folder indexing is the longest-running attachment operation. The chip updates live so you can see progress:

| Stage | Chip text | Meaning |
|---|---|---|
| 1 | `walking…` | Discovering files matching the allow-list |
| 2 | `42/387` | Embedding chunks; `n/total` |
| 3 | `87 files` | Finished — the folder is queryable |

The status bar at the bottom of the window aggregates all in-flight indexing across attachments and tabs (`Indexing docs/ — 42/87`), so you know when local work is still happening.

## Incremental re-index

When you change a file inside an attached folder, Ekorbia notices via the file's modification time the next time the folder is re-indexed. To trigger a re-index:

1. Click the **↻ refresh icon** on a Ready folder chip

Only files whose modification time has changed since the last index will be re-embedded. Unchanged files keep their existing chunks — re-indexing a 500-file folder where one note changed takes seconds, not minutes.

## Asking questions across a folder

Once the folder is Ready, ask anything — Ekorbia retrieves the top-6 most relevant chunks from across all files at send time and includes them as context for the model.

In the assistant's reply, citation markers like `[3]` appear inline. Below the reply, a **Sources** footer shows file chips that match the citations. Folder chips can be **expanded** to show which sub-files contributed and their relevance scores. **Shift-click** any source chip to reveal that file in Finder.

See [Citations and sources](./citations.md) for the full footer behavior.

## Changing the embedding model

If you change your embedding model in **Settings → Attachments → Embedding model**, existing embeddings become unusable until re-indexed (different models produce non-comparable vectors).

When that happens, a yellow banner appears above the chat:

> *N attachments were embedded with a different model. Re-index them with X to make them searchable again.*

One click handles the lot — every stale attachment in every chat is re-indexed with the new model.

## Related pages

- [Attaching files](./files.md)
- [Citations and sources](./citations.md)
- [Settings](../settings.md) — for folder filters and embedding model
