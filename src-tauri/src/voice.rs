// SPDX-License-Identifier: MIT

//! Voice input — local push-to-talk dictation.
//!
//! Pipeline: `cpal` microphone capture → downmix to mono → linear resample
//! to 16 kHz → whisper.cpp transcription (via `whisper-rs`, Metal-accelerated
//! on Apple Silicon). Everything runs on-device; the only network the feature
//! ever touches is the one-time model download from Hugging Face (the ggml
//! `.bin` files whisper.cpp expects), which mirrors the streamed-progress +
//! cancel UX of the Ollama model manager (see `ollama.rs`).
//!
//! Threading: `cpal::Stream` is `!Send` (it owns a CoreAudio AudioUnit), so
//! capture runs on its own dedicated thread that builds, owns, and drops the
//! stream. Only the Send-safe sample buffer and stop flag cross threads.
//!
//! Microphone permission is the OS's job. The macOS app bundle declares
//! `NSMicrophoneUsageDescription` (`src-tauri/Info.plist`) so the system shows
//! the TCC consent prompt the first time capture starts. If the user denies —
//! or simply hasn't granted yet — the capture callback receives nothing/
//! silence; `voice_record_stop` detects an empty or near-silent buffer and
//! returns `captured: false`, letting the UI guide the user to System
//! Settings. A pre-flight AVFoundation authorization check is a Phase 2
//! polish item; for now we rely on the OS prompt + silence detection.

use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

// Seeds Whisper's decoder so it spells our domain proper-nouns correctly —
// without this they come back as "Acorbia" / "Alama" (confirmed in the
// Phase 0 spike). Kept short: the initial prompt competes with real audio
// for the context window.
const INITIAL_PROMPT: &str = "Ekorbia, Ollama, Gemma, Whisper, Qwen, Llama.";

// Whisper wants 16 kHz mono f32. Capture devices run at 44.1/48 kHz, so we
// resample down before inference.
const WHISPER_RATE: u32 = 16_000;

// ── Model storage ──────────────────────────────────────────────────────────

/// Whisper models live under `<app_data_dir>/whisper-models/` as the standard
/// `ggml-<name>.bin` files whisper.cpp loads (e.g. `ggml-base.en.bin`).
fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("whisper-models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create models dir: {e}"))?;
    Ok(dir)
}

/// A model name is the `<name>` in `ggml-<name>.bin` (e.g. "base.en"). It's
/// interpolated into a fixed Hugging Face URL template and a filename, so we
/// validate it to a safe charset — defence against path traversal / URL
/// injection even though the names originate from our own curated UI list.
fn valid_model_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && !name.contains("..")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

fn model_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !valid_model_name(name) {
        return Err(format!("invalid voice model name: {name}"));
    }
    Ok(models_dir(app)?.join(format!("ggml-{name}.bin")))
}

fn hf_url(name: &str) -> String {
    format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin")
}

/// Installed whisper model names (the `<name>` from each `ggml-<name>.bin`).
/// Partial downloads (`*.partial`) are ignored.
#[tauri::command]
pub(crate) fn voice_models_installed(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = models_dir(&app)?;
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let fname = entry.file_name();
            let fname = fname.to_string_lossy();
            if let Some(rest) = fname.strip_prefix("ggml-") {
                if let Some(name) = rest.strip_suffix(".bin") {
                    if !name.is_empty() {
                        out.push(name.to_string());
                    }
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Delete an installed whisper model from disk.
#[tauri::command]
pub(crate) fn voice_model_delete(app: AppHandle, name: String) -> Result<(), String> {
    let path = model_path(&app, &name)?;
    // Drop the cached context if it's the one being removed.
    evict_cached_context(&name);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("delete model: {e}"))?;
    }
    Ok(())
}

// ── Model download (streamed progress + cancel) ────────────────────────────
//
// Mirrors the ollama_pull cancellation model: a per-request AtomicBool in a
// registry, flipped by voice_model_download_cancel, polled between chunks. We
// download to a `.partial` sibling and rename on success so an interrupted
// download never leaves a truncated file that looks installed.

static DL_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn dl_registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    DL_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// RAII guard — Drop removes the registry entry on every exit path (return,
/// early-break, panic-unwind), so the map can't leak. Mirrors ChatCancelToken.
struct DlToken {
    id: String,
    flag: Arc<AtomicBool>,
}

impl Drop for DlToken {
    fn drop(&mut self) {
        if let Ok(mut m) = dl_registry().lock() {
            m.remove(&self.id);
        }
    }
}

fn register_dl(id: &str) -> DlToken {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut m) = dl_registry().lock() {
        m.insert(id.to_string(), flag.clone());
    }
    DlToken {
        id: id.to_string(),
        flag,
    }
}

/// Flip the cancel flag for an in-flight download. No-op for unknown ids.
#[tauri::command]
pub(crate) fn voice_model_download_cancel(request_id: String) {
    if let Ok(m) = dl_registry().lock() {
        if let Some(flag) = m.get(&request_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Download `ggml-<name>.bin` from Hugging Face, streaming `{completed, total}`
/// byte progress to the UI over a Tauri Channel. Resolves Ok on success,
/// cancel, or JS dropping the channel; Err on HTTP/IO failure.
#[tauri::command]
pub(crate) async fn voice_model_download(
    app: AppHandle,
    name: String,
    request_id: String,
    on_progress: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    let dest = model_path(&app, &name)?;
    if dest.exists() {
        let _ = on_progress.send(serde_json::json!({ "completed": 1, "total": 1, "done": true }));
        return Ok(());
    }

    let token = register_dl(&request_id);
    let cancel = token.flag.clone();

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut resp = client
        .get(hf_url(&name))
        // Whisper models are tens-to-hundreds of MB; the default per-request
        // timeout would abort a slow connection mid-download.
        .timeout(Duration::from_secs(60 * 60))
        .send()
        .await
        .map_err(|e| format!("download request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download returned HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    let partial = dest.with_extension("partial");
    let mut file =
        std::fs::File::create(&partial).map_err(|e| format!("create download file: {e}"))?;
    let mut completed: u64 = 0;

    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = std::fs::remove_file(&partial);
            return Ok(());
        }
        let next = resp
            .chunk()
            .await
            .map_err(|e| format!("download read failed: {e}"))?;
        let bytes = match next {
            Some(b) => b,
            None => break,
        };
        file.write_all(&bytes)
            .map_err(|e| format!("write failed: {e}"))?;
        completed += bytes.len() as u64;
        // Channel send failure = JS handle dropped → treat as cancel.
        if on_progress
            .send(serde_json::json!({ "completed": completed, "total": total }))
            .is_err()
        {
            drop(file);
            let _ = std::fs::remove_file(&partial);
            return Ok(());
        }
    }

    file.flush().map_err(|e| format!("flush failed: {e}"))?;
    drop(file);
    std::fs::rename(&partial, &dest).map_err(|e| format!("finalize failed: {e}"))?;
    let _ = on_progress.send(
        serde_json::json!({ "completed": completed.max(total), "total": total, "done": true }),
    );
    Ok(())
}

// ── Whisper context cache ──────────────────────────────────────────────────
//
// Loading a model is ~150 ms once the Metal shader library is built (a
// one-time ~8 s cost on a cold machine). We cache the most-recently-used
// context so repeated dictations skip the reload, and expose voice_prewarm so
// the app can pay the cold cost in the background at startup instead of on the
// user's first dictation. WhisperContext is Send + Sync (whisper-rs marks the
// inner context so), so a global cache is sound.

struct CachedCtx {
    name: String,
    ctx: Arc<WhisperContext>,
}

static WHISPER_CACHE: OnceLock<Mutex<Option<CachedCtx>>> = OnceLock::new();

fn whisper_cache() -> &'static Mutex<Option<CachedCtx>> {
    WHISPER_CACHE.get_or_init(|| Mutex::new(None))
}

fn evict_cached_context(name: &str) {
    if let Ok(mut g) = whisper_cache().lock() {
        if g.as_ref().is_some_and(|c| c.name == name) {
            *g = None;
        }
    }
}

fn load_or_get_context(app: &AppHandle, name: &str) -> Result<Arc<WhisperContext>, String> {
    // Silence whisper.cpp + ggml/Metal's stderr spam (model-load + backend-init
    // logging that otherwise prints on every dictation). whisper-rs captures it
    // via its logging hooks; we don't enable the log/tracing backends, so it's
    // dropped rather than printed. Idempotent — only the first call installs.
    whisper_rs::install_logging_hooks();
    {
        let g = whisper_cache().lock().map_err(|_| "cache lock poisoned")?;
        if let Some(c) = g.as_ref() {
            if c.name == name {
                return Ok(c.ctx.clone());
            }
        }
    }
    let path = model_path(app, name)?;
    if !path.exists() {
        return Err(format!("voice model '{name}' is not installed"));
    }
    let path_str = path.to_string_lossy().to_string();
    let ctx = WhisperContext::new_with_params(&path_str, WhisperContextParameters::default())
        .map_err(|e| format!("load whisper model: {e}"))?;
    let arc = Arc::new(ctx);
    if let Ok(mut g) = whisper_cache().lock() {
        *g = Some(CachedCtx {
            name: name.to_string(),
            ctx: arc.clone(),
        });
    }
    Ok(arc)
}

/// Load (and cache) a model so the first real dictation is fast. Also pays the
/// one-time Metal shader-compile cost up front. Safe to call repeatedly.
#[tauri::command]
pub(crate) async fn voice_prewarm(app: AppHandle, model: String) -> Result<(), String> {
    // Loading a model (incl. the one-time Metal shader compile) blocks; run it
    // on the blocking pool so the UI / async threads stay responsive.
    tokio::task::spawn_blocking(move || load_or_get_context(&app, &model).map(|_| ()))
        .await
        .map_err(|e| format!("prewarm task failed: {e}"))?
}

/// Resolve the effective recognition language + translate flag for a model.
/// English-only models (`*.en`) always transcribe English and can't run the
/// translate task, so force `("en", false)` for them regardless of the user's
/// picks. Multilingual models use the chosen language ("auto" auto-detects)
/// and honour translate-to-English.
fn effective_lang_translate<'a>(
    model: &str,
    language: Option<&'a str>,
    translate: bool,
) -> (&'a str, bool) {
    if model.ends_with(".en") {
        ("en", false)
    } else {
        (language.unwrap_or("auto"), translate)
    }
}

fn transcribe_samples(
    ctx: &WhisperContext,
    audio: &[f32],
    language: &str,
    translate: bool,
) -> Result<String, String> {
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("whisper state: {e}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let threads = std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4)
        .clamp(1, 8);
    params.set_n_threads(threads);
    params.set_language(Some(language));
    params.set_translate(translate);
    // Each dictation is independent — don't carry decoder state between them.
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_initial_prompt(INITIAL_PROMPT);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_print_special(false);

    state
        .full(params, audio)
        .map_err(|e| format!("transcription failed: {e}"))?;

    let n = state.full_n_segments();
    let mut text = String::new();
    for i in 0..n {
        if let Some(seg) = state.get_segment(i) {
            if let Ok(s) = seg.to_str_lossy() {
                text.push_str(&s);
            }
        }
    }
    Ok(text.trim().to_string())
}

// ── Microphone capture (dedicated thread; cpal::Stream is !Send) ────────────

struct RecSession {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    in_rate: Arc<AtomicU32>,
    handle: Option<std::thread::JoinHandle<()>>,
}

static REC_SESSIONS: OnceLock<Mutex<HashMap<String, RecSession>>> = OnceLock::new();

fn rec_sessions() -> &'static Mutex<HashMap<String, RecSession>> {
    REC_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn take_session(session_id: &str) -> Option<RecSession> {
    rec_sessions().lock().ok()?.remove(session_id)
}

/// Signal a session to stop and join its capture thread, discarding samples.
fn stop_and_join(session_id: &str) {
    if let Some(mut sess) = take_session(session_id) {
        sess.stop.store(true, Ordering::Relaxed);
        if let Some(h) = sess.handle.take() {
            let _ = h.join();
        }
    }
}

/// Begin capturing from the default input device. Blocks until the audio
/// stream is actually running (or fails to build), so the caller knows the mic
/// is live before it shows a recording indicator.
#[tauri::command]
pub(crate) async fn voice_record_start(
    session_id: String,
    vad: bool,
    on_event: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    // Building the input stream + waiting for it to start blocks; run on the
    // blocking pool so the UI / async threads stay responsive.
    tokio::task::spawn_blocking(move || voice_record_start_blocking(session_id, vad, on_event))
        .await
        .map_err(|e| format!("record start task failed: {e}"))?
}

fn voice_record_start_blocking(
    session_id: String,
    vad: bool,
    on_event: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    // Replace any stale session reusing this id (defensive — the UI uses a
    // fresh id per press).
    stop_and_join(&session_id);

    let stop = Arc::new(AtomicBool::new(false));
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let in_rate = Arc::new(AtomicU32::new(0));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let t_stop = stop.clone();
    let t_samples = samples.clone();
    let t_rate = in_rate.clone();
    let handle = std::thread::spawn(move || {
        run_capture(t_stop, t_samples, t_rate, ready_tx, vad, on_event);
    });

    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = handle.join();
            return Err(e);
        }
        Err(_) => {
            stop.store(true, Ordering::Relaxed);
            let _ = handle.join();
            return Err("microphone did not start in time".into());
        }
    }

    if let Ok(mut m) = rec_sessions().lock() {
        m.insert(
            session_id,
            RecSession {
                stop,
                samples,
                in_rate,
                handle: Some(handle),
            },
        );
    }
    Ok(())
}

// ── Voice-activity detection (auto-stop on silence) ─────────────────────────
//
// Energy-based: the capture callback stores the latest buffer's peak amplitude
// and the polling loop decides when trailing silence (after some speech) means
// the user is done. Crude next to a trained VAD but plenty for push-to-talk
// dictation and dependency-free. Tunables are conservative so a pause
// mid-thought doesn't clip the recording.
const VAD_POLL_MS: u32 = 30;
const VAD_SPEECH_THRESHOLD: f32 = 0.02; // peak amplitude that counts as speech
const VAD_SILENCE_MS: u32 = 1500; // trailing silence (after speech) → stop
const VAD_MAX_MS: u32 = 60_000; // hard cap so a hot mic can't record forever

#[derive(Default)]
struct VadState {
    had_speech: bool,
    silent_ms: u32,
    elapsed_ms: u32,
}

/// Advance the VAD by one poll tick; return whether to auto-stop. Pure (no
/// I/O) so the silence logic is unit-testable. `level` is the current peak
/// amplitude in 0..1.
fn vad_should_stop(state: &mut VadState, level: f32, tick_ms: u32) -> bool {
    state.elapsed_ms = state.elapsed_ms.saturating_add(tick_ms);
    if level > VAD_SPEECH_THRESHOLD {
        state.had_speech = true;
        state.silent_ms = 0;
    } else if state.had_speech {
        state.silent_ms = state.silent_ms.saturating_add(tick_ms);
    }
    (state.had_speech && state.silent_ms >= VAD_SILENCE_MS) || state.elapsed_ms >= VAD_MAX_MS
}

/// Owns the cpal stream for its whole lifetime (the stream is !Send, so it can
/// never leave this thread). Reports build/start success or failure back to
/// `voice_record_start` via `ready`, then idles until the stop flag is set —
/// or, when `vad` is on, until trailing silence triggers an auto-stop, which it
/// announces on `on_event` so the UI can finalize like a manual stop.
fn run_capture(
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    in_rate: Arc<AtomicU32>,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
    vad: bool,
    on_event: tauri::ipc::Channel<serde_json::Value>,
) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let host = cpal::default_host();
    let device = match host.default_input_device() {
        Some(d) => d,
        None => {
            let _ = ready.send(Err("no microphone found".into()));
            return;
        }
    };
    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(format!("input config: {e}")));
            return;
        }
    };
    in_rate.store(supported.sample_rate().0, Ordering::Relaxed);
    let channels = supported.channels() as usize;
    let fmt = supported.sample_format();
    let cfg: cpal::StreamConfig = supported.into();
    let err_fn = |e| eprintln!("[voice] stream error: {e}");

    // Latest buffer peak amplitude × 10000, read by the VAD polling loop.
    let level = Arc::new(AtomicU32::new(0));

    // Downmix each frame to mono, append, and track the buffer peak. The audio
    // callback runs on a realtime thread; keep it allocation-light.
    let s = samples.clone();
    let lvl = level.clone();
    let stream_result: Result<cpal::Stream, String> = match fmt {
        cpal::SampleFormat::F32 => device
            .build_input_stream(
                &cfg,
                move |data: &[f32], _: &_| {
                    let mut peak = 0.0f32;
                    if let Ok(mut g) = s.lock() {
                        for fr in data.chunks(channels) {
                            let v = fr.iter().sum::<f32>() / channels as f32;
                            if v.abs() > peak {
                                peak = v.abs();
                            }
                            g.push(v);
                        }
                    }
                    lvl.store((peak * 10000.0) as u32, Ordering::Relaxed);
                },
                err_fn,
                None,
            )
            .map_err(|e| e.to_string()),
        cpal::SampleFormat::I16 => device
            .build_input_stream(
                &cfg,
                move |data: &[i16], _: &_| {
                    let mut peak = 0.0f32;
                    if let Ok(mut g) = s.lock() {
                        for fr in data.chunks(channels) {
                            let v = fr.iter().map(|x| *x as f32 / 32768.0).sum::<f32>()
                                / channels as f32;
                            if v.abs() > peak {
                                peak = v.abs();
                            }
                            g.push(v);
                        }
                    }
                    lvl.store((peak * 10000.0) as u32, Ordering::Relaxed);
                },
                err_fn,
                None,
            )
            .map_err(|e| e.to_string()),
        cpal::SampleFormat::U16 => device
            .build_input_stream(
                &cfg,
                move |data: &[u16], _: &_| {
                    let mut peak = 0.0f32;
                    if let Ok(mut g) = s.lock() {
                        for fr in data.chunks(channels) {
                            let v = fr
                                .iter()
                                .map(|x| (*x as f32 - 32768.0) / 32768.0)
                                .sum::<f32>()
                                / channels as f32;
                            if v.abs() > peak {
                                peak = v.abs();
                            }
                            g.push(v);
                        }
                    }
                    lvl.store((peak * 10000.0) as u32, Ordering::Relaxed);
                },
                err_fn,
                None,
            )
            .map_err(|e| e.to_string()),
        other => Err(format!("unsupported sample format: {other:?}")),
    };

    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = ready.send(Err(format!("stream play: {e}")));
        return;
    }
    let _ = ready.send(Ok(()));

    let mut vad_state = VadState::default();
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(VAD_POLL_MS as u64));
        if vad {
            let lvl = level.load(Ordering::Relaxed) as f32 / 10000.0;
            if vad_should_stop(&mut vad_state, lvl, VAD_POLL_MS) {
                let _ = on_event.send(serde_json::json!({ "type": "autostop" }));
                stop.store(true, Ordering::Relaxed);
                break;
            }
        }
    }
    drop(stream);
}

/// Discard an in-progress recording without transcribing.
#[tauri::command]
pub(crate) fn voice_record_cancel(session_id: String) {
    stop_and_join(&session_id);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceResult {
    /// Transcribed text (empty when `captured` is false).
    text: String,
    /// False when the buffer was empty/near-silent — almost always a denied
    /// or not-yet-granted mic permission. The UI prompts accordingly.
    captured: bool,
    /// Seconds of audio captured (after resampling), for UI/telemetry.
    audio_secs: f32,
}

/// Stop capturing, transcribe the buffer with `model`, return the text.
#[tauri::command]
pub(crate) async fn voice_record_stop(
    app: AppHandle,
    session_id: String,
    model: String,
    language: Option<String>,
    translate: bool,
) -> Result<VoiceResult, String> {
    // Joining the capture thread + running Whisper blocks; keep it off the
    // async worker threads.
    tokio::task::spawn_blocking(move || {
        voice_record_stop_blocking(&app, &session_id, &model, language.as_deref(), translate)
    })
    .await
    .map_err(|e| format!("transcription task failed: {e}"))?
}

fn voice_record_stop_blocking(
    app: &AppHandle,
    session_id: &str,
    model: &str,
    language: Option<&str>,
    translate: bool,
) -> Result<VoiceResult, String> {
    let mut sess = take_session(session_id).ok_or_else(|| "no active recording".to_string())?;
    sess.stop.store(true, Ordering::Relaxed);
    if let Some(h) = sess.handle.take() {
        let _ = h.join();
    }
    let in_rate = sess.in_rate.load(Ordering::Relaxed).max(1);
    let raw = std::mem::take(
        &mut *sess
            .samples
            .lock()
            .map_err(|_| "audio buffer lock poisoned".to_string())?,
    );
    let audio = resample_linear(&raw, in_rate, WHISPER_RATE);
    let audio_secs = audio.len() as f32 / WHISPER_RATE as f32;

    // < 0.1 s or essentially silent → the mic almost certainly wasn't granted
    // (callback delivered nothing/zeros). Report captured=false so the UI can
    // point the user at System Settings rather than show an empty transcript.
    let peak = audio.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    if audio.len() < (WHISPER_RATE / 10) as usize || peak < 0.005 {
        return Ok(VoiceResult {
            text: String::new(),
            captured: false,
            audio_secs,
        });
    }

    let ctx = load_or_get_context(app, model)?;
    let (lang, do_translate) = effective_lang_translate(model, language, translate);
    let text = transcribe_samples(&ctx, &audio, lang, do_translate)?;
    Ok(VoiceResult {
        text,
        captured: true,
        audio_secs,
    })
}

/// Linear-interpolation resample. Quality is fine for speech → Whisper; a
/// polyphase resampler would be overkill for 16 kHz dictation.
fn resample_linear(input: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
    if input.is_empty() || in_rate == 0 || in_rate == out_rate {
        return input.to_vec();
    }
    let ratio = out_rate as f64 / in_rate as f64;
    let out_len = (input.len() as f64 * ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vad_stops_after_silence_following_speech() {
        // Silence with no prior speech never triggers an auto-stop.
        let mut st = VadState::default();
        for _ in 0..300 {
            assert!(!vad_should_stop(&mut st, 0.0, 30));
        }
        // Speech, then trailing silence → stops within ~VAD_SILENCE_MS.
        let mut st = VadState::default();
        assert!(!vad_should_stop(&mut st, 0.5, 30));
        let mut stopped = false;
        for _ in 0..(VAD_SILENCE_MS / 30 + 2) {
            if vad_should_stop(&mut st, 0.0, 30) {
                stopped = true;
                break;
            }
        }
        assert!(stopped, "should auto-stop after trailing silence");
    }

    #[test]
    fn vad_hard_cap_fires_under_constant_speech() {
        let mut st = VadState::default();
        let mut stopped = false;
        for _ in 0..(VAD_MAX_MS / 30 + 2) {
            if vad_should_stop(&mut st, 0.9, 30) {
                stopped = true;
                break;
            }
        }
        assert!(stopped, "hard cap should fire even with continuous speech");
    }

    #[test]
    fn model_name_validation() {
        assert!(valid_model_name("base.en"));
        assert!(valid_model_name("large-v3-turbo"));
        assert!(valid_model_name("small"));
        assert!(!valid_model_name(""));
        assert!(!valid_model_name("../etc/passwd"));
        assert!(!valid_model_name("a/b"));
        assert!(!valid_model_name("has space"));
        assert!(!valid_model_name("..")); // contains ".."
    }

    #[test]
    fn lang_translate_gating() {
        // English-only models force ("en", false) and ignore the user's picks.
        assert_eq!(
            effective_lang_translate("base.en", Some("es"), true),
            ("en", false)
        );
        // Multilingual models honour the chosen language + translate flag.
        assert_eq!(
            effective_lang_translate("small", Some("es"), true),
            ("es", true)
        );
        assert_eq!(
            effective_lang_translate("base", Some("auto"), false),
            ("auto", false)
        );
        // No language → auto-detect on multilingual.
        assert_eq!(
            effective_lang_translate("large-v3-turbo", None, true),
            ("auto", true)
        );
    }

    #[test]
    fn hf_url_shape() {
        let u = hf_url("base.en");
        assert!(u.starts_with("https://huggingface.co/"));
        assert!(u.ends_with("ggml-base.en.bin"));
    }

    #[test]
    fn resample_passthrough_and_downsample() {
        let x = vec![0.0_f32, 1.0, 0.0, -1.0];
        assert_eq!(resample_linear(&x, 16000, 16000), x);
        assert_eq!(resample_linear(&[], 48000, 16000), Vec::<f32>::new());

        let down = resample_linear(&vec![0.5_f32; 48000], 48000, 16000);
        // 48k → 16k is a 3× decimation; length within rounding of 16000.
        assert!(
            (down.len() as i64 - 16000).abs() <= 1,
            "len was {}",
            down.len()
        );
        // Constant signal stays constant through interpolation.
        assert!(down.iter().all(|&v| (v - 0.5).abs() < 1e-6));
    }
}
