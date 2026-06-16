# Managing models

Ekorbia has a built-in model manager — download new models and delete old
ones without touching a terminal. Everything still goes through your local
Ollama install; the manager is a friendlier face on `ollama pull` and
`ollama rm`.

## Opening the manager

Three ways in:

- **Settings → Models** — the manager lives as a Settings tab.
- **The model picker** — click the model name in the bottom-right of the
  composer, then **Manage models…** at the bottom of the list. (If you
  have no models at all, the picker shows a **Download a model…** button
  instead.)
- **The startup dialog** — if Ekorbia launches and your selected model
  isn't installed, the "Model not found" dialog offers **Download a
  model…** directly.

## Downloading a model

Type any model name from [ollama.com/library](https://ollama.com/library)
into the box — `gemma4:e4b`, `llama3.2:3b`, whatever you like — and click
**Pull**. Or click **Pull** on one of the suggestions, which include the
Gemma 4 family and the `nomic-embed-text` embedding model that folder
attachments and search rely on.

While a download runs you'll see a live progress bar with percentage and
bytes. Downloads keep running if you close the manager — reopen it any
time to check progress, and a notification toast appears when the model
is ready. **Cancel** stops a download immediately; partially-downloaded
layers are kept by Ollama, so retrying later resumes cheaply.

You can queue several downloads at once; each gets its own progress row.

<!-- TODO: screenshot of the model manager mid-download -->

## Deleting a model

Click **Delete** next to any installed model. A confirmation explains
what's about to happen — deleting removes the model from disk, but you
can always pull it again later. If you delete the model you're currently
chatting with, Ekorbia falls back to another installed model at the next
launch so you're never stranded.

## The terminal still works

Everything the manager does can also be done with the Ollama CLI
(`ollama pull`, `ollama rm`, `ollama list`) — the manager and the CLI
see the same models, so use whichever you prefer.

## Related pages

- [Pull your first model](./getting-started/pull-a-model.md) — picking a
  good first model for your machine
- [Settings](./settings.md)
