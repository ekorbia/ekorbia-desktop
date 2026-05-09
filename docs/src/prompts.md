# Prompts library

Ekorbia's prompts library is a folder of Markdown files. Each `.md` file is one reusable system prompt — a persona, a task template, a style guide, anything you want the model to start each chat with already in mind. The library is git-friendly, shareable, and editable in any text editor.

The library lives at `~/Documents/Ekorbia/Prompts/` by default. You can change the location in **Settings → Prompts**.

<!-- TODO: screenshot of the Prompts panel with the search box and list -->

## What ships out of the box

Ekorbia includes **28 built-in prompts** covering common use cases:

- Album Deep Dive
- Brainstorm
- Cliff Notes
- Cloudflare Uptime Watcher
- Cover Letter Writer
- Devil's Advocate
- Email Draft
- Explain Simply
- Google Cloud Uptime Watcher
- How Does It End
- Job Posting Watcher
- Lateral Thinking Puzzles
- Log Triage
- Murder Mystery Interrogation
- New Listing Watcher
- Notes Synthesizer
- Personal Website Builder
- Price / Availability Watcher
- Professional Website Builder
- Rental Watcher
- Research Paper Tracker
- Resume Coach
- Sensitive Doc Q&A
- Should I Watch This
- Summarize
- Text Adventure
- Tone Reframer
- Translate → Spanish / French / German
- Wikipedia Edit Watcher

If you ever delete some of these by accident, **Settings → Prompts → Restore built-in prompts** re-copies them.

## Using a prompt in a chat

In the composer, click the **prompt-attach button** (📋 icon) to see your prompts. Pick one and it attaches as a chip above the textarea. When you send your message, the prompt is included as a system message at the top of the conversation.

You can attach **multiple prompts** to a single chat — they're concatenated in attach order. Click the `×` on a prompt chip to detach it.

## The prompts panel

Open the **Prompts** tab in the right sidebar to see the full library:

- **Search box** at the top — searches across prompt names, body text, and tags
- **Favorite filter** chips — five colored buckets you can use to categorize personal favorites
- **Tag filter** chips — free-text tags pulled from each prompt's frontmatter
- **Sort options** — Recent / A→Z / Z→A / Favorite (default: A→Z)
- **List on the left**, **prompt body on the right** — the column is resizable

Right-click any prompt in the list for actions:

- Attach to current chat
- Edit (opens the `.md` file in your default editor)
- Reveal in Finder
- Set favorite color (None / Red / Yellow / Green / Blue / Purple)
- Delete

## The `.md` file format

Every prompt is a Markdown file with optional YAML **frontmatter**:

```markdown
---
name: Email Draft
tags: [writing, work]
description: Write a professional email from rough bullet points.
---

You are a professional email drafter. Given a list of bullet points or rough
notes, produce a clear, concise, polite email...
```

| Field | Required | What it does |
|---|---|---|
| `name` | No (defaults to filename) | Display name in the list |
| `tags` | No | Used by the tag filter |
| `description` | No | Currently not displayed, but reserved for future use |

The body below `---` is the prompt content. Everything after the closing `---` is what the model sees when this prompt is attached.

> **Filename is the stable ID.** The `.md` filename (without extension) uniquely identifies the prompt. The display `name` in frontmatter is just for the UI — renaming a prompt is renaming the file, which keeps things consistent if you sync the folder via git or Dropbox.

## Favorites

Favorites are five colored buckets — Red, Yellow, Green, Blue, Purple — that you can assign to individual prompts via right-click. They're a personal categorization system: maybe Red is "everyday," Blue is "for research," Green is "watchers." Use them however helps you find things.

Favorite colors are **local to your machine** — they live in Ekorbia's local database and don't travel with the `.md` files if you share them. This is deliberate: your favorites are personal, not metadata for the prompt itself.

## Importing prompts

Click **Import** in the Prompts panel header to import `.md` or `.txt` files into your library. Plain-text files become Markdown files with no frontmatter — fine to start with, edit later.

## Sharing prompts

Because prompts are plain Markdown files in a folder you control, you can:

- **Sync the folder via git, Dropbox, iCloud, etc.** — everything but favorite color travels with the file
- **Email a `.md` file** to someone with Ekorbia — they drop it in their prompts folder and it appears in their library
- **Build a team prompt repo** — a shared folder of best-practice prompts everyone pulls from

## Related pages

- [The chat window](./chat/composer.md) — for the prompt-attach button in the composer
- [Settings](./settings.md) — for changing the prompts folder location
