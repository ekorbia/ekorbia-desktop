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
mod text_extract;
mod watch;

use crate::log::{log_info, log_warn};
use rusqlite::Connection;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

use crate::db::{DbState, SCHEMA};

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
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            ollama::start_ollama,
            overlay::overlay_hide,
            overlay::overlay_resize,
            overlay::focus_main,
            overlay::register_hotkey,
            overlay::register_screenshot_hotkey,
            screenshot::screenshot_consumed,
            chat::db_load_chats,
            chat::db_load_messages,
            chat::db_upsert_chat,
            chat::db_upsert_message,
            chat::db_delete_chat,
            chat::db_clear_all_chats,
            chat::db_truncate_chat_from,
            chat::chat_export_to_path,
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

            // No migration block: this app is in development, so future
            // schema changes go directly into the SCHEMA const in db.rs
            // and the dev DB gets wiped between schema iterations.
            // Reintroduce ALTER TABLE / DO-UPDATE plumbing here when
            // there are users whose DBs need to survive upgrades.

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
            // Two slots:
            //   • Overlay toggle: ⌘⇧Space (default; user-rebindable in
            //     Settings → General → Hotkey)
            //   • Screenshot capture: ⌘⇧1 (default; user-rebindable)
            //
            // We register the defaults here AND update the HOTKEY_REGISTRY
            // so the global-shortcut handler can route by identity. The
            // user can override either via the register_hotkey /
            // register_screenshot_hotkey commands at runtime; those use
            // the registry to surgically swap their slot without touching
            // the other.
            //
            // Modifiers::SUPER maps to Command on macOS, Windows key on
            // Windows, Super on Linux — the right "primary modifier".
            let overlay_toggle = Shortcut::new(
                Some(Modifiers::SUPER | Modifiers::SHIFT),
                Code::Space,
            );
            let screenshot_capture = Shortcut::new(
                Some(Modifiers::SUPER | Modifiers::SHIFT),
                Code::Digit1,
            );
            let gs = app.global_shortcut();
            gs.register(overlay_toggle)?;
            gs.register(screenshot_capture)?;
            // Populate the registry so the handler can dispatch by
            // identity. Errors here would mean the OnceLock-init panicked,
            // which shouldn't happen — we log and proceed; the worst case
            // is no hotkey routing, which the user will notice immediately.
            if let Ok(mut reg) = overlay::registry().lock() {
                reg.overlay = Some(overlay_toggle);
                reg.screenshot = Some(screenshot_capture);
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
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running Ekorbia");
}
