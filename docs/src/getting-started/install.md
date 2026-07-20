# Install Ekorbia

Ekorbia is a native macOS desktop app that runs AI models **on your own machine** — and it comes with everything it needs to do that built in. There's nothing else to install first.

## Install the app

Download the latest Ekorbia DMG from the website and drag the app to your Applications folder. The first launch may show a Gatekeeper prompt — right-click the app icon and choose **Open** if macOS won't let you double-click it.

<!-- TODO: screenshot of Ekorbia in /Applications -->

## First launch

On first launch Ekorbia runs a brief **onboarding tour** covering the hotkeys, attachments, memory file, and prompts library. You can skip it any time with `Esc`, and re-open it later from **Settings → General → Help → Show tour again**.

Right after the tour, Ekorbia helps you get a model: it recommends one sized for your Mac and downloads it with a progress bar — no terminal, no separate install. See [Choose a model](./choose-a-model.md) for the details.

## How Ekorbia runs models

Out of the box, Ekorbia runs models itself with a **bundled engine**. You pick a model from the built-in catalog, it downloads, and you start chatting. That's the default and the easiest path — most people never need anything else.

If you'd rather bring your own runtime, Ekorbia also works with two other backends, selectable under **Settings → Backend**:

- **[Ollama](https://ollama.com)** — if you already use it or prefer it. Install it separately, then pick it under Settings → Backend.
- **A custom endpoint** — any OpenAI-compatible server (LM Studio, llama.cpp's `llama-server`, vLLM, …). Point Ekorbia at its URL under Settings → Backend.

See [Choosing a backend](./choose-a-model.md#choosing-a-backend) for the trade-offs.

## What gets created on your machine

On first run, Ekorbia creates a few things — all on your local disk, none on a server:

| What | Where | Why |
|---|---|---|
| App data folder | macOS: `~/Library/Application Support/com.ekorbia.desktop/`<br>Linux: `~/.local/share/com.ekorbia.desktop/`<br>Windows: `%APPDATA%\com.ekorbia.desktop\` | Chats, settings, and attachment metadata |
| Models folder | `<app data>/models/` | GGUF model files you download for the bundled engine |
| Prompts folder | `~/Documents/Ekorbia/Prompts/` | Your prompts library (28 built-ins shipped) |
| Memory file | `~/Documents/Ekorbia/memory.md` | Your personal context file (empty by default) |

The prompts folder and memory file paths are configurable in **Settings**. The app data and models folders are fixed by each OS's convention.

## Next: [Choose a model →](./choose-a-model.md)
