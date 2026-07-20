# Watches

A **Watch** is an ambient background job that monitors something — a folder, an RSS feed, or a web page — and summarizes anything new to a notes file. Set one up and forget about it; Ekorbia polls in the background and writes a running log of summaries.

Open the **Watches** tab in the right sidebar to see your watches. Click **+ Configure** to create a new one, or the **pencil icon** on an existing row to edit it.

<!-- TODO: screenshot of the Watches panel with multiple watches running -->

## Recipes — the quick way to start

You don't have to know what "diff mode" or a CSS selector is to set up a watch. Click **+ Configure** (or use the cards shown when you have no watches yet) and pick a **recipe**:

- **Summarise new downloads** — watches your Downloads folder and summarizes PDFs, text, and Markdown as they arrive. It skips everything already there, so you don't get flooded with summaries of old files.
- **Watch a price** — tracks a product page and tells you when the price or stock changes.
- **Watch job listings** — follows a careers page and summarizes new postings.
- **Follow a blog or feed** — summarizes new posts from any RSS/Atom feed.
- **Custom watch** — start from a blank form.

A recipe just **pre-fills the watch form** — the right kind, a sensible summarization prompt, the polling cadence, and (for Downloads) the folder and a "skip existing files" cutoff. Review it, tweak anything you like, and click **Create**.

## Today digest

Above the activity feed, switch between **All** and **Today**. **Today** shows only the last 24 hours of activity. When there's something to talk about, a **Chat about today** button appears — click it to open a new chat seeded with the day's summaries, so you can ask "what changed across my watches today?" in one place.

## The three kinds of watch

| Kind | Polls | What it summarizes |
|---|---|---|
| **📁 Folder** | Every 30 s | New `.pdf` / `.txt` / `.md` files that land in the folder |
| **📡 RSS feed** | Every 10 min | Each previously-unseen entry in an RSS/Atom feed |
| **🌐 URL** | Every 30 min | Visible text content of a public web page — only when the text actually changes |

All three kinds share the same notes file, model, and (optional) summarization prompt. They differ only in what they watch and how they decide there's something new.

## Common settings for all watches

Every watch has:

- **Name** — what shows in the list (free-form)
- **Source** — the folder path, feed URL, or web URL
- **Model** — which model summarizes new events (defaults to your main chat model)
- **Summarization prompt** — optional system prompt; you can pick one of the included `*-Watcher` prompts or none
- **Notes file** — where summaries are appended (defaults to `~/Documents/Ekorbia/notes.md`)
- **Cadence** — how often to poll (in seconds)
- **Notify** — toggle for native OS notifications when new events arrive

## Folder watches

Point at a directory; Ekorbia scans it every 30 seconds for new files. For each new `.pdf`, `.txt`, or `.md`, it extracts text and summarizes via the configured model.

Files that already existed when the watch was created are **not** summarized — only new arrivals trigger summaries.

## RSS watches

Paste any RSS 1.0, RSS 2.0, or Atom feed URL. Ekorbia handles all three formats. For each previously-unseen entry, the summary is built from whichever of these is longest:

1. The `<content>` element
2. `<summary>` or `<description>`
3. The article body fetched from the entry's link (if the feed only ships a teaser)

That fallback to fetching the linked article is what makes RSS watches useful even on feeds that don't include full content.

**Click "Test"** before saving to see how many entries the feed currently exposes — catches typos before you commit.

## URL watches

Paste any public web URL. Ekorbia fetches the page, strips HTML to text, and **only summarizes when the visible text actually changes**. This makes URL watches ideal for:

- Release-note pages
- Changelogs
- Leaderboards
- Status pages
- Job listings
- Any page that updates occasionally and you don't want to keep refreshing

### Snapshot mode vs Diff mode

URL watches have two modes:

- **Snapshot** (default) — when the page changes, the whole new page goes to the model
- **Diff** — only the added/removed lines (unified diff, 3 lines of context) go to the model

**Diff mode** is the right choice when you mostly care about deltas — for a long-lived changelog, sending only what's changed since last poll keeps summaries tight and token costs low.

> **Diff mode's first fetch is always a snapshot.** There's no prior content to diff against on the very first poll, so the first summary is always a full-page snapshot. Subsequent polls produce diff-only summaries.

### Advanced: CSS selector

If a page has a lot of nav/footer/sidebar noise, you can specify a **CSS selector** in the watch form to narrow extraction to a sub-tree:

- `article`
- `main`
- `.post-content`
- `#changelog`

Anything matching the selector is extracted; everything else is ignored. If the selector matches nothing on a given poll, Ekorbia falls back to the whole page — a watch never silently dies from a typo.

## Per-watch cadence

Each watch has its own poll interval. The defaults are tuned to be reasonable for each kind, but you can change them in the form:

- Folder: `30` seconds (good for active dev folders)
- RSS: `600` seconds = 10 min
- URL: `1800` seconds = 30 min

There's a **Run now** button on each row that bypasses the cadence and polls immediately — useful when you don't want to wait.

## OS notifications

Toggle **Notify** in the watch form to get a native OS notification whenever new events arrive (macOS Notification Center). Multiple events from the same poll cycle are **coalesced** into a single banner ("5 new items from My Folder") rather than five separate alerts. Watches with notifications enabled show a 🔔 in the list.

On macOS the watch form shows a small inline explainer before macOS's permission dialog fires the first time, so you understand what you're granting.

## Editing a watch

Click the **pencil icon** between the on/off toggle and the trash icon on any watch row. The form opens pre-filled. Saving runs an **upsert** that preserves pipeline state (the URL's last-seen content, the RSS feed's seen-entry list, the next poll time) — so the next poll continues from where it left off rather than firing a baseline summary again.

## The activity feed

The Watches panel shows the activity feed below the watch list. Each entry shows:

- The watch's **kind glyph** (📁 / 📡 / 🌐)
- The source label
- The model that summarized
- Processing dots (animated when in flight)
- The full summary, inline (long ones truncate; click to expand)

## Chat with your notes

The **"Chat with notes"** button at the top of the Watches panel opens a new chat with the accumulated notes file injected as a system message. This is useful when you've collected dozens of summaries and want to ask cross-cutting questions like "what's been changing in the kubernetes docs this month?"

## Related pages

- [Prompts library](./prompts.md) — for picking a summarization prompt
- [Settings](./settings.md) — for default watch cadence and notes file path
