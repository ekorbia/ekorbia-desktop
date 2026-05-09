// SPDX-License-Identifier: MIT

//! Chat-generated file storage and the write_file tool plumbing.
//!
//! Submodules:
//!   sandbox  — pure path-resolution / containment check (no Tauri deps).
//!   tools    — tool-call execution (Phase 3 — filled in alongside the
//!              ollama_chat tool loop).
//!   commands — Tauri commands for managing chat output dirs and listing
//!              / revealing previously-saved files.

pub(crate) mod commands;
pub(crate) mod sandbox;
pub(crate) mod tools;
