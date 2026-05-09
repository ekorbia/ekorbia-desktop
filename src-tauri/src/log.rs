// SPDX-License-Identifier: MIT

//! Tiny logging shim. Single chokepoint so future routing (file sink,
//! OS log, structured JSON) is a one-file change instead of grepping for
//! every `eprintln!` in the tree.
//!
//! Usage from any module:
//!
//! ```ignore
//! use crate::log::{log_warn, log_info};
//!
//! log_warn!("db write failed: {e}");
//! log_info!("cleaned up {n} empty chats");
//! ```
//!
//! Output format: `[<module_path>] LEVEL: <message>`. `module_path!()` is
//! captured by the macro at the call site, so logs are automatically tagged
//! with the source module without callers passing a target string.
//!
//! Why `macro_rules!` instead of a free function: macros let us bake
//! `module_path!()` into every call without forcing the caller to pass it.
//! The `pub(crate) use log_warn;` re-export is the modern Rust 2018+ idiom
//! for crate-visible macros that don't pollute `#[macro_export]`'s
//! crate-root namespace.

/// Warning-level log: anything the user/operator should know happened but
/// the code recovered (or chose to fire-and-forget) from. Most converted
/// `eprintln!` calls land here.
macro_rules! log_warn {
    ($($arg:tt)*) => {{
        eprintln!("[{}] WARN: {}", module_path!(), format_args!($($arg)*));
    }};
}

/// Info-level log: routine progress / completion notices. Sparingly used —
/// only for things a maintainer reading stderr would want to see (e.g.
/// "cleaned up N stale chats on startup").
macro_rules! log_info {
    ($($arg:tt)*) => {{
        eprintln!("[{}] INFO: {}", module_path!(), format_args!($($arg)*));
    }};
}

// `pub(crate) use` makes the macros visible to other modules without
// polluting the crate root. Callers do `use crate::log::log_warn;` (or
// `log_info`). Deliberately NOT `#[macro_export]` — that would put them at
// `$crate::log_warn`, conflicting with `use crate::log::log_warn`.
pub(crate) use log_info;
pub(crate) use log_warn;
