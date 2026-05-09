# Edit and retry messages

Two things rarely go right on the first try: the question you asked, and the answer you got. Ekorbia makes both fixable.

## Edit a user message

Every message you sent has a small **pencil icon** that appears when you hover over it. Click it to:

1. Pull the message text back into the composer for editing
2. Truncate the conversation from that point onward (everything after the edited message is removed)
3. Send the revised message to the model, which then re-answers from your new wording

This is the right move when you realize partway through that you phrased the question badly and the model has gone down the wrong path. Edit, resend, and the conversation effectively rewinds.

> **The full database stays consistent.** The truncated messages are removed from the chat, the full-text search index is updated to match, and there are no orphan rows. Re-editing the same message is fine.

## Retry an assistant message

The most recent assistant reply has a **retry icon** (a small circular arrow) on hover. Click it to regenerate the same reply from scratch using the same context and the same model.

Useful when:

- The model gave you a reasonable but not-quite-right answer and you want to roll the dice
- A streaming reply got cut off by network hiccup or you accidentally pressed Stop too early
- You want to compare two answers to the same question (copy the first, then retry)

The previous reply is replaced in-place — Ekorbia doesn't keep both. If you want to compare, copy the first reply to a scratchpad before retrying.

## What edit and retry do **not** do

- They don't preserve the previous reply alongside the new one
- They don't re-run any attached file's indexing — attachments are reused
- They don't change the active model — switch the model in the picker if you want a different one to answer

## Related pages

- [Streaming and the Stop button](./streaming-and-stop.md)
- [The chat window](./composer.md)
