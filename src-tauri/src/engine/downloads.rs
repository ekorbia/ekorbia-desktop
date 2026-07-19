// SPDX-License-Identifier: MIT

//! Model catalog + downloader (no-Ollama plan, Phase 3) — the in-app
//! replacement for `ollama pull`.
//!
//! ## Catalog
//!
//! `catalog.json` (baked into the binary via `include_str!`) is a SMALL,
//! CURATED list — gemma4-first, official Google QAT builds where they
//! exist. Every file entry pins a download URL, a sha256, and a byte
//! size; the pin set is refreshed deliberately, never resolved at
//! runtime. Curation is the feature: it bounds the `--jinja`
//! template-correctness risk to models we've actually run, and it means
//! the app never trusts a moving remote target. File `dest` names follow
//! the Phase 2 conventions the engine already scans (`<id>.gguf` +
//! `<id>.mmproj.gguf` for vision).
//!
//! ## Downloader (the voice.rs whisper pattern, extended)
//!
//! Same skeleton as `voice_model_download` — streamed chunks, `.partial`
//! sibling + atomic rename, cancel flag polled between chunks — plus the
//! two things multi-GB files demand:
//!
//!   - **Range resume.** An interrupted download leaves `.partial`; the
//!     next attempt hashes what's on disk (keeping the running sha256
//!     honest) and asks the server for `bytes=<len>-`. 206 → append;
//!     200/416 → restart clean. Cancel KEEPS the partial for this
//!     reason (voice.rs deletes it — its files are small enough not to
//!     care).
//!   - **sha256 verify.** Hashed incrementally while streaming; a
//!     mismatch deletes the file and errors — a truncated or tampered
//!     download can never end up looking installed.
//!
//! Cancellation reuses the shared registry in `providers/mod.rs`
//! (request ids are namespaced `dl:<model>:<nonce>` by the UI — same
//! scheme as `pull:`).
//!
//! ## Progress wire format — deliberately Ollama-shaped
//!
//! Events on the channel mimic `/api/pull` chunks:
//!   `{"status":"downloading <dest>","digest":"sha256:…","total":N,"completed":n}`
//!   per file, then `{"status":"success"}` (or `{"error":"…"}`).
//! The UI's `accumulatePullProgress` was built for Ollama's multi-layer
//! pulls, which map 1:1 onto our model+mmproj file pairs — reusing the
//! shape means the model manager's whole progress UI (bars, byte counts,
//! cancel) works unchanged.

use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::io::{Read, Seek, Write};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use std::time::Duration;

// ── Catalog ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogFile {
    pub(crate) url: String,
    pub(crate) sha256: String,
    pub(crate) bytes: u64,
    /// File name inside the models dir (Phase 2 naming conventions).
    pub(crate) dest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogCaps {
    pub(crate) vision: bool,
    pub(crate) tools: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogModel {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) blurb: String,
    /// "chat" | "embed" — drives which slot the model belongs to and
    /// where the UI surfaces it.
    pub(crate) purpose: String,
    #[serde(default)]
    pub(crate) recommended: bool,
    pub(crate) min_ram_gb: u64,
    pub(crate) caps: CatalogCaps,
    pub(crate) license: String,
    /// Upstream repo, for attribution/debugging (not fetched at runtime).
    pub(crate) source: String,
    pub(crate) files: Vec<CatalogFile>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct Catalog {
    pub(crate) version: u32,
    pub(crate) models: Vec<CatalogModel>,
}

const CATALOG_JSON: &str = include_str!("catalog.json");

static CATALOG: OnceLock<Catalog> = OnceLock::new();

pub(crate) fn catalog() -> &'static Catalog {
    CATALOG.get_or_init(|| {
        serde_json::from_str(CATALOG_JSON).unwrap_or_else(|e| {
            // A malformed baked-in catalog is a build defect; tests pin
            // it. Degrade to an empty catalog rather than panicking a
            // release build.
            crate::log::log_warn!("engine catalog failed to parse: {e}");
            Catalog {
                version: 0,
                models: Vec::new(),
            }
        })
    })
}

/// Is every file of this catalog model present in the models dir?
fn model_installed(m: &CatalogModel) -> bool {
    let Ok(dir) = crate::engine::models_dir() else {
        return false;
    };
    m.files.iter().all(|f| dir.join(&f.dest).is_file())
}

/// Catalog + per-model install state for the model manager.
#[tauri::command]
pub(crate) fn engine_catalog() -> serde_json::Value {
    let models: Vec<serde_json::Value> = catalog()
        .models
        .iter()
        .map(|m| {
            let total: u64 = m.files.iter().map(|f| f.bytes).sum();
            let mut v = serde_json::to_value(m).unwrap_or_default();
            v["installed"] = serde_json::Value::Bool(model_installed(m));
            v["totalBytes"] = serde_json::json!(total);
            v
        })
        .collect();
    serde_json::json!({ "version": catalog().version, "models": models })
}

// ── Download engine ────────────────────────────────────────────────────────

static DL_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn dl_client() -> &'static reqwest::Client {
    DL_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Multi-GB downloads: reqwest timeouts are TOTAL-request, so
            // the ceiling must cover the whole transfer (same 24h hedge
            // as ollama_pull). Stalls surface as chunk-read errors.
            .timeout(Duration::from_secs(24 * 60 * 60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Send an Ollama-pull-shaped progress chunk. Returns false when JS
/// dropped the channel (treat as cancel).
fn send_progress(
    ch: &tauri::ipc::Channel<serde_json::Value>,
    dest: &str,
    digest: &str,
    total: u64,
    completed: u64,
) -> bool {
    ch.send(serde_json::json!({
        "status": format!("downloading {dest}"),
        "digest": format!("sha256:{digest}"),
        "total": total,
        "completed": completed,
    }))
    .is_ok()
}

enum FileOutcome {
    Done,
    Cancelled,
}

/// Download one pinned file with resume + incremental sha256.
/// `expected_sha` empty ⇒ integrity check skipped (custom URLs only).
async fn download_file(
    dir: &std::path::Path,
    url: &str,
    dest: &str,
    expected_sha: &str,
    expected_bytes: u64,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    on_progress: &tauri::ipc::Channel<serde_json::Value>,
) -> Result<FileOutcome, String> {
    let final_path = dir.join(dest);
    if final_path.is_file() {
        // Already installed (e.g. re-download after a partial multi-file
        // run) — report it complete and move on.
        send_progress(
            on_progress,
            dest,
            expected_sha,
            expected_bytes,
            expected_bytes,
        );
        return Ok(FileOutcome::Done);
    }
    let partial = dir.join(format!("{dest}.partial"));

    // Resume bookkeeping: hash whatever is already on disk so the
    // running sha256 stays truthful, then ask for the remainder.
    let mut hasher = sha2::Sha256::new();
    let mut completed: u64 = 0;
    if let Ok(meta) = std::fs::metadata(&partial) {
        let mut existing =
            std::fs::File::open(&partial).map_err(|e| format!("open partial: {e}"))?;
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            let n = existing
                .read(&mut buf)
                .map_err(|e| format!("read partial: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        completed = meta.len();
    }

    let mut req = dl_client().get(url);
    if completed > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={completed}-"));
    }
    let mut resp = req
        .send()
        .await
        .map_err(|e| format!("download request failed: {e}"))?;

    let status = resp.status();
    let mut file: std::fs::File;
    if completed > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT {
        // Server honored the Range — append.
        file = std::fs::OpenOptions::new()
            .append(true)
            .open(&partial)
            .map_err(|e| format!("open partial for append: {e}"))?;
    } else if status.is_success() {
        // Full body (fresh download, or the server ignored/rejected the
        // Range) — restart clean, including the hash.
        hasher = sha2::Sha256::new();
        completed = 0;
        file = std::fs::File::create(&partial).map_err(|e| format!("create partial: {e}"))?;
        file.rewind().ok();
    } else if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // Stale/oversized partial — throw it away and error; the next
        // attempt starts clean.
        let _ = std::fs::remove_file(&partial);
        return Err("resume rejected by server — retry the download".into());
    } else {
        return Err(format!("download returned HTTP {status}"));
    }

    loop {
        if cancel.load(Ordering::Relaxed) {
            // Keep .partial — that's what makes resume work.
            let _ = file.flush();
            return Ok(FileOutcome::Cancelled);
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
        hasher.update(&bytes);
        completed += bytes.len() as u64;
        if !send_progress(
            on_progress,
            dest,
            expected_sha,
            expected_bytes.max(completed),
            completed,
        ) {
            let _ = file.flush();
            return Ok(FileOutcome::Cancelled);
        }
    }
    file.flush().map_err(|e| format!("flush failed: {e}"))?;
    drop(file);

    // Integrity gate: a bad hash deletes the evidence so nothing
    // half-broken can ever look installed.
    if !expected_sha.is_empty() {
        let got = format!("{:x}", hasher.finalize());
        if got != expected_sha {
            let _ = std::fs::remove_file(&partial);
            return Err(format!(
                "checksum mismatch for {dest} (expected {expected_sha}, got {got}) — download discarded, try again"
            ));
        }
    }
    std::fs::rename(&partial, &final_path).map_err(|e| format!("finalize failed: {e}"))?;
    Ok(FileOutcome::Done)
}

/// Download every file of a catalog model (model GGUF + optional mmproj),
/// sequentially, with per-file Ollama-shaped progress. Resolves Ok on
/// success AND on cancel (mirrors ollama_pull); Err on failure.
#[tauri::command]
pub(crate) async fn engine_download(
    model_id: String,
    request_id: String,
    on_progress: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    let model = catalog()
        .models
        .iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("unknown catalog model: {model_id}"))?
        .clone();
    let dir = crate::engine::models_dir()?;
    let _ = std::fs::create_dir_all(&dir);

    let token = crate::providers::register_cancel(&request_id);
    let cancel = token.flag.clone();

    for f in &model.files {
        match download_file(
            &dir,
            &f.url,
            &f.dest,
            &f.sha256,
            f.bytes,
            &cancel,
            &on_progress,
        )
        .await
        {
            Ok(FileOutcome::Done) => {}
            Ok(FileOutcome::Cancelled) => return Ok(()),
            Err(e) => {
                let _ = on_progress.send(serde_json::json!({ "error": e }));
                return Err(e);
            }
        }
    }
    let _ = on_progress.send(serde_json::json!({ "status": "success" }));
    Ok(())
}

/// Best-effort custom GGUF by URL — no pinned checksum (the UI labels it
/// unverified). The name is validated and forced into the models-dir
/// naming scheme; everything else rides the same downloader.
#[tauri::command]
pub(crate) async fn engine_download_custom(
    url: String,
    name: String,
    request_id: String,
    on_progress: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    crate::engine::validate_model_name(&name)?;
    let url_trim = url.trim().to_string();
    if !url_trim.starts_with("https://") {
        return Err("model URLs must be https://".into());
    }
    let dir = crate::engine::models_dir()?;
    let _ = std::fs::create_dir_all(&dir);
    let dest = format!("{name}.gguf");

    let token = crate::providers::register_cancel(&request_id);
    let cancel = token.flag.clone();
    match download_file(&dir, &url_trim, &dest, "", 0, &cancel, &on_progress).await {
        Ok(FileOutcome::Done) => {
            let _ = on_progress.send(serde_json::json!({ "status": "success" }));
            Ok(())
        }
        Ok(FileOutcome::Cancelled) => Ok(()),
        Err(e) => {
            let _ = on_progress.send(serde_json::json!({ "error": e }));
            Err(e)
        }
    }
}

/// Cancel an in-flight download at the next chunk boundary. The partial
/// file is KEPT so a later attempt resumes.
#[tauri::command]
pub(crate) fn engine_download_cancel(request_id: String) {
    crate::providers::cancel(&request_id);
}

/// Delete an installed model's files (GGUF + mmproj + any partials).
/// Refuses while the model is streaming; a merely-resident model is
/// unloaded first so the file isn't yanked out from under a live server.
#[tauri::command]
pub(crate) async fn engine_model_delete(name: String) -> Result<(), String> {
    crate::engine::validate_model_name(&name)?;
    crate::engine::supervisor::global()
        .evict_idle_model(&name)
        .await?;
    let dir = crate::engine::models_dir()?;
    let mut removed = 0usize;
    for cand in [
        format!("{name}.gguf"),
        format!("{name}.mmproj.gguf"),
        format!("mmproj-{name}.gguf"),
        format!("{name}.gguf.partial"),
        format!("{name}.mmproj.gguf.partial"),
    ] {
        let p: PathBuf = dir.join(&cand);
        if p.is_file() {
            std::fs::remove_file(&p).map_err(|e| format!("delete {cand}: {e}"))?;
            removed += 1;
        }
    }
    if removed == 0 {
        return Err(format!("no files found for model `{name}`"));
    }
    Ok(())
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baked_catalog_parses_and_is_sane() {
        let c = catalog();
        assert!(
            c.version >= 1,
            "catalog must parse (version 0 = parse failure)"
        );
        assert!(!c.models.is_empty());
        for m in &c.models {
            // ids must be valid engine model names (they become file stems).
            crate::engine::validate_model_name(&m.id).expect("catalog id");
            assert!(matches!(m.purpose.as_str(), "chat" | "embed"), "{}", m.id);
            assert!(!m.files.is_empty(), "{}", m.id);
            assert!(m.min_ram_gb >= 4, "{}", m.id);
            for f in &m.files {
                assert!(f.url.starts_with("https://"), "{}", f.url);
                assert_eq!(f.sha256.len(), 64, "{} sha256 must be pinned", f.dest);
                assert!(f.sha256.chars().all(|c| c.is_ascii_hexdigit()));
                assert!(f.bytes > 0, "{}", f.dest);
                assert!(f.dest.ends_with(".gguf"), "{}", f.dest);
                assert!(
                    !f.dest.contains('/') && !f.dest.contains('\\'),
                    "dest must be a bare file name: {}",
                    f.dest
                );
            }
            // The primary file must land as <id>.gguf so the engine's
            // scan + model_path find it; a vision model's projector must
            // land as <id>.mmproj.gguf so find_mmproj pairs it.
            assert!(
                m.files.iter().any(|f| f.dest == format!("{}.gguf", m.id)),
                "{} needs a primary <id>.gguf",
                m.id
            );
            if m.caps.vision {
                assert!(
                    m.files
                        .iter()
                        .any(|f| f.dest == format!("{}.mmproj.gguf", m.id)),
                    "vision model {} needs <id>.mmproj.gguf",
                    m.id
                );
            }
        }
        // Exactly one embed model and at least one recommended chat model.
        assert_eq!(c.models.iter().filter(|m| m.purpose == "embed").count(), 1);
        assert!(c
            .models
            .iter()
            .any(|m| m.purpose == "chat" && m.recommended));
    }

    #[test]
    fn catalog_ids_and_dests_are_unique() {
        let c = catalog();
        let mut ids: Vec<&str> = c.models.iter().map(|m| m.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), c.models.len(), "duplicate catalog ids");
        let mut dests: Vec<&str> = c
            .models
            .iter()
            .flat_map(|m| m.files.iter().map(|f| f.dest.as_str()))
            .collect();
        dests.sort();
        dests.dedup();
        assert_eq!(
            dests.len(),
            c.models.iter().map(|m| m.files.len()).sum::<usize>(),
            "duplicate file dests"
        );
    }

    #[test]
    fn engine_catalog_payload_carries_install_state() {
        let v = engine_catalog();
        let models = v["models"].as_array().unwrap();
        assert_eq!(models.len(), catalog().models.len());
        for m in models {
            assert!(m["installed"].is_boolean());
            assert!(m["totalBytes"].as_u64().unwrap() > 0);
            assert!(m["minRamGb"].as_u64().unwrap() >= 4);
        }
    }

    /// Real-network integration smoke — ignored in normal runs. Proves
    /// the two extensions over the voice.rs pattern against the REAL
    /// HF CDN (redirects included): (1) cancel keeps `.partial` and a
    /// second attempt resumes via Range with the running sha256 kept
    /// honest across the boundary; (2) the completed file hashes to the
    /// catalog's pinned value (which also pins the "HF LFS oid == raw
    /// sha256" assumption the whole catalog rests on). Uses the smallest
    /// catalog entry (~274 MB). Run manually:
    ///
    ///   cargo test --lib engine_real_download_smoke -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn engine_real_download_smoke() {
        let m = catalog()
            .models
            .iter()
            .find(|m| m.purpose == "embed")
            .expect("embed entry");
        let f = &m.files[0];

        let dir = std::env::temp_dir().join(format!("ek-dl-smoke-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Leg 1: cancel a few MB in — the partial must survive.
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let c2 = cancel.clone();
        let ch = tauri::ipc::Channel::new(move |msg| {
            // InvokeResponseBody::Json carries our serialized chunk.
            if let tauri::ipc::InvokeResponseBody::Json(s) = msg {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                    if v["completed"].as_u64().unwrap_or(0) > 3_000_000 {
                        c2.store(true, Ordering::Relaxed);
                    }
                }
            }
            Ok(())
        });
        let out = download_file(&dir, &f.url, &f.dest, &f.sha256, f.bytes, &cancel, &ch)
            .await
            .expect("leg 1");
        assert!(matches!(out, FileOutcome::Cancelled));
        let partial = dir.join(format!("{}.partial", f.dest));
        let partial_len = std::fs::metadata(&partial).expect("partial kept").len();
        assert!(partial_len > 0, "cancel must keep the partial for resume");
        eprintln!("cancelled at {partial_len} bytes; resuming…");

        // Leg 2: resume to completion — Range + cross-boundary hash.
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ch = tauri::ipc::Channel::new(|_| Ok(()));
        let out = download_file(&dir, &f.url, &f.dest, &f.sha256, f.bytes, &cancel, &ch)
            .await
            .expect("leg 2 (resume)");
        assert!(matches!(out, FileOutcome::Done));
        let final_path = dir.join(&f.dest);
        assert_eq!(
            std::fs::metadata(&final_path).unwrap().len(),
            f.bytes,
            "final size must match the catalog pin"
        );
        assert!(!partial.exists(), "partial renamed away on success");
        // download_file already verified the sha256 (it errors on
        // mismatch), so reaching here means pinned hash == real bytes.
        let _ = std::fs::remove_dir_all(&dir);
    }
}
