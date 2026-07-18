// SPDX-License-Identifier: MIT

//! Provider-neutral LLM surface (no-Ollama plan — Phase 0 seam, Phase 1
//! dispatch).
//!
//! The UI and internal pipelines (watch summaries, attachment embeddings)
//! speak ONLY this surface. As of Phase 2 it dispatches between three
//! adapters in `providers/`:
//!
//!   - **Ollama** (default) — `providers/ollama.rs`, the external local
//!     engine.
//!   - **OpenAI-compatible** — `providers/openai_compat.rs`, any server
//!     speaking the /v1 dialect (LM Studio, llama-server, vLLM, …).
//!   - **Bundled engine** — `providers/engine.rs`, Ekorbia's own
//!     supervised `llama-server` sidecar (src/engine/); no external
//!     install at all. Wire work delegates to the openai_compat layer.
//!
//! Backend selection lives in the settings table and in-memory here:
//!
//!   - `llm_backend`  — "ollama" (default) | "openai" | "engine"
//!   - `llm_base_url` — Ollama: optional base override (Phase 0 semantics).
//!     OpenAI: REQUIRED endpoint base, normalized (no trailing slash, no
//!     trailing /v1). Engine: ignored.
//!   - `llm_api_key`  — optional bearer token (OpenAI backend only; the
//!     engine generates its own per-process keys).
//!
//! Loaded once at startup (`load_backend_config`, called from lib.rs
//! setup) and updated live by `llm_backend_config_set` — the next request
//! uses the new backend, no relaunch needed.
//!
//! Ollama-*lifecycle* commands (`start_ollama`, `ollama_pull(_cancel)`,
//! `ollama_delete`) stay Ollama-named in the adapter — they manage that
//! engine's install, not "an LLM" — and the UI hides them on BYO.

use crate::providers::openai_compat::EndpointCfg;
use rusqlite::Connection;
use serde::Serialize;
use std::sync::{OnceLock, RwLock};

// ── Shared result types (serialized to the UI) ─────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelCapabilities {
    pub(crate) vision: bool,
    pub(crate) tools: bool,
    pub(crate) thinking: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddingModelCheck {
    pub(crate) installed: bool,
    pub(crate) model: String,
}

// ── Backend config ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackendKind {
    Ollama,
    OpenAiCompat,
    /// Bundled llama-server sidecar, supervised in-process (Phase 2).
    Engine,
}

#[derive(Debug, Clone)]
pub(crate) struct BackendConfig {
    pub(crate) kind: BackendKind,
    pub(crate) base_url: Option<String>,
    pub(crate) api_key: Option<String>,
}

impl Default for BackendConfig {
    fn default() -> Self {
        Self {
            kind: BackendKind::Ollama,
            base_url: None,
            api_key: None,
        }
    }
}

static BACKEND: OnceLock<RwLock<BackendConfig>> = OnceLock::new();

fn backend() -> &'static RwLock<BackendConfig> {
    BACKEND.get_or_init(|| RwLock::new(BackendConfig::default()))
}

fn current_config() -> BackendConfig {
    backend().read().map(|c| c.clone()).unwrap_or_default()
}

/// Normalize a user-pasted endpoint base: trim, strip trailing slashes,
/// strip a trailing `/v1` (adapter paths always include it — accepting
/// both forms means pasting LM Studio's suggested ".../v1" just works).
/// Empty input → None.
pub(crate) fn normalize_base_url(raw: &str) -> Option<String> {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    if s.to_ascii_lowercase().ends_with("/v1") {
        s.truncate(s.len() - 3);
        s = s.trim_end_matches('/').to_string();
    }
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn parse_kind(raw: Option<&str>) -> BackendKind {
    match raw {
        Some("openai") => BackendKind::OpenAiCompat,
        Some("engine") => BackendKind::Engine,
        _ => BackendKind::Ollama,
    }
}

fn kind_str(kind: BackendKind) -> &'static str {
    match kind {
        BackendKind::Ollama => "ollama",
        BackendKind::OpenAiCompat => "openai",
        BackendKind::Engine => "engine",
    }
}

/// Apply a config: store it and keep the Ollama adapter's Phase-0 base
/// override in sync (set only when the OLLAMA backend has a custom base;
/// cleared otherwise so an OpenAI base URL never leaks into Ollama HTTP).
fn apply_config(cfg: BackendConfig) {
    match cfg.kind {
        BackendKind::Ollama => {
            crate::providers::ollama::set_base_url_override(cfg.base_url.clone())
        }
        BackendKind::OpenAiCompat | BackendKind::Engine => {
            crate::providers::ollama::set_base_url_override(None)
        }
    }
    if let Ok(mut w) = backend().write() {
        *w = cfg;
    }
}

/// Startup load (lib.rs setup, right after migrations).
pub(crate) fn load_backend_config(conn: &Connection) {
    let kind = parse_kind(crate::db::get_setting(conn, "llm_backend").as_deref());
    let base_url = crate::db::get_setting(conn, "llm_base_url")
        .as_deref()
        .and_then(normalize_base_url);
    let api_key = crate::db::get_setting(conn, "llm_api_key").filter(|s| !s.trim().is_empty());
    apply_config(BackendConfig {
        kind,
        base_url,
        api_key,
    });
}

/// Resolve the endpoint config for the OpenAI adapter, or a friendly
/// error when the backend is selected but unconfigured.
fn endpoint_cfg(cfg: &BackendConfig) -> Result<EndpointCfg, String> {
    let base_url = cfg.base_url.clone().ok_or_else(|| {
        "Custom endpoint URL is not configured — set it in Settings → Backend".to_string()
    })?;
    Ok(EndpointCfg {
        base_url,
        api_key: cfg.api_key.clone(),
    })
}

// ── Streaming contract ─────────────────────────────────────────────────────

/// Neutral streaming events carried over the Tauri channel to JS.
///
/// Serialized shape (what `consumeChunk` in main.jsx / overlay.jsx sees):
///   {"type":"delta","text":"…"}
///   {"type":"toolCalls","calls":[{…, function:{name, arguments:{OBJECT}}}]}
///   {"type":"done","promptTokens":N,"outputTokens":N}
///   {"type":"error","message":"…"}
///   {"type":"status","message":"…"}
///
/// Contract guarantees, owned by EVERY adapter (pinned by their golden
/// tests):
///   - `toolCalls` is emitted AT MOST ONCE per stream, before `done`.
///   - every call's `function.arguments` is ALWAYS a JSON object — never a
///     JSON-encoded string, never null (unparseable args become `{}`).
///   - `done` carries the request's token counts (0 when the provider
///     omits them).
///   - in-band provider errors surface as an `error` event; transport
///     failures still reject the invoke promise as before.
///   - `status` (Phase 2) is OPTIONAL pre-content progress ("loading
///     gemma…", "waiting for model…") — only the engine adapter emits
///     it today. Zero or more may arrive, always BEFORE the first
///     `delta`; consumers render it as ephemeral placeholder text and
///     must never treat it as content.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type")]
pub(crate) enum StreamEvent {
    #[serde(rename = "delta")]
    Delta { text: String },
    #[serde(rename = "toolCalls")]
    ToolCalls { calls: Vec<serde_json::Value> },
    #[serde(rename = "done", rename_all = "camelCase")]
    Done {
        prompt_tokens: u64,
        output_tokens: u64,
    },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "status")]
    Status { message: String },
}

// ── Internal delegators (watch + attachment pipelines) ─────────────────────

/// Non-streaming chat (watch summaries). One system + one user message.
pub(crate) async fn chat(model: &str, system: &str, user: &str) -> Result<String, String> {
    let cfg = current_config();
    match cfg.kind {
        BackendKind::Ollama => crate::providers::ollama::chat(model, system, user).await,
        BackendKind::OpenAiCompat => {
            crate::providers::openai_compat::chat(&endpoint_cfg(&cfg)?, model, system, user).await
        }
        BackendKind::Engine => crate::providers::engine::chat(model, system, user).await,
    }
}

/// Batch text embedding (attachment indexer).
pub(crate) async fn embed(model: &str, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    let cfg = current_config();
    match cfg.kind {
        BackendKind::Ollama => crate::providers::ollama::embed(model, texts).await,
        BackendKind::OpenAiCompat => {
            crate::providers::openai_compat::embed(&endpoint_cfg(&cfg)?, model, texts).await
        }
        BackendKind::Engine => crate::providers::engine::embed(model, texts).await,
    }
}

/// Single-capability probe used by the attachment image path.
pub(crate) async fn model_has_vision(model: &str) -> Result<bool, String> {
    let cfg = current_config();
    match cfg.kind {
        BackendKind::Ollama => crate::providers::ollama::model_has_vision(model).await,
        BackendKind::OpenAiCompat => {
            Ok(crate::providers::openai_compat::capabilities(model).vision)
        }
        BackendKind::Engine => Ok(crate::providers::engine::model_has_vision(model)),
    }
}

// ── Neutral Tauri commands ─────────────────────────────────────────────────

/// List installed models. Payload is Ollama's `{ models: [...] }` shape on
/// every backend (the OpenAI adapter maps /v1/models into it) so the UI
/// stays payload-stable.
#[tauri::command]
pub(crate) async fn llm_list_models() -> Result<serde_json::Value, String> {
    let cfg = current_config();
    match cfg.kind {
        BackendKind::Ollama => crate::providers::ollama::list_models().await,
        BackendKind::OpenAiCompat => {
            crate::providers::openai_compat::list_models(&endpoint_cfg(&cfg)?).await
        }
        BackendKind::Engine => crate::providers::engine::list_models().await,
    }
}

/// Currently-loaded models (status bar polling). Empty on BYO — no
/// portable equivalent exists across OpenAI-compatible servers. The
/// engine answers from its own supervisor state.
#[tauri::command]
pub(crate) async fn llm_loaded_models() -> Result<serde_json::Value, String> {
    let cfg = current_config();
    match cfg.kind {
        BackendKind::Ollama => crate::providers::ollama::loaded_models().await,
        BackendKind::OpenAiCompat => {
            crate::providers::openai_compat::loaded_models(&endpoint_cfg(&cfg)?).await
        }
        BackendKind::Engine => crate::providers::engine::loaded_models().await,
    }
}

/// Fire-and-forget warm-up — forces a model into RAM. On the engine this
/// is ensure-spawned + health-checked (a real warm-up, not a 1-token
/// generation).
#[tauri::command]
pub(crate) async fn llm_warmup(body: serde_json::Value) -> Result<(), String> {
    let cfg = current_config();
    match cfg.kind {
        BackendKind::Ollama => crate::providers::ollama::warmup(body).await,
        BackendKind::OpenAiCompat => {
            crate::providers::openai_compat::warmup(&endpoint_cfg(&cfg)?, body).await
        }
        BackendKind::Engine => crate::providers::engine::warmup(body).await,
    }
}

/// Vision / tools / thinking capability probe. Ollama: cached /api/show.
/// BYO: static optimistic defaults (tools on, vision/thinking off) — no
/// portable probe exists; see the adapter docs for the reasoning.
/// Engine: real answers (tools on via --jinja, vision = mmproj sibling
/// present, thinking suppressed server-side).
#[tauri::command]
pub(crate) async fn llm_capabilities(model: String) -> Result<ModelCapabilities, String> {
    let cfg = current_config();
    match cfg.kind {
        BackendKind::Ollama => crate::providers::ollama::capabilities(model).await,
        BackendKind::OpenAiCompat => Ok(crate::providers::openai_compat::capabilities(&model)),
        BackendKind::Engine => Ok(crate::providers::engine::capabilities(&model)),
    }
}

/// Is the configured embedding model available on the active backend?
#[tauri::command]
pub(crate) async fn llm_embed_model_check(
    app: tauri::AppHandle,
) -> Result<EmbeddingModelCheck, String> {
    let model = crate::attachments::config::current_embedding_model(&app);
    let cfg = current_config();
    let installed = match cfg.kind {
        BackendKind::Ollama => crate::providers::ollama::embed_model_installed(&model).await,
        BackendKind::OpenAiCompat => match endpoint_cfg(&cfg) {
            Ok(ep) => crate::providers::openai_compat::embed_model_installed(&ep, &model).await,
            Err(_) => false,
        },
        BackendKind::Engine => crate::providers::engine::embed_model_installed(&model),
    };
    Ok(EmbeddingModelCheck { installed, model })
}

/// Streaming chat. Forwards the request body to the active provider and
/// emits normalized [`StreamEvent`]s on the channel. (The body is
/// Ollama-shaped; the OpenAI adapter translates — see its module docs.)
#[tauri::command]
pub(crate) async fn llm_chat_stream(
    request_id: String,
    body: serde_json::Value,
    on_chunk: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    let cfg = current_config();
    match cfg.kind {
        BackendKind::Ollama => {
            crate::providers::ollama::chat_stream(request_id, body, on_chunk).await
        }
        BackendKind::OpenAiCompat => {
            crate::providers::openai_compat::chat_stream(
                &endpoint_cfg(&cfg)?,
                request_id,
                body,
                on_chunk,
            )
            .await
        }
        BackendKind::Engine => {
            crate::providers::engine::chat_stream(request_id, body, on_chunk).await
        }
    }
}

/// Cancel a running stream at the next chunk boundary. No-op for unknown
/// ids (stream already finished, or never started).
#[tauri::command]
pub(crate) fn llm_chat_stream_cancel(request_id: String) {
    crate::providers::cancel(&request_id);
}

// ── Backend config commands (Settings → Backend) ───────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendConfigView {
    backend: String,
    base_url: Option<String>,
    api_key: Option<String>,
}

#[tauri::command]
pub(crate) fn llm_backend_config_get() -> BackendConfigView {
    let cfg = current_config();
    BackendConfigView {
        backend: kind_str(cfg.kind).to_string(),
        base_url: cfg.base_url,
        api_key: cfg.api_key,
    }
}

/// Persist + apply a backend selection. Takes effect on the next request —
/// no relaunch. `base_url` is required for the OpenAI backend.
#[tauri::command]
pub(crate) fn llm_backend_config_set(
    state: tauri::State<'_, crate::db::DbState>,
    backend_kind: String,
    base_url: Option<String>,
    api_key: Option<String>,
) -> Result<(), String> {
    let kind = match backend_kind.as_str() {
        "ollama" => BackendKind::Ollama,
        "openai" => BackendKind::OpenAiCompat,
        "engine" => BackendKind::Engine,
        other => return Err(format!("unknown backend: {other}")),
    };
    let base_url = base_url.as_deref().and_then(normalize_base_url);
    let api_key = api_key.filter(|s| !s.trim().is_empty());
    if kind == BackendKind::OpenAiCompat && base_url.is_none() {
        return Err(
            "A base URL is required for a custom endpoint (e.g. http://127.0.0.1:1234)".into(),
        );
    }
    {
        let db = state.0.lock().map_err(|e| e.to_string())?;
        crate::db::set_setting(&db, "llm_backend", kind_str(kind))?;
        crate::db::set_setting(&db, "llm_base_url", base_url.as_deref().unwrap_or(""))?;
        crate::db::set_setting(&db, "llm_api_key", api_key.as_deref().unwrap_or(""))?;
    }
    apply_config(BackendConfig {
        kind,
        base_url,
        api_key,
    });
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendTestResult {
    ok: bool,
    models: usize,
    error: Option<String>,
}

/// Settings "Test connection" — hits /v1/models on the CANDIDATE config
/// (not the active one) so users can validate before saving.
#[tauri::command]
pub(crate) async fn llm_backend_test(
    base_url: String,
    api_key: Option<String>,
) -> BackendTestResult {
    let Some(base_url) = normalize_base_url(&base_url) else {
        return BackendTestResult {
            ok: false,
            models: 0,
            error: Some("Enter a base URL first".into()),
        };
    };
    let cfg = EndpointCfg {
        base_url,
        api_key: api_key.filter(|s| !s.trim().is_empty()),
    };
    match crate::providers::openai_compat::list_models(&cfg).await {
        Ok(v) => BackendTestResult {
            ok: true,
            models: v["models"].as_array().map(|a| a.len()).unwrap_or(0),
            error: None,
        },
        Err(e) => BackendTestResult {
            ok: false,
            models: 0,
            error: Some(e),
        },
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_base_url_strips_slashes_and_v1() {
        assert_eq!(
            normalize_base_url("http://127.0.0.1:1234"),
            Some("http://127.0.0.1:1234".into())
        );
        assert_eq!(
            normalize_base_url("http://127.0.0.1:1234/"),
            Some("http://127.0.0.1:1234".into())
        );
        assert_eq!(
            normalize_base_url("http://localhost:1234/v1"),
            Some("http://localhost:1234".into())
        );
        assert_eq!(
            normalize_base_url("http://localhost:1234/V1/"),
            Some("http://localhost:1234".into())
        );
        assert_eq!(normalize_base_url("   "), None);
        assert_eq!(normalize_base_url(""), None);
        // A path segment that merely contains v1 must survive.
        assert_eq!(
            normalize_base_url("http://host/api/v1x"),
            Some("http://host/api/v1x".into())
        );
    }

    #[test]
    fn parse_kind_defaults_to_ollama() {
        assert_eq!(parse_kind(None), BackendKind::Ollama);
        assert_eq!(parse_kind(Some("ollama")), BackendKind::Ollama);
        assert_eq!(parse_kind(Some("garbage")), BackendKind::Ollama);
        assert_eq!(parse_kind(Some("openai")), BackendKind::OpenAiCompat);
        assert_eq!(parse_kind(Some("engine")), BackendKind::Engine);
    }

    #[test]
    fn kind_str_roundtrips() {
        for k in [
            BackendKind::Ollama,
            BackendKind::OpenAiCompat,
            BackendKind::Engine,
        ] {
            assert_eq!(parse_kind(Some(kind_str(k))), k);
        }
    }

    #[test]
    fn endpoint_cfg_requires_base_url() {
        let cfg = BackendConfig {
            kind: BackendKind::OpenAiCompat,
            base_url: None,
            api_key: None,
        };
        assert!(endpoint_cfg(&cfg).is_err());
        let cfg = BackendConfig {
            kind: BackendKind::OpenAiCompat,
            base_url: Some("http://x".into()),
            api_key: Some("k".into()),
        };
        let ep = endpoint_cfg(&cfg).unwrap();
        assert_eq!(ep.base_url, "http://x");
        assert_eq!(ep.api_key.as_deref(), Some("k"));
    }
}
