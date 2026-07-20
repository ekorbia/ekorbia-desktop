# Compare 2-3 models side-by-side

Sometimes you want to see how a few different models answer the same prompt — to pick the best opening for a creative piece, to sanity-check a tough question across a small + a large model, or just to learn how each model "thinks". Ekorbia's **compare mode** sends one message to 2 or 3 models in parallel and lets you keep the winner.

<!-- TODO: screenshot of the 3-column compare pane mid-stream -->

## How it works

A compare chat is a one-shot side-by-side experience:

1. You pick 2 or 3 models when you create the chat.
2. You send one message.
3. Each model streams its response into its own column, in parallel.
4. You click **✓ Keep this** on whichever response you like best.
5. The chat keeps the chosen response and switches to a normal chat with the picked model. The other responses are saved alongside, accessible later via the **▸ N alternatives** disclosure under the kept message.

That's the whole interaction. Compare mode is deliberately one user-turn — for ongoing back-and-forth, you'd want to commit to a model anyway, and we use the pick to do that.

## Starting a comparison

Click the **columns icon** (next to the lock icon for private chats) in the sidebar. A modal asks you to pick 2 or 3 models from your installed list. Hit **Done** and a new tab opens in compare mode — you'll see the Compare badge in the tab title.

<!-- TODO: screenshot of the model picker modal with 3 models checked -->

The new tab shows a hint listing your selected models and an empty composer. Type your prompt and hit Send — every model gets the same input simultaneously.

## During streaming

Each column has its own state:

- A **three-dot indicator** while the model is still loading or generating its first token. Different models load at different speeds — don't be surprised if column A starts streaming before column B even shows a first token.
- A **per-column Stop** button to cancel just that model's stream (the others keep going).
- A **Stop all** button at the top of the pane to cancel every in-flight stream.

Columns transition to "done" independently as they finish. A column that finishes early shows its **✓ Keep this** button while slower siblings are still streaming.

## Keeping a winner

When you find the response you want, click **✓ Keep this** on its column. Three things happen:

1. The chat transitions from compare mode to a normal single-model chat.
2. The kept model becomes this chat's active model. Any follow-up messages you send go to it alone (using the normal Composer).
3. The unpicked responses are preserved alongside the kept one. A small **▸ N alternatives** link appears under the kept message — click it to expand the other models' responses for comparison.

The next message you send goes to the kept model only. The comparison was one-shot; you've made your pick.

## Attaching prompts to a comparison

You can attach prompts from your [Prompts library](../prompts.md) to a compare chat the same way you would to a normal chat: open the prompts panel, click a prompt to attach it. The prompt becomes a system message that's prepended to all models' contexts, so every column receives the same prefix.

> **Attachments aren't supported in compare mode yet.** Files, folders, and the memory file are skipped for comparison sends. Prompts are the only context you can attach.

## What if a model errors?

Sometimes a column finishes with no content — the model might have been unloaded to free memory, an OS-level OOM may have killed the request, or the model was deleted between when you picked it and when you sent. The column will show an italic note explaining no response came back, and its **Keep this** button stays disabled (you can't keep an empty response). Pick one of the other columns instead, or close the tab and start over.

## Limitations to know about

- **One comparison per chat.** Once you pick a winner, the chat moves to normal mode. To compare again, start a new compare chat.
- **No file or folder attachments.** Prompts attach; file attachments don't (yet).
- **Compute cost.** All 2-3 models load and run on your machine. On the bundled engine, compare-mode runs the columns one after another (a single model is resident at a time), so a three-way compare is sequential by design. On other backends, picking models that together exceed your memory will also serialize as they swap in and out. For best results, keep the models modest in size.
- **Comparison data is preserved.** Even after you pick, the unpicked responses are kept in the database (and surfaced via the **▸ N alternatives** disclosure). Exporting the chat to Markdown or JSON includes them.

## Removing the compare chat from history

A compare chat appears in your sidebar history with a small **columns** icon next to the title (the same icon as the create button). Delete it like any other chat — click the × on its history row.
