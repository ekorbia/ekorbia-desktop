# Managing models

Ekorbia has a built-in model manager — download new models and delete old ones without touching a terminal. On the **bundled engine** (the default) it's driven by a curated catalog; models download straight into the app.

## Opening the manager

Three ways in:

- **Settings → Models** — the manager lives as a Settings tab.
- **The model picker** — click the model name in the bottom-right of the
  composer, then **Manage models…** at the bottom of the list. (If you
  have no models at all, the picker shows a **Download a model…** button
  instead.)
- **The startup dialog** — if Ekorbia launches and your selected model
  isn't installed, the setup card offers **Download a model…** directly.

## Downloading a model

On the bundled engine, the manager shows the built-in **catalog** — the Gemma 4 family, Qwen3.5, plus the `nomic-embed-text` embedding model that folder attachments and search rely on. The catalog leads with the best pick for **your** Mac (sized to your memory), ranks the rest by fit, and folds the long tail behind **Show more** — with a filter box once the list grows. Each entry lists its download size and how much memory it wants. Click **Download** on any of them.

While a download runs you'll see a live progress bar with percentage and bytes. Downloads keep running if you close the manager — reopen it any time to check progress, and a notification toast appears when the model is ready. Downloads are **checksummed** (a corrupted file never looks installed) and **resumable**: **Cancel** stops immediately but keeps what's already downloaded, so retrying later picks up where it left off.

You can queue several downloads at once; each gets its own progress row.

<!-- TODO: screenshot of the model manager mid-download -->

## Adding a model from Hugging Face

Beyond the catalog, you can pull almost any GGUF model straight from [Hugging Face](https://huggingface.co) using the **Add from a link** box:

- **Browse a repo.** Paste a model id (`org/model`) or its Hugging Face page URL and click **Browse**. Ekorbia lists the repo's `.gguf` files with their sizes and quantization, flags a sensible default, and — when the repo ships a vision projector (`mmproj`) — pairs it automatically so vision just works. Pick a quant and click **Download**.
- **Add a direct link.** Paste a direct link to a single `.gguf` file (a Hugging Face page or download link both work) and click **Add**; Ekorbia names it from the file.

Repo downloads are **checksum-verified** against the hashes Hugging Face publishes for each file — the same integrity guarantee as the built-in catalog. Direct links are best-effort (there's no published hash to check against), and either way the quality of a custom model depends on the chat template baked into the file.

> **What leaves your machine.** Browsing or downloading contacts `huggingface.co` — first to read a repo's public file list, then to fetch the files you choose. That's the only time Ekorbia reaches the network for models, and it never sends your chats or documents. To stay fully offline, drop `.gguf` files into the models folder yourself (**Reveal models folder**) and skip this box.

## Deleting a model

Click **Delete** next to any installed model. A confirmation explains what's about to happen — deleting removes the model's files from disk, but you can always download it again later. If you delete the model you're currently chatting with, Ekorbia falls back to another installed model at the next launch so you're never stranded.

## Using Ollama or a custom endpoint instead

If you've switched to the **Ollama** backend under **Settings → Backend**, the manager instead manages your Ollama models — type any name from [ollama.com/library](https://ollama.com/library) and pull it, or delete what you have. Everything the manager does there can also be done with the Ollama CLI (`ollama pull`, `ollama rm`, `ollama list`); the manager and the CLI see the same models.

On a **custom endpoint**, the server owns its own model store, so the manager's download/delete controls are hidden — manage models on that server directly.

## Related pages

- [Choose a model](./getting-started/choose-a-model.md) — picking a good
  first model for your machine, and choosing a backend
- [Settings](./settings.md)
