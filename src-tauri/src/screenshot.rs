// SPDX-License-Identifier: MIT

//! Screenshot capture pipeline (Phase 5).
#![allow(clippy::needless_pass_by_value)]

//!
//! When the user presses the screenshot hotkey, we shell out to macOS's
//! built-in `screencapture -i` to bring up the native region selector
//! (the crosshair-and-drag UI). Once the user finishes selecting (or
//! captures a window via Space, or cancels via Escape), we:
//!   • If a file was written (user confirmed): bring the main window to
//!     the front and emit `screenshot:captured` with the temp file path.
//!     The UI handles the rest — opens a new chat tab, attaches the file,
//!     switches to a vision-capable model if needed, focuses the composer.
//!   • If no file was written (user cancelled): silent no-op.
//!
//! Why shell out to `screencapture` rather than calling the underlying
//! macOS APIs directly: `screencapture` is the OS-blessed UI for region
//! selection — same crosshair, same Space-to-window shortcut, same Escape
//! to cancel — that users already know from `Cmd+Shift+4`. Replicating
//! that UI would be a lot of work and the result would be worse than
//! "use the built-in tool".
//!
//! Threading: we run `screencapture` on a dedicated std::thread (not the
//! tokio async runtime) because it blocks until the user finishes their
//! selection, which could be minutes. Holding a tokio worker that long
//! is anti-social; a fresh thread costs essentially nothing and dies the
//! moment screencapture exits. We avoid adding `tokio::process` features
//! just for this since the work isn't actually async.

use crate::log::log_warn;
// `Emitter` and `Manager` are only referenced inside the macOS-gated
// `dispatch_capture` (it brings the main window forward and emits the
// `screenshot:captured` event). On Linux / Windows the dispatch fn is
// a one-line stub that never touches either trait — gate the import to
// match so clippy's `-D warnings` doesn't fail the cross-platform build.
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
const SCREENCAPTURE_BIN: &str = "/usr/sbin/screencapture";

/// Fire-and-forget: spawns a thread that runs `screencapture -i`, then
/// emits a Tauri event when (and if) a file was produced. Caller is the
/// global-shortcut handler in `lib.rs`; it doesn't await anything because
/// the user's selection UI runs entirely inside screencapture.
#[cfg(target_os = "macos")]
pub(crate) fn dispatch_capture(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        match capture_to_temp_sync() {
            Ok(Some(path)) => {
                // Bring the main window to the foreground so the user
                // sees their capture land in a new chat tab. The
                // unminimize/show pair swallows errors because they
                // fail benignly when the window is already shown.
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                if let Err(e) = app.emit("screenshot:captured", &path) {
                    log_warn!("emit screenshot:captured failed: {e}");
                }
            }
            Ok(None) => {
                // User cancelled (pressed Escape, or clicked outside the
                // capture area). Silent — no toast, no event. Same UX as
                // the system Cmd+Shift+4 cancel behaviour.
            }
            Err(e) => {
                log_warn!("screencapture error: {e}");
                let _ = app.emit("screenshot:failed", e);
            }
        }
    });
}

/// Run `screencapture -i -t png /tmp/...` and return:
///   • `Ok(Some(path))` when the file was written and is non-empty
///   • `Ok(None)` when the user cancelled (screencapture exits 0 with
///     no file written)
///   • `Err(_)` when the binary couldn't be spawned at all
///
/// macOS-only because screencapture(1) is macOS-only. Compiled out on
/// other targets; the dispatch handler is also cfg'd to macos.
#[cfg(target_os = "macos")]
fn capture_to_temp_sync() -> Result<Option<String>, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // Files in /tmp survive only until reboot, but more importantly the
    // attachment pipeline copies them into the chat's attachment store
    // on ingest — so we delete the temp file after ingestion (handled
    // in the UI, see screenshot_consumed below). If the user ignores
    // the captured screenshot entirely, the file lingers until either
    // explicit consumption or system reboot. Acceptable tradeoff vs.
    // hand-rolling a "delete after N minutes" scheduler.
    let path = std::env::temp_dir().join(format!("ekorbia-shot-{ts}.png"));
    let path_str = path.to_string_lossy().to_string();

    let status = std::process::Command::new(SCREENCAPTURE_BIN)
        .args(["-i", "-t", "png", path_str.as_str()])
        // No stdin/stdout/stderr capture — screencapture writes only to
        // the destination file; stderr is unused in -i mode.
        .status()
        .map_err(|e| format!("spawn screencapture: {e}"))?;

    // screencapture returns 0 even on user-cancel. The real "did we get
    // anything" check is whether the destination file exists and has
    // content. Logging non-success status keeps a trail if a future
    // macOS update changes this behaviour.
    if !status.success() {
        log_warn!("screencapture returned non-zero status: {status}");
    }

    match std::fs::metadata(&path) {
        Ok(m) if m.len() > 0 => Ok(Some(path_str)),
        _ => Ok(None),
    }
}

/// Best-effort cleanup of a captured temp file after the UI has handed
/// it to the attachment pipeline. The pipeline writes its own copy into
/// the chat's attachment storage, so the /tmp file is redundant once
/// attached. Errors are swallowed — the file is in /tmp and will be
/// reclaimed on reboot if nothing else.
#[tauri::command]
pub(crate) fn screenshot_consumed(path: String) -> Result<(), String> {
    // Defensive: only delete files that look like ours, in case JS gets
    // confused and sends an arbitrary path. Pattern: `<tmp>/ekorbia-shot-`
    // prefix and `.png` suffix. Anything else is silently ignored.
    let tmp = std::env::temp_dir();
    let p = std::path::Path::new(&path);
    let parent_ok = p.parent().is_some_and(|x| x == tmp);
    let name_ok = p
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("ekorbia-shot-") && n.ends_with(".png"));
    if parent_ok && name_ok {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

// Stubs for non-macOS targets so the rest of the codebase compiles
// cleanly when someone tries `cargo check` on a non-mac dev machine.
// In practice the app is macOS-only for the near future, but cheap
// stubs make the gate a one-line change later.

#[cfg(not(target_os = "macos"))]
pub(crate) fn dispatch_capture(_app: tauri::AppHandle) {
    log_warn!("screencapture is macOS-only");
}
