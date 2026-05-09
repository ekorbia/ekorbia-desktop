// SPDX-License-Identifier: MIT

//! Chat attachments + local RAG.
//!
//! Three attachment kinds:
//! - `text` (small, <8KB) — inlined verbatim into a system message at send
//! - `text` (large, ≥8KB) — chunked + embedded at attach; top-k retrieval per query
//! - `image` — base64-encoded into Ollama `images: [...]`, gated by vision capability
//! - `folder` — recursive walk; per-file chunks + embeddings; top-k retrieval per query
//!
//! Module layout:
//! - `types`     — serde types (AttachmentRow, PreparedAttachment, etc.) + consts
//! - `config`    — current_* settings resolvers (embedding model, top-k, folder exts/ignore)
//! - `cancel`    — registry of cancel flags so `attachment_remove` can abort in-flight indexing
//! - `pipeline`  — chunk_text, ollama_embed wrappers, set_attachment_status, index_attachment, retrieve_chunks
//! - `folder`    — walk_folder, attachment_add_folder, index_folder, index_one_folder_file
//! - `commands`  — public Tauri commands (list/add_files/remove/prepare/reindex/stale)

pub(crate) mod cancel;
pub(crate) mod commands;
pub(crate) mod config;
pub(crate) mod folder;
pub(crate) mod pipeline;
pub(crate) mod types;
