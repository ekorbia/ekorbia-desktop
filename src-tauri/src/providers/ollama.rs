// SPDX-License-Identifier: MIT

//! The Ollama ADAPTER (no-Ollama plan, Phase 0): every byte of Ollama HTTP
//! lives in this file and nowhere else. The rest of the app speaks the
//! provider-neutral surface in `llm.rs` — this module implements it:
//! `chat` / `embed` / `chat_stream` (normalized via [`StreamNorm`] to the
//! neutral StreamEvent contract) / `list_models` / `loaded_models` /
//! `warmup` / `capabilities` + probes / `embed_model_check`.
//!
//! Ollama-*lifecycle* commands stay here under their own names —
//! `start_ollama`, `ollama_pull(_cancel)`, `ollama_delete` manage the
//! engine install itself, not "an LLM".
//!
//! `start_ollama` is a defensive multi-layer launcher: on macOS it first
//! tries `open -g -a Ollama` (uses the menu-bar app's GPU/env setup); if
//! that fails, it falls back to spawning `ollama serve` detached from a
//! list of known binary paths. The fallback uses `setsid()` on Unix so
//! Tauri exiting doesn't SIGHUP the child.

use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const OLLAMA_ADDR: &str = "127.0.0.1:11434";

/// HTTP base URL for Ollama's local API. Distinct from `OLLAMA_ADDR` (no
/// scheme, used for direct TCP probes in `is_ollama_listening`).
///
/// Uses `127.0.0.1` rather than `localhost` to force IPv4. On Windows,
/// reqwest's tokio resolver and the WebView2 used by the UI both resolve
/// `localhost` to BOTH `::1` (IPv6) and `127.0.0.1` (IPv4). Default
/// Ollama on Windows binds only to IPv4 — `::1` connections fail or
/// hang past our 3 s status-check timeout, and the app concludes
/// "Ollama not running" even when it is. Using `127.0.0.1` skips DNS
/// resolution entirely, eliminating the IPv4-vs-IPv6 race. Same fix on
/// every platform (linux/mac never had a problem, but consistency wins).
/// Use `ollama_url(path)` to build endpoint URLs.
const OLLAMA_BASE: &str = "http://127.0.0.1:11434";

/// Optional base-URL override, loaded from the settings key `llm_base_url`
/// at startup (lib.rs `setup()`; Phase 0 of the no-Ollama plan). `None` =
/// use the `OLLAMA_BASE` default. Empty/whitespace values normalize to
/// `None` and trailing slashes are stripped so `ollama_url("/api/…")`
/// never doubles a separator. No settings UI writes this until Phase 1 —
/// power users can set it via the generic `setting_set` command.
static BASE_URL_OVERRIDE: OnceLock<std::sync::RwLock<Option<String>>> = OnceLock::new();

fn base_url_override() -> &'static std::sync::RwLock<Option<String>> {
    BASE_URL_OVERRIDE.get_or_init(|| std::sync::RwLock::new(None))
}

pub(crate) fn set_base_url_override(url: Option<String>) {
    let cleaned = url
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty());
    if let Ok(mut w) = base_url_override().write() {
        *w = cleaned;
    }
}

fn ollama_url(path: &str) -> String {
    if let Ok(r) = base_url_override().read() {
        if let Some(base) = r.as_ref() {
            return format!("{base}{path}");
        }
    }
    format!("{OLLAMA_BASE}{path}")
}

/// Shared HTTP client for every Ollama endpoint. Built once, then handed
/// out by reference; `reqwest::Client` is Arc-backed internally so multiple
/// concurrent senders share the same connection pool. A 120s default
/// timeout covers `/api/chat` + `/api/embed` (the only endpoints that can
/// take that long). Faster endpoints (`/api/show` probe in
/// `embedding_model_check`) override per-request via `.timeout(...)`.
static OLLAMA_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn ollama_client() -> &'static reqwest::Client {
    OLLAMA_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            // Builder errors only on TLS init; fall back to bare default
            // so a background task can still try to limp along rather
            // than panicking inside a one-shot OnceLock initialiser.
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

// ── Model capability caches ─────────────────────────────────────────────────
//
// Ollama's /api/show returns a `capabilities` array including "vision" for
// multimodal models (gemma3, gemma4, llava, …) and "tools" for models that
// support function/tool calling (gemma4, llama3.1+, qwen2.5+, …). We cache
// per model id in memory so we don't hit /api/show on every send. The caches
// are invalidated on app restart, which is fine — capabilities don't change
// for a pulled model name.
//
// Both caches share `probe_capability()` so a single /api/show round-trip
// could populate either; in practice we call them independently because each
// caller only cares about one bit at a time.

static MODEL_VISION_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, bool>>,
> = std::sync::OnceLock::new();
static MODEL_TOOLS_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, bool>>,
> = std::sync::OnceLock::new();
// "thinking" = reasoning models (qwen3.x, deepseek-r1/v3.1, gpt-oss, …).
// Ollama auto-enables thinking on these UNLESS the request sets
// `think: false`, so we detect the capability to (a) badge it in the UI
// and (b) default thinking OFF for snappy replies. CRITICAL: sending
// `think` (even false) to a NON-thinking model is a 400 error, so this
// flag must gate every place we set the field.
static MODEL_THINKING_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, bool>>,
> = std::sync::OnceLock::new();

fn vision_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, bool>> {
    MODEL_VISION_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
fn tools_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, bool>> {
    MODEL_TOOLS_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
fn thinking_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, bool>> {
    MODEL_THINKING_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Generic capability check against /api/show. Reads the `capabilities`
/// array and returns true iff `needle` appears in it (case-sensitive — Ollama
/// uses lowercase canonical names like "vision", "tools").
async fn probe_capability(model: &str, needle: &str) -> Result<bool, String> {
    let body = serde_json::json!({ "model": model });
    let resp = ollama_client()
        .post(ollama_url("/api/show"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Ollama /api/show returned {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json["capabilities"]
        .as_array()
        .is_some_and(|caps| caps.iter().any(|v| v.as_str().is_some_and(|s| s == needle))))
}

pub(crate) async fn model_has_vision(model: &str) -> Result<bool, String> {
    if let Ok(cache) = vision_cache().lock() {
        if let Some(v) = cache.get(model) {
            return Ok(*v);
        }
    }
    let has = probe_capability(model, "vision").await?;
    if let Ok(mut cache) = vision_cache().lock() {
        cache.insert(model.to_string(), has);
    }
    Ok(has)
}

pub(crate) async fn model_has_tools(model: &str) -> Result<bool, String> {
    if let Ok(cache) = tools_cache().lock() {
        if let Some(v) = cache.get(model) {
            return Ok(*v);
        }
    }
    let has = probe_capability(model, "tools").await?;
    if let Ok(mut cache) = tools_cache().lock() {
        cache.insert(model.to_string(), has);
    }
    Ok(has)
}

pub(crate) async fn model_has_thinking(model: &str) -> Result<bool, String> {
    if let Ok(cache) = thinking_cache().lock() {
        if let Some(v) = cache.get(model) {
            return Ok(*v);
        }
    }
    let has = probe_capability(model, "thinking").await?;
    if let Ok(mut cache) = thinking_cache().lock() {
        cache.insert(model.to_string(), has);
    }
    Ok(has)
}

/// Adapter impl behind the neutral `llm_capabilities` command (llm.rs).
pub(crate) async fn capabilities(model: String) -> Result<crate::llm::ModelCapabilities, String> {
    let vision = model_has_vision(&model).await.unwrap_or(false);
    let tools = model_has_tools(&model).await.unwrap_or(false);
    let thinking = model_has_thinking(&model).await.unwrap_or(false);
    Ok(crate::llm::ModelCapabilities {
        vision,
        tools,
        thinking,
    })
}

// ── Ollama chat + embed HTTP ────────────────────────────────────────────────

/// POST a system + user message pair to Ollama's /api/chat with stream=false
/// and return the assistant's response. Using /api/chat (not /api/generate)
/// lets us pass an explicit `system` role for the user-selected prompt and
/// matches what the main composer does.
pub(crate) async fn chat(model: &str, system: &str, user: &str) -> Result<String, String> {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user",   "content": user },
        ],
        "stream": false,
    });
    // Reasoning models (qwen3.x, deepseek-r1, …) auto-enable thinking,
    // which would bloat a watch summary with a long chain-of-thought and
    // slow each poll. Force it off for these — but ONLY for them, since
    // sending `think` to a non-thinking model is a 400. Capability probe
    // failures fall through to the default (thinking left as-is).
    if model_has_thinking(model).await.unwrap_or(false) {
        body["think"] = serde_json::Value::Bool(false);
    }
    let resp = ollama_client()
        .post(ollama_url("/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama returned HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Bad JSON from Ollama: {e}"))?;
    json["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "Ollama response had no message.content".to_string())
}

/// POST a batch of texts to Ollama's /api/embed and return the embeddings
/// in the same order. Falls back to /api/embeddings (older, single-input)
/// if the newer endpoint returns 404 — keeps us compatible with older
/// Ollama installs without a version probe.
pub(crate) async fn embed(model: &str, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let client = ollama_client();
    // Try the newer batched endpoint first.
    let body = serde_json::json!({ "model": model, "input": texts });
    let resp = client
        .post(ollama_url("/api/embed"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama embed request failed: {e}"))?;
    if resp.status().is_success() {
        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let arr = json["embeddings"]
            .as_array()
            .ok_or("Ollama embed: missing `embeddings` array")?;
        let mut out: Vec<Vec<f32>> = Vec::with_capacity(arr.len());
        for v in arr {
            let row = v
                .as_array()
                .ok_or("Ollama embed: non-array embedding row")?
                .iter()
                .map(|x| x.as_f64().unwrap_or(0.0) as f32)
                .collect();
            out.push(row);
        }
        return Ok(out);
    }
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        // Older Ollama — fall back to /api/embeddings (one text per call).
        let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
        for t in texts {
            let body = serde_json::json!({ "model": model, "prompt": t });
            let r = client
                .post(ollama_url("/api/embeddings"))
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !r.status().is_success() {
                return Err(format!(
                    "Ollama /api/embeddings returned {} (model `{model}` may not be pulled)",
                    r.status()
                ));
            }
            let j: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
            let row = j["embedding"]
                .as_array()
                .ok_or("Ollama /api/embeddings: missing `embedding`")?
                .iter()
                .map(|x| x.as_f64().unwrap_or(0.0) as f32)
                .collect();
            out.push(row);
        }
        return Ok(out);
    }
    Err(format!(
        "Ollama /api/embed returned {} (model `{model}` may not be pulled — run `ollama pull {model}`)",
        resp.status()
    ))
}

/// Probe whether the configured embedding model is pulled. Used by the UI
/// to show a helpful "ollama pull nomic-embed-text" hint before the user
/// tries to attach a large file. The check is just `/api/show` — if Ollama
/// returns 200 the model exists; 404 means not pulled; anything else (e.g.
/// connection refused) is treated as "unknown" → installed: false.
/// Adapter impl behind the neutral `llm_embed_model_check` command (llm.rs
/// resolves the configured model name and builds the response struct).
pub(crate) async fn embed_model_installed(model: &str) -> bool {
    let body = serde_json::json!({ "model": model });
    // UI feedback probe — override the shared client's generous default to
    // 3s. reqwest applies min(client_timeout, request_timeout), so this
    // short-circuits when Ollama isn't responding instead of stalling the
    // settings panel for 2 minutes.
    let r = ollama_client()
        .post(ollama_url("/api/show"))
        .timeout(Duration::from_secs(3))
        .json(&body)
        .send()
        .await;
    matches!(r, Ok(ref resp) if resp.status().is_success())
}

// ── UI-facing proxies for Ollama HTTP endpoints (Phase B.1) ────────────────
//
// These commands exist because the UI's direct `fetch("http://127.0.0.1:11434")`
// calls fail on Windows due to WebView2's Private Network Access (PNA)
// preflight enforcement: a fetch from the app's `tauri://localhost` origin
// to 127.0.0.1 triggers a CORS preflight asking for
// `Access-Control-Allow-Private-Network: true`, which Ollama doesn't send
// by default. macOS WebKit and Linux WebKitGTK don't enforce PNA yet, so
// the bug only surfaced on Windows.
//
// Routing through Rust completely bypasses the browser network stack —
// reqwest connects via OS sockets, no preflight, no CORS, no PNA. Same
// fix works on every platform. Each command mirrors the response shape
// the UI used to consume directly, so the JS-side data handling is
// untouched aside from `fetch(...).then(r => r.json())` becoming
// `await invoke(...)`.
//
// The streaming `/api/chat` endpoint uses a separate `ollama_chat_stream`
// command via `Channel<T>` (Phase B.2) because Tauri commands can't
// natively return a streamed body.

/// Wrap GET /api/tags. Returns the raw `{ models: [...] }` payload as
/// `serde_json::Value` so the UI can keep accessing `.models` the same
/// way it did when this was a `fetch().json()` call. 3-second per-request
/// timeout matches the previous `AbortSignal.timeout(3000)`.
/// Adapter impl behind the neutral `llm_list_models` command (llm.rs).
pub(crate) async fn list_models() -> Result<serde_json::Value, String> {
    let resp = ollama_client()
        .get(ollama_url("/api/tags"))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|e| format!("Ollama /api/tags request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama /api/tags returned {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Bad JSON from /api/tags: {e}"))
}

/// Wrap GET /api/ps — currently-loaded models. 2-second timeout matches
/// the previous UI behaviour; this endpoint is called from the status
/// bar's polling loop, so a tighter ceiling keeps the UI responsive when
/// Ollama is unreachable.
/// Adapter impl behind the neutral `llm_loaded_models` command (llm.rs).
pub(crate) async fn loaded_models() -> Result<serde_json::Value, String> {
    let resp = ollama_client()
        .get(ollama_url("/api/ps"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map_err(|e| format!("Ollama /api/ps request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama /api/ps returned {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Bad JSON from /api/ps: {e}"))
}

/// Wrap POST /api/generate — fire-and-forget, used only by the model
/// warm-up path in `main.jsx` (`{ prompt: "hi", num_predict: 1 }`).
/// Accepts an arbitrary JSON body so the UI can evolve its warming
/// payload without a Rust change. Response body is intentionally
/// discarded; the caller only cares that the request reached Ollama
/// (which forces the model into RAM as a side effect).
/// Adapter impl behind the neutral `llm_warmup` command (llm.rs).
pub(crate) async fn warmup(body: serde_json::Value) -> Result<(), String> {
    let resp = ollama_client()
        .post(ollama_url("/api/generate"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama /api/generate request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama /api/generate returned {}", resp.status()));
    }
    Ok(())
}

// ── Streaming chat proxy (Phase B.2) ───────────────────────────────────────
//
// The UI used to POST /api/chat directly and consume the response body as a
// stream of newline-delimited JSON objects. On Windows that fetch is gated
// by WebView2's Private Network Access enforcement and silently fails (see
// the B.1 block above for the full story).
//
// `ollama_chat_stream` mirrors the same protocol — POST the same body Ollama
// expects, consume the response chunk by chunk, parse out complete NDJSON
// lines, and forward each one as a `serde_json::Value` through a Tauri
// `Channel<T>` to the JS caller. The UI's `consumeLine()` then sees the
// same parsed-object shape it used to get from `JSON.parse(line)`. No
// schema is hardcoded on the Rust side because Ollama's chunk shape varies
// across endpoints and model versions — keeping the wire format opaque
// here makes us forwards-compatible.
//
// Cancellation: the UI calls `ollama_chat_stream_cancel(request_id)` when
// the user hits Stop. We poll a per-request `AtomicBool` at chunk
// boundaries — latency is sub-second on any reasonable model (the gap
// between two emitted tokens). For a more aggressive interrupt we'd need
// `tokio::select!` against a Notify — overkill for B.2 v1.

/// Normalizer for Ollama's chat-stream chunks → the neutral
/// [`crate::llm::StreamEvent`] contract. This is where the adapter absorbs
/// every Ollama quirk so the UI never sees them:
///
///   - `message.tool_calls` may arrive on any chunk but in practice only on
///     the `done: true` chunk. We ACCUMULATE across chunks and emit ONE
///     `toolCalls` event right before `done` — post-stream reads were
///     already the documented contract (never stream tool_calls
///     progressively), now it's structural.
///   - `function.arguments` arrives as an object OR a JSON-encoded string
///     depending on the model. Normalized to always-an-object;
///     unparseable strings become `{}` (the tool executor's existing
///     defensive default).
///   - In-band errors (`{"error": "…"}`, HTTP 200) become an `error`
///     event.
///   - `prompt_eval_count` / `eval_count` map to promptTokens /
///     outputTokens on `done`, defaulting to 0 when absent.
pub(crate) struct StreamNorm {
    tool_calls: Vec<serde_json::Value>,
}

impl StreamNorm {
    pub(crate) fn new() -> Self {
        Self {
            tool_calls: Vec::new(),
        }
    }

    pub(crate) fn ingest(&mut self, raw: &serde_json::Value) -> Vec<crate::llm::StreamEvent> {
        use crate::llm::StreamEvent as E;
        let mut out = Vec::new();
        if let Some(msg) = raw.get("error").and_then(|v| v.as_str()) {
            out.push(E::Error {
                message: msg.to_string(),
            });
            return out;
        }
        if let Some(text) = raw.pointer("/message/content").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                out.push(E::Delta {
                    text: text.to_string(),
                });
            }
        }
        if let Some(calls) = raw
            .pointer("/message/tool_calls")
            .and_then(|v| v.as_array())
        {
            for c in calls {
                self.tool_calls.push(normalize_tool_call(c));
            }
        }
        if raw.get("done").and_then(|v| v.as_bool()).unwrap_or(false) {
            if !self.tool_calls.is_empty() {
                out.push(E::ToolCalls {
                    calls: std::mem::take(&mut self.tool_calls),
                });
            }
            out.push(E::Done {
                prompt_tokens: raw
                    .get("prompt_eval_count")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                output_tokens: raw.get("eval_count").and_then(|v| v.as_u64()).unwrap_or(0),
            });
        }
        out
    }
}

/// Coerce one tool call's `function.arguments` to always-an-object.
fn normalize_tool_call(call: &serde_json::Value) -> serde_json::Value {
    let mut c = call.clone();
    let normalized = match c.pointer("/function/arguments") {
        Some(serde_json::Value::String(s)) => serde_json::from_str::<serde_json::Value>(s)
            .ok()
            .filter(|v| v.is_object())
            .unwrap_or_else(|| serde_json::json!({})),
        Some(v) if v.is_object() => return c,
        _ => serde_json::json!({}),
    };
    if let Some(f) = c.get_mut("function") {
        f["arguments"] = normalized;
    }
    c
}

/// Stream `/api/chat`'s NDJSON response to the JS caller via a Tauri
/// Channel, normalized to the neutral [`crate::llm::StreamEvent`] shape.
/// Adapter impl behind the neutral `llm_chat_stream` command (llm.rs).
///
/// `request_id` is the UI's logical identifier for this stream — typically
/// the assistant message id. The UI uses the same id to cancel via
/// `llm_chat_stream_cancel`.
///
/// `body` is forwarded verbatim to Ollama. We don't validate it because
/// the UI assembles different shapes (tools array present or absent, image
/// attachments, etc.) and any breaking change to that shape would be a
/// UI-side bug regardless of what Rust does. (Neutralizing the REQUEST
/// shape is Phase 1 scope — the OpenAI-compat adapter will translate.)
///
/// If JS drops the channel (window closes, user navigates away),
/// `on_chunk.send` returns Err on the next event and we treat it as a
/// graceful cancel.
pub(crate) async fn chat_stream(
    request_id: String,
    body: serde_json::Value,
    on_chunk: tauri::ipc::Channel<crate::llm::StreamEvent>,
) -> Result<(), String> {
    let token = crate::providers::register_cancel(&request_id);
    let cancel = token.flag.clone();

    let mut resp = ollama_client()
        .post(ollama_url("/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama /api/chat request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama /api/chat returned {}", resp.status()));
    }

    let mut norm = StreamNorm::new();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let next = resp
            .chunk()
            .await
            .map_err(|e| format!("Ollama stream read failed: {e}"))?;
        let bytes = match next {
            Some(b) => b,
            None => break, // end of stream
        };
        buf.extend_from_slice(&bytes);
        // Drain complete lines. Each NDJSON line is one JSON object plus
        // a trailing '\n'. We strip the newline before parsing.
        while let Some(nl_pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl_pos).collect();
            // `line` includes the trailing newline — slice it off.
            let body = if line.last() == Some(&b'\n') {
                &line[..line.len() - 1]
            } else {
                &line[..]
            };
            let s = match std::str::from_utf8(body) {
                Ok(s) => s.trim(),
                Err(_) => continue, // skip non-UTF-8 fragments
            };
            if s.is_empty() {
                continue;
            }
            match serde_json::from_str::<serde_json::Value>(s) {
                Ok(obj) => {
                    for ev in norm.ingest(&obj) {
                        // Channel send failure = JS handle dropped (user
                        // closed the window or component unmounted). Treat
                        // as cancellation — return Ok so the caller sees a
                        // clean resolution rather than an error.
                        if on_chunk.send(ev).is_err() {
                            return Ok(());
                        }
                    }
                }
                Err(_) => continue, // malformed line, keep going
            }
        }
    }

    // Final partial line (no trailing newline). Ollama always terminates
    // with '\n' in practice, but flushing here keeps us robust against
    // servers that don't.
    if !buf.is_empty() {
        if let Ok(s) = std::str::from_utf8(&buf) {
            let s = s.trim();
            if !s.is_empty() {
                if let Ok(obj) = serde_json::from_str::<serde_json::Value>(s) {
                    for ev in norm.ingest(&obj) {
                        let _ = on_chunk.send(ev);
                    }
                }
            }
        }
    }

    Ok(())
}

// ── Model pull / delete (in-app model manager) ─────────────────────────────
//
// `ollama_pull` streams /api/pull's NDJSON progress to the UI over a Tauri
// Channel — the same shape and cancellation model as `ollama_chat_stream`
// above, with one deliberate difference:
//
//   • Timeout: the shared client's 120s default is a TOTAL request timeout
//     in reqwest — it covers the entire streamed body, not just the first
//     byte. A multi-GB pull takes far longer, so we override per-request
//     to 24h (the per-request value overrides the client default).
//
// Cancellation is checked between chunks (cancel latency = time to the next
// progress line, sub-second during an active download). We deliberately do
// NOT wrap the chunk read in a per-iteration tokio::time::timeout: on elapse
// that drops the partially-polled body future, and re-issuing chunk()
// corrupts reqwest's stream so it ends early — which made real downloads
// report failure almost immediately. See the loop body for the full note.
//
// Cancellation shares the chat registry. The UI namespaces pull request
// ids as `pull:<model>:<nonce>` so they can never collide with chat
// message ids (the RAII Drop removes entries by id — a collision would
// let one stream's cleanup orphan the other's flag).
//
// Progress chunk shapes the UI consumes (see accumulatePullProgress in
// ui/utils.js): `{"status":"pulling <digest>","digest":"…","total":N,
// "completed":N}` per layer, bare `{"status":"…"}` lines between phases,
// `{"status":"success"}` last, or `{"error":"…"}` on failure (HTTP 200).

/// Body for POST /api/pull. `model` is the documented key on current
/// Ollama; older builds used `name`. Unknown fields are ignored, so
/// sending both works everywhere without a version probe.
fn pull_request_body(model: &str) -> serde_json::Value {
    serde_json::json!({ "model": model, "name": model, "stream": true })
}

#[tauri::command]
pub(crate) async fn ollama_pull(
    request_id: String,
    model: String,
    on_progress: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    let token = crate::providers::register_cancel(&request_id);
    let cancel = token.flag.clone();

    let mut resp = ollama_client()
        .post(ollama_url("/api/pull"))
        // Total-request timeout override — see module comment above.
        .timeout(Duration::from_secs(24 * 60 * 60))
        .json(&pull_request_body(&model))
        .send()
        .await
        .map_err(|e| format!("Ollama /api/pull request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama /api/pull returned {}", resp.status()));
    }

    let mut buf: Vec<u8> = Vec::new();
    loop {
        // Cancellation is observed between chunks — exactly like
        // ollama_chat_stream. During an active pull Ollama emits progress
        // lines frequently, so cancel latency is sub-second.
        //
        // CRITICAL: do NOT wrap resp.chunk() in tokio::time::timeout. On
        // elapse, timeout drops the partially-polled body future; re-issuing
        // chunk() on the next iteration corrupts reqwest's stream and it
        // ends early. That made a real multi-second download bail out almost
        // immediately (success line never seen → pull reported as failed)
        // while Ollama kept downloading in the background. The mocked tests
        // never caught it because they don't stream a real HTTP body.
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let next = resp
            .chunk()
            .await
            .map_err(|e| format!("Ollama pull stream read failed: {e}"))?;
        let bytes = match next {
            Some(b) => b,
            None => break, // end of stream
        };
        buf.extend_from_slice(&bytes);
        while let Some(nl_pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl_pos).collect();
            let body = if line.last() == Some(&b'\n') {
                &line[..line.len() - 1]
            } else {
                &line[..]
            };
            let s = match std::str::from_utf8(body) {
                Ok(s) => s.trim(),
                Err(_) => continue,
            };
            if s.is_empty() {
                continue;
            }
            if let Ok(obj) = serde_json::from_str::<serde_json::Value>(s) {
                // Channel send failure = JS handle dropped. Graceful cancel,
                // same contract as the chat stream.
                if on_progress.send(obj).is_err() {
                    return Ok(());
                }
            }
        }
    }

    // Flush a final partial line, mirroring ollama_chat_stream.
    if !buf.is_empty() {
        if let Ok(s) = std::str::from_utf8(&buf) {
            let s = s.trim();
            if !s.is_empty() {
                if let Ok(obj) = serde_json::from_str::<serde_json::Value>(s) {
                    let _ = on_progress.send(obj);
                }
            }
        }
    }

    Ok(())
}

/// Cancel a running `ollama_pull`. Shares the chat-cancel registry — pull
/// ids are namespaced (`pull:<model>:<nonce>`) by the UI so they can't
/// collide with chat message ids. No-op for unknown ids.
#[tauri::command]
pub(crate) fn ollama_pull_cancel(request_id: String) {
    crate::providers::cancel(&request_id);
}

/// Remove a pulled model from Ollama's local store via DELETE /api/delete.
/// Same dual-key body hedge as `pull_request_body`.
#[tauri::command]
pub(crate) async fn ollama_delete(model: String) -> Result<(), String> {
    let resp = ollama_client()
        .delete(ollama_url("/api/delete"))
        .json(&serde_json::json!({ "model": &model, "name": &model }))
        .send()
        .await
        .map_err(|e| format!("Ollama /api/delete request failed: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("Model `{model}` is not pulled, nothing to delete"));
    }
    if !resp.status().is_success() {
        return Err(format!("Ollama /api/delete returned {}", resp.status()));
    }
    Ok(())
}

// ── Process startup ────────────────────────────────────────────────────────

/// Quick sync check: is *something* listening on Ollama's port?
fn is_ollama_listening() -> bool {
    let addr: SocketAddr = match OLLAMA_ADDR.parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Poll the port until something binds it, or the deadline expires.
async fn wait_for_ollama(secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if is_ollama_listening() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    false
}

/// Spawn `ollama serve` detached so it survives Tauri exiting.
/// On Unix, `setsid()` puts the child in its own session — no controlling
/// terminal, no parent process group — so SIGHUP from our exit doesn't kill it.
#[cfg(unix)]
fn spawn_ollama_detached(bin: &str) -> Result<(), String> {
    use std::os::unix::process::CommandExt;

    let mut cmd = std::process::Command::new(bin);
    cmd.arg("serve")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    // Safety: pre_exec runs in the forked child before exec. setsid is
    // async-signal-safe per POSIX, so it's valid here.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn spawn_ollama_detached(bin: &str) -> Result<(), String> {
    std::process::Command::new(bin)
        .arg("serve")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn start_ollama(app: tauri::AppHandle) -> Result<(), String> {
    // Already running? Nothing to do.
    if is_ollama_listening() {
        return Ok(());
    }

    // Layer 1 (macOS): open the Ollama menu-bar app. This is the OS-blessed
    // path — it handles env, GPU access, login items, and the binary lookup.
    //
    // `use tauri::Manager` is scoped to this cfg block because Linux /
    // Windows code paths below never call `get_webview_window` — leaving
    // the import at function scope would fire an unused-import warning
    // there, which clippy's `-D warnings` turns into a hard error.
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        // `-g` asks open(1) not to foreground the app, but Ollama calls
        // activateIgnoringOtherApps on launch and overrides it — so we still
        // have to reclaim focus afterwards.
        let opened = std::process::Command::new("open")
            .args(["-g", "-a", "Ollama"])
            .status()
            .is_ok_and(|s| s.success());
        if opened && wait_for_ollama(15).await {
            // Pull focus back to Ekorbia. set_focus() calls
            // activateIgnoringOtherApps under the hood — it wins the race
            // because we run it after Ollama has finished activating.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
            return Ok(());
        }
        // Either Ollama.app isn't installed, or the app launched but didn't
        // bind 11434 (e.g. first-run setup wizard). Fall through to direct spawn.
    }

    // Suppress "unused" warning on non-macOS where `app` isn't otherwise read.
    let _ = &app;

    // Layer 2: spawn `ollama serve` from a known binary path, detached.
    let candidates = [
        "/usr/local/bin/ollama",
        "/opt/homebrew/bin/ollama",
        "/Applications/Ollama.app/Contents/Resources/ollama",
        "/opt/local/bin/ollama",
        "/usr/bin/ollama",
    ];

    let mut last_err: Option<String> = None;
    for bin in &candidates {
        if !Path::new(bin).exists() {
            continue;
        }
        match spawn_ollama_detached(bin) {
            Ok(()) => {
                if wait_for_ollama(15).await {
                    return Ok(());
                }
                last_err = Some(format!(
                    "Started {bin} serve, but Ollama did not bind to port 11434 within 15 seconds. \
                     Try running `{bin} serve` manually to see the error."
                ));
            }
            Err(e) => {
                last_err = Some(format!("Failed to spawn {bin}: {e}"));
            }
        }
    }

    Err(last_err.unwrap_or_else(|| {
        "Ollama is not installed. Download it from https://ollama.com, \
         or install the CLI and ensure it is on your PATH."
            .to_string()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression guard for the Windows WebView2 Private Network Access
    /// bug fixed in 0.3.0-rc1/rc2. The constant MUST use IPv4 literal
    /// `127.0.0.1` — never `localhost`. WebView2 resolves `localhost`
    /// to IPv6 `::1` first; default Ollama on Windows binds only to
    /// IPv4 so the IPv6 connection fails or hangs past our 3s status
    /// check, and Ekorbia would mistakenly conclude "Ollama not
    /// running." If anyone tries to "clean up" the constant by going
    /// back to `localhost`, this test fails loud.
    #[test]
    fn ollama_base_uses_ipv4_literal() {
        assert_eq!(OLLAMA_BASE, "http://127.0.0.1:11434");
        assert!(
            !OLLAMA_BASE.contains("localhost"),
            "OLLAMA_BASE must NOT use 'localhost' — see WebView2 PNA note"
        );
        assert_eq!(OLLAMA_ADDR, "127.0.0.1:11434");
    }

    /// Same intent for the URL builder — plus the Phase 0 settings
    /// override behaviour. Default, override, and reset assertions live in
    /// ONE test because the override is a process-global: splitting them
    /// across tests would race under cargo's parallel test runner.
    #[test]
    fn ollama_url_default_override_and_reset() {
        assert_eq!(ollama_url("/api/tags"), "http://127.0.0.1:11434/api/tags");
        assert_eq!(ollama_url(""), "http://127.0.0.1:11434");

        // Override honored; trailing slash + whitespace normalized.
        set_base_url_override(Some("  http://192.168.1.50:11434/  ".to_string()));
        assert_eq!(
            ollama_url("/api/tags"),
            "http://192.168.1.50:11434/api/tags"
        );

        // Empty/whitespace values normalize to "no override".
        set_base_url_override(Some("   ".to_string()));
        assert_eq!(ollama_url("/api/tags"), "http://127.0.0.1:11434/api/tags");

        // Explicit reset returns to the IPv4 default.
        set_base_url_override(Some("http://10.0.0.9:8080".to_string()));
        set_base_url_override(None);
        assert_eq!(ollama_url("/api/tags"), "http://127.0.0.1:11434/api/tags");
    }

    // ── StreamNorm golden tests: raw Ollama NDJSON → neutral events ────────

    use crate::llm::StreamEvent as E;

    fn ingest_all(lines: &[&str]) -> Vec<E> {
        let mut norm = StreamNorm::new();
        lines
            .iter()
            .flat_map(|l| norm.ingest(&serde_json::from_str(l).unwrap()))
            .collect()
    }

    #[test]
    fn norm_content_chunks_become_deltas_and_done_carries_counts() {
        let evs = ingest_all(&[
            r#"{"message":{"role":"assistant","content":"Hel"},"done":false}"#,
            r#"{"message":{"role":"assistant","content":"lo"},"done":false}"#,
            r#"{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":12,"eval_count":34}"#,
        ]);
        assert_eq!(
            evs,
            vec![
                E::Delta { text: "Hel".into() },
                E::Delta { text: "lo".into() },
                E::Done {
                    prompt_tokens: 12,
                    output_tokens: 34
                },
            ]
        );
    }

    #[test]
    fn norm_missing_counts_default_to_zero() {
        let evs = ingest_all(&[r#"{"message":{"content":""},"done":true}"#]);
        assert_eq!(
            evs,
            vec![E::Done {
                prompt_tokens: 0,
                output_tokens: 0
            }]
        );
    }

    #[test]
    fn norm_tool_calls_in_done_chunk_emit_once_before_done() {
        // The documented Ollama shape: tool_calls arrive ON the done chunk.
        let evs = ingest_all(&[
            r#"{"message":{"content":"thinking"},"done":false}"#,
            r#"{"message":{"content":"","tool_calls":[{"function":{"name":"write_file","arguments":{"path":"a.txt","contents":"x"}}}]},"done":true,"eval_count":5}"#,
        ]);
        assert_eq!(evs.len(), 3);
        assert_eq!(
            evs[0],
            E::Delta {
                text: "thinking".into()
            }
        );
        match &evs[1] {
            E::ToolCalls { calls } => {
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0]["function"]["arguments"]["path"], "a.txt");
            }
            other => panic!("expected toolCalls, got {other:?}"),
        }
        assert_eq!(
            evs[2],
            E::Done {
                prompt_tokens: 0,
                output_tokens: 5
            }
        );
    }

    #[test]
    fn norm_tool_calls_accumulate_across_chunks_and_emit_at_done() {
        // Defensive: if a model DOES stream calls early, they still arrive
        // as one toolCalls event at done — never progressively.
        let evs = ingest_all(&[
            r#"{"message":{"content":"","tool_calls":[{"function":{"name":"write_file","arguments":{"path":"1"}}}]},"done":false}"#,
            r#"{"message":{"content":"","tool_calls":[{"function":{"name":"write_file","arguments":{"path":"2"}}}]},"done":true}"#,
        ]);
        assert_eq!(evs.len(), 2, "one toolCalls + one done, no early emit");
        match &evs[0] {
            E::ToolCalls { calls } => {
                assert_eq!(calls.len(), 2);
                assert_eq!(calls[0]["function"]["arguments"]["path"], "1");
                assert_eq!(calls[1]["function"]["arguments"]["path"], "2");
            }
            other => panic!("expected toolCalls, got {other:?}"),
        }
    }

    #[test]
    fn norm_string_args_parse_to_object_and_garbage_becomes_empty() {
        // The object-or-JSON-string quirk is absorbed HERE — JS never sees
        // a string-typed arguments field again.
        let evs = ingest_all(&[r#"{"message":{"content":"","tool_calls":[
                {"function":{"name":"write_file","arguments":"{\"path\":\"x.md\",\"contents\":\"hi\"}"}},
                {"function":{"name":"write_file","arguments":"not json"}},
                {"function":{"name":"write_file"}}
            ]},"done":true}"#]);
        match &evs[0] {
            E::ToolCalls { calls } => {
                assert_eq!(calls[0]["function"]["arguments"]["path"], "x.md");
                assert!(calls[1]["function"]["arguments"].is_object());
                assert_eq!(calls[1]["function"]["arguments"], serde_json::json!({}));
                assert_eq!(calls[2]["function"]["arguments"], serde_json::json!({}));
            }
            other => panic!("expected toolCalls, got {other:?}"),
        }
    }

    #[test]
    fn norm_error_chunk_becomes_error_event() {
        let evs = ingest_all(&[r#"{"error":"model 'nope' not found"}"#]);
        assert_eq!(
            evs,
            vec![E::Error {
                message: "model 'nope' not found".into()
            }]
        );
    }

    #[test]
    fn norm_empty_content_and_thinking_fields_emit_nothing() {
        // Reasoning models stream a `thinking` field we don't render;
        // empty content chunks must not produce empty deltas.
        let evs =
            ingest_all(&[r#"{"message":{"content":"","thinking":"step 1..."},"done":false}"#]);
        assert!(evs.is_empty());
    }

    #[test]
    fn stream_event_wire_shape_is_stable() {
        // The UI's consumeChunk switches on these exact strings — pin them.
        assert_eq!(
            serde_json::to_value(E::Delta { text: "x".into() }).unwrap(),
            serde_json::json!({"type":"delta","text":"x"})
        );
        assert_eq!(
            serde_json::to_value(E::Done {
                prompt_tokens: 1,
                output_tokens: 2
            })
            .unwrap(),
            serde_json::json!({"type":"done","promptTokens":1,"outputTokens":2})
        );
        assert_eq!(
            serde_json::to_value(E::Error {
                message: "m".into()
            })
            .unwrap(),
            serde_json::json!({"type":"error","message":"m"})
        );
        let tc = serde_json::to_value(E::ToolCalls { calls: vec![] }).unwrap();
        assert_eq!(tc["type"], "toolCalls");
    }

    /// Cancel registry happy path: register inserts an entry whose
    /// flag is initially false; explicit cancel flips the flag to
    /// true and removes the entry.

    /// Cancel registry drop semantics: the registry slot is removed
    /// when the token is dropped (normal scope exit). The Arc<AtomicBool>
    /// the spawned task may still hold via clone() is independent — it
    /// just stops being reachable through the registry.

    /// `ollama_chat_stream_cancel` is safe to call for an unknown id —
    /// no panic, no error. Matches the attachments cancel registry's
    /// /api/pull body must carry BOTH `model` (current Ollama) and `name`
    /// (older builds) plus `stream: true`. Sending both keys is the
    /// version-compatibility hedge — if someone "cleans up" the duplicate
    /// key, old Ollama installs silently stop pulling.
    #[test]
    fn pull_request_body_carries_both_keys_and_stream() {
        let body = pull_request_body("gemma4:e4b");
        assert_eq!(body["model"], "gemma4:e4b");
        assert_eq!(body["name"], "gemma4:e4b");
        assert_eq!(body["stream"], true);
    }
}
