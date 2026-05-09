# Attaching files

Click the **paperclip** in the composer to attach one or more individual files to the current chat. The model can then answer questions about their contents.

<!-- TODO: screenshot of the file picker open from the paperclip button -->

## Supported file types

| Type | Extensions | What happens |
|---|---|---|
| Plain text | `.txt`, `.md` | Read as UTF-8 |
| PDFs | `.pdf` | Text extracted page-by-page; images inside PDFs are skipped |
| Images | `.png`, `.jpg`, `.jpeg`, `.webp` | Passed to vision-capable models as base64 — see [Images and vision models](./images-and-vision.md) |

Other file types aren't accepted — the picker filters them out. If you need to ask about a different format, convert it to text first (e.g. PDF a Word document, or copy-paste a spreadsheet's contents into a `.md` file).

## What "attached" actually means

When you attach a file, you see a small **chip** above the composer with the filename and a progress indicator. What happens behind that chip depends on the file's size:

- **Small text files (under 8 KB)** — inlined **verbatim** into the next prompt. Zero indexing latency; the model sees the whole file as part of your message.
- **Larger text files and PDFs** — extracted, chunked, and embedded with your configured embedding model (default `nomic-embed-text`). When you ask a question, Ekorbia retrieves the most relevant chunks and includes those in the prompt — see [Citations and sources](./citations.md).
- **Images** — handed directly to a vision-capable model as base64; no chunking or embedding involved.

## The chip lifecycle

A file chip moves through these states:

| State | What you see | Meaning |
|---|---|---|
| Pending | filename + spinner | Reading the file |
| Indexing | `42/87` or `walking…` | Chunking and embedding (large files only) |
| Ready | filename + size badge | Available to the model |
| Error | red border + tooltip | Hover to see why (file too large, unsupported format, etc.) |

Click the **×** on any chip to detach. Detaching deletes the embeddings for that file too — re-attaching re-indexes from scratch.

## File size limits

There's no hard cap on file size, but very large files (hundreds of MB of text) take time to embed and your local machine has to fit it all in memory while indexing. For PDFs, the practical ceiling is somewhere around 50 MB before things slow noticeably — split larger PDFs if you can.

## What the chat sees

When you send a message, Ekorbia constructs the prompt roughly like:

1. (Optional) The contents of your **memory file** as a system message
2. (Optional) Any attached **prompts** as system messages
3. **Retrieved chunks** from your attachments, labelled with citation indices `[1]`, `[2]`, …
4. The chat history
5. Your new message

The model is instructed to use the citation indices when referencing attached content. See [Citations and sources](./citations.md) for what the user-facing result looks like.

## Related pages

- [Attaching folders](./folders.md) — same flow, but for entire directories
- [Images and vision models](./images-and-vision.md) — how images route to vision-capable models
- [Citations and sources](./citations.md) — how retrieved chunks become a Sources footer
