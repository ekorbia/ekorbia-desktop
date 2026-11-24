// SPDX-License-Identifier: MIT

//! Bundled inference engine (no-Ollama plan, Phase 2 / L2 core).
//!
//! Ekorbia ships llama.cpp's `llama-server` as a Tauri sidecar
//! (`binaries/llama-server-<triple>`, built by
//! `scripts/fetch-llama-server.sh` from a PINNED source release) and runs
//! it as one or two supervised child processes: one for the chat model,
//! one for the embedding model. This module owns the process mechanics;
//! the scheduler that decides WHICH model runs lives in
//! [`supervisor`]; the provider adapter that speaks HTTP to the spawned
//! server is `providers/engine.rs` (which delegates the wire work to
//! `providers/openai_compat.rs` — llama-server speaks the /v1 dialect).
//!
//! ## Process-lifetime invariants (opposite of `start_ollama` — no orphans)
//!
//! `start_ollama` deliberately DETACHES (setsid) so Ollama outlives the
//! app. The bundled engine is the exact opposite: its processes must
//! never outlive Ekorbia. Three layers enforce that:
//!
//!   1. **Process group**: each spawn leads its own group; graceful app
//!      exit (RunEvent::Exit → [`shutdown_sync`]) SIGTERMs the group,
//!      waits briefly, SIGKILLs survivors.
//!   2. **Watchdog wrapper**: the server is spawned via a tiny
//!      `/bin/sh` wrapper that polls the APP's pid every 2s and kills
//!      the server when the app dies — this covers `kill -9` and
//!      Force-Quit, where no in-app cleanup can run.
//!   3. **RAII in the supervisor**: idle-unload and model swaps shut
//!      processes down through [`Handle::shutdown`], which also reaps
//!      the child (no zombies) and unregisters its process group.
//!
//! ## Security posture
//!
//! Loopback bind + a per-process random `--api-key` (16 bytes from
//! /dev/urandom). Strictly better than Ollama's tokenless :11434 — no
//! other local process can drive our server. `/health` and `/v1/models`
//! are auth-exempt by llama-server design (verified: inference endpoints
//! return 401 without the key); we only use `/health` from the exempt
//! set.
//!
//! ## Models directory
//!
//! `<app_data_dir>/models/*.gguf`, hand-placed in Phase 2 (the Phase 3
//! catalog + downloader fills it in-app). A model's id is its file stem
//! (`gemma-3-4b.gguf` → `gemma-3-4b`). Vision models pair with a
//! projector via sibling naming: `<stem>.mmproj.gguf` (preferred) or
//! `mmproj-<stem>.gguf`. Plain files, symlinks, and hardlinks all work.

pub(crate) mod downloads;
pub(crate) mod supervisor;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

// A note on the `cfg_attr(not(unix), allow(dead_code))` markers below:
// the engine's spawn path is unix-only (`spawn_real` is a stub error on
// other platforms — the bundled backend is macOS-first, plan Phase 6
// adds the rest). Everything reachable only through that path is dead
// code to Windows' clippy, which CI runs with `-D warnings`. The allows
// are scoped to non-unix so unix builds still catch REAL dead code.

/// DEFAULT context window for chat spawns, shared by the prompt AND the
/// reply. The user can pick another from [`CHAT_CTX_CHOICES`] in Settings →
/// Backend; [`chat_ctx`] is the value in force. llama-server's `-c 0` ("use
/// the model's native ctx") would allocate a cache for Gemma 4's full
/// 256K-token window — multiple GB of RAM for headroom chats never use.
///
/// 32768, raised from 8192 in Oct 2026: real pastes outgrew 8K (the
/// Tessera4X mod brief alone is ~9.8K tokens, so it 400'd before the model
/// could write a word). It is cheap on the catalog's Gemma 4 models, whose
/// sliding-window layers keep a fixed-size cache — only the few global
/// layers grow with `-c`. Measured on gemma4-12b (M1 Max, phys_footprint
/// beyond the weights, engine b10067): 8K 1.2 GB, 32K 1.6 GB, 64K 2.1 GB.
/// 64K was turned down AS THE DEFAULT because reading a full window at the
/// measured ~240 tok/s would take minutes, and because this window applies
/// to EVERY model, including link-added ones with full attention on every
/// layer, where the cache costs far more per token. Since 0.8.0 the bigger
/// windows are a user choice instead (see [`CHAT_CTX_CHOICES`]).
///
/// Engine bump to llama.cpp v0.9.0 (Nov 2026), same model and args,
/// two uncached 8.8K-token prompts per build: prompt read 231–240 tok/s
/// on b10067 vs 207–210 on v0.9.0 (its Metal flash-attention path);
/// decode ~35 tok/s and the 3.2 GB post-prompt footprint unchanged.
/// `-fa off` recovered prompt speed but cost decode speed and +0.9 GB,
/// so the defaults stay.
///
/// Embed spawns pass no `-c` at all: embedding models declare small
/// native contexts, and chunk sizes must fit the model's real window
/// anyway.
pub(crate) const DEFAULT_CHAT_CTX: u32 = 32768;

/// The windows Settings → Backend offers (tokens). A closed list on
/// purpose: `-c` is a RAM commitment made at spawn, so the UI shows five
/// honest steps rather than a free-form number, and the setter rejects
/// anything else. Changing the window takes a respawn — the supervisor
/// treats "same model, different window" like a model swap (idle slot
/// swaps on the next request, a streaming slot is waited out).
///
/// What the steps cost, measured on gemma4-12b (llama.cpp v0.9.0, M1 Max),
/// one uncached prompt filling ~85% of the window:
///
/// | `-c` | idle footprint | prompt read            | footprint after |
/// |------|----------------|------------------------|-----------------|
/// | 8K   | 1.10 GB        | 7.0K tok in 30 s       | 1.80 GB         |
/// | 16K  | 1.20 GB        | 13.9K tok in 77 s      | 1.80 GB         |
/// | 32K  | 1.50 GB        | 27.9K tok in 227 s     | 2.20 GB         |
/// | 64K  | 2.00 GB        | 55.7K tok in 751 s     | 2.80 GB         |
/// | 128K | 3.00 GB        | (not run: 30+ min)     | —               |
///
/// Memory is the small part: idle grows ~15 KB per token of window on
/// this model (only its global layers grow). A model with full attention
/// on every layer pays about double — qwen3.5-9b idles at 0.41 GB (8K),
/// 1.20 GB (32K) and 4.20 GB (128K), ~30 KB per token.
///
/// TIME is the real cost: read speed FALLS as the prompt grows (232 →
/// 181 → 123 → 74 tok/s above), so one paste that fills 64K takes twelve
/// minutes and 128K far longer. The big windows earn their place in long
/// CHATS, which fill a turn at a time while the prompt cache carries the
/// earlier turns — which is why they are a choice and 32K stays the
/// default.
pub(crate) const CHAT_CTX_CHOICES: [u32; 5] = [8192, 16384, 32768, 65536, 131072];

// The two user-facing engine settings, loaded from `app_settings` in
// `init` and updated live by `providers::engine::engine_tuning_set`.
// Plain atomics: each is one word, read on every request.
static CHAT_CTX_NOW: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(DEFAULT_CHAT_CTX);
static THINKING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Settings keys behind the two atomics above.
pub(crate) const SETTING_CHAT_CTX: &str = "engine_chat_ctx";
pub(crate) const SETTING_THINKING: &str = "engine_thinking";

/// The chat context window in force (tokens). New spawns use it, the
/// pre-flight compares against it, and `engine_status` reports it.
pub(crate) fn chat_ctx() -> u32 {
    CHAT_CTX_NOW.load(std::sync::atomic::Ordering::Relaxed)
}

/// Is "Thinking" on in Settings → Backend? It never reaches the spawn
/// arguments — see `build_args` and `providers::engine::apply_thinking`.
pub(crate) fn thinking() -> bool {
    THINKING.load(std::sync::atomic::Ordering::Relaxed)
}

pub(crate) fn valid_chat_ctx(n: u32) -> bool {
    CHAT_CTX_CHOICES.contains(&n)
}

/// Caller validates with [`valid_chat_ctx`] first.
pub(crate) fn set_chat_ctx(n: u32) {
    CHAT_CTX_NOW.store(n, std::sync::atomic::Ordering::Relaxed);
}

pub(crate) fn set_thinking(on: bool) {
    THINKING.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// Stored setting → window. Missing, unparseable, or no longer on the
/// list (a hand-edited DB, a choice a later version dropped) all fall back
/// to the default instead of spawning with a number nobody vetted.
pub(crate) fn parse_chat_ctx(raw: Option<&str>) -> u32 {
    raw.and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|n| valid_chat_ctx(*n))
        .unwrap_or(DEFAULT_CHAT_CTX)
}

/// Stored boolean setting: `"1"` / `"true"` are on, everything else off.
pub(crate) fn parse_flag(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1") | Some("true"))
}

/// How long a spawn may take to reach `/health` = 200 before we give up.
/// Dominated by weight loading — a 12B Q4 model takes ~10-30s from a
/// warm disk cache, longer cold. Generous beats flaky.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(180);

/// Grace between SIGTERM and SIGKILL when stopping a process.
#[cfg_attr(not(unix), allow(dead_code))]
const TERM_GRACE: Duration = Duration::from_millis(1500);

/// Last N log lines kept per process (ring buffer) — surfaced in spawn
/// failures ("model keeps crashing") so the user sees llama-server's
/// actual complaint instead of a bare timeout.
#[cfg_attr(not(unix), allow(dead_code))]
const LOG_TAIL: usize = 120;

// ── App-wide engine context (set once in lib.rs setup) ─────────────────────

struct EngineCtx {
    models_dir: PathBuf,
    /// Settings override `engine_binary_path` (power users / testing a
    /// different llama-server build). Read once at startup; changing it
    /// requires a relaunch — deliberate, this is an escape hatch, not a
    /// feature surface.
    binary_override: Option<String>,
}

static CTX: OnceLock<EngineCtx> = OnceLock::new();

/// Initialize engine state. Call from lib.rs setup AFTER the DB is
/// managed (reads settings) — also starts the idle-unload reaper task.
pub(crate) fn init(app: &tauri::AppHandle, conn: &rusqlite::Connection) {
    use tauri::Manager;
    // The two user settings first — they don't depend on anything below.
    set_chat_ctx(parse_chat_ctx(
        crate::db::get_setting(conn, SETTING_CHAT_CTX).as_deref(),
    ));
    set_thinking(parse_flag(
        crate::db::get_setting(conn, SETTING_THINKING).as_deref(),
    ));
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            crate::log::log_warn!("engine init: no app data dir ({e}) — engine backend disabled");
            return;
        }
    };
    let models_dir = data_dir.join("models");
    if let Err(e) = std::fs::create_dir_all(&models_dir) {
        crate::log::log_warn!("engine init: models dir create failed: {e}");
    }
    let binary_override =
        crate::db::get_setting(conn, "engine_binary_path").filter(|s| !s.trim().is_empty());
    let _ = CTX.set(EngineCtx {
        models_dir,
        binary_override,
    });

    // Idle-unload reaper: a resident model whose last stream ended more
    // than `engine_idle_unload_secs` ago (default 10 min, 0 = never)
    // gets shut down to release RAM. Uses try_lock inside — never
    // stalls behind an in-flight spawn.
    let idle_secs: u64 = crate::db::get_setting(conn, "engine_idle_unload_secs")
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(600);
    if idle_secs > 0 {
        tauri::async_runtime::spawn(async move {
            let idle = Duration::from_secs(idle_secs);
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                supervisor::global().reap_idle(idle).await;
            }
        });
    }
}

pub(crate) fn models_dir() -> Result<PathBuf, String> {
    CTX.get()
        .map(|c| c.models_dir.clone())
        .ok_or_else(|| "engine not initialized".to_string())
}

// ── Binary resolution ──────────────────────────────────────────────────────

/// Locate the llama-server binary. Order:
///   1. `engine_binary_path` setting (explicit override),
///   2. next to the app executable (where Tauri's externalBin lands the
///      sidecar in a bundled .app AND in `cargo tauri dev` target dirs),
///   3. `src-tauri/binaries/llama-server-*` via the compile-time
///      manifest path (dev builds run from anywhere — this is the
///      fetch-script install location, immune to the CWD gotcha).
pub(crate) fn resolve_binary() -> Result<PathBuf, String> {
    if let Some(over) = CTX.get().and_then(|c| c.binary_override.as_ref()) {
        let p = PathBuf::from(over);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!("engine_binary_path is set but not a file: {over}"));
    }
    let mut tried: Vec<String> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("llama-server");
            if p.is_file() {
                return Ok(p);
            }
            tried.push(p.display().to_string());
        }
    }
    let dev_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    if let Some(p) = find_prefixed_binary(&dev_dir, "llama-server") {
        return Ok(p);
    }
    tried.push(format!("{}/llama-server-*", dev_dir.display()));
    Err(format!(
        "llama-server binary not found (tried: {}). Run scripts/fetch-llama-server.sh once to build it.",
        tried.join(", ")
    ))
}

/// First regular file in `dir` whose name starts with `prefix`
/// (`llama-server-aarch64-apple-darwin` etc. — the externalBin naming
/// convention carries the target triple as a suffix).
fn find_prefixed_binary(dir: &Path, prefix: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(prefix))
        })
        .collect();
    candidates.sort();
    candidates.into_iter().next()
}

// ── Model discovery ────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ModelFile {
    /// Model id = file stem. What the UI's model picker shows and what
    /// chat bodies carry in `model`.
    pub(crate) name: String,
    pub(crate) size_bytes: u64,
}

/// Is this file a multimodal projector rather than a standalone model?
/// Two supported conventions (both appear in the wild on HF):
/// `<stem>.mmproj.gguf` and `mmproj-<whatever>.gguf`.
pub(crate) fn is_mmproj_name(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    lower.starts_with("mmproj") || lower.contains(".mmproj.")
}

/// Scan the models dir for `*.gguf` files (excluding projectors).
/// Follows symlinks deliberately — pointing a symlink at a GGUF you
/// already have elsewhere is the cheapest way to hand-place a model.
pub(crate) fn scan_models(dir: &Path) -> Vec<ModelFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<ModelFile> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !name.to_ascii_lowercase().ends_with(".gguf") || is_mmproj_name(&name) {
                return None;
            }
            // metadata() follows symlinks; broken links drop out here.
            let meta = std::fs::metadata(&path).ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(ModelFile {
                name: name[..name.len() - ".gguf".len()].to_string(),
                size_bytes: meta.len(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Model ids come from the UI — validate before joining onto a path.
/// Separators and NUL are the traversal vectors (the id is always used
/// as `<models_dir>/<id>.gguf`); a leading dot also covers `..` and
/// hidden files.
pub(crate) fn validate_model_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("empty model name".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') || name.starts_with('.') {
        return Err(format!("invalid model name: {name}"));
    }
    Ok(())
}

/// Absolute path for a model id, requiring the file to exist.
pub(crate) fn model_path(name: &str) -> Result<PathBuf, String> {
    validate_model_name(name)?;
    let dir = models_dir()?;
    let p = dir.join(format!("{name}.gguf"));
    if !std::fs::metadata(&p).map(|m| m.is_file()).unwrap_or(false) {
        return Err(format!(
            "model file not found: {name}.gguf (looked in {})",
            dir.display()
        ));
    }
    Ok(p)
}

/// Projector lookup for a model stem — see the module docs for the two
/// naming conventions. Pure function of `dir` for testability.
pub(crate) fn find_mmproj(dir: &Path, stem: &str) -> Option<PathBuf> {
    [
        dir.join(format!("{stem}.mmproj.gguf")),
        dir.join(format!("mmproj-{stem}.gguf")),
    ]
    .into_iter()
    .find(|cand| {
        std::fs::metadata(cand)
            .map(|m| m.is_file())
            .unwrap_or(false)
    })
}

/// Does this model have a projector (⇒ vision-capable on the engine)?
pub(crate) fn model_has_mmproj(name: &str) -> bool {
    if validate_model_name(name).is_err() {
        return false;
    }
    match models_dir() {
        Ok(dir) => find_mmproj(&dir, name).is_some(),
        Err(_) => false,
    }
}

// ── Spawn parameters ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SlotKind {
    Chat,
    Embed,
}

#[derive(Debug, Clone)]
#[cfg_attr(not(unix), allow(dead_code))] // fields read only by the unix spawn path
pub(crate) struct SpawnSpec {
    pub(crate) kind: SlotKind,
    pub(crate) model: String,
    pub(crate) gguf: PathBuf,
    pub(crate) mmproj: Option<PathBuf>,
    pub(crate) port: u16,
    pub(crate) api_key: String,
    /// Chat context window (`-c`). Ignored for embed spawns, which use
    /// the model's native context.
    pub(crate) chat_ctx: u32,
}

/// llama-server argv for a spec. Chat spawns get `--jinja` (GGUF chat
/// template incl. tool-call grammar — explicit even though current
/// builds default it on) and `--reasoning off`: the server-side fix for the
/// "/v1 thinking tax" documented in the plan notes. Ollama's /v1 honors
/// no thinking lever; OUR server does, so thinking models stop burning
/// ~10x tokens on hidden reasoning.
///
/// `--reasoning off` stays HARDCODED even though a Thinking toggle
/// shipped in 0.8.0: the toggle is opt-IN PER REQUEST
/// (`chat_template_kwargs.enable_thinking`, which llama-server lets a
/// request override — see `providers::engine::apply_thinking`), not a
/// spawn flag. That keeps the default path — the overlay, Watches, the
/// pre-flight count — exactly as fast as before, and flipping the toggle
/// costs no model reload. Verified on llama.cpp v0.9.0 with gemma4-12b,
/// gemma4-e2b and qwen3.5-9b: spawned `off`, a request with the kwarg
/// streams `delta.reasoning_content` ahead of the answer (one 10-token
/// answer became ~500 tokens — the tax is real), and tool calls still
/// arrive after the reasoning.
///
/// `-c` is the one argument the user controls (`SpawnSpec::chat_ctx`).
/// `-np 1` = one server slot: the full chat ctx serves one stream; a
/// second same-model stream queues server-side (same behavior users get
/// from default Ollama).
#[cfg_attr(not(unix), allow(dead_code))] // called only by the unix spawn path
pub(crate) fn build_args(spec: &SpawnSpec) -> Vec<String> {
    let mut args = vec![
        "-m".into(),
        spec.gguf.display().to_string(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        spec.port.to_string(),
        "--api-key".into(),
        spec.api_key.clone(),
        "-ngl".into(),
        "99".into(),
        "--no-webui".into(),
    ];
    match spec.kind {
        SlotKind::Chat => {
            args.extend([
                "--jinja".into(),
                "--reasoning".into(),
                "off".into(),
                "-c".into(),
                spec.chat_ctx.to_string(),
                "-np".into(),
                "1".into(),
            ]);
            if let Some(mm) = &spec.mmproj {
                args.extend(["--mmproj".into(), mm.display().to_string()]);
            }
        }
        SlotKind::Embed => {
            args.push("--embedding".into());
        }
    }
    args
}

/// Random per-process API key: 16 bytes of /dev/urandom as hex. The
/// fallback (no /dev/urandom — non-unix or exotic sandbox) hashes
/// pid + a monotonic counter + nanos twice; not cryptographic, but the
/// key only gates loopback access and the primary path is urandom.
pub(crate) fn gen_api_key() -> String {
    #[cfg(unix)]
    {
        use std::io::Read;
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            let mut buf = [0u8; 16];
            if f.read_exact(&mut buf).is_ok() {
                return buf.iter().map(|b| format!("{b:02x}")).collect();
            }
        }
    }
    use std::hash::{Hash, Hasher};
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut out = String::new();
    for round in 0..2u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        std::process::id().hash(&mut h);
        COUNTER
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .hash(&mut h);
        round.hash(&mut h);
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
            .hash(&mut h);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// OS-assigned ephemeral loopback port. The bind-then-release window
/// before llama-server binds is the standard benign race — ephemeral
/// ports aren't handed out again while in TIME_WAIT, and a lost race
/// surfaces as a spawn failure the supervisor retries.
pub(crate) fn alloc_port() -> Result<u16, String> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("no ephemeral port available: {e}"))
}

// ── Live process-group registry + app-exit kill switch ─────────────────────
//
// Every spawned process group registers its pgid here; Handle::shutdown
// and the reaper unregister. `shutdown_sync` (RunEvent::Exit in lib.rs)
// kills whatever is left WITHOUT taking supervisor locks — exit must
// never deadlock behind a wedged spawn.

static PGIDS: OnceLock<Mutex<std::collections::HashSet<i32>>> = OnceLock::new();

fn pgids() -> &'static Mutex<std::collections::HashSet<i32>> {
    PGIDS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

#[cfg_attr(not(unix), allow(dead_code))] // registrations happen in the unix spawn path
fn register_pgid(pgid: i32) {
    if let Ok(mut s) = pgids().lock() {
        s.insert(pgid);
    }
}

fn unregister_pgid(pgid: i32) {
    if let Ok(mut s) = pgids().lock() {
        s.remove(&pgid);
    }
}

#[cfg(unix)]
fn signal_group(pgid: i32, sig: libc::c_int) {
    // Negative pid = the whole process group (wrapper + server).
    unsafe {
        libc::kill(-pgid, sig);
    }
}

#[cfg(unix)]
fn group_alive(pgid: i32) -> bool {
    // Signal 0 probes deliverability without delivering anything.
    unsafe { libc::kill(-pgid, 0) == 0 }
}

/// Kill every live engine process group. Called from RunEvent::Exit —
/// synchronous and bounded (~TERM_GRACE worst case). Layer 2 (the
/// watchdog wrapper) covers the paths where this never runs.
pub(crate) fn shutdown_sync() {
    #[cfg(unix)]
    {
        let snapshot: Vec<i32> = pgids()
            .lock()
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default();
        if snapshot.is_empty() {
            return;
        }
        for pg in &snapshot {
            signal_group(*pg, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + TERM_GRACE;
        while std::time::Instant::now() < deadline {
            if snapshot.iter().all(|pg| !group_alive(*pg)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        for pg in &snapshot {
            if group_alive(*pg) {
                signal_group(*pg, libc::SIGKILL);
            }
        }
    }
}

// ── Real process handle ────────────────────────────────────────────────────

/// The watchdog wrapper (layer 2 of the no-orphans stack). `sh` becomes
/// the process-group leader; it backgrounds llama-server (stderr merged
/// into stdout for one log pipe), forwards TERM/INT, and polls the APP
/// pid every 2s — if Ekorbia dies without cleanup (`kill -9`,
/// Force-Quit), the wrapper TERM-then-KILLs the server and exits. `$$`
/// reuse of the parent pid is theoretically possible but the window is
/// seconds and the fallback is one orphan, not a leak class.
#[cfg(unix)]
const WATCHDOG_SH: &str = r#"
parent="$1"; shift
"$@" 2>&1 &
child=$!
trap 'kill -TERM "$child" 2>/dev/null' TERM INT
while kill -0 "$child" 2>/dev/null; do
  if ! kill -0 "$parent" 2>/dev/null; then
    kill -TERM "$child" 2>/dev/null
    sleep 2
    kill -KILL "$child" 2>/dev/null
    exit 0
  fi
  sleep 2
done
wait "$child"
"#;

pub(crate) struct RealHandle {
    child: tokio::process::Child,
    pgid: i32,
    port: u16,
    logs: Arc<Mutex<VecDeque<String>>>,
}

impl RealHandle {
    pub(crate) fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub(crate) fn tail_logs(&self) -> String {
        self.logs
            .lock()
            .map(|l| {
                l.iter()
                    .rev()
                    .take(8)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    }

    /// Poll `/health` until the server answers 200 (weights loaded) or
    /// the deadline passes. Fails fast if the process dies first —
    /// with its last log lines, which name the real problem (bad GGUF,
    /// OOM, unsupported arch) instead of a mute timeout.
    pub(crate) async fn wait_ready(&mut self) -> Result<(), String> {
        let url = format!("http://127.0.0.1:{}/health", self.port);
        // net-gate: this Mac only — the engine's own health check on
        // 127.0.0.1, so there is nothing for the gate (net.rs) to record.
        let client = reqwest::Client::new();
        let deadline = std::time::Instant::now() + HEALTH_TIMEOUT;
        loop {
            if !self.is_alive() {
                let tail = self.tail_logs();
                return Err(format!("engine process exited during startup.\n{tail}"));
            }
            if let Ok(resp) = client
                .get(&url)
                .timeout(Duration::from_secs(2))
                .send()
                .await
            {
                if resp.status().is_success() {
                    return Ok(());
                }
            }
            if std::time::Instant::now() > deadline {
                return Err(format!(
                    "engine didn't become healthy within {}s.\n{}",
                    HEALTH_TIMEOUT.as_secs(),
                    self.tail_logs()
                ));
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    }

    /// Graceful stop: TERM the group, give it TERM_GRACE, KILL
    /// leftovers, reap the wrapper (no zombie), unregister the pgid.
    pub(crate) async fn shutdown(&mut self) {
        #[cfg(unix)]
        {
            signal_group(self.pgid, libc::SIGTERM);
            let reap = tokio::time::timeout(TERM_GRACE, self.child.wait()).await;
            if reap.is_err() {
                signal_group(self.pgid, libc::SIGKILL);
                let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
            }
        }
        #[cfg(not(unix))]
        {
            let _ = self.child.kill().await;
        }
        unregister_pgid(self.pgid);
    }
}

/// Spawn llama-server (via the watchdog wrapper) for a spec. Returns a
/// handle whose process group is registered for the exit kill switch.
#[cfg(unix)]
pub(crate) fn spawn_real(spec: &SpawnSpec) -> Result<RealHandle, String> {
    let binary = resolve_binary()?;
    let args = build_args(spec);

    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(WATCHDOG_SH)
        .arg("ekorbia-engine-watchdog") // $0
        .arg(std::process::id().to_string()) // $1 = app pid
        .arg(&binary) // "$@" from here
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    {
        use std::os::unix::process::CommandExt;
        // New process group led by the wrapper — one negative-pid kill
        // reaches wrapper + server together.
        cmd.process_group(0);
    }

    crate::log::log_info!(
        "engine: spawning llama-server for `{}` ({:?}) on 127.0.0.1:{}",
        spec.model,
        spec.kind,
        spec.port
    );
    let mut child = tokio::process::Command::from(cmd)
        .spawn()
        .map_err(|e| format!("failed to spawn engine: {e}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "engine spawn returned no pid".to_string())? as i32;
    register_pgid(pid);

    // Log pump: wrapper's stdout carries the server's merged output.
    let logs: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(stdout) = child.stdout.take() {
        let sink = logs.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut l) = sink.lock() {
                    if l.len() >= LOG_TAIL {
                        l.pop_front();
                    }
                    l.push_back(line);
                }
            }
        });
    }

    Ok(RealHandle {
        child,
        pgid: pid,
        port: spec.port,
        logs,
    })
}

#[cfg(not(unix))]
pub(crate) fn spawn_real(_spec: &SpawnSpec) -> Result<RealHandle, String> {
    Err("the bundled engine backend is not yet available on this platform — use the Ollama or custom-endpoint backend".into())
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(kind: SlotKind, mmproj: Option<&str>) -> SpawnSpec {
        SpawnSpec {
            kind,
            model: "m".into(),
            gguf: PathBuf::from("/models/m.gguf"),
            mmproj: mmproj.map(PathBuf::from),
            port: 12345,
            api_key: "k".into(),
            chat_ctx: DEFAULT_CHAT_CTX,
        }
    }

    #[test]
    fn chat_args_carry_engine_invariants() {
        let args = build_args(&spec(SlotKind::Chat, None));
        let joined = args.join(" ");
        // Loopback + auth + GPU + template + no-thinking + bounded ctx.
        assert!(joined.contains("--host 127.0.0.1"));
        assert!(joined.contains("--api-key k"));
        assert!(joined.contains("-ngl 99"));
        assert!(joined.contains("--jinja"));
        assert!(joined.contains("--reasoning off"), "thinking-tax fix");
        // Pinned as a literal on purpose: the DEFAULT window is a measured
        // RAM trade-off (see DEFAULT_CHAT_CTX), so changing it should fail
        // a test.
        assert!(joined.contains("-c 32768"));
        assert!(joined.contains("--no-webui"));
        assert!(!joined.contains("--embedding"));
        assert!(!joined.contains("--mmproj"));
    }

    #[test]
    fn chat_args_follow_the_chosen_window_and_never_spawn_thinking() {
        for ctx in CHAT_CTX_CHOICES {
            let mut s = spec(SlotKind::Chat, None);
            s.chat_ctx = ctx;
            let joined = build_args(&s).join(" ");
            assert!(joined.contains(&format!("-c {ctx} ")), "{joined}");
            // Thinking is opt-in per request, never a spawn flag — the
            // overlay, Watches and the pre-flight rely on this default.
            assert!(joined.contains("--reasoning off"), "{joined}");
        }
    }

    #[test]
    fn stored_window_falls_back_to_the_default_unless_it_is_on_the_list() {
        assert_eq!(parse_chat_ctx(None), DEFAULT_CHAT_CTX);
        assert_eq!(parse_chat_ctx(Some("")), DEFAULT_CHAT_CTX);
        assert_eq!(parse_chat_ctx(Some("lots")), DEFAULT_CHAT_CTX);
        // Parses, but nobody vetted it: 0 is llama-server's "native ctx".
        assert_eq!(parse_chat_ctx(Some("0")), DEFAULT_CHAT_CTX);
        assert_eq!(parse_chat_ctx(Some("40000")), DEFAULT_CHAT_CTX);
        assert_eq!(parse_chat_ctx(Some("8192")), 8192);
        assert_eq!(parse_chat_ctx(Some(" 131072 ")), 131072);
        assert!(valid_chat_ctx(DEFAULT_CHAT_CTX), "default must be offered");
        assert!(!valid_chat_ctx(4096));
        let mut sorted = CHAT_CTX_CHOICES;
        sorted.sort_unstable();
        assert_eq!(sorted, CHAT_CTX_CHOICES, "the UI lists them in order");
    }

    #[test]
    fn stored_flag_is_on_only_for_one_or_true() {
        assert!(parse_flag(Some("1")));
        assert!(parse_flag(Some("true")));
        assert!(parse_flag(Some(" 1 ")));
        assert!(!parse_flag(Some("0")));
        assert!(!parse_flag(Some("")));
        assert!(!parse_flag(Some("yes")));
        assert!(!parse_flag(None));
    }

    #[test]
    fn chat_args_include_mmproj_when_present() {
        let args = build_args(&spec(SlotKind::Chat, Some("/models/m.mmproj.gguf")));
        let joined = args.join(" ");
        assert!(joined.contains("--mmproj /models/m.mmproj.gguf"));
    }

    #[test]
    fn embed_args_are_minimal() {
        let args = build_args(&spec(SlotKind::Embed, None));
        let joined = args.join(" ");
        assert!(joined.contains("--embedding"));
        assert!(!joined.contains("--jinja"));
        assert!(!joined.contains("--reasoning"));
        assert!(
            !args.iter().any(|a| a == "-c"),
            "embed uses model-native ctx"
        );
    }

    #[test]
    fn mmproj_naming_conventions() {
        assert!(is_mmproj_name("mmproj-gemma-3-4b.gguf"));
        assert!(is_mmproj_name("MMPROJ-model-f16.gguf"));
        assert!(is_mmproj_name("gemma-3-4b.mmproj.gguf"));
        assert!(!is_mmproj_name("gemma-3-4b.gguf"));
        assert!(!is_mmproj_name("my-mmproj-notes.gguf")); // mid-name ≠ prefix
    }

    #[test]
    fn scan_finds_models_and_skips_projectors() {
        let dir = std::env::temp_dir().join(format!("ek-engine-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("gemma-3-4b.gguf"), b"GGUFxxxx").unwrap();
        std::fs::write(dir.join("gemma-3-4b.mmproj.gguf"), b"GGUF").unwrap();
        std::fs::write(dir.join("mmproj-other.gguf"), b"GGUF").unwrap();
        std::fs::write(dir.join("notes.txt"), b"nope").unwrap();
        std::fs::write(dir.join("nomic-embed.GGUF"), b"GGUFyy").unwrap();

        let models = scan_models(&dir);
        let names: Vec<&str> = models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["gemma-3-4b", "nomic-embed"]);
        assert_eq!(models[0].size_bytes, 8);

        let mm = find_mmproj(&dir, "gemma-3-4b").unwrap();
        assert!(mm.ends_with("gemma-3-4b.mmproj.gguf"));
        assert!(find_mmproj(&dir, "nomic-embed").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn model_name_validation_rejects_traversal() {
        assert!(validate_model_name("gemma-3-4b").is_ok());
        assert!(validate_model_name("nomic-embed-text-v1.5").is_ok());
        assert!(validate_model_name("").is_err());
        assert!(validate_model_name("../etc/passwd").is_err());
        assert!(validate_model_name("a/b").is_err());
        assert!(validate_model_name("a\\b").is_err());
        assert!(validate_model_name(".hidden").is_err());
        assert!(validate_model_name("..").is_err());
    }

    #[test]
    fn api_keys_are_long_and_distinct() {
        let a = gen_api_key();
        let b = gen_api_key();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn alloc_port_returns_nonzero() {
        assert!(alloc_port().unwrap() > 0);
    }

    /// Real-binary integration smoke — ignored in normal runs (CI has no
    /// engine binary or GGUF). Exercises the sh-wrapper spawn, the log
    /// pump, /health readiness, and group shutdown against a real
    /// llama-server. Run manually:
    ///
    ///   EKORBIA_ENGINE_TEST_GGUF=/path/to/model.gguf \
    ///     cargo test --lib engine_real_spawn_smoke -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn engine_real_spawn_smoke() {
        let Ok(gguf) = std::env::var("EKORBIA_ENGINE_TEST_GGUF") else {
            eprintln!("set EKORBIA_ENGINE_TEST_GGUF to run this");
            return;
        };
        let spec = SpawnSpec {
            kind: SlotKind::Embed,
            model: "smoke".into(),
            gguf: PathBuf::from(gguf),
            mmproj: None,
            port: alloc_port().unwrap(),
            api_key: gen_api_key(),
            chat_ctx: DEFAULT_CHAT_CTX,
        };
        let mut h = spawn_real(&spec).expect("spawn");
        h.wait_ready().await.expect("healthy");
        assert!(h.is_alive());

        // Auth is enforced on inference endpoints.
        let client = reqwest::Client::new();
        let unauth = client
            .post(format!("http://127.0.0.1:{}/v1/embeddings", spec.port))
            .json(&serde_json::json!({"input": ["x"]}))
            .send()
            .await
            .expect("request");
        assert_eq!(unauth.status(), 401, "no key must be rejected");
        let authed = client
            .post(format!("http://127.0.0.1:{}/v1/embeddings", spec.port))
            .bearer_auth(&spec.api_key)
            .json(&serde_json::json!({"input": ["hello engine"]}))
            .send()
            .await
            .expect("request");
        assert!(authed.status().is_success());

        h.shutdown().await;
        assert!(!h.is_alive(), "group shutdown must reap the process");
    }
}
