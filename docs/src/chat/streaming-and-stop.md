# Streaming and the Stop button

When you send a message in Ekorbia, the model's reply **streams in token-by-token** rather than appearing all at once. You see the response forming live, which is helpful for two reasons: you can start reading early, and you can interrupt it cleanly if it's heading the wrong direction.

## Stopping a streaming reply

While a reply is streaming, the **Send** button in the composer turns into a **Stop** button. Click it (or press the keyboard shortcut shown on hover) to halt generation immediately.

When you stop:

- Whatever was generated up to the cut-off point is kept and saved
- The partial message is marked as **`Stopped`** in the assistant's response so you can see exactly where it was interrupted
- The conversation history stays consistent — no orphan rows, no half-saved tool calls

> **Stopping is non-destructive.** You can edit the user message and resend, retry the assistant message to regenerate, or just keep going — the stopped reply is preserved as if the model had ended there on its own.

## When a reply hits the length limit

Sometimes a reply ends mid-sentence not because you stopped it, but because the model ran out of room — every model has a limit on how much it can hold in one exchange. When that happens, Ekorbia shows **`Reply hit the length limit`** under the message with a **Continue →** button.

Click **Continue** and the model picks up where it left off, as a new reply in the same conversation. Behind the scenes Ekorbia narrows what it re-sends to just the last exchange, so continuing works even when the conversation itself is what filled the model's memory.

The chip only appears on the newest reply — once you've continued (or sent anything else), it retires.

## When a message is too long for the model

A model's memory for one exchange — its **context window** — holds your message, the earlier conversation, and the reply, all at once. With the bundled engine that's about 32,000 tokens, roughly 100,000 characters of ordinary English.

If a message won't fit with room left for a reply, Ekorbia doesn't send it. A note explains how big the message is next to what the model can hold, and your text stays in the composer so you can shorten it or split it up. If the conversation as a whole has grown too long, start a new chat.

On other backends, Ekorbia can't check ahead of time, so the server refuses the message instead. The reply then shows the same plain-language explanation.

> **Very long messages take a while to start.** The model reads the whole message before it writes anything. A paste of several thousand words can take most of a minute on many Macs. Follow-up messages are usually quick, because the model keeps what it has already read.

## What happens behind the scenes

Ekorbia streams tokens from the model as they're produced. Each chunk is rendered into the UI as soon as it arrives, with Markdown re-parsed on every chunk so headings, lists, and code blocks render correctly while the reply is still being written.

If your model supports **tool calls** (the `TOOL` badge on the model picker), tool calls only arrive in the final chunk of a turn — they aren't streamed progressively. The visible token stream pauses briefly between the model's text and the tool invocation, which is normal.

## Related pages

- [Edit and retry messages](./edit-and-retry.md) — for what to do with a stopped reply
- [Saving files from chat](../saving-files-from-chat.md) — when tool calls produce file writes
