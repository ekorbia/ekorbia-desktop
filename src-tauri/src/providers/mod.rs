// SPDX-License-Identifier: MIT

//! Provider adapters (no-Ollama plan, Phase 1).
//!
//! Each submodule implements the neutral surface that `llm.rs` dispatches
//! to: `ollama` (the default local engine) and `openai_compat` (any
//! OpenAI-compatible server — LM Studio, llama-server, vLLM, …). All HTTP
//! for a provider lives inside its adapter file and nowhere else; the
//! stream contract every adapter must uphold is `llm::StreamEvent` (see
//! the guarantees documented there and pinned by each adapter's golden
//! tests).
//!
//! This module owns the one piece of genuinely shared runtime state: the
//! **cancel registry**. Chat streams (both adapters) and Ollama pulls
//! register a per-request `AtomicBool` here; `llm_chat_stream_cancel` /
//! `ollama_pull_cancel` flip it, and the running loop observes it at the
//! next chunk boundary. Request-id namespaces keep the spaces from
//! colliding (chat = assistant message id, pulls = `pull:<model>:<nonce>`).

pub(crate) mod ollama;
pub(crate) mod openai_compat;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

static CANCELS: OnceLock<std::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>> =
    OnceLock::new();

fn cancel_registry() -> &'static std::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>
{
    CANCELS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// RAII guard for a registered cancel slot. Holding this keeps the flag's
/// Arc alive in the registry. Drop removes the entry — runs on normal
/// return, early-break, AND panic-unwind, so the map can't leak. Mirrors
/// the `CancelToken` in attachments/cancel.rs.
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

/// Flip the cancel flag for `request_id`. The running stream picks it up
/// at the next chunk boundary and exits cleanly. Safe for unknown ids —
/// the lookup just no-ops.
pub(crate) fn cancel(request_id: &str) {
    if let Ok(m) = cancel_registry().lock() {
        if let Some(flag) = m.get(request_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_registry_register_and_cancel() {
        let token = register_cancel("test-cancel-happy");
        assert!(!token.flag.load(Ordering::Relaxed));
        {
            let m = cancel_registry().lock().unwrap();
            assert!(m.contains_key("test-cancel-happy"));
        }
        cancel("test-cancel-happy");
        assert!(token.flag.load(Ordering::Relaxed));
        drop(token);
    }

    #[test]
    fn cancel_registry_drop_removes_entry() {
        {
            let _token = register_cancel("test-cancel-drop");
            let m = cancel_registry().lock().unwrap();
            assert!(m.contains_key("test-cancel-drop"));
        }
        let m = cancel_registry().lock().unwrap();
        assert!(!m.contains_key("test-cancel-drop"));
    }

    #[test]
    fn cancel_unknown_id_is_no_op() {
        cancel("never-registered");
    }

    /// Pull ids share the registry but are namespaced
    /// (`pull:<model>:<nonce>`), so a pull cancel must not touch a chat
    /// stream's flag and vice versa.
    #[test]
    fn pull_and_chat_cancel_ids_are_independent() {
        let chat = register_cancel("msg-abc");
        let pull = register_cancel("pull:gemma4:e4b:x1");

        cancel("pull:gemma4:e4b:x1");
        assert!(pull.flag.load(Ordering::Relaxed), "pull flag should flip");
        assert!(
            !chat.flag.load(Ordering::Relaxed),
            "chat flag must be untouched by a pull cancel"
        );

        drop(pull);
        let m = cancel_registry().lock().unwrap();
        assert!(m.contains_key("msg-abc"));
        assert!(!m.contains_key("pull:gemma4:e4b:x1"));
    }
}
