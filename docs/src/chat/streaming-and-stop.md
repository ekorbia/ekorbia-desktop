# Streaming and the Stop button

When you send a message in Ekorbia, the model's reply **streams in token-by-token** rather than appearing all at once. You see the response forming live, which is helpful for two reasons: you can start reading early, and you can interrupt it cleanly if it's heading the wrong direction.

## Stopping a streaming reply

While a reply is streaming, the **Send** button in the composer turns into a **Stop** button. Click it (or press the keyboard shortcut shown on hover) to halt generation immediately.

When you stop:

- Whatever was generated up to the cut-off point is kept and saved
- The partial message is marked as **`Stopped`** in the assistant's response so you can see exactly where it was interrupted
- The conversation history stays consistent — no orphan rows, no half-saved tool calls

> **Stopping is non-destructive.** You can edit the user message and resend, retry the assistant message to regenerate, or just keep going — the stopped reply is preserved as if the model had ended there on its own.

## What happens behind the scenes

Ekorbia streams tokens from the model as they're produced. Each chunk is rendered into the UI as soon as it arrives, with Markdown re-parsed on every chunk so headings, lists, and code blocks render correctly while the reply is still being written.

If your model supports **tool calls** (the `TOOL` badge on the model picker), tool calls only arrive in the final chunk of a turn — they aren't streamed progressively. The visible token stream pauses briefly between the model's text and the tool invocation, which is normal.

## Related pages

- [Edit and retry messages](./edit-and-retry.md) — for what to do with a stopped reply
- [Saving files from chat](../saving-files-from-chat.md) — when tool calls produce file writes
