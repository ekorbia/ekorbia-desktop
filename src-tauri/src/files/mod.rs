// SPDX-License-Identifier: MIT

//! Paths the app opens or resolves on the user's behalf.
//!
//! Submodules:
//!   sandbox  — pure path-resolution / containment check (no Tauri deps),
//!              used when opening a file inside an attached folder.
//!   commands — `spawn_opener`: open or reveal a path in the OS.
//!
//! (The model's own file saving — a `write_file` tool and its Files panel —
//! lived here and was removed.)

pub(crate) mod commands;
pub(crate) mod sandbox;
