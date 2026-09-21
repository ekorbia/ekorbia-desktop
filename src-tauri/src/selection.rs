// SPDX-License-Identifier: MIT

//! Selection actions — clipboard capture for the quick-query overlay.
#![allow(clippy::needless_pass_by_value)]

//!
//! The user copies text in any app (⌘C), presses the selection hotkey, and
//! the overlay opens with that text ready for a local model to act on —
//! summarize, rewrite, fix grammar, explain, or whatever instruction they
//! type.
//!
//! Why the clipboard rather than reading the selection directly: reading
//! `AXSelectedText` out of the frontmost app requires the Accessibility
//! (TCC) permission, whose grant is tied to the app's code signature — on
//! an ad-hoc-signed build like this one it silently lapses on rebuild, the
//! same way the microphone grant does. It also has uneven coverage (many
//! custom and Electron views expose nothing), so it needs a synthesized-⌘C
//! fallback that briefly clobbers the user's clipboard. Reading what the
//! user themselves copied costs one extra keystroke and needs no permission
//! at all, works in every app including the ones Accessibility can't see,
//! and never touches the clipboard except to read it. Auto-capture can be
//! layered on later as an opt-in that degrades to this path.
//!
//! Threading mirrors `screenshot.rs`: the global-shortcut handler spawns a
//! thread rather than shelling out on the UI thread. `pbpaste` returns in
//! milliseconds for ordinary text, but the clipboard is user-controlled and
//! can hold megabytes; a stalled read must not freeze the app.

use crate::log::log_warn;
// Both traits are only used inside the macOS-gated dispatch (it shows the
// overlay and emits the capture event). The non-macOS stub touches neither,
// so gate the import to match or clippy's `-D warnings` fails that build.
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
const PBPASTE_BIN: &str = "/usr/bin/pbpaste";

// A note on the `cfg_attr(not(target_os = "macos"), allow(dead_code))`
// markers below: the only non-test caller of the clamp and its payload is the
// macOS-gated `dispatch_selection`, so on Windows and Linux the plain lib
// build sees all three as dead code — and CI builds every platform with
// `-D warnings`. They are annotated rather than cfg-gated away so the unit
// tests below stay platform-neutral and keep running on every CI leg; the
// allow is scoped to non-macOS so the macOS build still catches REAL dead
// code. Same arrangement, same reasoning, as the unix-only spawn helpers in
// `engine/mod.rs`. A local macOS `cargo clippy` CANNOT see this class of
// failure — anything reachable only from a `#[cfg(target_os = "macos")]` item
// needs one of these markers.

/// Upper bound on the characters handed to the overlay.
///
/// The bundled engine pins its chat context to 8192 tokens (see
/// `engine::CHAT_CTX`); at the usual ~4 characters per token, 12k characters
/// is roughly 3k tokens — a large selection still leaves the model room to
/// answer, and the request fails in the UI rather than being silently
/// truncated by the server. Selections this long are rare in practice.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // read only via clamp_selection
pub(crate) const MAX_SELECTION_CHARS: usize = 12_000;

/// Payload for the `selection:captured` event.
///
/// `chars` is the length of what the user actually copied, not of `text` —
/// when `truncated` is set, `text` carries the elision marker and is
/// therefore a different length. The overlay reports the original count so
/// "8,000 of 41,312 characters" stays truthful.
#[derive(Clone, serde::Serialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // built only by clamp_selection
pub(crate) struct SelectionPayload {
    pub text: String,
    pub chars: usize,
    pub truncated: bool,
}

/// Trim, reject empty, and clamp an over-long selection to
/// `MAX_SELECTION_CHARS`.
///
/// Truncation keeps the head and the tail and elides the middle: the opening
/// states the topic and the closing usually carries the ask, while the middle
/// of a long document is the most expendable part. Everything is sliced on
/// `chars()` boundaries, never bytes — a clipboard full of emoji or CJK text
/// would panic a naive `&s[..n]`.
///
/// Returns `None` for a clipboard holding nothing but whitespace (or no text
/// at all), which the caller reports as an empty capture rather than sending
/// a blank request to a model.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // called only by the macOS dispatch
pub(crate) fn clamp_selection(raw: &str) -> Option<SelectionPayload> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    let chars = text.chars().count();
    if chars <= MAX_SELECTION_CHARS {
        return Some(SelectionPayload {
            text: text.to_string(),
            chars,
            truncated: false,
        });
    }
    let head_len = MAX_SELECTION_CHARS * 2 / 3;
    let tail_len = MAX_SELECTION_CHARS - head_len;
    let head: String = text.chars().take(head_len).collect();
    let tail: String = text.chars().skip(chars - tail_len).collect();
    let omitted = chars - head_len - tail_len;
    Some(SelectionPayload {
        text: format!("{head}\n\n[… {omitted} characters omitted …]\n\n{tail}"),
        chars,
        truncated: true,
    })
}

/// Read the clipboard's text flavour via `pbpaste`.
///
/// Shelling out keeps this dependency-free and matches how `screenshot.rs`
/// reaches `screencapture`. `pbpaste` with no arguments asks for text only,
/// so a clipboard holding an image or a file promise comes back empty — which
/// `clamp_selection` turns into the same "nothing to act on" state as a blank
/// clipboard, exactly right for this feature.
#[cfg(target_os = "macos")]
fn read_clipboard_sync() -> Result<String, String> {
    let out = std::process::Command::new(PBPASTE_BIN)
        .output()
        .map_err(|e| format!("spawn pbpaste: {e}"))?;
    if !out.status.success() {
        return Err(format!("pbpaste returned {}", out.status));
    }
    // The clipboard is arbitrary user data and need not be valid UTF-8
    // (a stray Latin-1 paste, say). Lossy conversion keeps the readable
    // part instead of discarding the whole capture over one bad byte.
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Fire-and-forget: show the overlay, then hand it whatever text the
/// clipboard holds.
///
/// Ordering is load-bearing. The overlay resets its query state on window
/// `focus` (see the focus effect in `ui/overlay.jsx`), so the window must be
/// shown and focused BEFORE the capture event is emitted — otherwise a late
/// focus could wipe the selection we just delivered. The overlay's selection
/// state is deliberately excluded from that reset for the same reason the
/// voice hotkey's start signal is: a counter or payload the reset doesn't
/// touch survives the race either way.
///
/// An empty clipboard still shows the overlay and emits `selection:empty`.
/// Doing nothing at all would be indistinguishable from a broken hotkey.
#[cfg(target_os = "macos")]
pub(crate) fn dispatch_selection(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let Some(window) = app.get_webview_window("overlay") else {
            return;
        };
        match window.is_visible() {
            Ok(false) => {
                let _ = window.center();
                let _ = window.show();
            }
            Ok(true) => {}
            Err(e) => log_warn!("overlay is_visible failed: {e}"),
        }
        let _ = window.set_focus();

        let raw = match read_clipboard_sync() {
            Ok(s) => s,
            Err(e) => {
                log_warn!("clipboard read failed: {e}");
                String::new()
            }
        };
        match clamp_selection(&raw) {
            Some(payload) => {
                if let Err(e) = window.emit("selection:captured", payload) {
                    log_warn!("emit selection:captured failed: {e}");
                }
            }
            None => {
                let _ = window.emit("selection:empty", ());
            }
        }
    });
}

// Stub for non-macOS targets. Selection actions are macOS-first: the
// clipboard read is `pbpaste`, and the hotkey slot is never registered
// off macOS (see lib.rs), so this is unreachable rather than merely
// unused — it exists so the module compiles everywhere.
#[cfg(not(target_os = "macos"))]
pub(crate) fn dispatch_selection(_app: tauri::AppHandle) {
    log_warn!("selection capture is macOS-only");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_trims_and_reports_length() {
        let p = clamp_selection("  hello world  ").expect("some");
        assert_eq!(p.text, "hello world");
        assert_eq!(p.chars, 11);
        assert!(!p.truncated);
    }

    #[test]
    fn clamp_rejects_blank_clipboard() {
        assert!(clamp_selection("").is_none());
        assert!(clamp_selection("   \n\t  ").is_none());
    }

    #[test]
    fn clamp_elides_the_middle_of_an_over_long_selection() {
        let head = "A".repeat(MAX_SELECTION_CHARS);
        let tail = "Z".repeat(500);
        let p = clamp_selection(&format!("{head}{tail}")).expect("some");
        assert!(p.truncated);
        // chars reports the ORIGINAL length, not the elided text's.
        assert_eq!(p.chars, MAX_SELECTION_CHARS + 500);
        assert!(p.text.starts_with("AAA"));
        assert!(p.text.ends_with("ZZZ"));
        assert!(p.text.contains("characters omitted"));
    }

    #[test]
    fn clamp_slices_multibyte_text_on_char_boundaries() {
        // Every char here is 4 bytes, so a byte-indexed slice would panic.
        let p = clamp_selection(&"🙂".repeat(MAX_SELECTION_CHARS + 10)).expect("some");
        assert!(p.truncated);
        assert_eq!(p.chars, MAX_SELECTION_CHARS + 10);
        assert!(p.text.starts_with('🙂'));
        assert!(p.text.ends_with('🙂'));
    }

    #[test]
    fn clamp_passes_through_at_exactly_the_cap() {
        let s = "x".repeat(MAX_SELECTION_CHARS);
        let p = clamp_selection(&s).expect("some");
        assert!(!p.truncated);
        assert_eq!(p.text.chars().count(), MAX_SELECTION_CHARS);
    }
}
