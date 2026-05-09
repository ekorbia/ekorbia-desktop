// SPDX-License-Identifier: MIT

//! Cancellation registry for in-flight indexing tasks.
//!
//! Indexing tasks run on the tokio runtime and outlive the command that
//! spawned them. If the user removes an attachment mid-index, we need a way
//! to tell the running task to bail before it writes chunks against a now-
//! deleted row. Each spawn registers an `Arc<AtomicBool>`;
//! `attachment_remove` flips it before issuing the DELETE.
//!
//! **Panic safety.** Indexing pulls in `pdf-extract`, which has been known
//! to panic on malformed PDFs. Pairing every `register_cancel` with a
//! manual `clear_cancel` call leaks the registry entry if the task panics
//! between the two — the `HashMap<String, Arc<AtomicBool>>` grows without
//! bound. The fix: `register_cancel` returns a `CancelToken` whose `Drop`
//! impl removes the registry entry. The spawned task holds the token; the
//! map is cleaned up whether the task ends normally, via an early `return`,
//! or via a panic (Drop runs while unwinding).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

static INDEX_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cancel_registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    INDEX_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Owns one registry entry. The spawned task holds this for the duration
/// of the index run; on drop (normal exit, early return, or panic) the
/// entry is removed from the map. `flag` is the shared cancel signal —
/// callers `.clone()` it to hand into helpers like `index_attachment`.
///
/// `cancel_index` may have already removed the entry by the time Drop
/// runs (e.g. the user detached mid-index). The Drop's `remove` is then
/// a no-op — `HashMap::remove` returns `None` quietly.
pub(crate) struct CancelToken {
    id: String,
    pub(crate) flag: Arc<AtomicBool>,
}

impl Drop for CancelToken {
    fn drop(&mut self) {
        if let Ok(mut m) = cancel_registry().lock() {
            m.remove(&self.id);
        }
    }
}

/// Register a cancel flag for an attachment id. The returned token owns
/// the registry entry; drop it (by letting it go out of scope at the end
/// of the spawned task) to release the slot. Overwrites any prior entry
/// for the same id — reindex of an in-flight attachment will see the
/// previous task's flag flipped on drop.
pub(crate) fn register_cancel(id: &str) -> CancelToken {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut m) = cancel_registry().lock() {
        m.insert(id.to_string(), flag.clone());
    }
    CancelToken {
        id: id.to_string(),
        flag,
    }
}

/// Flip the cancel flag for an attachment and remove the entry. Tasks
/// holding the original Arc (via `CancelToken::flag.clone()`) will see
/// the change on their next check. Safe to call when no task is running
/// — the lookup just no-ops.
///
/// `Ordering::Relaxed` is sufficient: this is a one-shot publish/poll
/// with no piggybacked data — the next operation after seeing "cancelled"
/// is an early return, not a read of some other memory location.
pub(crate) fn cancel_index(id: &str) {
    if let Ok(mut m) = cancel_registry().lock() {
        if let Some(flag) = m.remove(id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}
