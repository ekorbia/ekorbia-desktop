// SPDX-License-Identifier: MIT

//! Ollama integration: process startup, HTTP helpers (`ollama_chat`,
//! `ollama_embed`), and capability probes (`model_has_vision`,
//! `model_has_tools`, `model_capabilities`).
//!
//! `start_ollama` is a defensive multi-layer launcher: on macOS it first
//! tries `open -g -a Ollama` (uses the menu-bar app's GPU/env setup); if
//! that fails, it falls back to spawning `ollama serve` detached from a
//! list of known binary paths. The fallback uses `setsid()` on Unix so
//! Tauri exiting doesn't SIGHUP the child.

use serde::Serialize;
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
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

fn ollama_url(path: &str) -> String {
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

fn vision_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, bool>> {
    MODEL_VISION_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
fn tools_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, bool>> {
    MODEL_TOOLS_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelCapabilities {
    vision: bool,
    tools: bool,
}

#[tauri::command]
pub(crate) async fn model_capabilities(model: String) -> Result<ModelCapabilities, String> {
    let vision = model_has_vision(&model).await.unwrap_or(false);
    let tools = model_has_tools(&model).await.unwrap_or(false);
    Ok(ModelCapabilities { vision, tools })
}

// ── Ollama chat + embed HTTP ────────────────────────────────────────────────

/// POST a system + user message pair to Ollama's /api/chat with stream=false
/// and return the assistant's response. Using /api/chat (not /api/generate)
/// lets us pass an explicit `system` role for the user-selected prompt and
/// matches what the main composer does.
pub(crate) async fn ollama_chat(model: &str, system: &str, user: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user",   "content": user },
        ],
        "stream": false,
    });
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
pub(crate) async fn ollama_embed(model: &str, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddingModelCheck {
    installed: bool,
    model: String,
}

/// Probe whether the configured embedding model is pulled. Used by the UI
/// to show a helpful "ollama pull nomic-embed-text" hint before the user
/// tries to attach a large file. The check is just `/api/show` — if Ollama
/// returns 200 the model exists; 404 means not pulled; anything else (e.g.
/// connection refused) is treated as "unknown" → installed: false.
#[tauri::command]
pub(crate) async fn embedding_model_check(
    app: tauri::AppHandle,
) -> Result<EmbeddingModelCheck, String> {
    let model = crate::attachments::config::current_embedding_model(&app);
    let body = serde_json::json!({ "model": &model });
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
    let installed = matches!(r, Ok(ref resp) if resp.status().is_success());
    Ok(EmbeddingModelCheck { installed, model })
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
#[tauri::command]
pub(crate) async fn ollama_tags() -> Result<serde_json::Value, String> {
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
#[tauri::command]
pub(crate) async fn ollama_ps() -> Result<serde_json::Value, String> {
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
#[tauri::command]
pub(crate) async fn ollama_generate(body: serde_json::Value) -> Result<(), String> {
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

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;

static CHAT_CANCELS: OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
> = OnceLock::new();

fn chat_cancel_registry(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>> {
    CHAT_CANCELS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// RAII guard for a registered chat-cancel slot. Holding this keeps the
/// flag's Arc alive in the registry. Drop removes the entry — runs on
/// normal return, early-break, AND panic-unwind, so the map can't leak.
/// Mirrors the `CancelToken` in attachments/cancel.rs.
struct ChatCancelToken {
    id: String,
    flag: Arc<AtomicBool>,
}

impl Drop for ChatCancelToken {
    fn drop(&mut self) {
        if let Ok(mut m) = chat_cancel_registry().lock() {
            m.remove(&self.id);
        }
    }
}

fn register_chat_cancel(id: &str) -> ChatCancelToken {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut m) = chat_cancel_registry().lock() {
        m.insert(id.to_string(), flag.clone());
    }
    ChatCancelToken {
        id: id.to_string(),
        flag,
    }
}

/// Flip the cancel flag for `request_id`. The running stream picks it up
/// at the next chunk boundary and exits cleanly, the Tauri command
/// returns Ok, and the JS-side `invoke` promise resolves. Safe to call
/// when no stream is registered — the lookup just no-ops.
#[tauri::command]
pub(crate) fn ollama_chat_stream_cancel(request_id: String) {
    if let Ok(m) = chat_cancel_registry().lock() {
        if let Some(flag) = m.get(&request_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Stream `/api/chat`'s NDJSON response to the JS caller via a Tauri
/// Channel.
///
/// `request_id` is the UI's logical identifier for this stream — typically
/// the assistant message id. The UI uses the same id to cancel via
/// `ollama_chat_stream_cancel`.
///
/// `body` is forwarded verbatim to Ollama. We don't validate it because
/// the UI assembles different shapes (tools array present or absent, image
/// attachments, etc.) and any breaking change to that shape would be a
/// UI-side bug regardless of what Rust does.
///
/// `on_chunk` receives one parsed `serde_json::Value` per complete NDJSON
/// line. The final chunk carries `done: true` plus token counts. If JS
/// drops the channel (window closes, user navigates away), `on_chunk.send`
/// returns Err on the next chunk and we treat it as a graceful cancel.
#[tauri::command]
pub(crate) async fn ollama_chat_stream(
    request_id: String,
    body: serde_json::Value,
    on_chunk: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    let token = register_chat_cancel(&request_id);
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
                    // Channel send failure = JS handle dropped (user
                    // closed the window or component unmounted). Treat
                    // as cancellation — return Ok so the caller sees a
                    // clean resolution rather than an error.
                    if on_chunk.send(obj).is_err() {
                        return Ok(());
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
                    let _ = on_chunk.send(obj);
                }
            }
        }
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

    /// Same intent for the URL builder.
    #[test]
    fn ollama_url_concatenates_base_and_path() {
        assert_eq!(ollama_url("/api/tags"), "http://127.0.0.1:11434/api/tags");
        assert_eq!(ollama_url(""), "http://127.0.0.1:11434");
    }

    /// Cancel registry happy path: register inserts an entry whose
    /// flag is initially false; explicit cancel flips the flag to
    /// true and removes the entry.
    #[test]
    fn chat_cancel_registry_register_and_cancel() {
        let id = "test-cancel-happy";
        let token = register_chat_cancel(id);
        assert!(!token.flag.load(Ordering::Relaxed));
        // Registry entry exists while the token is alive.
        {
            let m = chat_cancel_registry().lock().unwrap();
            assert!(m.contains_key(id));
        }
        // Explicit cancel flips the shared flag.
        ollama_chat_stream_cancel(id.to_string());
        assert!(token.flag.load(Ordering::Relaxed));
        // Drop cleanup happens at end of scope below.
        drop(token);
    }

    /// Cancel registry drop semantics: the registry slot is removed
    /// when the token is dropped (normal scope exit). The Arc<AtomicBool>
    /// the spawned task may still hold via clone() is independent — it
    /// just stops being reachable through the registry.
    #[test]
    fn chat_cancel_registry_drop_removes_entry() {
        let id = "test-cancel-drop";
        {
            let _token = register_chat_cancel(id);
            let m = chat_cancel_registry().lock().unwrap();
            assert!(m.contains_key(id));
        }
        // _token dropped — registry entry should be gone.
        let m = chat_cancel_registry().lock().unwrap();
        assert!(!m.contains_key(id));
    }

    /// `ollama_chat_stream_cancel` is safe to call for an unknown id —
    /// no panic, no error. Matches the attachments cancel registry's
    /// "lookup misses are silent" contract.
    #[test]
    fn chat_cancel_unknown_id_is_no_op() {
        // No panic, no side effect we can observe (since there's no
        // registered entry). Just call it.
        ollama_chat_stream_cancel("never-registered".to_string());
    }
}
