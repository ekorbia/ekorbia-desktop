// SPDX-License-Identifier: MIT

//! Ekorbia — Tauri v2 entry point.
//!
//! This file does three things and three things only:
//! 1. Declares the module tree (everything else lives in `src/<domain>.rs`
//!    or `src/<domain>/<file>.rs`).
//! 2. Registers Tauri plugins and the `invoke_handler` command list.
//! 3. Runs the `setup` callback — DB open + idempotent migrations,
//!    background watch poller, global hotkey, overlay vibrancy.
//!
//! Domain modules:
//! - `db`            — DbState, SCHEMA, `now_unix`, `get_setting`/`set_setting`
//! - `text_extract`  — shared PDF/text extraction
//! - `chat`          — chat + message persistence commands
//! - `spaces`        — Spaces (workspace bundles): system prompt, default model, pinned attachments, pinned prompts, optional memory file
//! - `search`        — FTS5 chat search
//! - `prompts`       — file-system prompt store + commands
//! - `settings`      — generic `setting_get`/`setting_set`
//! - `ollama`        — process startup, `/api/chat`, `/api/embed`, vision capability
//! - `overlay`       — overlay window + hotkey commands
//! - `attachments::` — types, config, cancel registry, pipeline, folder, commands
//! - `watch::`       — types, commands, pipeline, folder/rss/url runners, HTTP
//! - `files::`       — sandbox + write_file tool execution + chat_files commands

mod attachments;
mod chat;
mod db;
mod files;
mod log;
mod memory;
mod ollama;
mod overlay;
mod prompts;
mod screenshot;
mod search;
mod settings;
mod spaces;
mod system;
mod text_extract;
// Voice input is macOS-only — it depends on cpal + whisper-rs, which are
// macOS-gated in Cargo.toml (cpal pulls in alsa-sys on Linux). Keep this
// `cfg` in lockstep with the command registrations + setup() default below.
#[cfg(target_os = "macos")]
mod voice;
mod watch;

use crate::log::{log_info, log_warn};
use rusqlite::Connection;
use std::sync::Mutex;
use tauri::Manager;
// `Code` and `Modifiers` are only referenced by the platform-gated default
// hotkey registrations below — on Linux both default hotkeys are skipped so
// neither symbol is touched, and clippy's `-D warnings` would fail the
// build on an unused import. Gate the import to match.
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri_plugin_global_shortcut::{Code, Modifiers};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
// Vibrancy backends differ per platform: NSVisualEffectView on macOS, Mica
// (preferred, Win11) or Acrylic (fallback, Win10) on Windows. The
// `window-vibrancy` crate gates these per cfg internally too — we just
// import the symbols we use on each platform so unused-import warnings
// stay quiet. Linux has no per-window blur primitive that works across
// compositors, so the overlay there falls back to its CSS-tinted bg.
#[cfg(target_os = "windows")]
use window_vibrancy::{apply_acrylic, apply_mica};
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

use crate::db::{apply_migrations, DbState, SCHEMA};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Native file/folder pickers for the Watch modal's path fields.
        .plugin(tauri_plugin_dialog::init())
        // OS-native notifications for watch events (macOS Notification Center,
        // Linux libnotify via D-Bus, Windows WinToast). Permission is requested
        // lazily — the first time a watch with `notify=true` is about to fire.
        .plugin(tauri_plugin_notification::init())
        // Global hotkey plumbing. The handler fires on press/release for every
        // registered shortcut; we discriminate by state and by shortcut
        // identity. The HOTKEY_REGISTRY in overlay.rs tracks which Shortcut
        // belongs to which logical slot (overlay toggle vs. screenshot
        // capture) so we route correctly even after the user re-binds.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let Ok(reg) = overlay::registry().lock() else { return };
                    if reg.overlay.as_ref() == Some(shortcut) {
                        let _ = overlay::toggle_overlay(app);
                    } else if reg.screenshot.as_ref() == Some(shortcut) {
                        // Drop the registry lock before dispatching the
                        // capture — dispatch_capture spawns a thread that
                        // may want the AppHandle, and we don't need to
                        // hold the lock through that thread's lifetime.
                        drop(reg);
                        screenshot::dispatch_capture(app.clone());
                    } else if reg.voice.as_ref() == Some(shortcut) {
                        drop(reg);
                        let _ = overlay::start_voice_query(app);
                    }
                })
                .build(),
        )
        // ── Window close behaviour ──────────────────────────────────────
        //
        // The overlay window in tauri.conf.json is always created but
        // kept hidden (visible: false) — it's the Spotlight-style
        // quick-query panel summoned via the global hotkey. Tauri's
        // default "exit when all windows close" rule on Windows + Linux
        // counts the hidden overlay as a live window, so closing the
        // main window leaves the process running in the background
        // (Task Manager shows a "ghost" ekorbia.exe with no visible UI).
        //
        // On macOS the platform convention is exactly the opposite —
        // closing the main window should leave the app running so the
        // Dock icon stays; the user quits via Cmd+Q.
        //
        // Resolution: when the main window is asked to close, we explicitly
        // call exit(0) on Windows + Linux to match user expectations, and
        // do nothing on macOS to preserve the dock-stays-alive convention.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    #[cfg(not(target_os = "macos"))]
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ollama::start_ollama,
            ollama::ollama_tags,
            ollama::ollama_ps,
            ollama::ollama_generate,
            ollama::ollama_chat_stream,
            ollama::ollama_chat_stream_cancel,
            ollama::ollama_pull,
            ollama::ollama_pull_cancel,
            ollama::ollama_delete,
            system::system_profile,
            // Voice commands — macOS only (see `mod voice`). generate_handler!
            // honours per-entry cfg attributes, so on Linux/Windows these are
            // dropped and the `voice` module isn't compiled at all.
            #[cfg(target_os = "macos")]
            voice::voice_models_installed,
            #[cfg(target_os = "macos")]
            voice::voice_model_download,
            #[cfg(target_os = "macos")]
            voice::voice_model_download_cancel,
            #[cfg(target_os = "macos")]
            voice::voice_model_delete,
            #[cfg(target_os = "macos")]
            voice::voice_record_start,
            #[cfg(target_os = "macos")]
            voice::voice_record_stop,
            #[cfg(target_os = "macos")]
            voice::voice_record_cancel,
            #[cfg(target_os = "macos")]
            voice::voice_prewarm,
            overlay::overlay_hide,
            overlay::overlay_resize,
            overlay::focus_main,
            overlay::register_hotkey,
            overlay::register_screenshot_hotkey,
            overlay::register_voice_hotkey,
            screenshot::screenshot_consumed,
            chat::db_load_chats,
            chat::db_load_messages,
            chat::db_upsert_chat,
            chat::db_upsert_message,
            chat::db_delete_chat,
            chat::db_clear_all_chats,
            chat::db_truncate_chat_from,
            chat::chat_export_to_path,
            spaces::space_list,
            spaces::space_get,
            spaces::space_create,
            spaces::space_update,
            spaces::space_delete,
            spaces::space_reorder,
            spaces::db_move_chat_to_space,
            spaces::space_attachments_list,
            spaces::space_attachment_add,
            spaces::space_attachment_remove,
            spaces::space_prompts_list,
            spaces::space_prompt_add,
            spaces::space_prompt_set_locked,
            spaces::space_prompt_remove,
            spaces::space_prompt_reorder,
            search::search_chats,
            attachments::commands::attachment_list,
            attachments::commands::attachment_add_files,
            attachments::folder::attachment_add_folder,
            attachments::commands::attachment_remove,
            attachments::commands::attachment_reveal,
            attachments::commands::attachment_hit_open,
            attachments::commands::attachment_prepare_for_send,
            attachments::pipeline::attachment_reindex,
            attachments::commands::attachment_reindex_stale,
            ollama::embedding_model_check,
            attachments::commands::embedding_stale_count,
            settings::setting_get,
            settings::setting_set,
            ollama::model_capabilities,
            prompts::prompts_dir_get,
            prompts::prompts_dir_set,
            prompts::prompts_dir_reveal,
            prompts::prompts_list,
            prompts::prompts_save,
            prompts::prompts_delete,
            prompts::prompts_meta_set,
            prompts::prompts_seed_builtins,
            prompts::prompts_restore_builtins,
            watch::commands::watch_list,
            watch::commands::watch_create,
            watch::commands::watch_delete,
            watch::commands::watch_set_enabled,
            watch::commands::watch_events_list,
            watch::commands::watch_run_once,
            watch::commands::watch_run_one,
            watch::commands::watch_test_source,
            watch::commands::watch_notes_read,
            watch::commands::watch_default_paths,
            files::commands::chat_set_output_dir,
            files::commands::chat_output_dir,
            files::commands::chat_files_list,
            files::commands::chat_file_path,
            files::commands::chat_file_open,
            files::commands::chat_file_reveal,
            files::commands::chat_output_dir_reveal,
            files::tools::chat_tool_schemas,
            files::tools::default_output_dir_for_chat,
            files::tools::tool_write_file,
            files::tools::chat_save_manual_file,
            memory::memory_info,
            memory::memory_read,
            memory::memory_set_path,
            memory::memory_open,
            memory::space_memory_read,
            memory::space_memory_open,
        ])
        .setup(|app| {
            let win = app
                .get_webview_window("main")
                .expect("main webview window missing from tauri.conf.json");
            win.set_title("Ekorbia — Local AI Desktop")?;

            // Open (or create) the SQLite database in the app data directory
            let data_dir = app.path().app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("ekorbia.db");
            let conn = Connection::open(&db_path)
                .expect("failed to open SQLite database");
            conn.execute_batch(SCHEMA)
                .expect("failed to initialize database schema");

            // Column-add migrations for upgraded installs. SCHEMA uses
            // CREATE TABLE IF NOT EXISTS, which is a no-op on existing
            // tables — so any column added to SCHEMA in a later release
            // never lands on a pre-existing user DB. apply_migrations is
            // idempotent (PRAGMA-introspection per column) so fresh
            // installs no-op through it and upgraded installs converge
            // on the same final shape. See db.rs::apply_migrations for
            // the full migration list and the rule on where to add new
            // ones.
            apply_migrations(&conn).expect("failed to apply database migrations");

            // Backfill the FTS index for any messages that pre-date the
            // virtual table. The sync triggers keep new inserts indexed
            // automatically; this only runs work on rows the triggers
            // never fired for (i.e. on the first launch after FTS was
            // added to the schema). Cheap: skips rows already in the
            // index via NOT IN, so subsequent launches are no-ops.
            if let Err(e) = conn.execute(
                "INSERT INTO messages_fts(rowid, content, msg_id, chat_id, role) \
                 SELECT m.rowid, m.content, m.id, m.chat_id, m.role FROM messages m \
                 WHERE m.rowid NOT IN (SELECT rowid FROM messages_fts)",
                [],
            ) {
                log_warn!("FTS backfill failed (search will return empty until messages are re-saved): {e}");
            }

            // Sweep "empty" chats from prior sessions. A chat is empty if
            // it has neither messages NOR attachments. Chats with messages
            // OR live attachments are preserved (the attachment-but-no-
            // messages case is intentional: pending chats with context
            // loaded). FK cascade handles attachments automatically if
            // any were already removed.
            match conn.execute(
                "DELETE FROM chats WHERE id NOT IN (SELECT DISTINCT chat_id FROM messages) \
                                       AND id NOT IN (SELECT DISTINCT chat_id FROM attachments)",
                [],
            ) {
                Ok(n) if n > 0 => log_info!("Cleaned up {n} empty chat(s) from prior sessions"),
                _ => {}
            }

            app.manage(DbState(Mutex::new(conn)));

            // ── Seed built-in prompts on first launch ───────────────────────
            // Idempotent: only writes files that aren't already present, so
            // user edits and deletions survive across launches.
            if let Err(e) = prompts::prompts_seed_builtins(app.handle().clone()) {
                log_warn!("Built-in prompt seeding failed: {e}");
            }

            // ── Global hotkeys ──────────────────────────────────────────────
            // Two slots, both platform-gated for the L1/W1 MVP scope:
            //
            //   • Overlay toggle: registered on macOS + Windows.
            //     - macOS:   ⌘⇧Space (Modifiers::SUPER | Modifiers::SHIFT).
            //     - Windows: Alt+Space (Modifiers::ALT). The Win-key
            //       (SUPER) combos are heavily reserved by Windows for
            //       input-method switching — Win+Space cycles keyboard
            //       layouts and `RegisterHotKey()` either rejects or
            //       silently swallows Win+Shift+Space depending on the
            //       user's locale config. Alt+Space matches the
            //       convention used by PowerToys Run / Raycast Windows /
            //       ChatGPT Desktop, at the cost of shadowing the
            //       rarely-used "Window menu" system shortcut. Worth it.
            //     - Linux: skipped entirely — overlay deferred to Phase L2.
            //   • Screenshot capture: macOS only (⌘⇧1). Linux (L3) and
            //     Windows (W3) need their own capture pipelines (no
            //     equivalent to /usr/sbin/screencapture). The slot stays
            //     empty until then.
            //
            // We populate HOTKEY_REGISTRY so the global-shortcut handler
            // can route by identity. The user can override either default
            // via the register_hotkey / register_screenshot_hotkey
            // commands at runtime; the registry tracks slots
            // independently so a re-register swaps only its slot.
            //
            // CRITICAL: registration failures must be NON-FATAL. They
            // happen routinely — another app has the same combo, the
            // OS reserves it, system policy blocks it, etc. — and the
            // app should still launch with an empty slot. Pre-W1, the
            // code propagated the error out of setup() via `?`, which
            // killed the whole app on the very first Windows test run
            // because Win+Shift+Space is reserved. Log the failure and
            // leave the slot None; the user can rebind via Settings
            // once the main window is up.
            #[allow(unused_variables)]
            let gs = app.global_shortcut();

            // Helper closure: register a shortcut, log on failure, return
            // Some(shortcut) on success / None on failure. Pure
            // best-effort — never propagates the error.
            #[allow(unused_variables)]
            let try_register = |s: Shortcut, slot: &str| -> Option<Shortcut> {
                match gs.register(s) {
                    Ok(_) => Some(s),
                    Err(e) => {
                        log_warn!(
                            "Failed to register default {slot} hotkey: {e}. \
                             User can rebind in Settings → General."
                        );
                        None
                    }
                }
            };

            #[cfg(target_os = "macos")]
            let overlay_toggle_opt: Option<Shortcut> = try_register(
                Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space),
                "overlay",
            );
            #[cfg(target_os = "windows")]
            let overlay_toggle_opt: Option<Shortcut> = try_register(
                // Alt+Space — see the platform notes above for why not Win+...
                Shortcut::new(Some(Modifiers::ALT), Code::Space),
                "overlay",
            );
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let overlay_toggle_opt: Option<Shortcut> = None;

            #[cfg(target_os = "macos")]
            let screenshot_capture_opt: Option<Shortcut> = try_register(
                Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Digit1),
                "screenshot",
            );
            #[cfg(not(target_os = "macos"))]
            let screenshot_capture_opt: Option<Shortcut> = None;

            // Voice dictation hotkey — macOS only (voice input is a macOS
            // feature; see `mod voice` / Cargo.toml). Defaults to ⌘⇧V,
            // rebindable in Settings → General. Shadowing of the app-local
            // ⌘⇧V (paste-and-match-style) is the cost of a mnemonic default;
            // registration failure just leaves the slot empty (best-effort).
            #[cfg(target_os = "macos")]
            let voice_opt: Option<Shortcut> = try_register(
                Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyV),
                "voice",
            );
            #[cfg(not(target_os = "macos"))]
            let voice_opt: Option<Shortcut> = None;

            // Populate the registry so the handler can dispatch by
            // identity. Errors here would mean the OnceLock-init panicked,
            // which shouldn't happen — we log and proceed; the worst case
            // is no hotkey routing, which the user will notice immediately.
            if let Ok(mut reg) = overlay::registry().lock() {
                reg.overlay = overlay_toggle_opt;
                reg.screenshot = screenshot_capture_opt;
                reg.voice = voice_opt;
            } else {
                log_warn!("hotkey registry init failed");
            }

            // ── Background watch poller ─────────────────────────────────────
            // One global async task that loops forever, re-reading the
            // enabled watches each tick so add/remove/toggle in the UI take
            // effect on the next scan without restarting the task.
            //
            // We use tauri::async_runtime::spawn (not tokio::spawn) because
            // Tauri's setup() callback runs before the tokio reactor is
            // attached to the calling thread — tokio::spawn would panic
            // with "there is no reactor running".
            let watch_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                watch::pipeline::watch_poller(watch_app).await
            });

            // ── Overlay rendering: transparent webview + native vibrancy ────
            // Three layers stack here:
            //   1. OS window — transparent (transparent: true + macos-private-api)
            //   2. NSVisualEffectView — placed behind the webview by
            //      apply_vibrancy below; provides the blurred desktop tint
            //      and the rounded-corner mask that clips both itself and
            //      the webview to a 12px radius
            //   3. WKWebView — set to fully transparent so the vibrancy
            //      shows through everywhere our HTML content isn't drawing
            //
            // The radius arg to apply_vibrancy is what fixes the "rectangle
            // border" problem: it masks at the OS level, so there's nothing
            // for an opaque webview surface to leak through.
            if let Some(overlay) = app.get_webview_window("overlay") {
                let _ = overlay
                    .set_background_color(Some(tauri::webview::Color(0, 0, 0, 0)));
                #[cfg(target_os = "macos")]
                {
                    if let Err(e) = apply_vibrancy(
                        &overlay,
                        // Sidebar material gives us a strong native blur and
                        // crisp OS-level rounded-corner masking, but in
                        // Sequoia the material itself is too translucent to
                        // hold contrast across wallpapers. The heavy CSS
                        // tint in overlay.jsx (~0.7 alpha) does most of the
                        // contrast work; vibrancy here is doing the
                        // blur + corner mask jobs only.
                        NSVisualEffectMaterial::Sidebar,
                        Some(NSVisualEffectState::Active),
                        // Bigger radius → closer to Spotlight's pill look.
                        Some(18.0),
                    ) {
                        log_warn!("Failed to apply overlay vibrancy: {e:?}");
                    }
                }
                // Windows: prefer Mica (Win 11), fall back to Acrylic
                // (Win 10). Both are the OS-level blur backends that ship
                // with the WinAppSDK; users get a native Fluent feel close
                // to Spotlight without us hand-rolling a blur shader. If
                // both fail (very old Windows or unusual graphics drivers)
                // the overlay just renders with its CSS-tinted bg, which
                // is functionally fine — just less pretty.
                #[cfg(target_os = "windows")]
                {
                    if apply_mica(&overlay, /* dark */ Some(true)).is_err() {
                        if let Err(e) = apply_acrylic(&overlay, /* tint */ None) {
                            log_warn!("Failed to apply overlay vibrancy: {e:?}");
                        }
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running Ekorbia");
}
