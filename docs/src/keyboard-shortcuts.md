# Keyboard shortcuts

Two kinds of shortcut in Ekorbia: **global** (work in any app) and **in-app** (work when Ekorbia is focused).

## Global shortcuts

Both global shortcuts are **customizable** in **Settings → General**.

| Default | Action |
|---|---|
| **⌘⇧Space** | Open the [quick-query overlay](./overlay.md) |
| **⌘⇧1** | Invoke macOS region [screenshot capture](./screenshots.md) → opens a new chat with the screenshot attached |

> **Pick combinations that don't collide with macOS** (notably `Cmd+Shift+3/4/5` for built-in screenshots) or other apps you use frequently.

## In the composer

| Shortcut | Action |
|---|---|
| **Enter** | Send the current message |
| **Shift+Enter** | Insert a newline (don't send) |
| **Esc** | Dismiss the composer's autocomplete / picker if one is open |

## In the overlay

| Shortcut | Action |
|---|---|
| **Enter** | Send the query |
| **Shift+Enter** | Insert a newline |
| **Esc** | Close the overlay without sending |

## In the main window

| Shortcut | Action |
|---|---|
| **Cmd+N** | New chat (same as the `+ New chat` button) |
| **Cmd+W** | Close the active tab |
| **Cmd+T** | Reopen the most recently closed tab (where supported) |
| **Cmd+,** | Open Settings |
| **Cmd+F** | Focus the search box in the History sidebar |

## In the History sidebar

| Shortcut | Action |
|---|---|
| **Enter** (in the search box) | Highlights all matches in the parent chat after clicking a hit |
| **Esc** (in the search box) | Clear the search |

## In a code block (in an assistant reply)

| Shortcut | Action |
|---|---|
| **(hover)** | Reveals the Copy button (and Save, on non-tool models) |

There are no keyboard shortcuts on individual code blocks — they're click-targets, not focusable.

## Onboarding tour

| Shortcut | Action |
|---|---|
| **Esc** | Skip the tour |
| **Enter** | Advance to the next slide |

## Hotkeys you cannot bind

A few combinations are reserved by macOS and can't be used as global hotkeys:

- `Cmd+Q`, `Cmd+W`, `Cmd+H`, `Cmd+M` — app-level controls
- `Cmd+Tab`, `Cmd+Space` (alone) — system switchers
- `Cmd+Shift+3`, `Cmd+Shift+4`, `Cmd+Shift+5` — macOS screenshot menu

Ekorbia will refuse to record any of these in the hotkey-capture field.

## Related pages

- [Settings](./settings.md) — for changing the global hotkeys
- [Quick-query overlay](./overlay.md)
- [Screenshot capture](./screenshots.md)
