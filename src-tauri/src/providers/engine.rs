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
//!     spawn — the fix for the documented Ollama-/v1 thinking tax). The
//!     `thinking` capability means "this model thinks unless told not
//!     to", which is never true here: on this backend thinking is opt-in
//!     per request — see [`apply_thinking`].
//!   - **loaded_models is honest**: it's the supervisor's own snapshot,
//!     not an unknowable remote server state.
//!   - **warmup really warms**: ensure-spawned + health-checked, so the
//!     status bar's "loading… → loaded" transition reflects reality.
//!
//! Model ids are GGUF file stems in `<app_data>/models` (hand-placed in
//! Phase 2; the Phase 3 catalog downloads into the same directory).

use crate::llm::{PromptFit, StreamEvent};
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
        .ensure(
            crate::engine::SlotKind::Chat,
            &model,
            crate::engine::chat_ctx(),
            &on_status,
        )
        .await?;
    let mut body = body;
    apply_thinking(&mut body, crate::engine::thinking());
    // Lease held across the whole stream — the refcount is what makes
    // "never evict mid-stream" true.
    openai_compat::chat_stream(&cfg_for(&lease), request_id, body, on_chunk).await
}

/// Thinking on the bundled engine is OPT-IN PER REQUEST, and needs two
/// yeses:
///
///   1. the request carries `think: true` — the UI's way of saying "this
///      surface renders reasoning" (the main chat and compare columns set
///      it; the overlay and the Watch pipeline never do), and
///   2. Settings → Backend → Thinking is on (`setting_on`).
///
/// Only then does the request get `chat_template_kwargs.enable_thinking`,
/// which llama-server lets a request use to override its spawn default
/// (`--reasoning off` — see `engine::build_args`). Everything else keeps
/// the default, so quick lookups and background summaries never pay the
/// thinking tax, and flipping the setting needs no model reload.
/// `openai_compat::translate_chat_body` drops `think` and passes the
/// kwargs through; nothing but this function ever sets them.
fn apply_thinking(body: &mut Value, setting_on: bool) {
    let asked = body.get("think").and_then(Value::as_bool) == Some(true);
    if asked && setting_on {
        body["chat_template_kwargs"] = json!({ "enable_thinking": true });
    }
}

/// Exact prompt-token count against the chat window, for the send
/// pre-flight. `None` unless `model` is already resident: this must never
/// spawn or swap (see `Supervisor::lease_if_resident`). The lease is held
/// across both HTTP calls so the process can't be reaped mid-count.
pub(crate) async fn count_prompt_tokens(body: Value) -> Result<Option<PromptFit>, String> {
    let model = model_from_body(&body)?;
    let Some(lease) = crate::engine::supervisor::global()
        .lease_if_resident(crate::engine::SlotKind::Chat, &model)
    else {
        return Ok(None);
    };
    let prompt_tokens =
        openai_compat::llama_server_count_prompt_tokens(&cfg_for(&lease), &body).await?;
    Ok(Some(PromptFit {
        prompt_tokens,
        // The window in force NOW, not the one the resident process was
        // spawned with: if the user just changed it, the send that follows
        // respawns at the new size.
        window: crate::engine::chat_ctx(),
    }))
}

/// Non-streaming chat (watch summaries). Cold-start latency (model
/// load) is acceptable at watch cadences — the plan doc calls this out.
pub(crate) async fn chat(model: &str, system: &str, user: &str) -> Result<String, String> {
    let lease = crate::engine::supervisor::global()
        .ensure(
            crate::engine::SlotKind::Chat,
            model,
            crate::engine::chat_ctx(),
            &no_status,
        )
        .await?;
    openai_compat::chat(&cfg_for(&lease), model, system, user).await
}

/// Batch embeddings on the dedicated embed slot — indexing a folder
/// never evicts the chat model.
pub(crate) async fn embed(model: &str, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    // The window argument is inert in the embed slot (no `-c` there).
    let lease = crate::engine::supervisor::global()
        .ensure(
            crate::engine::SlotKind::Embed,
            model,
            crate::engine::chat_ctx(),
            &no_status,
        )
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
        .ensure(
            crate::engine::SlotKind::Chat,
            &model,
            crate::engine::chat_ctx(),
            &no_status,
        )
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
    /// Chat context window (tokens) in force — the UI shows a message's
    /// input against this as a "context budget" and the send pre-flight
    /// compares against it. The user's choice (Settings → Backend);
    /// surfaced here so the UI has a single source of truth instead of
    /// duplicating the number.
    chat_ctx: u32,
    /// The windows the user may pick from, smallest first. Rust owns the
    /// list (`engine::CHAT_CTX_CHOICES`) so the UI can't offer a size the
    /// setter would refuse.
    chat_ctx_choices: Vec<u32>,
    /// Which of those is the out-of-the-box window (the UI labels it).
    chat_ctx_default: u32,
    /// Settings → Backend → Thinking.
    thinking: bool,
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
        chat_ctx: crate::engine::chat_ctx(),
        chat_ctx_choices: crate::engine::CHAT_CTX_CHOICES.to_vec(),
        chat_ctx_default: crate::engine::DEFAULT_CHAT_CTX,
        thinking: crate::engine::thinking(),
    }
}

/// Persist + apply the engine's two user settings (Settings → Backend).
/// Either argument may be left out to keep that setting as it is. Returns
/// the fresh status so the caller redraws from what was actually applied.
///
/// Nothing restarts here. A new context window takes effect when the next
/// request finds the resident process at the old size (the supervisor
/// swaps it — idle now, or as soon as an in-flight reply ends); Thinking
/// takes effect on the next request with no reload at all.
#[tauri::command]
pub(crate) fn engine_tuning_set(
    state: tauri::State<'_, crate::db::DbState>,
    chat_ctx: Option<u32>,
    thinking: Option<bool>,
) -> Result<EngineStatus, String> {
    if let Some(n) = chat_ctx {
        if !crate::engine::valid_chat_ctx(n) {
            return Err(format!("unsupported context window: {n} tokens"));
        }
    }
    {
        let db = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(n) = chat_ctx {
            crate::db::set_setting(&db, crate::engine::SETTING_CHAT_CTX, &n.to_string())?;
        }
        if let Some(on) = thinking {
            crate::db::set_setting(
                &db,
                crate::engine::SETTING_THINKING,
                if on { "1" } else { "0" },
            )?;
        }
    }
    if let Some(n) = chat_ctx {
        crate::engine::set_chat_ctx(n);
    }
    if let Some(on) = thinking {
        crate::engine::set_thinking(on);
    }
    Ok(engine_status())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_needs_both_the_request_and_the_setting() {
        // Asked + setting on → the per-request override llama-server reads.
        let mut body = json!({ "model": "m", "think": true, "messages": [] });
        apply_thinking(&mut body, true);
        assert_eq!(
            body["chat_template_kwargs"],
            json!({ "enable_thinking": true })
        );

        // Asked, setting off → untouched (spawn default `--reasoning off`).
        let mut body = json!({ "model": "m", "think": true, "messages": [] });
        apply_thinking(&mut body, false);
        assert!(body.get("chat_template_kwargs").is_none());

        // Setting on, but the surface didn't ask (overlay, selection
        // actions) or asked for none (`think: false`, the Ollama-ism the
        // overlay sends for reasoning models) → never thinks.
        for b in [
            json!({ "model": "m", "messages": [] }),
            json!({ "model": "m", "think": false, "messages": [] }),
            json!({ "model": "m", "think": "true", "messages": [] }),
        ] {
            let mut body = b;
            apply_thinking(&mut body, true);
            assert!(body.get("chat_template_kwargs").is_none(), "{body}");
        }
    }

    #[test]
    fn thinking_kwargs_survive_translation_and_think_does_not() {
        // The whole path a main-chat request takes on the engine.
        let mut body = json!({
            "model": "m", "stream": true, "think": true,
            "messages": [{ "role": "user", "content": "hi" }],
        });
        apply_thinking(&mut body, true);
        let wire = openai_compat::translate_chat_body(&body);
        assert_eq!(
            wire["chat_template_kwargs"],
            json!({ "enable_thinking": true })
        );
        assert!(wire.get("think").is_none(), "Ollama-ism must not leak");

        // And with the setting off nothing extra reaches the wire.
        let mut body = json!({
            "model": "m", "stream": true, "think": true,
            "messages": [{ "role": "user", "content": "hi" }],
        });
        apply_thinking(&mut body, false);
        let wire = openai_compat::translate_chat_body(&body);
        assert!(wire.get("chat_template_kwargs").is_none());
        assert!(wire.get("think").is_none());
    }

    #[test]
    fn status_reports_the_window_choices_in_order() {
        let st = engine_status();
        assert_eq!(
            st.chat_ctx_choices,
            crate::engine::CHAT_CTX_CHOICES.to_vec()
        );
        assert!(st.chat_ctx_choices.contains(&st.chat_ctx));
        // The UI reads these exact keys.
        let v = serde_json::to_value(&st).unwrap();
        for key in [
            "chatCtx",
            "chatCtxChoices",
            "chatCtxDefault",
            "thinking",
            "binaryOk",
            "modelsDir",
        ] {
            assert!(v.get(key).is_some(), "engine_status lost `{key}`");
        }
    }
}
