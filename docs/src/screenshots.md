# Screenshot capture

Press **⌘⇧1** (default) anywhere on your Mac to capture a screenshot straight into an Ekorbia chat.

<!-- TODO: screenshot of the macOS native crosshair region selector in action -->

## How it works

The hotkey invokes **macOS's native region selector** — the same crosshair UI you already know from `Cmd+Shift+4`:

- **Drag** for a region
- **Press Space** to switch to window-capture mode
- **Press Esc** to cancel

When you complete a capture, Ekorbia immediately:

1. Saves the PNG to your system temp directory
2. Opens a new chat tab in the main window
3. Attaches the screenshot to that tab as a vision attachment
4. Switches to the new tab so you can start typing your question

You can then ask anything about what's in the screenshot — "what does this error mean?" / "transcribe this whiteboard" / "what's wrong with this layout?"

## When you have a vision model installed

If your **active model** can see images, you're good — type your question, send, and the model gets the screenshot as part of the request.

## When you DON'T have a vision model active

Ekorbia handles this gracefully:

- **A vision model is installed but isn't your active model** — Ekorbia auto-switches the new tab to a vision-capable model and shows a toast: *"Switched to vision model: gemma3:4b"*.
- **No vision model is installed** — A toast warns you the image will be ignored. To fix this, pull a vision model: `ollama pull gemma3:4b`, then re-attach (or recapture).

## Customizing the hotkey

Open **Settings → General → Screenshot hotkey** and click the current shortcut. Press the new combination — it's recorded immediately. The shortcut is registered globally.

Pick something that doesn't collide with macOS's own shortcuts (notably `Cmd+Shift+3`, `Cmd+Shift+4`, `Cmd+Shift+5`).

## Where the PNG file lives

The captured PNG is written to your system temp directory (`/var/folders/.../T/`). Ekorbia references it from the attachment store by path. **Don't delete the file before sending the first message** — that's when the bytes are read and base64-encoded into the request.

After the message is sent, the PNG can be safely deleted; macOS reclaims temp files on reboot in any case.

## Workflow tips

- **One-question screenshots**: capture, type your question, get an answer, close the tab. Same flow as the [overlay](./overlay.md) but with visual context.
- **Annotated screenshots**: take the screenshot, then drag-attach a separate annotated version on top (`paperclip` button) — vision models can compare the two.
- **Combining with the memory file**: if you frequently ask "explain this error message" type questions, add a system instruction in your [Memory file](./memory.md) like "When I attach a screenshot of an error, explain plainly what it means and give one concrete fix to try first."

## Related pages

- [Images and vision models](./attachments/images-and-vision.md)
- [Quick-query overlay](./overlay.md) — sibling hotkey-driven feature
- [Settings](./settings.md) — for the screenshot hotkey
