// SPDX-License-Identifier: MIT

//! Serde types and shared constants for the attachment pipeline.

use serde::{Deserialize, Serialize};
use std::path::Path;

// ── Limits & defaults ────────────────────────────────────────────────────────

pub(crate) const ATTACHMENT_MAX_BYTES: u64 = 5 * 1024 * 1024; // 5 MB hard cap

/// Below this size, text attachments are inlined verbatim into the system
/// message at send time (no chunking, no embedding) — keeps short notes /
/// snippets accurate and zero-latency. Above it, the file is chunked and
/// indexed at attach time, and only top-k chunks are retrieved per query.
pub(crate) const SMALL_TEXT_THRESHOLD: usize = 8 * 1024;

/// Chunk shape for the embedding pipeline. ~1000 chars with 100-char overlap
/// is the rule-of-thumb default for nomic-style embeddings; small enough
/// that each chunk stays focused, large enough to carry surrounding context.
pub(crate) const CHUNK_TARGET_CHARS: usize = 1000;
pub(crate) const CHUNK_OVERLAP_CHARS: usize = 100;

/// Default top-k chunks retrieved per query across all attachments.
pub(crate) const DEFAULT_TOP_K: usize = 6;

/// Default embedding model. The active model is configurable in Settings
/// (stored in app_settings under key 'embedding_model'); this is the
/// fallback when nothing's been set.
pub(crate) const DEFAULT_EMBEDDING_MODEL: &str = "nomic-embed-text";

/// Phase 3 folder-indexing defaults. Conservative — only docs, capped at
/// 1000 files. Settings exposes these in `folder_exts` / `folder_ignore`.
pub(crate) const FOLDER_DEFAULT_EXTS: &[&str] = &["md", "markdown", "txt", "pdf"];
pub(crate) const FOLDER_MAX_FILES: usize = 1000;

/// Directory names to skip outright during the walk. Lowercased — matched
/// case-insensitively against each path component. These are the obvious
/// build / VCS / IDE noise; the goal is to keep "Add my repo" working
/// without forcing the user to configure anything first.
pub(crate) const FOLDER_IGNORE_DIRS: &[&str] = &[
    ".git", ".hg", ".svn",
    "node_modules", "target", "dist", "build", "out", ".next", ".cache",
    ".venv", "venv", "env", "__pycache__",
    ".idea", ".vscode",
    ".DS_Store",
];

// ── Serde types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentRow {
    pub(crate) id: String,
    pub(crate) chat_id: String,
    /// 'text' (txt/md/pdf), 'image' (png/jpg/jpeg/webp), or 'folder'.
    pub(crate) kind: String,
    /// Absolute filesystem path. For 'folder', the directory root. Source of
    /// truth for content on each send — we deliberately do NOT cache file
    /// contents in SQLite (would balloon the DB and hide edits made outside
    /// the app). Moved/renamed files produce an error on send, surfaced as
    /// a Sources-footer warning.
    pub(crate) path: String,
    /// Display name shown in chips and citations (filename / folder name).
    pub(crate) label: String,
    pub(crate) bytes: i64,
    pub(crate) added_at: i64,
    /// Indexing lifecycle: 'ready' | 'indexing' | 'error'. Small text files
    /// and images go straight to 'ready'; large files and folders ever
    /// transit 'indexing'.
    #[serde(default = "default_status")]
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) error: Option<String>,
    /// Number of files indexed inside a folder attachment. 0 for files /
    /// images. Updated by the walker as indexing progresses.
    #[serde(default)]
    pub(crate) file_count: i64,
}

fn default_status() -> String { "ready".to_string() }

/// SQL column list for `SELECT … FROM attachments`, in `AttachmentRow`
/// field-declaration order. `map_attachment_row` depends on this ordering.
/// **Keep this string and `map_attachment_row` in sync with the struct field
/// list above** — drift between any two of the three will silently misread
/// columns into the wrong fields.
pub(crate) const ATTACHMENT_COLUMNS: &str =
    "id, chat_id, kind, path, label, bytes, added_at, status, error, file_count";

/// Materialize an `AttachmentRow` from a row whose columns match
/// `ATTACHMENT_COLUMNS` in order. Used by `attachment_list` and
/// `attachment_prepare_for_send`.
pub(crate) fn map_attachment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttachmentRow> {
    Ok(AttachmentRow {
        id: row.get(0)?,
        chat_id: row.get(1)?,
        kind: row.get(2)?,
        path: row.get(3)?,
        label: row.get(4)?,
        bytes: row.get(5)?,
        added_at: row.get(6)?,
        status: row.get(7)?,
        error: row.get(8)?,
        file_count: row.get(9)?,
    })
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedAttachment {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) path: String,
    pub(crate) kind: String,
    /// Sequential citation index, 1-based. Both text and image attachments
    /// share one numbering scheme per send, so a model that emits "[2]" can
    /// refer to either.
    pub(crate) citation_index: i32,
    /// Per-chunk retrieval details for chips in the Sources footer. Empty
    /// for inlined (small text) attachments and images; populated for
    /// large files and folders. For folders, `path` is the sub-file under
    /// the attachment's root; for large single files, `path` matches the
    /// attachment's own path (the chunk just came from inside it).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) hits: Vec<PreparedHit>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedHit {
    /// File path the chunk came from. For folders this is the sub-path.
    pub(crate) path: String,
    /// Cosine score [0..1ish]. Useful for tooltips so the user can audit
    /// "did the retrieval actually find a strong match?".
    pub(crate) score: f32,
    pub(crate) char_start: i64,
    pub(crate) char_end: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentPayload {
    /// System-message block to prepend to the chat. Empty when there are no
    /// text attachments. Format mirrors what we tell the model in the prompt
    /// prefix so it can cite reliably.
    pub(crate) system_block: String,
    /// Base64-encoded image bytes for inclusion in Ollama's `images: [...]`
    /// field on the user message. Only populated when the active model has
    /// vision capability AND the chat has image attachments.
    pub(crate) images: Vec<String>,
    /// Per-attachment metadata in citation order — UI uses this to render the
    /// Sources footer chips.
    pub(crate) sources: Vec<PreparedAttachment>,
    /// True when the chat has images but the active model lacks vision. UI
    /// surfaces a one-time hint so the user knows the images were skipped.
    pub(crate) images_skipped: bool,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentStatusEvent {
    pub(crate) id: String,
    pub(crate) status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
    /// Folder-only: indexed files so far. None for files / images.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) done: Option<u32>,
    /// Folder-only: total files the walker discovered. None for files /
    /// images. JS uses this with `done` to render "(N/M indexed)".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) total: Option<u32>,
    /// Folder-only sub-phase: "walking" while the walker is still
    /// enumerating files, "embedding" once the walker is done and per-file
    /// indexing starts. JS chip uses this to show "walking…" vs "(N/M)".
    /// None on non-folder transitions and on terminal 'ready'/'error'.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) phase: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RetrievedChunk {
    pub(crate) attachment_id: String,
    /// Sub-path within a folder attachment, if any. For single-file
    /// attachments this is None and citation should use the attachment's
    /// own path.
    pub(crate) source_path: Option<String>,
    pub(crate) text: String,
    pub(crate) score: f32,
    pub(crate) char_start: i64,
    pub(crate) char_end: i64,
}

/// Classify a file path into our two attachment kinds. Returns None for
/// unsupported extensions so the caller can reject the file with a clear
/// message rather than producing junk attachments. Image classification is
/// extension-based — we don't sniff magic bytes; the Ollama model will reject
/// malformed bytes downstream if the extension lies.
pub(crate) fn classify_attachment(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "txt" | "md" | "markdown" | "pdf" => Some("text"),
        "png" | "jpg" | "jpeg" | "webp" => Some("image"),
        _ => None,
    }
}
