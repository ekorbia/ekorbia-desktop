# Images and vision models

Ekorbia supports image attachments through any **vision-capable model**. Drop a `.png`, `.jpg`, `.jpeg`, or `.webp` into a chat and a model that can see it will see it.

## What counts as a vision model

Ekorbia detects vision support per model; models that can see images get a small **`VISION`** badge in the model picker.

On the **bundled engine**, every model in the built-in catalog is vision-capable — just download any Gemma 4 from **Settings → Models**. (On the Ollama backend, pull one like `gemma4:e4b` or `llava`.)

## Attaching an image

Two ways:

1. **Paperclip** in the composer — choose any image file
2. **[Screenshot capture](../screenshots.md)** — press the hotkey, drag a region, and a new chat opens with the screenshot already attached

The image appears as a chip above the composer, just like other attachments. If the active model can see it, a `VISION` badge appears on the chip.

<!-- TODO: screenshot of a chat with an image attached + VISION badge -->

## Mixed vision/text model behavior

What happens depends on whether your active model can see images:

### When the active model is vision-capable

The image is encoded as base64 and included in the request to the model. It receives the image as part of your message and can describe, analyze, or answer questions about it.

### When the active model is NOT vision-capable

Ekorbia checks whether any vision-capable model is installed:

- **At least one available** — Ekorbia automatically switches to it and shows a toast: *"Switched to vision model: gemma3:4b"*. The original model is restored if you remove the image.
- **None available** — A toast warns you the image will be ignored. You can still attach it (no error), but the model can't see it. Download a vision model to fix the situation — any Gemma 4 in **Settings → Models**.

This auto-switch only happens for image attachments — text attachments never trigger a model swap.

## What images do NOT do

- They are **not** chunked or embedded. Vision works directly on pixels, not on a text representation.
- They are **not** included in [Citations and sources](./citations.md) — citation markers refer to text chunks only. The image's filename appears in the Sources footer as a non-citation chip so you can see what visual context was sent.
- They are **not** stored permanently as part of the chat unless the image came from your filesystem to begin with. Screenshot captures live in your temp directory and may be cleaned up by the OS on reboot.

## Related pages

- [Attaching files](./files.md)
- [Screenshot capture](../screenshots.md)
- [Choose a model](../getting-started/choose-a-model.md) — picking a vision-capable model
