# Spaces — workspaces for related chats

A **Space** is a named workspace that bundles everything a related body of work needs in one place: a default model, optional pinned files and folders, optional pinned prompts (some of which can be **locked** so they're always attached and can't be detached per chat), and an optional Space-scoped memory file. New chats created inside a Space inherit all of those automatically — so you stop re-attaching the same folder to every "novel" chat, stop re-pinning the same framing prompt to every "therapy notes" chat, and have one place where every conversation on a project lives.

<!-- TODO: screenshot of the sidebar with a few Spaces created -->

## Why use Spaces

Use a Space when you have a coherent body of work that crosses multiple chats:

- **Writing a novel** — pin your style guide, character sheets, and an outline folder; lock a "noir framing" prompt so every new chat opens with that voice baked in; every new chat in this Space starts with all that context.
- **Job hunt** — pin your resume and a folder of job descriptions; pre-attach your "cover letter writer" prompt; pick a vision-capable default model so screenshots of postings work.
- **Therapy / journaling** — set up a private Space-scoped memory file the model sees on every send; lock a "tone reframer" prompt so it can't be removed by accident; pick a small, fast local model.
- **Project planning** — pin a folder of design docs; pre-attach your "brainstorm" and "devil's advocate" prompts; set a Space memory file with project constraints.

Chats that don't belong to any Space still work exactly as before — Spaces are opt-in. The default **All chats** view shows everything, in or out of a Space.

## Creating a Space

Look at the top of the sidebar. The **Spaces** section shows the **All chats** pseudo-row and a dashed **+ New Space** button. Click it. A small modal asks for a name and a color — type the name (any text), pick a swatch (or the ∅ to skip color), and click **Create**.

Your new Space appears in the sidebar and becomes active immediately. The chat list narrows to just chats in this Space (empty for a fresh Space — every chat you've ever had still exists, they're just under **All chats**).

## Filtering by Space

Click any Space row in the sidebar to **activate** that Space:

- The chat list narrows to chats filed into this Space.
- The Space row gets a left-edge accent bar in its color.
- **+ New chat** creates a chat inside this Space.
- The **lock** icon (private chat) is hidden — private chats and Space context don't mix because the Space's whole point is persistent context.

Click **All chats** to deactivate and see your full history. Ekorbia remembers your active Space across launches, so you'll land back where you left off.

## Editing a Space

Hover any Space row to reveal a **⋯** overflow button. Click it:

- **Edit settings…** — opens the full Space-settings dialog (see below).
- **Rename Space** — change the display name (the URL-safe slug stays pinned so disk paths don't move out from under you).
- **Change color…** — pick a new palette swatch.
- **Delete Space** — removes the Space row. Chats stay — they just move back to **All chats**.

## The Space settings dialog

The big one. Five sections, all editable in one place:

### 1. Name + Color

Top of the dialog. Rename freely; color picks from the seven-swatch palette (Amber / Yellow / Green / Teal / Blue / Purple / Red) or ∅ for no color.

### 2. Default model

A text input. Type a model id (e.g. `gemma4:latest`) and every new chat in this Space will start with that model selected. Leave it empty to inherit your global default-model preference.

### 3. Memory file

Each Space can optionally have its **own** `memory.md` file, separate from the global one. Both are injected as system messages on **every send** (not just the first), so you can edit them mid-conversation and the next turn reflects the change.

Four buttons:

- **Browse…** — picks any `.md` file you want to use. Suggested path is `~/Documents/Ekorbia/Spaces/<slug>/memory.md`.
- **Edit** — opens the file in your OS default editor. If the file doesn't exist yet, Ekorbia creates it (with a small starter template) at the suggested path. Sets the path on the row so you don't lose it on cancel.
- **Reveal** — shows the file in Finder / Explorer / your file manager.
- **Clear** — removes the path from the Space (the file on disk stays untouched; you can re-pick it later).

The Space memory injects **after** the global memory file, so it overlays project-specific context on top of your stable user facts. Inside the prompt, it's wrapped as:

```
<user_memory>
… your global memory …
</user_memory>
<space_memory>
… this Space's memory …
</space_memory>
```

> Note: in **compare mode**, neither global memory nor Space memory is currently injected — compare-mode sends are simpler by design. That parity may change in a future release.

### 4. Pinned prompts

A chip strip showing every prompt in your library. Click a chip to toggle pinning. Pinned prompts get the amber tint. Whatever's pinned here will be **auto-attached** to every new chat you create in this Space — saving you the slash-trigger step in the composer.

#### Locking a pinned prompt

Pinned chips show a small **lock icon** at their right edge. Click the lock to **lock** the pin:

- A locked pin is **always attached** to new chats in this Space (same as an unlocked pin), AND
- In the composer's prompt-chip strip on every chat in this Space, the chip's **×** detach button is **suppressed** — the lock glyph replaces it. Locked pins can't be removed per-chat; the user has to come back to Space settings and unlock them.

Lock the prompts you genuinely want enforced for the project's framing — the kind of context where "removing it just for this chat" would mean the chat stops belonging to the Space's purpose. Leave the rest unlocked so they're still *attached by default* but the user can detach them on a per-chat basis when something doesn't fit.

> Locked pins still surface as chips on the user's own messages in the transcript — so anyone reading the chat back later sees exactly which prompts were in force at send time. (For now, the chip carries the prompt *name*; the body isn't snapshotted into the chat itself.)

#### "+ New prompt for this Space"

Below the chip strip is a dashed **+ New prompt for this Space** button. Click it to inline-author a new prompt right from the dialog:

- A small form opens with **Name** (pre-filled to `"<Space name> framing"`) and **Body** fields.
- Click **Save & pin** to write the prompt to your library and auto-pin **and** auto-lock it for this Space in one shot.
- Click **Cancel** to discard.

This is the fast path for "I want to write a custom framing prompt and force it on every chat in this project." The prompt lives in the regular library (it's a normal `.md` file under your Prompts folder) — it's just bootstrapped with the Space already pre-locked. You can later edit, rename, or delete it like any other library prompt.

You can still attach or detach unlocked prompts per-chat via the composer's slash-picker; the Space's pinned set is just the *starting* set for new chats. Removing an unlocked pinned prompt from a chat doesn't unpin it from the Space.

### 5. Pinned attachments

**Add file…** and **Add folder…** buttons open the usual file pickers; what you pick gets pinned to the Space. Every new chat in this Space will have those attachments instantiated automatically — small files inlined, large files chunked, folders walked + indexed with the embedding model — using the exact same pipeline as the composer's paperclip / folder buttons.

The list shows each pinned attachment with its kind (`FILE` / `FOLDER`) and path. Click the **×** on a row to remove a pin. Removing a pin doesn't touch chats that were already created — they keep their copies.

Click **Save** to apply everything; **Cancel** discards every change. Both buttons close the dialog.

## Moving an existing chat into a Space

Right-click any chat in the sidebar. The context menu now has a **Move to Space →** submenu listing every Space you've created plus a **(none)** option to remove a chat from its Space. Pick where you want it; the chat moves immediately and (if the new Space is active) appears in the filtered view.

You can also move a chat *out* of a Space by activating the destination Space (or All chats), right-clicking, and picking **(none)** — same flow.

## Where things live on disk

- The list of Spaces, the pinned-attachment list, and the pinned-prompt list all live in the same SQLite database as your chats (`ekorbia.db` in your app data directory).
- Pinned **file paths** are stored as-is — Ekorbia doesn't copy or move the files themselves. If you move a pinned file off disk, new chats in the Space will toast a warning at instantiation; existing chats keep working.
- Pinned **prompt slugs** reference your prompt library by filename. Deleting the underlying `.md` from your prompts folder silently drops the pin (the row stays in the DB but read-time filtering skips it).
- The **Space memory file** is wherever you set it via Browse / Edit. The default location is `~/Documents/Ekorbia/Spaces/<slug>/memory.md`, but it can be anywhere you choose.

## What's deferred

Two things in the Space model are kept simple in this release:

- **Pinned watches** — a Space can't yet own watches the way it owns prompts and attachments. Plan to add this once the use-case shape clarifies; for now, watches are global.
- **Drag-reorder pinned prompts** — pin order is the order you toggled the chips on. Reordering manually is on the roadmap.
