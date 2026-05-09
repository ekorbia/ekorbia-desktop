# Citations and sources

When you ask a question against attached files or folders, Ekorbia retrieves the most relevant chunks and gives them to the model with citation indices. The model is instructed to mark its references inline as `[1]`, `[2]`, `[3]`, and so on. Below the reply you'll see a **Sources** footer with clickable chips that match those indices.

<!-- TODO: screenshot of an assistant reply with [N] citations and the Sources footer below -->

## What a citation marker looks like

In the rendered reply, markers appear next to the claim they support:

> The watcher runs every 30 seconds by default `[2]`. You can change this in the form's *Cadence* field `[3]`.

Clicking a marker scrolls (or jumps) the page to the matching chip in the Sources footer.

## The Sources footer

Below the reply, each cited file appears as a chip:

- **Filename** + size badge
- A **[3]** label matching the marker in the reply
- A **relevance score** (higher = better match)
- **Folder chips can be expanded** to show which sub-files inside the folder contributed, each with its own score

**Click** a chip to open the file with your OS default application. **Shift-click** to reveal it in Finder.

## Why citations matter

Without citation markers, you'd have to take the model's word that it found the answer in your attachments. With them, you can:

- Spot-check claims against the source ("the model says X — did it really come from `notes.md`?")
- Track down a particular section of a long document
- Notice when the model is **answering without citing** — usually a sign it's making something up rather than using your content

## Top-k chunks

By default, Ekorbia retrieves the top **6** most relevant chunks across all attachments. You can adjust this in **Settings → Attachments → Top-k chunks**. Higher values give the model more context (more citations possible) but slower responses and larger token usage.

## How relevance is scored

Both your question and your attached content are passed through your embedding model. Each chunk gets a similarity score against the question, and the top N are picked. The score shown on each chip is the cosine similarity — closer to 1.0 means more relevant.

This is **semantic** search, not keyword search. Asking "how do I undo a commit" finds chunks about `git reset` even though the chunk doesn't contain the word "undo."

## Images in the Sources footer

Image attachments appear in the Sources footer as **non-citation chips** (no `[N]` label). They were sent to the model as visual context, but the model can't cite a pixel region the way it cites a text chunk. The chip is there so you can see what visual context contributed.

## Related pages

- [Attaching files](./files.md)
- [Attaching folders](./folders.md)
- [Settings](../settings.md) — Top-k and embedding model
