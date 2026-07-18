// SPDX-License-Identifier: MIT

//! Engine scheduler (no-Ollama plan, Phase 2) — the "hard kernel" the
//! plan doc called out: Ollama used to do this for us.
//!
//! Policy: at most **one chat process + one embed process** resident.
//! Each slot runs exactly one model at a time; asking for a different
//! model triggers a swap, gated by three invariants:
//!
//!   1. **Never evict mid-stream.** A slot with active leases
//!      (refcount > 0) is never torn down. Requests for another model
//!      WAIT (with a "waiting for model…" status surfaced to the UI)
//!      until the last lease drops.
//!   2. **Swaps are serialized** per slot by an async guard. Concurrent
//!      requests for the same model share the spawn (second request
//!      blocks on the guard, then finds the model resident).
//!   3. **Crash-loop backoff.** Three consecutive spawn/health failures
//!      for a model pause retries for a minute and surface the
//!      process's own log tail — a corrupt GGUF fails loud, not in an
//!      infinite spawn loop.
//!
//! Compare mode needs NO special handling: its N-column fan-out issues
//! N concurrent streams whose `ensure` calls serialize right here —
//! columns fill one model at a time with waiting states in between
//! (exactly the plan's "Option 2, serialized" behavior).
//!
//! Leases are RAII: [`Lease`] bumps the slot's refcount + last-used
//! stamp on mint, decrements and notifies waiters on drop (normal
//! return, cancel, or panic — same pattern as the cancel registry).
//! The idle reaper ([`Supervisor::reap_idle`]) shuts down a resident
//! process once it's been lease-free past the idle window.

use super::{RealHandle, SlotKind, SpawnSpec};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// Consecutive-failure threshold + pause window for crash-loop backoff.
const FAIL_LIMIT: u32 = 3;
const FAIL_PAUSE: Duration = Duration::from_secs(60);

// ── Process handle (enum dispatch: real vs. test fake) ─────────────────────

pub(crate) enum Handle {
    // Boxed: RealHandle is ~300 bytes (tokio Child + log ring Arc + …)
    // vs the tiny test fake — clippy's large_enum_variant is right that
    // every Proc shouldn't carry the max size inline.
    Real(Box<RealHandle>),
    #[cfg(test)]
    Fake(fake::FakeHandle),
}

impl Handle {
    fn is_alive(&mut self) -> bool {
        match self {
            Handle::Real(h) => h.is_alive(),
            #[cfg(test)]
            Handle::Fake(h) => h.is_alive(),
        }
    }

    async fn wait_ready(&mut self) -> Result<(), String> {
        match self {
            Handle::Real(h) => h.wait_ready().await,
            #[cfg(test)]
            Handle::Fake(h) => h.wait_ready().await,
        }
    }

    async fn shutdown(&mut self) {
        match self {
            Handle::Real(h) => h.shutdown().await,
            #[cfg(test)]
            Handle::Fake(h) => h.shutdown(),
        }
    }
}

// ── Spawner (real vs. scripted fake) ───────────────────────────────────────

enum SpawnerImpl {
    Real,
    #[cfg(test)]
    Fake(Arc<fake::FakeSpawner>),
}

impl SpawnerImpl {
    fn spawn(&self, kind: SlotKind, model: &str) -> Result<Proc, String> {
        match self {
            SpawnerImpl::Real => {
                let gguf = crate::engine::model_path(model)?;
                let mmproj = if kind == SlotKind::Chat {
                    crate::engine::models_dir()
                        .ok()
                        .and_then(|d| crate::engine::find_mmproj(&d, model))
                } else {
                    None
                };
                let port = crate::engine::alloc_port()?;
                let api_key = crate::engine::gen_api_key();
                let spec = SpawnSpec {
                    kind,
                    model: model.to_string(),
                    gguf,
                    mmproj,
                    port,
                    api_key: api_key.clone(),
                };
                let handle = crate::engine::spawn_real(&spec)?;
                Ok(Proc {
                    model: model.to_string(),
                    port,
                    api_key,
                    handle: Handle::Real(Box::new(handle)),
                })
            }
            #[cfg(test)]
            SpawnerImpl::Fake(f) => f.spawn(kind, model),
        }
    }
}

// ── Slot state ─────────────────────────────────────────────────────────────

pub(crate) struct Proc {
    pub(crate) model: String,
    pub(crate) port: u16,
    pub(crate) api_key: String,
    handle: Handle,
}

struct Counts {
    refcount: u32,
    last_used: Instant,
}

/// Cross-lease shared state for one slot. `m` is a std (not tokio)
/// mutex because Lease::drop can't await; critical sections are a few
/// loads/stores. New leases are only minted while holding the slot
/// guard, so "guard held + refcount == 0" proves no stream can start
/// during an eviction.
struct SlotShared {
    m: Mutex<Counts>,
    notify: Notify,
}

impl SlotShared {
    fn refcount(&self) -> u32 {
        self.m.lock().map(|c| c.refcount).unwrap_or(0)
    }
}

/// RAII stream lease: connection details for the resident process plus
/// the refcount that keeps it resident. Hold it for the FULL duration
/// of the HTTP request against the engine.
pub(crate) struct Lease {
    pub(crate) base_url: String,
    pub(crate) api_key: String,
    shared: Arc<SlotShared>,
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // api_key deliberately omitted — leases can end up in error logs.
        f.debug_struct("Lease")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut c) = self.shared.m.lock() {
            c.refcount = c.refcount.saturating_sub(1);
            c.last_used = Instant::now();
        }
        // Wake every waiter — each re-takes the slot guard and
        // re-evaluates; over-notification is harmless, lost wakeups are
        // covered by the 1s re-check timeout in `ensure`.
        self.shared.notify.notify_waiters();
    }
}

struct SlotInner {
    proc: Option<Proc>,
    /// model → (consecutive failures, last failure at) for backoff.
    fails: HashMap<String, (u32, Instant)>,
}

struct SlotUnit {
    guard: tokio::sync::Mutex<SlotInner>,
    shared: Arc<SlotShared>,
}

impl SlotUnit {
    fn new() -> Self {
        Self {
            guard: tokio::sync::Mutex::new(SlotInner {
                proc: None,
                fails: HashMap::new(),
            }),
            shared: Arc::new(SlotShared {
                m: Mutex::new(Counts {
                    refcount: 0,
                    last_used: Instant::now(),
                }),
                notify: Notify::new(),
            }),
        }
    }

    fn mint_lease(&self, port: u16, api_key: &str) -> Lease {
        if let Ok(mut c) = self.shared.m.lock() {
            c.refcount += 1;
            c.last_used = Instant::now();
        }
        Lease {
            base_url: format!("http://127.0.0.1:{port}"),
            api_key: api_key.to_string(),
            shared: self.shared.clone(),
        }
    }
}

// ── Supervisor ─────────────────────────────────────────────────────────────

pub(crate) struct Supervisor {
    spawner: SpawnerImpl,
    chat: SlotUnit,
    embed: SlotUnit,
}

static GLOBAL: OnceLock<Supervisor> = OnceLock::new();

/// The app-wide supervisor (real spawner). Tests build their own with
/// a scripted fake instead.
pub(crate) fn global() -> &'static Supervisor {
    GLOBAL.get_or_init(|| Supervisor::new(SpawnerImpl::Real))
}

impl Supervisor {
    fn new(spawner: SpawnerImpl) -> Self {
        Self {
            spawner,
            chat: SlotUnit::new(),
            embed: SlotUnit::new(),
        }
    }

    fn unit(&self, kind: SlotKind) -> &SlotUnit {
        match kind {
            SlotKind::Chat => &self.chat,
            SlotKind::Embed => &self.embed,
        }
    }

    /// Make `model` resident in the slot and return a stream lease.
    /// May spawn (cold), swap (different model idle), or wait (different
    /// model streaming). `on_status` receives human-readable progress
    /// ("loading …", "waiting for … to finish…") that adapters forward
    /// to the UI as `status` stream events.
    pub(crate) async fn ensure(
        &self,
        kind: SlotKind,
        model: &str,
        on_status: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<Lease, String> {
        let unit = self.unit(kind);
        // A contended guard = another request is mid-spawn or mid-swap.
        // Say so instead of streaming nothing.
        let mut inner = match unit.guard.try_lock() {
            Ok(g) => g,
            Err(_) => {
                on_status("waiting for model…");
                unit.guard.lock().await
            }
        };
        loop {
            // Reap a process that died behind our back (crash while
            // idle). The next block treats the slot as empty.
            if let Some(p) = inner.proc.as_mut() {
                if !p.handle.is_alive() {
                    crate::log::log_warn!(
                        "engine: {} process for `{}` exited unexpectedly",
                        kind_label(kind),
                        p.model
                    );
                    let mut dead = inner.proc.take().expect("checked Some");
                    dead.handle.shutdown().await; // reap + unregister
                }
            }

            match inner.proc.as_ref() {
                Some(p) if p.model == model => {
                    return Ok(unit.mint_lease(p.port, &p.api_key));
                }
                Some(p) => {
                    if unit.shared.refcount() == 0 {
                        // Idle → swap now. Guard held: no new lease can
                        // appear between the check and the teardown.
                        on_status(&format!("switching to {model}…"));
                        let mut old = inner.proc.take().expect("checked Some");
                        old.handle.shutdown().await;
                        // fall through to the spawn path below
                    } else {
                        // Streaming → wait for the last lease to drop.
                        on_status(&format!("waiting for {} to finish…", p.model));
                        let mut waiter = Box::pin(unit.shared.notify.notified());
                        // Register interest BEFORE releasing the guard —
                        // otherwise a lease dropped in the gap would
                        // notify nobody and we'd sleep the full timeout.
                        waiter.as_mut().enable();
                        drop(inner);
                        // 1s ceiling: belt-and-braces re-check even on a
                        // missed wakeup.
                        let _ = tokio::time::timeout(Duration::from_secs(1), waiter).await;
                        inner = unit.guard.lock().await;
                        continue;
                    }
                }
                None => {}
            }

            // Spawn path — slot is empty here, guard still held (other
            // requests queue behind us and find the model resident).
            if let Some((n, at)) = inner.fails.get(model) {
                if *n >= FAIL_LIMIT && at.elapsed() < FAIL_PAUSE {
                    return Err(format!(
                        "`{model}` failed to start {n} times in a row — check the model file \
                         (Settings → Backend shows the models folder). Retries pause for a minute."
                    ));
                }
            }
            on_status(&format!("loading {model}…"));
            let mut proc = match self.spawner.spawn(kind, model) {
                Ok(p) => p,
                Err(e) => {
                    record_fail(&mut inner.fails, model);
                    return Err(e);
                }
            };
            match proc.handle.wait_ready().await {
                Ok(()) => {
                    inner.fails.remove(model);
                    let lease = unit.mint_lease(proc.port, &proc.api_key);
                    inner.proc = Some(proc);
                    return Ok(lease);
                }
                Err(e) => {
                    proc.handle.shutdown().await;
                    record_fail(&mut inner.fails, model);
                    return Err(e);
                }
            }
        }
    }

    /// Shut down resident processes that have been lease-free longer
    /// than `max_idle`. try_lock: never stalls behind an in-flight
    /// spawn — a busy slot is by definition not idle.
    pub(crate) async fn reap_idle(&self, max_idle: Duration) {
        for kind in [SlotKind::Chat, SlotKind::Embed] {
            let unit = self.unit(kind);
            if let Ok(mut inner) = unit.guard.try_lock() {
                let idle = unit
                    .shared
                    .m
                    .lock()
                    .map(|c| c.refcount == 0 && c.last_used.elapsed() > max_idle)
                    .unwrap_or(false);
                if idle {
                    if let Some(mut p) = inner.proc.take() {
                        crate::log::log_info!(
                            "engine: unloading idle {} model `{}`",
                            kind_label(kind),
                            p.model
                        );
                        p.handle.shutdown().await;
                    }
                }
            }
        }
    }

    /// Resident models (for `llm_loaded_models` / the status bar).
    /// try_lock: a slot mid-spawn just doesn't report this tick.
    pub(crate) fn snapshot(&self) -> Vec<(String, &'static str)> {
        let mut out = Vec::new();
        for kind in [SlotKind::Chat, SlotKind::Embed] {
            if let Ok(inner) = self.unit(kind).guard.try_lock() {
                if let Some(p) = inner.proc.as_ref() {
                    out.push((p.model.clone(), kind_label(kind)));
                }
            }
        }
        out
    }

    /// Test hook: pretend the slot's last use was `d` ago.
    #[cfg(test)]
    fn rewind_last_used(&self, kind: SlotKind, d: Duration) {
        if let Ok(mut c) = self.unit(kind).shared.m.lock() {
            if let Some(t) = Instant::now().checked_sub(d) {
                c.last_used = t;
            }
        }
    }
}

fn kind_label(kind: SlotKind) -> &'static str {
    match kind {
        SlotKind::Chat => "chat",
        SlotKind::Embed => "embed",
    }
}

fn record_fail(fails: &mut HashMap<String, (u32, Instant)>, model: &str) {
    let entry = fails
        .entry(model.to_string())
        .or_insert((0, Instant::now()));
    entry.0 += 1;
    entry.1 = Instant::now();
}

// ── Test fakes ─────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};

    #[derive(Clone)]
    pub(crate) enum Outcome {
        Ready,
        SpawnErr(&'static str),
        ReadyErr(&'static str),
    }

    pub(crate) struct FakeState {
        pub(crate) alive: AtomicBool,
        pub(crate) killed: AtomicBool,
    }

    pub(crate) struct FakeHandle {
        state: Arc<FakeState>,
        ready: Result<(), String>,
    }

    impl FakeHandle {
        pub(crate) fn is_alive(&mut self) -> bool {
            self.state.alive.load(Ordering::SeqCst)
        }
        pub(crate) async fn wait_ready(&mut self) -> Result<(), String> {
            self.ready.clone()
        }
        pub(crate) fn shutdown(&mut self) {
            self.state.alive.store(false, Ordering::SeqCst);
            self.state.killed.store(true, Ordering::SeqCst);
        }
    }

    #[derive(Default)]
    pub(crate) struct FakeSpawner {
        pub(crate) script: Mutex<VecDeque<Outcome>>,
        pub(crate) spawned: Mutex<Vec<(SlotKind, String)>>,
        pub(crate) live: Mutex<Vec<Arc<FakeState>>>,
        next_port: AtomicU16,
    }

    impl FakeSpawner {
        pub(crate) fn scripted(outcomes: &[Outcome]) -> Arc<Self> {
            let s = Self::default();
            s.next_port.store(20000, Ordering::SeqCst);
            *s.script.lock().unwrap() = outcomes.iter().cloned().collect();
            Arc::new(s)
        }

        pub(crate) fn spawn(&self, kind: SlotKind, model: &str) -> Result<Proc, String> {
            self.spawned.lock().unwrap().push((kind, model.to_string()));
            let outcome = self
                .script
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Outcome::Ready);
            if let Outcome::SpawnErr(e) = outcome {
                return Err(e.to_string());
            }
            let state = Arc::new(FakeState {
                alive: AtomicBool::new(true),
                killed: AtomicBool::new(false),
            });
            self.live.lock().unwrap().push(state.clone());
            let ready = match outcome {
                Outcome::ReadyErr(e) => Err(e.to_string()),
                _ => Ok(()),
            };
            let port = self.next_port.fetch_add(1, Ordering::SeqCst);
            Ok(Proc {
                model: model.to_string(),
                port,
                api_key: format!("fake-key-{port}"),
                handle: Handle::Fake(FakeHandle { state, ready }),
            })
        }

        pub(crate) fn spawn_count(&self) -> usize {
            self.spawned.lock().unwrap().len()
        }

        pub(crate) fn state(&self, idx: usize) -> Arc<FakeState> {
            self.live.lock().unwrap()[idx].clone()
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::fake::{FakeSpawner, Outcome};
    use super::*;

    fn sup(f: &Arc<FakeSpawner>) -> Supervisor {
        Supervisor::new(SpawnerImpl::Fake(f.clone()))
    }

    fn no_status() -> impl Fn(&str) + Send + Sync {
        |_: &str| {}
    }

    #[tokio::test]
    async fn same_model_shares_one_process() {
        let f = FakeSpawner::scripted(&[]);
        let s = sup(&f);
        let a = s
            .ensure(SlotKind::Chat, "gemma", &no_status())
            .await
            .unwrap();
        let b = s
            .ensure(SlotKind::Chat, "gemma", &no_status())
            .await
            .unwrap();
        assert_eq!(f.spawn_count(), 1, "second request reuses the process");
        assert_eq!(a.base_url, b.base_url);
        assert!(a.api_key.starts_with("fake-key-"));
        drop(a);
        drop(b);
    }

    #[tokio::test]
    async fn idle_slot_swaps_models() {
        let f = FakeSpawner::scripted(&[]);
        let s = sup(&f);
        let a = s
            .ensure(SlotKind::Chat, "gemma", &no_status())
            .await
            .unwrap();
        drop(a); // refcount back to 0 — swap allowed
        let _b = s
            .ensure(SlotKind::Chat, "llama", &no_status())
            .await
            .unwrap();
        assert_eq!(f.spawn_count(), 2);
        assert!(
            f.state(0).killed.load(std::sync::atomic::Ordering::SeqCst),
            "old model's process must be torn down on swap"
        );
        assert!(f.state(1).alive.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn never_evicts_mid_stream() {
        let f = FakeSpawner::scripted(&[]);
        let s = Arc::new(sup(&f));
        let lease_a = s
            .ensure(SlotKind::Chat, "gemma", &no_status())
            .await
            .unwrap();

        // Request for a DIFFERENT model while A streams: must wait.
        let s2 = s.clone();
        let statuses: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let st2 = statuses.clone();
        let waiter = tokio::spawn(async move {
            let cb = move |m: &str| st2.lock().unwrap().push(m.to_string());
            s2.ensure(SlotKind::Chat, "llama", &cb).await
        });

        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waiter.is_finished(), "B must wait while A holds a lease");
        assert!(
            !f.state(0).killed.load(std::sync::atomic::Ordering::SeqCst),
            "A's process must NOT be killed mid-stream"
        );
        assert!(
            statuses
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.contains("waiting")),
            "waiting state must be surfaced"
        );

        drop(lease_a); // stream ends → swap proceeds
        let lease_b = waiter.await.unwrap().unwrap();
        assert_eq!(f.spawn_count(), 2);
        assert!(f.state(0).killed.load(std::sync::atomic::Ordering::SeqCst));
        drop(lease_b);
    }

    #[tokio::test]
    async fn crash_loop_backs_off_after_three_failures() {
        let f = FakeSpawner::scripted(&[
            Outcome::ReadyErr("boom"),
            Outcome::ReadyErr("boom"),
            Outcome::ReadyErr("boom"),
        ]);
        let s = sup(&f);
        for _ in 0..3 {
            assert!(s.ensure(SlotKind::Chat, "bad", &no_status()).await.is_err());
        }
        assert_eq!(f.spawn_count(), 3);
        // Fourth attempt: rejected WITHOUT spawning.
        let err = s
            .ensure(SlotKind::Chat, "bad", &no_status())
            .await
            .unwrap_err();
        assert!(err.contains("failed to start"), "got: {err}");
        assert_eq!(f.spawn_count(), 3, "backoff must not spawn again");
        // A different model is unaffected by `bad`'s backoff.
        let ok = s.ensure(SlotKind::Chat, "good", &no_status()).await;
        assert!(ok.is_ok());
    }

    #[tokio::test]
    async fn spawn_error_also_counts_toward_backoff() {
        let f = FakeSpawner::scripted(&[
            Outcome::SpawnErr("no binary"),
            Outcome::SpawnErr("no binary"),
            Outcome::SpawnErr("no binary"),
        ]);
        let s = sup(&f);
        for _ in 0..3 {
            assert!(s.ensure(SlotKind::Embed, "m", &no_status()).await.is_err());
        }
        let err = s
            .ensure(SlotKind::Embed, "m", &no_status())
            .await
            .unwrap_err();
        assert!(err.contains("failed to start"));
        assert_eq!(f.spawn_count(), 3);
    }

    #[tokio::test]
    async fn chat_and_embed_slots_are_independent() {
        let f = FakeSpawner::scripted(&[]);
        let s = sup(&f);
        let a = s
            .ensure(SlotKind::Chat, "gemma", &no_status())
            .await
            .unwrap();
        let b = s
            .ensure(SlotKind::Embed, "nomic", &no_status())
            .await
            .unwrap();
        assert_eq!(f.spawn_count(), 2);
        assert_ne!(a.base_url, b.base_url, "distinct ports per slot");
        let snap = s.snapshot();
        assert_eq!(snap.len(), 2);
        assert!(snap.contains(&("gemma".to_string(), "chat")));
        assert!(snap.contains(&("nomic".to_string(), "embed")));
        drop(a);
        drop(b);
    }

    #[tokio::test]
    async fn dead_process_is_respawned_on_next_request() {
        let f = FakeSpawner::scripted(&[]);
        let s = sup(&f);
        let a = s
            .ensure(SlotKind::Chat, "gemma", &no_status())
            .await
            .unwrap();
        drop(a);
        // Simulate a crash while idle.
        f.state(0)
            .alive
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let b = s
            .ensure(SlotKind::Chat, "gemma", &no_status())
            .await
            .unwrap();
        assert_eq!(f.spawn_count(), 2, "dead process must be replaced");
        drop(b);
    }

    #[tokio::test]
    async fn reap_idle_unloads_only_past_the_window() {
        let f = FakeSpawner::scripted(&[]);
        let s = sup(&f);
        let a = s
            .ensure(SlotKind::Chat, "gemma", &no_status())
            .await
            .unwrap();
        drop(a);

        // Fresh drop — inside the window, must survive.
        s.reap_idle(Duration::from_secs(600)).await;
        assert!(f.state(0).alive.load(std::sync::atomic::Ordering::SeqCst));

        // Rewind the clock past the window — must unload.
        s.rewind_last_used(SlotKind::Chat, Duration::from_secs(1200));
        s.reap_idle(Duration::from_secs(600)).await;
        assert!(
            f.state(0).killed.load(std::sync::atomic::Ordering::SeqCst),
            "idle process past the window must be unloaded"
        );
        assert!(s.snapshot().is_empty());
    }

    #[tokio::test]
    async fn reap_idle_never_touches_a_streaming_slot() {
        let f = FakeSpawner::scripted(&[]);
        let s = sup(&f);
        let lease = s
            .ensure(SlotKind::Chat, "gemma", &no_status())
            .await
            .unwrap();
        s.rewind_last_used(SlotKind::Chat, Duration::from_secs(9999));
        s.reap_idle(Duration::from_secs(600)).await;
        assert!(
            f.state(0).alive.load(std::sync::atomic::Ordering::SeqCst),
            "active lease must protect the process regardless of clock"
        );
        drop(lease);
    }
}
