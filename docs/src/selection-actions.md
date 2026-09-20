# Selection actions — work on text from any app

Copy some text anywhere on your Mac, press **⌘⇧E**, and Ekorbia opens with that text ready to work on: summarize it, rewrite it, fix its grammar, explain it — or tell it what you want in your own words. The result is one click from your clipboard, so it goes straight back where the text came from.

All of it runs on the model on your machine. The text never leaves it.

<!-- TODO: screenshot of the overlay in selection mode with the chips visible -->

## The loop

1. Select text in any app and copy it (**⌘C**).
2. Press **⌘⇧E**.
3. Click a verb, type your own instruction and press **Enter** — or, with a library prompt attached, just press **Enter**.
4. Click **Copy result** and paste.

That's the whole thing. Step 4 is why the built-in verbs are written to reply with the replacement text and nothing else: no "Sure! Here's the corrected version:" to delete before you paste.

## The built-in verbs

| Verb | What it does |
|---|---|
| **Summarize** | The short version — the main point first, then only detail that matters. |
| **Rewrite** | Same meaning, clearer wording. Keeps your facts and roughly your length. |
| **Fix grammar** | Spelling and punctuation only. Your wording and tone are left alone. |
| **Explain** | What the text means and what to take from it, in plain language. |

## Typing your own instruction

The input at the top works on the captured text too — type "translate this into German", "turn this into bullet points", "shorten to one sentence" and press **Enter**. It's the same machinery as the chips, so the four verbs are a starting point rather than a fixed menu.

This is also how you translate: there's no Translate chip because a chip can't ask which language you want, and a sentence says it in the same breath.

## Using a prompt from your library

Library prompts come in the same way they do everywhere else in the overlay: click **+ prompt** in the bar under the input and pick one. It stays attached between uses, and then works two ways:

- **On its own — press Enter with the input empty.** The prompt runs on the copied text by itself. This is for prompts that are already a complete instruction: "turn this into meeting notes", "summarize as three bullets for my manager". The input's placeholder names the prompt that Enter will run. Because the attachment sticks, your go-to prompt becomes three keystrokes from any app: **⌘C**, **⌘⇧E**, **Enter**.
- **As a voice behind a verb.** Click a verb (or type an instruction) and the attached prompt shapes it — attach your "reply in my voice" prompt, then **Rewrite**, and the rewrite comes back in your voice.

## What happens to the result

- **Copy result** puts it on the clipboard, replacing what you copied. This is the main path.
- **Send to main** opens it as a real chat in the main window, so you can keep going — ask a follow-up, attach a file, change models. The chat stores both the instruction and the text, so it still reads correctly weeks later.
- Clicking a **different verb** re-runs on the same text. The chips stay on screen for exactly this reason — no going back first.

## Things worth knowing

- **It reads the clipboard, not your selection.** Ekorbia never watches what you have highlighted; it only ever looks when you press the hotkey, and only at the text you yourself copied. That's why there's no Accessibility permission to grant.
- **Copy before you press.** If the clipboard still holds something from an hour ago, that's what you'll get — the snippet at the top of the panel always shows exactly what's being worked on, so check it if a result looks strange.
- **Empty clipboard?** The overlay says so rather than silently doing nothing.
- **Very long text gets trimmed** to fit the model's context, keeping the beginning and the end. The panel tells you when this happened and shows the real size.
- **Images and files don't count.** The clipboard has to hold text; a copied image reads as an empty clipboard here. For images, use [screenshot capture](./screenshots.md) instead.
- **Model and prompt come from the overlay**, not the main window — the picker and the **+ prompt** chip at the top of the panel. A small, fast model is usually the right call for a one-shot rewrite. See above for how an attached prompt combines with the verbs.

## Changing the hotkey

**Settings → Hotkeys → Selection actions**. Click the shortcut and press a new combination — it needs at least one modifier. ⌘⇧E shadows the app-local ⌘⇧E in apps that use it (often Export), so rebind if that matters to you.

macOS only for now, like [voice input](./voice-input.md) and [screenshot capture](./screenshots.md).
