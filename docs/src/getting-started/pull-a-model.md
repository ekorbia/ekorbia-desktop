# Pull your first model

Ekorbia doesn't ship with any models. You pull them yourself, one at a time, from Ollama's library. Picking a good first model depends on what you have in mind.

## The easiest path: guided setup

If you launch Ekorbia with no model installed, it offers to set one up for you — **no terminal required**. It detects how much memory your machine has, recommends a right-sized [Gemma 4](https://ai.google.dev/gemma) model, and downloads it (plus the embedding model, if you want folder search) with a progress bar. You'll land in a working chat in a couple of minutes.

Want a different model than the one suggested? Click **Choose a different model** to open the full [model manager](../managing-models.md), or read on for how to pick one yourself.

## A quick model-picking primer

Models come in different sizes (`1b`, `7b`, `26b`, …) and capabilities (chat-only, vision, tool use). Bigger models are smarter but slower and need more RAM. Roughly:

| Class | Examples | RAM needed | Good for |
|---|---|---|---|
| Tiny | `llama3.2:1b` | 4 GB | Fast responses, simple tasks, embedding |
| Small | `llama3:8b`, `qwen2.5:7b` | 8 GB | Day-to-day chat, drafts |
| Medium | `qwen2.5:14b`, `gemma3:12b` | 16 GB | Better reasoning and writing |
| Large | `gemma4:26b`, `llama3.1:70b` | 32–64 GB | Long-form, complex analysis, vision |

If you're not sure, **`llama3`** is a solid all-rounder that fits comfortably on most machines.

## Pull a chat model

The easiest way is inside Ekorbia itself: open **Settings → Models** (or
click the model picker in the bottom-right of the composer and choose
**Manage models…**), type a model name, and click **Pull**. A progress bar
tracks the download, and the model appears in the picker the moment it's
ready. See [Managing models](../managing-models.md) for the full tour.

Prefer the terminal? The classic way works exactly the same:

```bash
ollama pull llama3
```

The first pull will download several gigabytes. Subsequent pulls of other models reuse shared layers and are usually faster.

You can pull as many models as you want; they all live side-by-side. Switch between them inside Ekorbia using the model picker in the bottom-right of the composer (covered in [The chat window](../chat/composer.md)).

## Pull a vision model (optional, but recommended)

If you want to drop images and screenshots into chats, you need a **vision-capable** model. Two good choices:

```bash
ollama pull gemma3:4b      # small, fast, can see images
ollama pull gemma4:26b     # larger, smarter, also sees images
```

If you have a vision model installed, Ekorbia will automatically switch to it when you attach an image — see [Images and vision models](../attachments/images-and-vision.md).

## Pull an embedding model (for attachments and search)

To attach files or folders and have Ekorbia find relevant chunks when you ask questions, you need an **embedding model**. The default Ekorbia expects is:

```bash
ollama pull nomic-embed-text
```

`nomic-embed-text` is small (about 270 MB), fast, and produces high-quality embeddings. You can use any other Ollama embedding model — change it in **Settings → Attachments → Embedding model**.

> **You only need this if you plan to attach files or folders.** Pure text chats don't use embeddings.

## Checking what you have

Anytime you want to see what's installed:

```bash
ollama list
```

You'll get a table of models with their sizes and modified dates.

## Removing a model

```bash
ollama rm <model-name>
```

Ekorbia is fine with you removing a model that's set as the active one — at the next launch it falls back to the first installed model so you're never stranded.

## Next: [Your first chat →](./first-chat.md)
