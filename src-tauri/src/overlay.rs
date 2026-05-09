// SPDX-License-Identifier: MIT

//! Quick-query overlay window controls.
#![allow(clippy::needless_pass_by_value)]

//!
//! A second Tauri window (label = "overlay") is pre-created at startup and
//! kept hidden. The global hotkey ⌘⇧Space toggles its visibility — because
//! the webview is already booted, the window appears with no perceptible
//! delay. The window is frameless, transparent, always-on-top, and skips the
//! taskbar/dock so it behaves like Spotlight or Raycast.
//!
//! `toggle_overlay` is `pub(crate)` because the global-shortcut handler in
//! `lib.rs::run()` calls it directly. The other commands are JS-callable.
//!
//! Hotkey registry: we keep track of EVERY shortcut we register (overlay
//! toggle + screenshot capture) in a shared HOTKEY_REGISTRY so the
//! global-shortcut handler can dispatch on shortcut identity, and so a
//! re-register call can surgically unregister just the previous binding
//! for that slot rather than `unregister_all` (which would clobber the
//! other slot's hotkey).

use std::sync::{Mutex, OnceLock};
use tauri::{LogicalSize, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

/// One entry per logical hotkey slot. Add fields when you add slots.
#[derive(Default)]
pub(crate) struct HotkeyRegistry {
    pub overlay: Option<Shortcut>,
    pub screenshot: Option<Shortcut>,
}

static HOTKEY_REGISTRY: OnceLock<Mutex<HotkeyRegistry>> = OnceLock::new();

pub(crate) fn registry() -> &'static Mutex<HotkeyRegistry> {
    HOTKEY_REGISTRY.get_or_init(|| Mutex::new(HotkeyRegistry::default()))
}

/// Show the overlay (centred on the active monitor) or hide it if visible.
pub(crate) fn toggle_overlay(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    if window.is_visible()? {
        window.hide()?;
    } else {
        // Recenter on each show — the user might have moved displays or
        // resized the previous invocation's response area.
        window.center()?;
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

/// Hide the overlay window. Called by JS on ⎋ or after the user picks an
/// action. Cheaper than spinning up a JS-side window API just for hide.
#[tauri::command]
pub(crate) fn overlay_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("overlay") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resize the overlay window to (600, height). Used by the QuickQuery
/// component to grow when a response is streaming and shrink back when
/// the user dismisses.
#[tauri::command]
pub(crate) fn overlay_resize(app: tauri::AppHandle, height: u32) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("overlay") {
        w.set_size(LogicalSize::new(600.0, height as f64))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bring the main window to the foreground. Called by the overlay when the
/// user clicks "Send to main" so the imported chat is immediately visible.
/// The unminimize/show calls swallow errors because they fail benignly when
/// the window is already in the corresponding state.
#[tauri::command]
pub(crate) fn focus_main(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Replace the current quick-query hotkey with a user-supplied shortcut.
/// The string follows Tauri's `Shortcut::from_str` format — modifiers and
/// the final key joined by `+`, e.g. "Super+Shift+Space", "Alt+KeyN".
///
/// We surgically unregister only the PREVIOUS overlay-slot shortcut (not
/// every shortcut globally) so a re-register here doesn't clobber the
/// screenshot hotkey. The registry tracks each slot independently.
#[tauri::command]
pub(crate) fn register_hotkey(app: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    let parsed: Shortcut = shortcut
        .parse()
        .map_err(|e| format!("Invalid shortcut '{shortcut}': {e:?}"))?;
    let gs = app.global_shortcut();
    {
        let mut reg = registry().lock().map_err(|e| e.to_string())?;
        if let Some(prev) = reg.overlay {
            let _ = gs.unregister(prev);
        }
        gs.register(parsed)
            .map_err(|e| format!("Failed to register '{shortcut}': {e}"))?;
        reg.overlay = Some(parsed);
    }
    Ok(())
}

/// Replace the current screenshot-capture hotkey. Same shape as
/// `register_hotkey` but operates on the screenshot slot in the registry,
/// so the two hotkeys never step on each other's registrations.
#[tauri::command]
pub(crate) fn register_screenshot_hotkey(
    app: tauri::AppHandle,
    shortcut: String,
) -> Result<(), String> {
    let parsed: Shortcut = shortcut
        .parse()
        .map_err(|e| format!("Invalid shortcut '{shortcut}': {e:?}"))?;
    let gs = app.global_shortcut();
    {
        let mut reg = registry().lock().map_err(|e| e.to_string())?;
        if let Some(prev) = reg.screenshot {
            let _ = gs.unregister(prev);
        }
        gs.register(parsed)
            .map_err(|e| format!("Failed to register '{shortcut}': {e}"))?;
        reg.screenshot = Some(parsed);
    }
    Ok(())
}
