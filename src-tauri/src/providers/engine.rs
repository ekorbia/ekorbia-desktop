// SPDX-License-Identifier: MIT

//! Bundled-engine ADAPTER (no-Ollama plan, Phase 2 / L2 core).
//!
//! Implements the neutral `llm.rs` surface against Ekorbia's own
//! supervised `llama-server` processes (see `src/engine/`). llama-server
//! speaks the OpenAI /v1 dialect, so this adapter does NO wire work of
//! its own: every request asks the supervisor for a [`Lease`] on the
//! right process (spawning / swapping / waiting as needed), builds an
//! [`EndpointCfg`] pointing at that process's loopback port + api key,
//! and delegates to `openai_compat`. The Phase 1 adapter is the wire
//! layer; Phase 2 is process management.
//!
//! What's better here than a generic BYO endpoint:
//!   - **Capabilities are real**: tools ON (we spawn with `--jinja`),
//!     vision = the model has an mmproj sibling file, thinking reported
//!     OFF because we *suppress it server-side* (`--reasoning off` at
//!     spawn — the fix for the documented Ollama-/v1 thinking tax).
//!   - **loaded_models is honest**: it's the supervisor's own snapshot,
//!     not an unknowable remote server state.
//!   - **warmup really warms**: ensure-spawned + health-checked, so the
//!     status bar's "loading… → loaded" transition reflects reality.
//!
//! Model ids are GGUF file stems in `<app_data>/models` (hand-placed in
//! Phase 2; the Phase 3 catalog downloads into the same directory).

use crate::llm::StreamEvent;
use crate::providers::openai_compat::{self, EndpointCfg};
use serde_json::{json, Value};

fn cfg_for(lease: &crate::engine::supervisor::Lease) -> EndpointCfg {
    EndpointCfg {
        base_url: lease.base_url.clone(),
        api_key: Some(lease.api_key.clone()),
    }
}

fn no_status(_: &str) {}

fn model_from_body(body: &Value) -> Result<String, String> {
    body.get("model")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "request body has no model".to_string())
}

// ── Neutral surface (mirrors providers/ollama.rs + openai_compat.rs) ───────

/// Streaming chat. The supervisor's progress ("loading gemma…",
/// "waiting for … to finish…") is forwarded as `status` stream events —
/// the UI shows them in the pending assistant bubble, so a model swap
/// reads as a visible state instead of a silent stall.
pub(crate) async fn chat_stream(
    request_id: String,
    body: Value,
    on_chunk: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    let model = model_from_body(&body)?;
    let status_channel = on_chunk.clone();
    let on_status = move |msg: &str| {
        let _ = status_channel.send(StreamEvent::Status {
            message: msg.to_string(),
        });
    };
    let lease = crate::engine::supervisor::global()
        .ensure(crate::engine::SlotKind::Chat, &model, &on_status)
        .await?;
    // Lease held across the whole stream — the refcount is what makes
    // "never evict mid-stream" true.
    openai_compat::chat_stream(&cfg_for(&lease), request_id, body, on_chunk).await
}

/// Non-streaming chat (watch summaries). Cold-start latency (model
/// load) is acceptable at watch cadences — the plan doc calls this out.
pub(crate) async fn chat(model: &str, system: &str, user: &str) -> Result<String, String> {
    let lease = crate::engine::supervisor::global()
        .ensure(crate::engine::SlotKind::Chat, model, &no_status)
        .await?;
    openai_compat::chat(&cfg_for(&lease), model, system, user).await
}

/// Batch embeddings on the dedicated embed slot — indexing a folder
/// never evicts the chat model.
pub(crate) async fn embed(model: &str, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    let lease = crate::engine::supervisor::global()
        .ensure(crate::engine::SlotKind::Embed, model, &no_status)
        .await?;
    openai_compat::embed(&cfg_for(&lease), model, texts).await
}

/// Installed models = *.gguf files in the models dir. A missing engine
/// binary is surfaced HERE (not at spawn time) because `llm_list_models`
/// is the status bar's canonical reachability probe on every backend.
pub(crate) async fn list_models() -> Result<Value, String> {
    crate::engine::resolve_binary()?;
    let dir = crate::engine::models_dir()?;
    let models: Vec<Value> = crate::engine::scan_models(&dir)
        .into_iter()
        .map(|m| {
            json!({
                "name": m.name,
                "model": m.name,
                "size": m.size_bytes,
            })
        })
        .collect();
    Ok(json!({ "models": models }))
}

/// Resident models straight from the supervisor. Same `{models:[{name}]}`
/// shape as Ollama's /api/ps so the status bar stays payload-stable.
pub(crate) async fn loaded_models() -> Result<Value, String> {
    let models: Vec<Value> = crate::engine::supervisor::global()
        .snapshot()
        .into_iter()
        .map(|(name, _kind)| json!({ "name": name, "model": name }))
        .collect();
    Ok(json!({ "models": models }))
}

/// Warm-up = ensure-spawned. The lease drops immediately (stamping
/// last_used, so the idle clock starts from the warm), and the status
/// bar's loaded_models poll flips to "loaded" when the health check
/// passes.
pub(crate) async fn warmup(body: Value) -> Result<(), String> {
    let model = model_from_body(&body)?;
    crate::engine::supervisor::global()
        .ensure(crate::engine::SlotKind::Chat, &model, &no_status)
        .await
        .map(drop)
}

/// Real capabilities, not BYO guesses — see module docs.
pub(crate) fn capabilities(model: &str) -> crate::llm::ModelCapabilities {
    crate::llm::ModelCapabilities {
        vision: crate::engine::model_has_mmproj(model),
        tools: true,
        thinking: false,
    }
}

pub(crate) fn model_has_vision(model: &str) -> bool {
    crate::engine::model_has_mmproj(model)
}

/// Embedding model availability = its GGUF exists.
pub(crate) fn embed_model_installed(model: &str) -> bool {
    crate::engine::model_path(model).is_ok()
}

// ── Engine status + folder commands (Settings → Backend / model manager) ───

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineStatus {
    binary_ok: bool,
    binary_path: Option<String>,
    binary_error: Option<String>,
    models_dir: String,
    model_count: usize,
}

/// One-shot health snapshot for the Settings → Backend engine card and
/// the model manager's engine view.
#[tauri::command]
pub(crate) fn engine_status() -> EngineStatus {
    let (binary_ok, binary_path, binary_error) = match crate::engine::resolve_binary() {
        Ok(p) => (true, Some(p.display().to_string()), None),
        Err(e) => (false, None, Some(e)),
    };
    let (models_dir, model_count) = match crate::engine::models_dir() {
        Ok(d) => {
            let n = crate::engine::scan_models(&d).len();
            (d.display().to_string(), n)
        }
        Err(e) => (format!("<unavailable: {e}>"), 0),
    };
    EngineStatus {
        binary_ok,
        binary_path,
        binary_error,
        models_dir,
        model_count,
    }
}

/// Open the models folder in the OS file manager — the Phase 2 way to
/// add a model is dropping a .gguf in here. Reuses files/commands.rs's
/// `spawn_opener` (native spawn; tauri-plugin-shell's `open` scope
/// rejects bare filesystem paths).
#[tauri::command]
pub(crate) fn engine_models_dir_reveal() -> Result<(), String> {
    let dir = crate::engine::models_dir()?;
    let _ = std::fs::create_dir_all(&dir);
    crate::files::commands::spawn_opener(&dir.display().to_string(), /* reveal */ false)
}
