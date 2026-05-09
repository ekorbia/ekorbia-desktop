// SPDX-License-Identifier: MIT

//! Settings resolvers for the attachment / embedding pipeline.
//!
//! Each `current_*` reads its app_settings key, falls back to the
//! corresponding default const if unset/empty, and is cheap enough to call
//! per-send / per-index without caching.

use crate::attachments::types::{
    DEFAULT_EMBEDDING_MODEL, DEFAULT_TOP_K, FOLDER_DEFAULT_EXTS, FOLDER_IGNORE_DIRS,
};
use crate::db::{get_setting, DbState};
use tauri::Manager;

/// Resolve the active embedding model. Reads from app_settings; falls back
/// to DEFAULT_EMBEDDING_MODEL on any error or empty value.
pub(crate) fn current_embedding_model(app: &tauri::AppHandle) -> String {
    let state = app.state::<DbState>();
    if let Ok(db) = state.0.lock() {
        if let Some(v) = get_setting(&db, "embedding_model") {
            if !v.is_empty() {
                return v;
            }
        }
    }
    DEFAULT_EMBEDDING_MODEL.to_string()
}

/// Resolve the top-k chunk count for retrieval. Settings override; default
/// 6. Clamped to [1, 50] so a typo can't blow up the context window.
pub(crate) fn current_top_k(app: &tauri::AppHandle) -> usize {
    let state = app.state::<DbState>();
    let v: Option<i64> = if let Ok(db) = state.0.lock() {
        get_setting(&db, "top_k").and_then(|s| s.parse().ok())
    } else {
        None
    };
    v.map(|n| n.clamp(1, 50) as usize).unwrap_or(DEFAULT_TOP_K)
}

/// Comma-separated lowercased file extensions (no leading dot) to index in
/// folder attachments. Defaults to FOLDER_DEFAULT_EXTS when unset.
pub(crate) fn current_folder_exts(app: &tauri::AppHandle) -> Vec<String> {
    let state = app.state::<DbState>();
    if let Ok(db) = state.0.lock() {
        if let Some(s) = get_setting(&db, "folder_exts") {
            let parsed: Vec<String> = s
                .split(',')
                .map(|t| t.trim().trim_start_matches('.').to_ascii_lowercase())
                .filter(|t| !t.is_empty())
                .collect();
            if !parsed.is_empty() {
                return parsed;
            }
        }
    }
    FOLDER_DEFAULT_EXTS.iter().map(|s| s.to_string()).collect()
}

/// Comma-separated directory names (case-insensitive) to skip during folder
/// walks. Defaults to FOLDER_IGNORE_DIRS when unset.
pub(crate) fn current_folder_ignore(app: &tauri::AppHandle) -> Vec<String> {
    let state = app.state::<DbState>();
    if let Ok(db) = state.0.lock() {
        if let Some(s) = get_setting(&db, "folder_ignore") {
            let parsed: Vec<String> = s
                .split(',')
                .map(|t| t.trim().to_ascii_lowercase())
                .filter(|t| !t.is_empty())
                .collect();
            if !parsed.is_empty() {
                return parsed;
            }
        }
    }
    FOLDER_IGNORE_DIRS.iter().map(|s| s.to_string()).collect()
}
