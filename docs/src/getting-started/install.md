# Install Ekorbia

Ekorbia is a native macOS desktop app. Before you can run it you need two things on your machine:

1. **[Ollama](https://ollama.com)** — the local AI model runtime
2. **A chat model** — at least one model pulled into Ollama (covered in the [next page](./pull-a-model.md))

This page walks through installing Ollama and the Ekorbia app itself.

## Install Ollama

Download Ollama from [ollama.com](https://ollama.com) and run the installer.

After it installs, Ollama runs in the background and exposes a local API on port `11434`. Ekorbia talks to it over that port — no configuration needed on your end.

You can verify Ollama is running by opening your terminal and typing:

```bash
ollama --version
```

If you see a version number, you're good. If the command isn't found, restart your terminal — the installer adds Ollama to your `PATH` but only new shells pick that up.

> **Ekorbia can start Ollama for you.** When you launch Ekorbia, it checks whether Ollama is already running. If it isn't, a small banner appears offering to start it. You don't have to interact with Ollama directly day-to-day.

## Install Ekorbia

Download the latest Ekorbia DMG from the website and drag the app to your Applications folder. The first launch may show a Gatekeeper prompt — right-click the app icon and choose **Open** if macOS won't let you double-click it.

<!-- TODO: screenshot of Ekorbia in /Applications -->

On first launch Ekorbia runs a brief **onboarding tour** covering the hotkeys, attachments, memory file, and prompts library. You can skip it any time with `Esc`, and re-open it later from **Settings → General → Help → Show tour again**.

## What gets created on your machine

On first run, Ekorbia creates a few things — all on your local disk, none on a server:

| What | Where | Why |
|---|---|---|
| App data folder | `~/Library/Application Support/dev.ekorbia.desktop/` | Chats, settings, and attachment metadata |
| Prompts folder | `~/Documents/Ekorbia/Prompts/` | Your prompts library (28 built-ins shipped) |
| Memory file | `~/Documents/Ekorbia/memory.md` | Your personal context file (empty by default) |

Both the prompts folder and memory file paths are configurable in **Settings**. The app data folder is fixed by macOS convention.

## Next: [Pull your first model →](./pull-a-model.md)
