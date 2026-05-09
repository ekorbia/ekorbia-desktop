# Searching chat history

Ekorbia indexes every message you've ever sent or received with full-text search. The search box at the top of the **History sidebar** is the way in.

<!-- TODO: screenshot of the sidebar with search active and message hits -->

## How it works

Start typing in the sidebar search box. After about 150 ms of idle time, Ekorbia searches across every message ever saved — both user and assistant — and shows ranked results below the title matches in a **Messages** section.

Each result row shows:

- The parent chat's title
- A three-line snippet of the matching message with the matched words highlighted
- A relevance ranking (best matches first, using BM25 scoring)

**Clicking a result** opens the parent chat with the same query terms highlighted in every message, so you can scan around the hit for context.

## Search syntax

The search is forgiving and tuned for natural typing:

- **Multi-word queries AND together** — `code review` finds messages containing both words
- **Prefix matching is automatic** — `interrog` matches "interrogation," "interrogating," etc.
- **Punctuation is ignored** — `it's` searches the same as `its`
- **Case-insensitive** — `Bug` and `bug` are equivalent

You don't need to learn any operators — type what you remember about the message and the relevant chats float to the top.

## Searching titles only

If you just want to find a chat by name (not by message body), the title-match results appear **above** the Messages section. Type a few characters of the title and the relevant chat appears at the top.

## When search results seem stale

In rare cases (e.g. after restoring from a backup, or after a database migration), the search index can drift out of sync with the messages. Ekorbia keeps the index in sync automatically via database triggers, but if you ever suspect it's stale:

- Close and reopen the app — the index is verified at startup
- If results still look wrong, file an issue

## Related pages

- [Edit and retry messages](./edit-and-retry.md) — both keep the search index consistent
- [The chat window](./composer.md)
