// SPDX-License-Identifier: MIT

//! Cancellation registry for in-flight watch cycles.
//!
//! A watch cycle (folder scan, RSS feed pull, URL fetch + summarise) can
//! take minutes if the LLM is slow or the source has many new items. When
//! the user toggles a watch off we want the work to stop immediately —
//! not on the next polling tick, and not after the current item finishes.
//!
//! This module mirrors the attachments cancel registry pattern (see
//! `attachments/cancel.rs`) almost verbatim. The single difference is
//! semantics: a watch is reusable (toggle on → off → on), so flipping the
//! flag must not poison future cycles. We achieve this by removing the
//! registry entry in `cancel_watch` (and via Drop on the cycle's
//! `WatchCancelToken`); the next `register_cancel` call gets a fresh
//! `AtomicBool` initialised to false.
//!
//! **Panic safety.** `ollama_chat` and `pdf-extract` have both been
//! observed to panic on malformed input. Pairing `register_cancel` with
//! an explicit `clear` would leak the registry entry on panic. The
//! `WatchCancelToken`'s `Drop` impl cleans up whether the cycle returns
//! normally, early-returns, or panics — same trick the attachment side
//! uses.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

static WATCH_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cancel_registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    WATCH_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Owns one registry entry for the duration of a watch cycle. The
/// pipeline holds this from the top of `run_watch` until `run_watch`
/// returns; on Drop the registry entry is removed so a re-enabled watch
/// starts clean.
///
/// `cancel_watch` may have already removed the entry by the time Drop
/// runs (toggle-off mid-cycle); the Drop's `remove` is then a quiet
/// no-op.
pub(crate) struct WatchCancelToken {
    id: String,
    pub(crate) flag: Arc<AtomicBool>,
}

impl Drop for WatchCancelToken {
    fn drop(&mut self) {
        if let Ok(mut m) = cancel_registry().lock() {
            // Only remove if the flag is the one *we* registered. A
            // concurrent re-toggle that briefly overlapped would have
            // inserted a fresh Arc; in that rare case we leave the new
            // entry alone so its cycle isn't poisoned. Identity check
            // uses Arc::ptr_eq because two Arcs to different AtomicBools
            // are distinct values.
            if let Some(existing) = m.get(&self.id) {
                if Arc::ptr_eq(existing, &self.flag) {
                    m.remove(&self.id);
                }
            }
        }
    }
}

/// Register a cancel flag for a watch id and return the owning token.
/// Overwrites any prior entry for the same id — if a previous cycle is
/// somehow still running (shouldn't happen under the serial poller, but
/// `watch_run_one` could theoretically race), its flag is flipped here
/// before being replaced. That tells the lingering cycle to bail.
pub(crate) fn register_cancel(id: &str) -> WatchCancelToken {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut m) = cancel_registry().lock() {
        if let Some(prev) = m.insert(id.to_string(), flag.clone()) {
            // Older cycle still around — make sure it sees a cancel
            // signal so it stops competing with the new one.
            prev.store(true, Ordering::Relaxed);
        }
    }
    WatchCancelToken {
        id: id.to_string(),
        flag,
    }
}

/// Flip the cancel flag for a watch and remove the entry. The pipeline's
/// in-flight checks see the change on their next read. Safe to call when
/// no cycle is running — the lookup just no-ops.
///
/// `Ordering::Relaxed` mirrors the attachments-side rationale: the next
/// op after seeing "cancelled" is an early return, not a read of some
/// other memory location, so no synchronisation piggyback is needed.
pub(crate) fn cancel_watch(id: &str) {
    if let Ok(mut m) = cancel_registry().lock() {
        if let Some(flag) = m.remove(id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Read the cancel flag for a watch id by direct registry lookup. The
/// pipeline normally uses the cloned `Arc<AtomicBool>` it was handed at
/// token-registration time (cheaper, no map lock); this helper exists
/// for paths that don't have the Arc on hand (e.g. a future hook that
/// wants to check from outside the cycle).
#[allow(dead_code)]
pub(crate) fn is_cancelled(id: &str) -> bool {
    cancel_registry()
        .lock()
        .ok()
        .and_then(|m| m.get(id).map(|f| f.load(Ordering::Relaxed)))
        .unwrap_or(false)
}
