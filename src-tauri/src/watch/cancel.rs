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

/// Register a cancel flag for a watch id and return the owning token —
/// or `None` if a cycle is ALREADY registered for this id, meaning the
/// caller should skip. One cycle per watch at a time.
///
/// This doubles as the mutual-exclusion point for watch cycles. Three
/// callers race to start a cycle for the same watch: the background poller
/// and the two "Run now" commands (`watch_run_once` / `watch_run_one`).
/// Letting two run concurrently double-processes items AND makes them
/// fight over this registry — the previous design overwrote the entry and
/// flipped the older cycle's flag, which surfaced as a spurious "Cancelled
/// by user" row on whatever file that cycle was mid-processing (then
/// reprocessed by the winner). Refusing the second cycle fixes both: the
/// in-flight cycle runs to completion, the redundant trigger no-ops.
pub(crate) fn register_cancel(id: &str) -> Option<WatchCancelToken> {
    // Recover from a poisoned lock rather than skipping the cycle — a
    // panic in one watch shouldn't wedge the whole subsystem.
    let mut m = cancel_registry().lock().unwrap_or_else(|e| e.into_inner());
    if m.contains_key(id) {
        return None; // a cycle is already live for this watch
    }
    let flag = Arc::new(AtomicBool::new(false));
    m.insert(id.to_string(), flag.clone());
    Some(WatchCancelToken {
        id: id.to_string(),
        flag,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    // Distinct ids per test: the registry is process-global and cargo runs
    // tests in parallel threads, so shared ids would cross-talk.

    #[test]
    fn register_cancel_refuses_a_second_concurrent_cycle() {
        let id = "watch-test-refuse-second";
        let first = register_cancel(id).expect("first cycle registers");
        assert!(
            register_cancel(id).is_none(),
            "a second cycle for the same watch must be refused while the first is live"
        );
        drop(first);
        // Once the first token drops (cycle finished), a fresh cycle registers.
        let again = register_cancel(id).expect("a new cycle registers after the first finished");
        drop(again);
    }

    #[test]
    fn cancel_watch_flips_flag_and_frees_the_slot() {
        let id = "watch-test-cancel-frees";
        let live = register_cancel(id).expect("register");
        let flag = live.flag.clone();
        cancel_watch(id);
        assert!(
            flag.load(Ordering::Relaxed),
            "cancel_watch flips the cycle's flag so its next check bails"
        );
        // The entry is gone, so a fresh cycle can register even though the
        // cancelled token is still alive (unwinding after seeing the flag).
        let next = register_cancel(id).expect("re-register after cancel_watch removed the entry");
        drop(next);
        drop(live);
    }
}
