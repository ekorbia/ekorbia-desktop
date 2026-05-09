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
/// scheme, used for direct TCP probes in `is_ollama_listening`) because the
/// probe path wants to skip DNS resolution while HTTP calls benefit from the
/// shorter `localhost` form. Use `ollama_url(path)` to build endpoint URLs.
const OLLAMA_BASE: &str = "http://localhost:11434";

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
    MODEL_VISION_CACHE
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
fn tools_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, bool>> {
    MODEL_TOOLS_CACHE
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
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
        .is_some_and(|caps| {
            caps.iter()
                .any(|v| v.as_str().is_some_and(|s| s == needle))
        }))
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
    let json: serde_json::Value =
        resp.json().await.map_err(|e| format!("Bad JSON from Ollama: {e}"))?;
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
pub(crate) async fn embedding_model_check(app: tauri::AppHandle) -> Result<EmbeddingModelCheck, String> {
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
    use tauri::Manager;
    // Already running? Nothing to do.
    if is_ollama_listening() {
        return Ok(());
    }

    // Layer 1 (macOS): open the Ollama menu-bar app. This is the OS-blessed
    // path — it handles env, GPU access, login items, and the binary lookup.
    #[cfg(target_os = "macos")]
    {
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

