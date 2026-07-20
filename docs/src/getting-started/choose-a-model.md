# Choose a model

Ekorbia doesn't ship with a model baked in — you pick one and it downloads. With the **bundled engine** (the default), that's a couple of clicks inside the app; no terminal, no separate install.

## The easiest path: guided setup

The first time you launch Ekorbia with no model installed, it offers to set one up for you. It detects how much memory your Mac has, recommends a right-sized [Gemma 4](https://ai.google.dev/gemma) model from the built-in catalog, and downloads it (plus the small embedding model, if you want folder search) with a progress bar. You'll land in a working chat in a couple of minutes.

Want a different model than the one suggested? Click **Choose a different model** to open the full [model manager](../managing-models.md), or read on.

## The built-in catalog

Open **Settings → Models** (or click the model picker in the bottom-right of the composer and choose **Manage models…**) to see the catalog. Each entry shows its download size and how much memory it wants, with the recommended pick flagged. Click **Download** and a progress bar tracks it; the model appears in the picker the moment it's ready.

Every catalog model is a [Gemma 4](https://ai.google.dev/gemma) build and **can see images**:

| Model | Download | Wants | Good for |
|---|---|---|---|
| Gemma 4 E2B | ~4.3 GB | 8 GB RAM | Fast responses on any Apple-Silicon Mac |
| Gemma 4 E4B | ~6.1 GB | 8 GB RAM | A balanced all-rounder |
| Gemma 4 12B | ~7.2 GB | 16 GB RAM | Stronger reasoning and writing *(recommended)* |
| Gemma 4 26B-A4B | ~15.4 GB | 32 GB RAM | Long-form, complex analysis |

Not sure? Take the guided recommendation — it's sized to leave headroom for the rest of your apps. You can download as many as you like; they live side-by-side, and you switch between them with the model picker in the bottom-right of the composer (see [The chat window](../chat/composer.md)).

Downloads are checksummed and resumable: closing the manager keeps them running, and **Cancel** keeps what's already downloaded so retrying later picks up where it left off. See [Managing models](../managing-models.md) for the full tour, including deleting models.

## The embedding model (for attachments and search)

To attach files or folders and have Ekorbia find relevant chunks when you ask questions, you also need a small **embedding model**. The guided setup offers to grab it for you; otherwise download **nomic-embed-text** (about 274 MB) from the catalog.

> **You only need this if you plan to attach files or folders.** Pure text chats don't use it.

## Choosing a backend

Most people should stay on the **bundled engine** — it's the default and needs nothing extra. But Ekorbia can run models three ways, switchable any time under **Settings → Backend**:

- **Bundled engine** *(default)* — Ekorbia runs models itself from the catalog above. Easiest, nothing to install.
- **Ollama** — if you already use [Ollama](https://ollama.com) or prefer it. Install it, pull a model with `ollama pull <name>`, then choose Ollama under Settings → Backend. Ekorbia's model picker then lists your Ollama models.
- **Custom endpoint** — any OpenAI-compatible server (LM Studio, llama.cpp's `llama-server`, vLLM, …). Enter its URL under Settings → Backend; that server owns its own models.

Switching backends is safe — nothing is lost. Because different backends produce different embeddings, if you've indexed attachments and then switch, Ekorbia offers a one-click re-index so search stays accurate.

## Next: [Your first chat →](./first-chat.md)
