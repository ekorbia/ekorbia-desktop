// SPDX-License-Identifier: MIT

//! Generic key/value settings IPC.
#![allow(clippy::needless_pass_by_value)]

//!
//! Thin wrappers around the `app_settings` table for JS-side preference
//! storage. The values are opaque strings — JS encodes/decodes any
//! structure it needs. Keeps the IPC surface small (two commands handle
//! all phase-4 settings) and avoids per-setting handlers.
//!
//! Embedding-specific knobs (current_top_k, current_embedding_model,
//! folder ext/ignore lists) and their consts live in
//! `attachments::config` because they're consumed there; this module
//! keeps only the raw get/set IPC.

use crate::db::{get_setting, set_setting, DbState};
use tauri::Manager;

#[tauri::command]
pub(crate) fn setting_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let state = app.state::<DbState>();
    let db = state.0.lock().map_err(|e| e.to_string())?;
    Ok(get_setting(&db, &key))
}

#[tauri::command]
pub(crate) fn setting_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let db = state.0.lock().map_err(|e| e.to_string())?;
    set_setting(&db, &key, &value)
}
