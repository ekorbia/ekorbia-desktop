# Ekorbia

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS%20%28Apple%20Silicon%29-lightgrey)
![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db)
![Runs models locally](https://img.shields.io/badge/models-100%25%20local-24c8db)
[![Launch Certified by FuzzPage](https://fuzzpage.com/badge/ekorbia-ekorbia-desktop.svg)](https://fuzzpage.com/p/ekorbia-ekorbia-desktop)

Private, local AI for your Mac. Ekorbia runs open models on your own machine with a bundled engine: pick one from the built-in catalog and it downloads. No terminal, no account, no API key. Your chats stay on your Mac.

<p align="center">
  <img src="docs/screenshots/ekorbia-screenshot-0.7.png" alt="Ekorbia main chat window" width="800">
</p>

## What it does

- **Ask from any app.** ⌘⇧Space opens a quick-query panel over whatever you are doing.
- **Act on copied text.** Copy something, press ⌘⇧E, and summarize, rewrite, fix or explain it.
- **Talk instead of type.** ⌘⇧V dictates from any app, transcribed on your Mac.
- **Ask about your screen.** ⌘⇧1 captures a region into a new chat.
- **Chat with your files.** Attach files or a whole folder; answers cite their sources.
- **Spaces.** Group chats with their own model, pinned files, prompts and memory.
- **Watches.** Summaries of new files in a folder, new posts in a feed, or changes to a web page, in the background.
- **Prompt library.** Plain Markdown files you own; 31 are included.

Also: compare two or three models side by side, private chats that are never saved, search across every chat, a memory file, optional thinking before answers, math and diagrams in replies, a ⌘K command palette, files the model saves to a folder you choose, and six themes.

What changed in each release is in the [changelog](CHANGELOG.md). More at [ekorbia.com](https://ekorbia.com).

## Install

1. Download the `.dmg` from the [latest release](https://github.com/ekorbia/ekorbia-desktop/releases/latest).
2. Drag **Ekorbia** into Applications and open it.
3. On first launch Ekorbia looks at your Mac's memory, suggests a model that fits, and downloads it.

You need a Mac with Apple Silicon and macOS 12 or newer. 8 GB of memory runs the small models; 16 GB or more is better. Models take 3 to 19 GB of disk each.

Windows and Linux builds ended with 0.7.1. Those installers remain on the Releases page.

### First launch on macOS (important)

Ekorbia is not signed with an Apple Developer ID, so macOS blocks it the first time. Both messages below have the same cause, a quarantine mark your browser puts on downloads, and a one-time fix.

**"Ekorbia…dmg is damaged and can't be opened."** The file is fine. Remove the mark, then open the `.dmg` again:

```bash
xattr -dr com.apple.quarantine ~/Downloads/Ekorbia_*.dmg
```

**macOS says it could not verify Ekorbia.** Open **System Settings → Privacy & Security**, find the message about Ekorbia and click **Open Anyway**. On macOS 14 or earlier you can instead right-click the app and choose **Open**. Or run:

```bash
xattr -dr com.apple.quarantine /Applications/Ekorbia.app
```

To check a download against the release's checksums, run `shasum -a 256 -c SHA256SUMS.txt` beside it. A [build from source](#build-from-source) needs no bypass.

## Models

The bundled engine is [llama.cpp](https://github.com/ggml-org/llama.cpp). The catalog offers Gemma 4 (E2B, E4B, 12B, 26B and 31B) and Qwen (3.5 4B, 3.5 9B and 3.8 27B). Every download is checked against a pinned checksum. Settings → Models also takes a Hugging Face link, so you can add any GGUF model.

Prefer your own runtime? Settings → Backend switches to [Ollama](https://ollama.com) or any OpenAI-compatible server, such as LM Studio, llama-server or vLLM.

## Privacy and your data

- No telemetry, no account, and no code or fonts loaded from the internet. Once a model is downloaded, Ekorbia works offline.
- The only network traffic is what you ask for: model downloads from Hugging Face, the feeds and pages your Watches follow, and a custom endpoint if you set one up.
- Chats are in a SQLite database in `~/Library/Application Support/com.ekorbia.desktop/`, with models in the `models` folder beside it.
- Prompts and the memory file are plain Markdown in `~/Documents/Ekorbia/`.
- Closing the window keeps Ekorbia running for its hotkeys and Watches, and ends any private chat. ⌘Q quits.

## Build from source

You need [Rust](https://rustup.rs), the Xcode Command Line Tools (`xcode-select --install`), `cmake` (`brew install cmake`) and the Tauri CLI (`cargo install tauri-cli --version '^2'`).

```bash
git clone https://github.com/ekorbia/ekorbia-desktop.git
cd ekorbia-desktop
./scripts/fetch-llama-server.sh      # build the bundled engine, once
./scripts/dev.sh                     # run the app in development
(cd src-tauri && cargo tauri build)  # or build Ekorbia.app and the .dmg
```

Run the tests with `./scripts/run-all-tests.sh`. The UI suite needs Node 20 or newer, `npm ci` and `npx playwright install webkit`. [CONTRIBUTING.md](CONTRIBUTING.md) lists the test gates and the conventions a patch has to follow.
