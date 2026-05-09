# Troubleshooting

Common issues and how to fix them.

## Status bar says "Ollama not running"

Ekorbia can't reach Ollama at `http://localhost:11434`.

**Fix:**

1. Click the **Start Ollama** prompt that should appear near the status bar, or
2. Open Ollama from your Applications folder yourself, or
3. From a terminal, run `ollama serve`

If Ollama is running and Ekorbia still says it isn't, the port may be blocked or in use by another process. Check with `lsof -i :11434`.

## Status bar says "Model not pulled"

The active model isn't installed in Ollama.

**Fix:** either pull it —

```bash
ollama pull <model-name>
```

— or switch to a model that is installed via the model picker in the composer.

If you just pulled a model and Ekorbia doesn't see it yet, click the model picker — Ekorbia queries Ollama live each time you open it.

## A model loads but generates nothing

**Possible causes:**

1. **The model is still warming up.** First-token latency on large models can be several seconds. The status bar shows `Warming…` during this phase.
2. **Your machine is out of memory.** Big models (26B+) can exceed available RAM and Ollama will eventually error out. Check Activity Monitor; switch to a smaller model.
3. **The context window is full.** Very long conversations with attachments can hit the model's context limit. Start a new chat or trim attachments.

## An attachment is stuck on "Indexing"

If a folder or large file chip has been stuck at `42/87` for many minutes without progress:

**Possible causes:**

1. **Your embedding model isn't installed.** Run `ollama pull nomic-embed-text` (or whatever model you've configured in Settings → Attachments).
2. **Ollama is overloaded.** If the chat model is also running, your machine may be RAM-starved. Try detaching one of them.
3. **A particular file is corrupt or extraction failed.** Detach the attachment and re-attach without that file.

To stop a stuck indexing job, click the **×** on the chip — Ekorbia cancels the in-flight embedding and discards partial work.

## "Stale Embeddings" yellow banner

You changed your embedding model in Settings → Attachments → Embedding model. Existing attachment chunks were embedded with the old model and can't be searched against the new one.

**Fix:** click **Re-index all** in the banner. Every attached file in every chat is re-embedded with the new model. This may take a few minutes if you have many attachments.

## Vision model doesn't see attached images

**Verify:**

1. The model has the `VISION` badge in the model picker
2. The image is `.png`, `.jpg`, `.jpeg`, or `.webp` (other formats aren't supported)
3. The image is under ~20 MB — very large images can fail to encode

If the model is vision-capable but still ignores images, restart Ekorbia (which re-reads model capabilities from Ollama).

## A code block's Save button doesn't appear

The Save button on individual code blocks appears **only** when the active model **doesn't** support tools. If you're using a tool-capable model, the model writes files via the [Saving files from chat](./saving-files-from-chat.md) flow — there's no per-block Save button because the file is already written.

To save a code block from a tool-capable model, copy it (the Copy button is always there) and paste into your editor manually.

## Tool-capable model isn't writing files

**Possible causes:**

1. **You previously chose "Block" on this chat's first-save modal.** Open the Files panel header → **Change…** to pick a folder, which un-blocks saves.
2. **The model isn't trying.** Some tool-capable models won't call `write_file` unless explicitly asked. Try "Save the result to a file called `foo.html`."
3. **The model's tool call failed.** Check the chat for a tool-error message; common issues are path traversal (`..` in the path) or unsupported characters.

## Quick-query overlay won't open

**Verify:**

1. The Ekorbia app is running (the overlay needs the main process alive even if the main window is closed)
2. The hotkey isn't being captured by another app (test it in TextEdit — if a Cmd+Shift+Space combo types a space, another app has stolen it)
3. The hotkey hasn't been changed without you remembering — check **Settings → General → Overlay hotkey**

## Screenshot capture toasts "Switched to vision model" and nothing happens

The screenshot was captured successfully but your previous active model can't see images. Ekorbia auto-switched the new tab to a vision model. **Type your question and send** — the vision model will see the screenshot.

If no toast appeared but the screenshot tab opened anyway, no vision model is installed. Pull one:

```bash
ollama pull gemma3:4b
```

…and either re-take the screenshot or detach + re-attach the existing one.

## A watch is silent

**Verify:**

1. The watch toggle is **on** (top-left of its row)
2. The cadence has actually elapsed since the last poll (folder=30s, RSS=10min, URL=30min — click **Run now** to bypass)
3. There's actually something new to summarize (URL watches stay silent when content hasn't changed; this is correct behavior)
4. The model the watch uses is installed (`ollama list`)

The activity feed in the Watches panel shows the **last poll time** — if it hasn't updated, the poller isn't reaching the source.

## A watch shows an error in its activity feed

Click the error entry to expand it. Common errors:

- **Network errors** — the URL is unreachable; check that the page works in a browser
- **Parse errors on RSS** — the feed isn't valid RSS/Atom; check the URL points at the feed XML, not the page
- **CSS selector matched nothing** — Ekorbia falls back to whole-page extraction; the next summary will use the whole page
- **Folder doesn't exist** — the watched directory was moved or deleted

The watch will keep retrying on its cadence; once the underlying problem is fixed, the next poll picks up cleanly.

## Themes look broken / fonts wrong

Ekorbia uses **Inter**, **JetBrains Mono**, and **Instrument Serif**. If these aren't on your machine, the app falls back to system equivalents — but the fallback may look different from intended.

**Fix:** install the fonts, or accept the fallback. Ekorbia doesn't bundle font files (yet).

## Something else

If you're stuck and the page above doesn't cover it:

- Check the README at the project's repository
- Open a fresh chat and ask Ekorbia itself — sometimes the model can talk you through the symptom

If you've found a real bug, please open an issue with reproduction steps.

## Related pages

- [Pull your first model](./getting-started/pull-a-model.md)
- [Settings](./settings.md)
- [Saving files from chat](./saving-files-from-chat.md)
