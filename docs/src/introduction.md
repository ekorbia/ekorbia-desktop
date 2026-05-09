# Welcome to Ekorbia

**Ekorbia** is a native desktop integrated productivity environment for local AI models. It runs entirely on your machine — there are no cloud services, no API keys, and nothing leaves your computer unless you explicitly tell it to.

Ekorbia is powered by [Ollama](https://ollama.com), an open-source runtime that lets you download and run language models locally. If you can run a chat model in Ollama, you can use it in Ekorbia.

## What Ekorbia gives you

- **Multi-tab chat** with independent conversations
- **File and folder attachments** with local retrieval-augmented generation (RAG) — ask questions over your own documents without uploading anything
- **Images and vision** — drop a screenshot or photo into a chat and ask about it (with a vision-capable model)
- **A prompts library** backed by plain Markdown files you can share, edit, and version-control
- **Watches** — ambient background jobs that monitor folders, RSS feeds, and web pages and summarize what changes
- **A quick-query overlay** — Spotlight-style panel that pops up over any app for fast one-off questions
- **Screenshot capture** — press a hotkey, drag a region, and a new chat opens with the screenshot attached
- **Saving files from chat** — let the model write HTML, scripts, configs, or notes straight to a folder you choose, sandboxed and atomic
- **A memory file** — a single Markdown file you control that Ekorbia injects into every chat as personal context
- **Private chats** — ephemeral sessions whose messages and attachments never touch the database
- **Full-text search across chat history** — find anything you've ever discussed
- **Five themes** — One Dark, One Light, Ayu Dark, Ayu Mirage, Ayu Light

## Privacy and storage

Everything you do with Ekorbia stays on your machine:

- **Chats** are stored in a local SQLite database in your app data directory
- **Prompts** live as Markdown files in a folder you choose
- **Attachments** are indexed locally; embeddings are computed by a local model
- **Watches** poll the URLs and folders you configure, summarize with the local model you choose, and write notes to a local file
- **Saved files from chat** go to a folder you pick, never anywhere else

Nothing is sent to a third party. The only network traffic Ekorbia generates is between the app and your local Ollama server, and any URLs you explicitly point a watch at.

## Where to start

If you're new to Ekorbia, follow the **Getting started** section in order:

1. [Install Ekorbia](./getting-started/install.md)
2. [Pull your first model](./getting-started/pull-a-model.md)
3. [Your first chat](./getting-started/first-chat.md)

Otherwise, dip into whichever section sounds useful. Every page is self-contained, with links back to related features.
