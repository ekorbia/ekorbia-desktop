// SPDX-License-Identifier: MIT

//! OpenAI-compatible adapter (no-Ollama plan, Phase 1 / L1).
//!
//! Serves any server speaking the OpenAI REST dialect — LM Studio,
//! llama.cpp's `llama-server`, vLLM, LocalAI, … Endpoints used:
//! `/v1/models`, `/v1/chat/completions` (streaming SSE + non-stream),
//! `/v1/embeddings`. The base URL comes from `llm.rs`'s BackendConfig
//! (settings key `llm_base_url`, normalized: no trailing slash, no
//! trailing `/v1` — paths here always include `/v1/…`).
//!
//! Two translation layers keep the rest of the app provider-blind:
//!
//!   1. **Request** — the UI still assembles Ollama-shaped bodies
//!      (`{model, messages:[{role, content, images?, tool_calls?,
//!      tool_call_id?}], tools?, think?, stream}`). `translate_chat_body`
//!      maps them to the OpenAI dialect: `think` stripped (Ollama-ism;
//!      sending it 400s many servers), `images: [b64]` → data-URL
//!      image_url content parts (mime sniffed from the base64 magic),
//!      assistant `tool_calls` arguments re-serialized object→string
//!      with id fallback to the function name (matches the UI's callId
//!      fallback so tool-result linkage survives), `stream_options:
//!      {include_usage: true}` requested for token counts.
//!   2. **Response** — `SseNorm` folds the SSE stream into the neutral
//!      [`crate::llm::StreamEvent`] contract with the same guarantees as
//!      the Ollama adapter's `StreamNorm`: deltas as they come, at most
//!      ONE `toolCalls` event (arguments ALWAYS objects — incremental
//!      argument fragments are assembled per index, then parsed; garbage
//!      → `{}`), then `done` with promptTokens/outputTokens (from
//!      `usage`, falling back to llama-server's `timings`).
//!
//! Capability probing has no `/api/show` here. BYO defaults are
//! deliberate: tools ON (the point of the feature; servers that can't
//! run tools surface a request error the user can see), vision OFF
//! (never silently ship base64 to a text model), thinking OFF (never
//! send `think`). Per-model overrides are a later-phase refinement; the
//! Phase 3 catalog manifest solves it for bundled models.

use crate::llm::StreamEvent;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use std::time::Duration;

/// Connection details resolved by llm.rs from BackendConfig at call time.
#[derive(Debug, Clone)]
pub(crate) struct EndpointCfg {
    pub(crate) base_url: String,
    pub(crate) api_key: Option<String>,
}

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn url(cfg: &EndpointCfg, path: &str) -> String {
    format!("{}{}", cfg.base_url, path)
}

fn with_auth(rb: reqwest::RequestBuilder, cfg: &EndpointCfg) -> reqwest::RequestBuilder {
    match &cfg.api_key {
        Some(k) if !k.is_empty() => rb.bearer_auth(k),
        _ => rb,
    }
}

// ── Request translation ─────────────────────────────────────────────────────

/// Sniff an image's mime type from base64 magic-byte prefixes. The Ollama
/// wire format carries raw base64 with no mime; data URLs need one.
/// Unknown formats default to png — servers decode by content anyway,
/// the mime is a formality.
pub(crate) fn sniff_image_mime(b64: &str) -> &'static str {
    if b64.starts_with("/9j/") {
        "image/jpeg"
    } else if b64.starts_with("iVBOR") {
        "image/png"
    } else if b64.starts_with("R0lGO") {
        "image/gif"
    } else if b64.starts_with("UklGR") {
        "image/webp"
    } else {
        "image/png"
    }
}

fn translate_message(msg: &Value) -> Value {
    let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");
    let content = msg
        .get("content")
        .cloned()
        .unwrap_or(Value::String(String::new()));

    match role {
        "tool" => json!({
            "role": "tool",
            "content": content,
            "tool_call_id": msg.get("tool_call_id").cloned().unwrap_or(Value::Null),
        }),
        "assistant" => {
            let mut out = json!({ "role": "assistant", "content": content });
            if let Some(calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                let translated: Vec<Value> = calls
                    .iter()
                    .map(|c| {
                        let name = c
                            .pointer("/function/name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        // The UI's callId fallback is the function name —
                        // mirror it so tool-result linkage stays intact.
                        let id = c
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| name.clone());
                        let args = c
                            .pointer("/function/arguments")
                            .cloned()
                            .unwrap_or_else(|| json!({}));
                        // Neutral contract carries args as objects; the
                        // OpenAI dialect wants a JSON-encoded string.
                        let args_str = if args.is_string() {
                            args.as_str().unwrap_or("{}").to_string()
                        } else {
                            serde_json::to_string(&args).unwrap_or_else(|_| "{}".into())
                        };
                        json!({
                            "id": id,
                            "type": "function",
                            "function": { "name": name, "arguments": args_str },
                        })
                    })
                    .collect();
                out["tool_calls"] = Value::Array(translated);
            }
            out
        }
        _ => {
            // user / system. Images ride only on user messages in the
            // Ollama shape; translate to multimodal content parts.
            if let Some(images) = msg.get("images").and_then(|v| v.as_array()) {
                if !images.is_empty() {
                    let mut parts = vec![json!({
                        "type": "text",
                        "text": content.as_str().unwrap_or(""),
                    })];
                    for img in images {
                        if let Some(b64) = img.as_str() {
                            let mime = sniff_image_mime(b64);
                            parts.push(json!({
                                "type": "image_url",
                                "image_url": { "url": format!("data:{mime};base64,{b64}") },
                            }));
                        }
                    }
                    return json!({ "role": role, "content": parts });
                }
            }
            json!({ "role": role, "content": content })
        }
    }
}

/// Ollama-shaped chat body → OpenAI chat.completions body.
pub(crate) fn translate_chat_body(body: &Value) -> Value {
    let model = body.get("model").cloned().unwrap_or(Value::Null);
    let stream = body
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let messages: Vec<Value> = body
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(translate_message).collect())
        .unwrap_or_default();

    let mut out = json!({
        "model": model,
        "messages": messages,
        "stream": stream,
    });
    // `think` (Ollama-ism) deliberately dropped. `tools` schemas are
    // already in the OpenAI function format — pass through untouched.
    if let Some(tools) = body.get("tools") {
        out["tools"] = tools.clone();
    }
    if stream {
        // Ask for token counts on the final chunk. Servers that don't
        // know the field ignore it; llama-server also reports `timings`,
        // which SseNorm reads as a fallback.
        out["stream_options"] = json!({ "include_usage": true });
    }
    out
}

// ── SSE line parsing + stream normalization ────────────────────────────────

/// One parsed SSE line. `Data` carries the JSON payload of a `data:`
/// line; `Done` is the `data: [DONE]` terminator; everything else
/// (comments, event names, blank keep-alives, malformed JSON) is
/// `Ignore`.
#[derive(Debug, PartialEq)]
pub(crate) enum SseLine {
    Data(Value),
    Done,
    Ignore,
}

pub(crate) fn parse_sse_line(line: &str) -> SseLine {
    let s = line.trim();
    let Some(payload) = s.strip_prefix("data:") else {
        return SseLine::Ignore;
    };
    let payload = payload.trim();
    if payload == "[DONE]" {
        return SseLine::Done;
    }
    match serde_json::from_str::<Value>(payload) {
        Ok(v) => SseLine::Data(v),
        Err(_) => SseLine::Ignore,
    }
}

#[derive(Default)]
struct PartialCall {
    id: Option<String>,
    name: String,
    args: String,
}

/// Folds OpenAI SSE chunks into the neutral StreamEvent contract.
/// `ingest` returns events to forward as chunks arrive; `finalize`
/// returns the tail events (toolCalls-then-done) and must be called
/// exactly once — on `[DONE]`, or at raw stream end for servers that
/// skip the terminator.
pub(crate) struct SseNorm {
    calls: std::collections::BTreeMap<u64, PartialCall>,
    prompt_tokens: u64,
    output_tokens: u64,
    finished: bool,
}

impl SseNorm {
    pub(crate) fn new() -> Self {
        Self {
            calls: std::collections::BTreeMap::new(),
            prompt_tokens: 0,
            output_tokens: 0,
            finished: false,
        }
    }

    pub(crate) fn ingest(&mut self, v: &Value) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        // In-band errors: {"error": {"message": …}} or {"error": "…"}.
        if let Some(err) = v.get("error") {
            let message = err
                .get("message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| err.as_str().unwrap_or("provider error").to_string());
            out.push(StreamEvent::Error { message });
            return out;
        }
        if let Some(delta) = v.pointer("/choices/0/delta") {
            if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
                if !text.is_empty() {
                    out.push(StreamEvent::Delta {
                        text: text.to_string(),
                    });
                }
            }
            if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
                for c in calls {
                    let idx = c.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                    let slot = self.calls.entry(idx).or_default();
                    if let Some(id) = c.get("id").and_then(|i| i.as_str()) {
                        slot.id = Some(id.to_string());
                    }
                    if let Some(name) = c.pointer("/function/name").and_then(|n| n.as_str()) {
                        slot.name.push_str(name);
                    }
                    if let Some(frag) = c.pointer("/function/arguments").and_then(|a| a.as_str()) {
                        slot.args.push_str(frag);
                    }
                }
            }
        }
        // Token counts: `usage` may arrive on the final content chunk OR
        // on a dedicated post-finish chunk (OpenAI semantics with
        // include_usage). llama-server reports `timings` instead.
        if let Some(usage) = v.get("usage") {
            if let Some(p) = usage.get("prompt_tokens").and_then(|x| x.as_u64()) {
                self.prompt_tokens = p;
            }
            if let Some(c) = usage.get("completion_tokens").and_then(|x| x.as_u64()) {
                self.output_tokens = c;
            }
        }
        if let Some(timings) = v.get("timings") {
            if self.prompt_tokens == 0 {
                if let Some(p) = timings.get("prompt_n").and_then(|x| x.as_u64()) {
                    self.prompt_tokens = p;
                }
            }
            if self.output_tokens == 0 {
                if let Some(c) = timings.get("predicted_n").and_then(|x| x.as_u64()) {
                    self.output_tokens = c;
                }
            }
        }
        out
    }

    pub(crate) fn finalize(&mut self) -> Vec<StreamEvent> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let mut out = Vec::new();
        if !self.calls.is_empty() {
            let calls: Vec<Value> = std::mem::take(&mut self.calls)
                .into_values()
                .map(|pc| {
                    // Same always-an-object guarantee as StreamNorm.
                    let args = serde_json::from_str::<Value>(&pc.args)
                        .ok()
                        .filter(|v| v.is_object())
                        .unwrap_or_else(|| json!({}));
                    let id = pc.id.unwrap_or_else(|| pc.name.clone());
                    json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": pc.name, "arguments": args },
                    })
                })
                .collect();
            out.push(StreamEvent::ToolCalls { calls });
        }
        out.push(StreamEvent::Done {
            prompt_tokens: self.prompt_tokens,
            output_tokens: self.output_tokens,
        });
        out
    }
}

// ── Adapter surface (mirrors providers/ollama.rs) ──────────────────────────

/// GET /v1/models, shape-mapped to Ollama's `{ models: [{name, model}] }`
/// so every UI consumer of `llm_list_models` stays payload-stable.
pub(crate) async fn list_models(cfg: &EndpointCfg) -> Result<Value, String> {
    let resp = with_auth(client().get(url(cfg, "/v1/models")), cfg)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|e| format!("Endpoint /v1/models request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Endpoint /v1/models returned {}", resp.status()));
    }
    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("Bad JSON from /v1/models: {e}"))?;
    Ok(map_models_response(&json))
}

pub(crate) fn map_models_response(v: &Value) -> Value {
    let models: Vec<Value> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
                .map(|id| json!({ "name": id, "model": id }))
                .collect()
        })
        .unwrap_or_default();
    json!({ "models": models })
}

/// No portable "loaded models" endpoint exists across OpenAI-compatible
/// servers (llama-server has /slots, LM Studio a vendor API). Empty list
/// = the status bar simply shows nothing resident; reachability signal
/// comes from list_models.
pub(crate) async fn loaded_models(_cfg: &EndpointCfg) -> Result<Value, String> {
    Ok(json!({ "models": [] }))
}

/// Warm-up: minimal 1-token chat round-trip. The incoming body is the
/// UI's Ollama-shaped `/api/generate` payload — only `model` matters.
pub(crate) async fn warmup(cfg: &EndpointCfg, body: Value) -> Result<(), String> {
    let model = body.get("model").cloned().unwrap_or(Value::Null);
    let req = json!({
        "model": model,
        "messages": [{ "role": "user", "content": "hi" }],
        "max_tokens": 1,
        "stream": false,
    });
    let resp = with_auth(client().post(url(cfg, "/v1/chat/completions")), cfg)
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("Endpoint warm-up request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Endpoint warm-up returned {}", resp.status()));
    }
    Ok(())
}

/// BYO capability defaults — see module docs for the reasoning.
pub(crate) fn capabilities(_model: &str) -> crate::llm::ModelCapabilities {
    crate::llm::ModelCapabilities {
        vision: false,
        tools: true,
        thinking: false,
    }
}

/// Embedding-model presence = listed by /v1/models. Cheaper than a probe
/// embedding and good enough for the settings-panel hint.
pub(crate) async fn embed_model_installed(cfg: &EndpointCfg, model: &str) -> bool {
    match list_models(cfg).await {
        Ok(v) => v["models"]
            .as_array()
            .is_some_and(|arr| arr.iter().any(|m| m["name"] == model)),
        Err(_) => false,
    }
}

/// Non-streaming chat (watch summaries).
pub(crate) async fn chat(
    cfg: &EndpointCfg,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String, String> {
    let req = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user",   "content": user },
        ],
        "stream": false,
    });
    let resp = with_auth(client().post(url(cfg, "/v1/chat/completions")), cfg)
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("Endpoint request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Endpoint returned HTTP {}", resp.status()));
    }
    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("Bad JSON from endpoint: {e}"))?;
    json.pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "Endpoint response had no message content".to_string())
}

/// Batch embeddings via /v1/embeddings. Rows re-ordered by the response's
/// `index` field — the spec allows out-of-order data entries.
pub(crate) async fn embed(
    cfg: &EndpointCfg,
    model: &str,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let req = json!({ "model": model, "input": texts });
    let resp = with_auth(client().post(url(cfg, "/v1/embeddings")), cfg)
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("Endpoint embed request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Endpoint /v1/embeddings returned {} (model `{model}` may not be available)",
            resp.status()
        ));
    }
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let data = json
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or("Endpoint embed: missing `data` array")?;
    let mut rows: Vec<(u64, Vec<f32>)> = Vec::with_capacity(data.len());
    for (i, entry) in data.iter().enumerate() {
        let idx = entry
            .get("index")
            .and_then(|x| x.as_u64())
            .unwrap_or(i as u64);
        let row = entry
            .get("embedding")
            .and_then(|e| e.as_array())
            .ok_or("Endpoint embed: non-array embedding row")?
            .iter()
            .map(|x| x.as_f64().unwrap_or(0.0) as f32)
            .collect();
        rows.push((idx, row));
    }
    rows.sort_by_key(|(i, _)| *i);
    Ok(rows.into_iter().map(|(_, r)| r).collect())
}

/// Streaming chat via SSE, normalized to StreamEvents. Same cancellation
/// contract as the Ollama adapter: registry flag observed at chunk
/// boundaries, channel-drop = graceful cancel.
pub(crate) async fn chat_stream(
    cfg: &EndpointCfg,
    request_id: String,
    body: Value,
    on_chunk: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    let token = crate::providers::register_cancel(&request_id);
    let cancel = token.flag.clone();

    let translated = translate_chat_body(&body);
    let resp = with_auth(client().post(url(cfg, "/v1/chat/completions")), cfg)
        .json(&translated)
        .send()
        .await
        .map_err(|e| format!("Endpoint /v1/chat/completions request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        // Error bodies usually carry a useful message — surface it.
        let detail = resp
            .text()
            .await
            .ok()
            .filter(|t| !t.trim().is_empty())
            .map(|t| {
                let t = t.trim().to_string();
                if t.len() > 300 {
                    format!("{}…", &t[..300])
                } else {
                    t
                }
            })
            .unwrap_or_default();
        return Err(format!(
            "Endpoint /v1/chat/completions returned {status}: {detail}"
        ));
    }

    let mut resp = resp;
    let mut norm = SseNorm::new();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let next = resp
            .chunk()
            .await
            .map_err(|e| format!("Endpoint stream read failed: {e}"))?;
        let bytes = match next {
            Some(b) => b,
            None => break, // raw end of stream
        };
        buf.extend_from_slice(&bytes);
        while let Some(nl_pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl_pos).collect();
            let Ok(s) = std::str::from_utf8(&line) else {
                continue;
            };
            match parse_sse_line(s) {
                SseLine::Data(v) => {
                    for ev in norm.ingest(&v) {
                        if on_chunk.send(ev).is_err() {
                            return Ok(());
                        }
                    }
                }
                SseLine::Done => {
                    for ev in norm.finalize() {
                        if on_chunk.send(ev).is_err() {
                            return Ok(());
                        }
                    }
                    return Ok(());
                }
                SseLine::Ignore => {}
            }
        }
    }

    // Server closed without `data: [DONE]` — flush any buffered final
    // line, then emit the tail events so the UI always gets its `done`.
    if !buf.is_empty() {
        if let Ok(s) = std::str::from_utf8(&buf) {
            if let SseLine::Data(v) = parse_sse_line(s) {
                for ev in norm.ingest(&v) {
                    let _ = on_chunk.send(ev);
                }
            }
        }
    }
    for ev in norm.finalize() {
        let _ = on_chunk.send(ev);
    }
    Ok(())
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::StreamEvent as E;

    // ── translate_chat_body ────────────────────────────────────────────

    #[test]
    fn translate_strips_think_and_requests_usage() {
        let body = serde_json::json!({
            "model": "qwen3", "think": false, "stream": true,
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let out = translate_chat_body(&body);
        assert!(
            out.get("think").is_none(),
            "think must never reach BYO servers"
        );
        assert_eq!(out["stream_options"]["include_usage"], true);
        assert_eq!(out["messages"][0]["content"], "hi");
    }

    #[test]
    fn translate_maps_images_to_data_url_parts_with_sniffed_mime() {
        let body = serde_json::json!({
            "model": "m", "stream": true,
            "messages": [{ "role": "user", "content": "what is this", "images": ["/9j/AAAA", "iVBORAAA"] }],
        });
        let out = translate_chat_body(&body);
        let parts = out["messages"][0]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0]["text"], "what is this");
        assert!(parts[1]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,/9j/"));
        assert!(parts[2]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,iVBOR"));
    }

    #[test]
    fn translate_assistant_tool_calls_stringify_args_with_id_fallback() {
        let body = serde_json::json!({
            "model": "m", "stream": true,
            "messages": [
                { "role": "assistant", "content": "",
                  "tool_calls": [{ "function": { "name": "write_file", "arguments": { "path": "a.txt" } } }] },
                { "role": "tool", "content": "{\"ok\":true}", "tool_call_id": "write_file" },
            ],
        });
        let out = translate_chat_body(&body);
        let call = &out["messages"][0]["tool_calls"][0];
        assert_eq!(
            call["id"], "write_file",
            "id falls back to fn name = UI callId"
        );
        assert_eq!(call["type"], "function");
        let args = call["function"]["arguments"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(args).unwrap()["path"],
            "a.txt"
        );
        assert_eq!(out["messages"][1]["tool_call_id"], "write_file");
    }

    #[test]
    fn translate_passes_tools_schemas_through() {
        let body = serde_json::json!({
            "model": "m", "stream": true, "messages": [],
            "tools": [{ "type": "function", "function": { "name": "write_file" } }],
        });
        let out = translate_chat_body(&body);
        assert_eq!(out["tools"][0]["function"]["name"], "write_file");
    }

    // ── parse_sse_line ─────────────────────────────────────────────────

    #[test]
    fn sse_line_variants() {
        assert_eq!(parse_sse_line("data: [DONE]"), SseLine::Done);
        assert_eq!(parse_sse_line(": keep-alive"), SseLine::Ignore);
        assert_eq!(parse_sse_line(""), SseLine::Ignore);
        assert_eq!(parse_sse_line("event: message"), SseLine::Ignore);
        assert_eq!(parse_sse_line("data: {not json"), SseLine::Ignore);
        match parse_sse_line(r#"data: {"choices":[]}"#) {
            SseLine::Data(v) => assert!(v["choices"].is_array()),
            other => panic!("expected Data, got {other:?}"),
        }
    }

    // ── SseNorm goldens ────────────────────────────────────────────────

    fn ingest_all(norm: &mut SseNorm, lines: &[&str]) -> Vec<E> {
        lines
            .iter()
            .flat_map(|l| norm.ingest(&serde_json::from_str(l).unwrap()))
            .collect()
    }

    #[test]
    fn norm_deltas_then_usage_chunk_then_done() {
        let mut n = SseNorm::new();
        let evs = ingest_all(
            &mut n,
            &[
                r#"{"choices":[{"delta":{"content":"Hel"}}]}"#,
                r#"{"choices":[{"delta":{"content":"lo"}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
                r#"{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}"#,
            ],
        );
        assert_eq!(
            evs,
            vec![
                E::Delta { text: "Hel".into() },
                E::Delta { text: "lo".into() }
            ]
        );
        assert_eq!(
            n.finalize(),
            vec![E::Done {
                prompt_tokens: 12,
                output_tokens: 34
            }]
        );
        assert!(n.finalize().is_empty(), "finalize must be idempotent");
    }

    #[test]
    fn norm_timings_fallback_for_llama_server() {
        let mut n = SseNorm::new();
        ingest_all(
            &mut n,
            &[
                r#"{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}],"timings":{"prompt_n":7,"predicted_n":21}}"#,
            ],
        );
        assert_eq!(
            n.finalize(),
            vec![E::Done {
                prompt_tokens: 7,
                output_tokens: 21
            }]
        );
    }

    #[test]
    fn norm_incremental_tool_call_assembly() {
        // OpenAI streams tool calls as fragments: id+name first, then
        // argument string pieces. Assembled per index, parsed at finalize,
        // emitted ONCE before done — the same contract as StreamNorm.
        let mut n = SseNorm::new();
        let evs = ingest_all(
            &mut n,
            &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write_file","arguments":""}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]}}]}"#,
            ],
        );
        assert!(evs.is_empty(), "no early toolCalls emission");
        let tail = n.finalize();
        assert_eq!(tail.len(), 2);
        match &tail[0] {
            E::ToolCalls { calls } => {
                assert_eq!(calls[0]["id"], "call_1");
                assert_eq!(calls[0]["function"]["name"], "write_file");
                assert_eq!(calls[0]["function"]["arguments"]["path"], "a.txt");
                assert!(calls[0]["function"]["arguments"].is_object());
            }
            other => panic!("expected toolCalls, got {other:?}"),
        }
        assert!(matches!(tail[1], E::Done { .. }));
    }

    #[test]
    fn norm_garbage_tool_args_become_empty_object() {
        let mut n = SseNorm::new();
        ingest_all(
            &mut n,
            &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"write_file","arguments":"not json"}}]}}]}"#,
            ],
        );
        match &n.finalize()[0] {
            E::ToolCalls { calls } => {
                assert_eq!(calls[0]["function"]["arguments"], serde_json::json!({}));
                assert_eq!(
                    calls[0]["id"], "write_file",
                    "missing id falls back to name"
                );
            }
            other => panic!("expected toolCalls, got {other:?}"),
        }
    }

    #[test]
    fn norm_error_payload_becomes_error_event() {
        let mut n = SseNorm::new();
        let evs = ingest_all(&mut n, &[r#"{"error":{"message":"model not loaded"}}"#]);
        assert_eq!(
            evs,
            vec![E::Error {
                message: "model not loaded".into()
            }]
        );
    }

    // ── models mapping ─────────────────────────────────────────────────

    #[test]
    fn models_response_maps_to_ollama_shape() {
        let v = serde_json::json!({
            "object": "list",
            "data": [{ "id": "qwen2.5-7b-instruct", "object": "model" }, { "id": "nomic-embed" }],
        });
        let out = map_models_response(&v);
        assert_eq!(out["models"][0]["name"], "qwen2.5-7b-instruct");
        assert_eq!(out["models"][1]["model"], "nomic-embed");
        assert_eq!(
            map_models_response(&serde_json::json!({}))["models"],
            serde_json::json!([])
        );
    }

    // ── mime sniffing ──────────────────────────────────────────────────

    #[test]
    fn image_mime_sniffing() {
        assert_eq!(sniff_image_mime("/9j/4AAQ"), "image/jpeg");
        assert_eq!(sniff_image_mime("iVBORw0KGgo"), "image/png");
        assert_eq!(sniff_image_mime("R0lGODlh"), "image/gif");
        assert_eq!(sniff_image_mime("UklGRh4A"), "image/webp");
        assert_eq!(sniff_image_mime("????"), "image/png");
    }
}
