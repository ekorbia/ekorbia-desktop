// SPDX-License-Identifier: MIT

//! Provider adapters (no-Ollama plan, Phases 1-2).
//!
//! Each submodule implements the neutral surface that `llm.rs` dispatches
//! to: `ollama` (the default external engine), `openai_compat` (any
//! OpenAI-compatible server — LM Studio, llama-server, vLLM, …), and
//! `engine` (the bundled, supervised llama-server sidecar — delegates
//! its wire work to `openai_compat`, process management to
//! `src/engine/`). All HTTP for a provider lives inside its adapter file
//! and nowhere else; the stream contract every adapter must uphold is
//! `llm::StreamEvent` (see the guarantees documented there and pinned by
//! each adapter's golden tests).
//!
//! This module owns the one piece of genuinely shared runtime state: the
//! **cancel registry**. Chat streams (both adapters) and Ollama pulls
//! register a per-request `AtomicBool` here; `llm_chat_stream_cancel` /
//! `ollama_pull_cancel` flip it, and the running loop observes it at the
//! next chunk boundary. Request-id namespaces keep the spaces from
//! colliding (chat = assistant message id, pulls = `pull:<model>:<nonce>`).
//!
//! It also owns the **streaming HTTP client** (`stream_client`) every
//! adapter's `chat_stream` sends through: no total timeout, a per-read
//! stall timeout instead — see its docs for why the adapters' own clients
//! must never carry a chat stream.

pub(crate) mod engine;
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

// ── Streaming HTTP client ──────────────────────────────────────────────────

/// Longest a streaming server may go SILENT before the stream is abandoned.
/// It bounds the wait for the first byte too, which includes the whole
/// prompt read: a full 32K-token window on a slower Mac can take several
/// minutes before the first token, so this is a stall detector, not a
/// latency budget.
const STREAM_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const STREAM_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

static STREAM_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// HTTP client for streaming chat — every adapter's `chat_stream` uses it.
///
/// Deliberately NO total timeout. reqwest's `timeout()` spans the whole
/// exchange INCLUDING the response body, so the 120 s cap on the adapters'
/// general-purpose clients cut off any reply that took longer to read and
/// write — and reqwest reports a timeout that fires mid-body as the opaque
/// "error decoding response body". The 32K engine window made that common:
/// the ~9.8K-token Tessera4X mod brief takes ~40 s to read on an M1 Max
/// before the first token, and a full themed mod reply ran past the cap.
/// A per-read timeout instead resets on every chunk: a reply may stream for
/// as long as it takes, while a server that stops sending is still caught.
/// (Ollama pulls solved the same problem with a 24 h per-request override;
/// chat wants stall detection, which a total timeout can't give.)
pub(crate) fn stream_client() -> &'static reqwest::Client {
    STREAM_CLIENT.get_or_init(|| build_stream_client(STREAM_READ_TIMEOUT))
}

fn build_stream_client(read_timeout: std::time::Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(STREAM_CONNECT_TIMEOUT)
        .read_timeout(read_timeout)
        .build()
        // Builder errors only on TLS init; a bare client beats a panic.
        .unwrap_or_else(|_| reqwest::Client::new())
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

    // ── stream client timeouts ──────────────────────────────────────────

    /// One-connection SSE server: sends `chunks` data lines `gap` apart,
    /// then (optionally) goes silent for `stall` before closing.
    fn slow_sse_server(
        chunks: usize,
        gap: std::time::Duration,
        stall: Option<std::time::Duration>,
    ) -> String {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/stream", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if r.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let _ = s.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            );
            for i in 0..chunks {
                std::thread::sleep(gap);
                if s.write_all(format!("data: {i}\n\n").as_bytes()).is_err() {
                    return;
                }
                let _ = s.flush();
            }
            if let Some(d) = stall {
                std::thread::sleep(d);
            }
        });
        url
    }

    async fn drain(client: &reqwest::Client, url: &str) -> Result<usize, reqwest::Error> {
        let mut resp = client.get(url).send().await?;
        let mut n = 0;
        while let Some(b) = resp.chunk().await? {
            n += b.len();
        }
        Ok(n)
    }

    #[tokio::test]
    async fn total_timeout_cuts_a_long_stream_with_the_opaque_decode_error() {
        // The bug, reproduced in miniature: a TOTAL timeout shorter than the
        // stream kills it mid-body, reported as "error decoding response
        // body" — exactly what a user saw on a long engine reply.
        let ms = std::time::Duration::from_millis;
        let url = slow_sse_server(8, ms(100), None);
        let total = reqwest::Client::builder().timeout(ms(400)).build().unwrap();
        let err = drain(&total, &url).await.unwrap_err();
        assert_eq!(err.to_string(), "error decoding response body");
        assert!(err.is_timeout(), "the hidden cause is the timeout");
    }

    #[tokio::test]
    async fn stream_client_lets_a_steady_stream_outlast_its_read_timeout() {
        // 8 chunks 100 ms apart = ~800 ms of streaming, twice the 400 ms
        // read timeout: completes, because the timer resets on every chunk.
        let ms = std::time::Duration::from_millis;
        let url = slow_sse_server(8, ms(100), None);
        let n = drain(&build_stream_client(ms(400)), &url).await.unwrap();
        assert_eq!(
            n,
            (0..8)
                .map(|i| format!("data: {i}\n\n").len())
                .sum::<usize>()
        );
    }

    #[tokio::test]
    async fn stream_client_abandons_a_stalled_stream() {
        let ms = std::time::Duration::from_millis;
        let url = slow_sse_server(1, ms(10), Some(ms(1500)));
        let started = std::time::Instant::now();
        let err = drain(&build_stream_client(ms(300)), &url)
            .await
            .unwrap_err();
        assert!(err.is_timeout(), "a silent server is caught: {err}");
        assert!(started.elapsed() < ms(1200), "caught by the read timeout");
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
