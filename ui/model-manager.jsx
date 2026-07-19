// model-manager.jsx — In-app model download / delete (the "no terminal
// required" path for `ollama pull` / `ollama rm`).
//
//   • Module-scope pull store + window.ekPullModel orchestrator. Lives
//     OUTSIDE any component so an in-flight download survives the modal
//     closing, and so other surfaces (the guided first-run gate) can start
//     pulls and render the same progress.
//   • ModelManagerPanel — installed-model list + download box. Embedded by
//     the Settings → Models tab and by ModelManagerModal.
//   • ModelManagerModal — fullscreen overlay wrapper, opened from the
//     composer ModelPicker / OllamaGate via window.ekOpenModelManager()
//     (registered in main.jsx, same pattern as window.ekOpenOnboarding).
//
// Depends on: tokens (T), utils.js (getInvoke, getChannel, genId,
// formatBytes, accumulatePullProgress), overlays.jsx (ConfirmDialog),
// toast.jsx (window.ekToast). Rust side: ollama_pull / ollama_pull_cancel /
// ollama_delete in src-tauri/src/ollama.rs.

// ── Pull store (module scope = window-global per no-bundler convention) ────
//
// EK_ACTIVE_PULLS maps model name → progress state (the return shape of
// accumulatePullProgress, plus {model, requestId}). Listeners are notified
// on every change; mounted panels subscribe and re-render. A model can
// only have one in-flight pull (second ekPullModel call for the same name
// is a no-op returning the existing promise) — this also sidesteps the
// cancel-registry id-collision hazard documented in ollama.rs.

'use strict';
const EK_ACTIVE_PULLS = new Map();
const EK_PULL_LISTENERS = new Set();
const EK_PULL_PROMISES = new Map(); // model -> in-flight promise

function ekPullsNotify() {
  EK_PULL_LISTENERS.forEach((fn) => {
    try { fn(); } catch (_) { /* a broken listener must not stall pulls */ }
  });
}

function ekPullsSubscribe(fn) {
  EK_PULL_LISTENERS.add(fn);
  return () => EK_PULL_LISTENERS.delete(fn);
}

// Start pulling `model`. Resolves { ok, error }: ok=true when the backend
// reports {"status":"success"}; ok=false on error, cancel, or early stream
// end, with `error` carrying the reason (the HTTP/in-band message) for
// callers that want to surface it. opts.silent suppresses the
// completion/error toasts (the guided first-run renders its own status).
//
// Backend flavors (Phase 3): the ENGINE catalog downloader emits the same
// Ollama-pull-shaped progress chunks (that's a deliberate wire contract —
// see engine/downloads.rs), so the whole store/progress path is shared and
// only the invoke names differ:
//   opts.engine    — `model` is a catalog id → engine_download
//   opts.customUrl — best-effort custom GGUF → engine_download_custom
async function ekPullModel(model, opts) {
  const silent = !!(opts && opts.silent);
  const engine = !!(opts && opts.engine);
  const customUrl = (opts && opts.customUrl) || null;
  const invoke = getInvoke();
  model = (model || "").trim();
  if (!invoke || !model) return { ok: false, error: "The model backend is not available" };
  if (EK_PULL_PROMISES.has(model)) return EK_PULL_PROMISES.get(model);

  // `dl:` namespace for engine downloads, `pull:` for Ollama — same
  // shared cancel registry on the Rust side, no id collisions.
  const isEngineFlavor = engine || !!customUrl;
  const requestId = `${isEngineFlavor ? "dl" : "pull"}:${model}:${genId()}`;
  const seed = accumulatePullProgress(null, null);
  seed.model = model;
  seed.requestId = requestId;
  seed.cancelCmd = isEngineFlavor ? "engine_download_cancel" : "ollama_pull_cancel";
  EK_ACTIVE_PULLS.set(model, seed);
  ekPullsNotify();

  const Channel = getChannel();
  const ch = Channel ? new Channel() : null;
  if (ch) {
    ch.onmessage = (chunk) => {
      const cur = EK_ACTIVE_PULLS.get(model);
      if (!cur) return; // finished/cancelled between chunks
      const next = accumulatePullProgress(cur, chunk);
      next.model = model;
      next.requestId = cur.requestId;
      next.cancelCmd = cur.cancelCmd;
      EK_ACTIVE_PULLS.set(model, next);
      ekPullsNotify();
    };
  }

  const run = (async () => {
    try {
      if (customUrl) {
        await invoke("engine_download_custom", {
          url: customUrl,
          name: model,
          requestId,
          onProgress: ch,
        });
      } else if (engine) {
        await invoke("engine_download", { modelId: model, requestId, onProgress: ch });
      } else {
        await invoke("ollama_pull", { requestId, model, onProgress: ch });
      }
      const last = EK_ACTIVE_PULLS.get(model);
      if (last && last.error) {
        if (!silent) {
          window.ekToast?.({
            kind: "error",
            title: `Could not pull ${model}`,
            body: last.error,
          });
        }
        return { ok: false, error: last.error };
      }
      // The command resolving WITHOUT a success line means the stream was
      // cancelled (or Ollama closed early) — not a completed download.
      if (!last || !last.done) {
        return { ok: false, error: "Download didn't complete (cancelled or interrupted)" };
      }
      if (!silent) {
        window.ekToast?.({
          kind: "success",
          title: `${model} downloaded`,
          body: "It now appears in the model picker.",
        });
      }
      return { ok: true, error: null };
    } catch (e) {
      if (!silent) {
        window.ekToast?.({
          kind: "error",
          title: `Could not pull ${model}`,
          body: String(e),
        });
      }
      return { ok: false, error: String(e) };
    } finally {
      EK_ACTIVE_PULLS.delete(model);
      EK_PULL_PROMISES.delete(model);
      ekPullsNotify();
    }
  })();
  EK_PULL_PROMISES.set(model, run);
  return run;
}

function ekCancelPull(model) {
  const cur = EK_ACTIVE_PULLS.get(model);
  const invoke = getInvoke();
  if (!cur || !invoke) return;
  // Rust flips the cancel flag; the download command resolves Ok and the
  // finally block above cleans the store. Fire-and-forget by design.
  // Engine downloads keep their .partial on cancel (resume support) —
  // the flavor is routed via the cancelCmd the seed recorded.
  invoke(cur.cancelCmd || "ollama_pull_cancel", { requestId: cur.requestId }).catch(() => {});
}

// Window-accessible progress accessor. EK_ACTIVE_PULLS is a module-scope
// const (not on window), so other scripts (e.g. OllamaGate in overlays.jsx)
// that want to render a pull's progress read it through this function
// declaration, which IS hoisted onto window. Returns the accumulated
// progress object for `model`, or null if no pull is active for it.
function ekGetPull(model) {
  return EK_ACTIVE_PULLS.get(model) || null;
}

// Curated suggestions for the download box. Names + sizes verified against
// the Ollama library (June 2026); sizes are download sizes shown to set
// expectations, not enforced. The panel filters out any model the user has
// already pulled (see `suggestions` in ModelManagerPanel), so this list is
// just the candidate pool — keep it diverse rather than many tags of one
// family.
const CURATED_MODELS = [
  { name: "gemma4:e4b", approx: "9.6 GB", blurb: "All-round default — chat, vision, tools" },
  { name: "gemma4:e2b", approx: "7.2 GB", blurb: "Smaller + faster — good on low-RAM machines" },
  { name: "gemma4:12b", approx: "7.6 GB", blurb: "Stronger reasoning, 256K context" },
  { name: "granite4.1:8b", approx: "5.3 GB", blurb: "IBM Granite — efficient, strong tool use" },
  { name: "qwen3.5:2b", approx: "2.7 GB", blurb: "Tiny + capable — vision, 256K context" },
  { name: "qwen3.5:9b", approx: "6.6 GB", blurb: "Mid-size reasoning + coding — vision, 256K context" },
  { name: "llama3.2:3b", approx: "2.0 GB", blurb: "Tiny general-purpose fallback" },
  { name: "nomic-embed-text", approx: "274 MB", blurb: "Embeddings — needed for folder attachments + search" },
];

// ── Panel ──────────────────────────────────────────────────────────────────

function ModelManagerPanel({ activeModel }) {
  const [models, setModels] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [pullInput, setPullInput] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null); // model name
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Bumped by the pull store on every progress chunk; the value is unused —
  // it exists to schedule a re-render that re-reads EK_ACTIVE_PULLS.
  const [, setPullTick] = useState(0);
  const prevPullingRef = useRef(new Set());
  const invoke = getInvoke();
  // Non-Ollama backends hide the pull/delete affordances:
  //   - BYO (custom endpoint): the endpoint owns its model store; the
  //     installed list mirrors /v1/models.
  //   - Bundled engine: models are .gguf FILES in the app's models
  //     folder — managed in the file manager (Phase 2; the Phase 3
  //     catalog adds in-app downloads). The list reads the same
  //     llm_list_models, which the engine adapter answers from a dir
  //     scan.
  const [backendKind, setBackendKind] = useState("ollama");
  const byoBackend = backendKind === "openai";
  const engineBackend = backendKind === "engine";
  // engine_status snapshot for the engine hint (models folder path).
  const [engineInfo, setEngineInfo] = useState(null);
  // Engine catalog (Phase 3): baked-in curated list + per-model install
  // state. null = not fetched. Refreshed when a download finishes (via
  // the pull-store subscription below) and after deletes.
  const [engineCatalog, setEngineCatalog] = useState(null);
  // Machine RAM (GB) for the catalog's fit badges.
  const [ramGb, setRamGb] = useState(null);
  // Custom-GGUF download row state.
  const [customUrl, setCustomUrl] = useState("");
  const [customName, setCustomName] = useState("");
  const refreshCatalog = () => {
    if (!invoke) return;
    invoke("engine_catalog")
      .then((c) => setEngineCatalog(c?.models || []))
      .catch(() => setEngineCatalog([]));
  };
  // The pull-finish subscription effect below is mount-scoped; give it a
  // ref so it can trigger catalog refreshes without re-subscribing.
  const refreshCatalogRef = useRef(() => {});
  refreshCatalogRef.current = engineBackend ? refreshCatalog : () => {};
  useEffect(() => {
    if (!invoke) return;
    invoke("llm_backend_config_get")
      .then((c) => setBackendKind(c?.backend || "ollama"))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);
  useEffect(() => {
    if (!invoke || !engineBackend) return;
    invoke("engine_status")
      .then((s) => setEngineInfo(s || null))
      .catch(() => setEngineInfo(null));
    refreshCatalog();
    invoke("system_profile")
      .then((p) => {
        const b = p?.totalRamBytes;
        if (b) setRamGb(Math.round(b / 1073741824));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kind-gated
  }, [engineBackend]);

  const refreshModels = () => {
    if (!invoke) { setModels([]); setLoadError("Ollama not running"); return; }
    invoke("llm_list_models")
      .then((data) => {
        const sorted = (data.models || []).slice().sort((a, b) =>
          (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }),
        );
        setModels(sorted);
        setLoadError("");
      })
      .catch((e) => {
        setModels([]);
        // The engine's errors name the real problem ("llama-server
        // binary not found — run scripts/…"); the legacy label only
        // fits the Ollama backend.
        setLoadError(String(e?.message || e || "") || "Ollama not running");
      });
  };

  useEffect(() => {
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render on pull progress; refresh the installed list when any pull
  // LEAVES the store (finished or cancelled — either way /api/tags may
  // have changed).
  useEffect(() => {
    return ekPullsSubscribe(() => {
      const now = new Set(EK_ACTIVE_PULLS.keys());
      const prev = prevPullingRef.current;
      let someoneFinished = false;
      prev.forEach((m) => { if (!now.has(m)) someoneFinished = true; });
      prevPullingRef.current = now;
      setPullTick((t) => t + 1);
      if (someoneFinished) {
        refreshModels();
        refreshCatalogRef.current(); // engine: flip catalog rows to Installed
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPull = (name) => {
    const model = (name || "").trim();
    if (!model) return;
    setPullInput("");
    ekPullModel(model);
  };

  const doDelete = async () => {
    const model = confirmDelete;
    if (!model) return;
    setDeleteBusy(true);
    try {
      if (engineBackend) {
        // Engine models are files; Rust unloads a resident (idle) model
        // first and refuses while it's actively streaming.
        await invoke("engine_model_delete", { name: model });
      } else {
        await invoke("ollama_delete", { model });
      }
      window.ekToast?.({ kind: "success", title: `${model} deleted` });
      refreshModels();
      refreshCatalogRef.current();
    } catch (e) {
      window.ekToast?.({ kind: "error", title: `Could not delete ${model}`, body: String(e) });
    } finally {
      setDeleteBusy(false);
      setConfirmDelete(null);
    }
  };

  const startCustomDownload = () => {
    const url = customUrl.trim();
    const name = customName.trim();
    if (!url || !name) return;
    setCustomUrl("");
    setCustomName("");
    ekPullModel(name, { customUrl: url });
  };

  const installed = models || [];
  const installedNames = new Set(installed.map((m) => m.name));
  const pulls = Array.from(EK_ACTIVE_PULLS.values());
  const suggestions = CURATED_MODELS.filter(
    (c) => !installedNames.has(c.name) && !EK_ACTIVE_PULLS.has(c.name),
  );

  // Type-ahead options for the download box. Ollama's local API has no
  // remote-library search endpoint (/api/tags only reports INSTALLED
  // models), and querying ollama.com directly would break the
  // "only talks to localhost" guarantee — so true full-library
  // autocomplete isn't possible offline. Instead we offer a static
  // <datalist>: the curated names plus the user's already-installed names
  // (handy for `pull`-to-update). Free-typing any other name still works.
  const datalistNames = Array.from(
    new Set([...CURATED_MODELS.map((c) => c.name), ...installed.map((m) => m.name)]),
  ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const sectionLabel = (text) => (
    <div
      style={{
        fontFamily: T.mono, fontSize: 10, color: T.fg3,
        textTransform: "uppercase", letterSpacing: 0.6,
        padding: "10px 2px 6px",
      }}
    >
      {text}
    </div>
  );

  return (
    <div data-model-manager style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      {sectionLabel("Installed models")}

      {models === null && (
        <div style={{ padding: "10px 2px", fontFamily: T.mono, fontSize: 11, color: T.fg3 }}>
          <span className="typing-dot">●</span> <span className="typing-dot">●</span>{" "}
          <span className="typing-dot">●</span>
        </div>
      )}
      {loadError && (
        <div style={{ padding: "10px 2px", fontFamily: T.mono, fontSize: 11, color: T.fg3 }}>
          {loadError}
        </div>
      )}
      {models !== null && !loadError && installed.length === 0 && (
        <div style={{ padding: "10px 2px", fontFamily: T.sans, fontSize: 12.5, color: T.fg2 }}>
          No models installed yet — download one below.
        </div>
      )}

      {installed.map((m) => {
        const isActive = m.name === activeModel;
        const params = m.details?.parameter_size || "";
        const quant = m.details?.quantization_level || "";
        const sizeOnDisk = formatBytes(m.size);
        return (
          <div
            key={m.name}
            style={{
              display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8,
              alignItems: "center", padding: "7px 8px", borderRadius: 4,
            }}
          >
            <ModelDot color={modelColor(m.name)} size={7} />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg, fontWeight: 500 }}>
                  {m.name}
                </span>
                {params && <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg2 }}>{params}</span>}
                {quant && <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.fg3 }}>{quant}</span>}
                {isActive && (
                  <span
                    style={{
                      fontFamily: T.mono, fontSize: 9, padding: "1px 5px", borderRadius: 3,
                      background: T.green + "26", color: T.green,
                      textTransform: "uppercase", letterSpacing: 0.4,
                    }}
                  >
                    active
                  </span>
                )}
              </div>
              {sizeOnDisk && (
                <div style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3, marginTop: 1 }}>
                  {sizeOnDisk} on disk
                </div>
              )}
            </div>
            {!byoBackend && (
            <button
              onClick={() => setConfirmDelete(m.name)}
              title={engineBackend ? `Delete ${m.name} from the models folder` : `Delete ${m.name} from Ollama`}
              style={{
                padding: "3px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
                background: "transparent", color: T.fg3, fontFamily: T.sans,
                fontSize: 11.5, cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = T.red; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = T.fg3; }}
            >
              Delete
            </button>
            )}
          </div>
        );
      })}

      {pulls.length > 0 && sectionLabel("Downloading")}
      {pulls.map((p) => (
        <div key={p.model} style={{ padding: "7px 8px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg, fontWeight: 500, flex: 1 }}>
              {p.model}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg2 }}>
              {p.pct !== null
                ? `${p.pct}% · ${formatBytes(p.completedBytes)} / ${formatBytes(p.totalBytes)}`
                : p.statusLine || "starting…"}
            </span>
            <button
              onClick={() => ekCancelPull(p.model)}
              style={{
                padding: "2px 8px", borderRadius: 4, border: `1px solid ${T.border}`,
                background: "transparent", color: T.fg3, fontFamily: T.sans,
                fontSize: 11, cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
          <div
            style={{
              marginTop: 6, height: 4, borderRadius: 2, background: T.bg3,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: p.pct !== null ? `${p.pct}%` : "30%",
                background: T.amber,
                borderRadius: 2,
                transition: "width 200ms linear",
                // Indeterminate shimmer until the first layer reports size.
                animation: p.pct === null ? "blink 1.1s steps(2) infinite" : "none",
              }}
            />
          </div>
        </div>
      ))}

      {byoBackend && (
        <div
          data-byo-hint
          style={{
            fontFamily: T.sans, fontSize: 11, color: T.fg3,
            lineHeight: 1.5, marginTop: 10,
          }}
        >
          Models are managed by your endpoint server (LM Studio,
          llama-server, ...). Load or download models there; this list
          mirrors what it reports at /v1/models.
        </div>
      )}
      {engineBackend && engineCatalog !== null && (
        <>
          {sectionLabel("Model catalog")}
          {engineCatalog.map((c) => {
            const pull = EK_ACTIVE_PULLS.get(c.id);
            const lowRam = ramGb !== null && ramGb < c.minRamGb;
            return (
              <div
                key={c.id}
                data-catalog-model={c.id}
                style={{
                  display: "grid", gridTemplateColumns: "1fr auto", gap: 8,
                  alignItems: "center", padding: "6px 8px", borderRadius: 4,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg, fontWeight: 500 }}>
                      {c.label}
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>
                      {formatBytes(c.totalBytes)}
                    </span>
                    {c.recommended && (
                      <span
                        style={{
                          fontFamily: T.mono, fontSize: 9, padding: "1px 5px", borderRadius: 3,
                          background: T.bg2, color: "var(--ek-accent)",
                          border: "1px solid var(--ek-accent)",
                          textTransform: "uppercase", letterSpacing: 0.4,
                        }}
                      >
                        recommended
                      </span>
                    )}
                    {c.purpose === "embed" && (
                      <span
                        style={{
                          fontFamily: T.mono, fontSize: 9, padding: "1px 5px", borderRadius: 3,
                          background: T.blue + "26", color: T.blue,
                          textTransform: "uppercase", letterSpacing: 0.4,
                        }}
                      >
                        embeddings
                      </span>
                    )}
                    {lowRam && (
                      <span
                        data-catalog-ram-warning
                        style={{
                          fontFamily: T.mono, fontSize: 9, padding: "1px 5px", borderRadius: 3,
                          background: T.amber + "26", color: T.amber,
                          textTransform: "uppercase", letterSpacing: 0.4,
                        }}
                        title={`This model wants ${c.minRamGb} GB of RAM; this Mac has ${ramGb} GB.`}
                      >
                        needs {c.minRamGb} GB RAM
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: T.sans, fontSize: 11.5, color: T.fg2, marginTop: 1 }}>
                    {c.blurb}
                  </div>
                </div>
                {c.installed ? (
                  <span
                    data-catalog-installed
                    style={{ fontFamily: T.mono, fontSize: 10.5, color: T.green, whiteSpace: "nowrap" }}
                  >
                    ✓ installed
                  </span>
                ) : pull ? (
                  <button
                    onClick={() => ekCancelPull(c.id)}
                    style={{
                      padding: "3px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
                      background: "transparent", color: T.fg3, fontFamily: T.sans,
                      fontSize: 11.5, cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    data-catalog-download={c.id}
                    onClick={() => ekPullModel(c.id, { engine: true })}
                    style={{
                      padding: "3px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
                      background: "transparent", color: T.fg2, fontFamily: T.sans,
                      fontSize: 11.5, cursor: "pointer",
                    }}
                  >
                    Download
                  </button>
                )}
              </div>
            );
          })}
        </>
      )}

      {engineBackend && (
        <div
          data-engine-hint
          style={{
            fontFamily: T.sans, fontSize: 11, color: T.fg3,
            lineHeight: 1.5, marginTop: 10,
            display: "flex", flexDirection: "column", gap: 8,
          }}
        >
          <span>
            Downloads land in Ekorbia's models folder — you can also drop
            any .gguf file in yourself (add a matching{" "}
            <span style={{ fontFamily: T.mono }}>name.mmproj.gguf</span> to
            enable vision). Custom models are best-effort: quality depends
            on the file's built-in chat template.
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            <input
              data-custom-gguf-url
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="https://huggingface.co/…/model.gguf"
              spellCheck={false}
              autoComplete="off"
              style={{
                flex: 2, minWidth: 0, padding: "6px 9px", borderRadius: 6,
                border: `1px solid ${T.border}`, background: T.bg2, color: T.fg,
                fontFamily: T.mono, fontSize: 11, outline: "none",
              }}
            />
            <input
              data-custom-gguf-name
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") startCustomDownload(); }}
              placeholder="local name"
              spellCheck={false}
              autoComplete="off"
              style={{
                flex: 1, minWidth: 0, padding: "6px 9px", borderRadius: 6,
                border: `1px solid ${T.border}`, background: T.bg2, color: T.fg,
                fontFamily: T.mono, fontSize: 11, outline: "none",
              }}
            />
            <button
              data-custom-gguf-download
              onClick={startCustomDownload}
              disabled={!customUrl.trim() || !customName.trim()}
              style={{
                padding: "5px 12px", borderRadius: 6, border: `1px solid ${T.border}`,
                background: T.bg2, color: T.fg, fontFamily: T.sans,
                fontSize: 11.5, cursor: "pointer", flexShrink: 0,
              }}
            >
              Download
            </button>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              data-engine-reveal
              onClick={() => invoke && invoke("engine_models_dir_reveal").catch(() => {})}
              style={{
                padding: "4px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
                background: T.bg2, color: T.fg, fontFamily: T.sans,
                fontSize: 11, cursor: "pointer", flexShrink: 0,
              }}
            >
              Reveal models folder
            </button>
            {engineInfo && (
              <span
                style={{
                  fontFamily: T.mono, fontSize: 10, color: T.fg3,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
                title={engineInfo.modelsDir}
              >
                {engineInfo.modelsDir}
              </span>
            )}
          </span>
        </div>
      )}
      {!byoBackend && !engineBackend && sectionLabel("Download a model")}
      {!byoBackend && !engineBackend && (
      <>
      <div style={{ display: "flex", gap: 6, padding: "0 2px" }}>
        <input
          value={pullInput}
          onChange={(e) => setPullInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") startPull(pullInput); }}
          placeholder="model name, e.g. gemma4:e4b"
          list="ek-model-list"
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1, padding: "7px 10px", borderRadius: 6,
            border: `1px solid ${T.border}`, background: T.bg2, color: T.fg,
            fontFamily: T.mono, fontSize: 12, outline: "none",
          }}
        />
        {/* Offline type-ahead — see datalistNames above for why this is a
            static list rather than a live library search. */}
        <datalist id="ek-model-list">
          {datalistNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <button
          onClick={() => startPull(pullInput)}
          disabled={!pullInput.trim()}
          style={{
            padding: "7px 14px", borderRadius: 6, border: "none",
            background: pullInput.trim() ? T.amber : T.bg3,
            color: pullInput.trim() ? T.bg0 : T.fg3,
            fontFamily: T.sans, fontSize: 12.5, fontWeight: 600,
            cursor: pullInput.trim() ? "pointer" : "default",
          }}
        >
          Pull
        </button>
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3, padding: "5px 2px 0" }}>
        Browse the full library at ollama.com/library
      </div>

      </>
      )}

      {!byoBackend && !engineBackend && suggestions.length > 0 && (
        <>
          {sectionLabel("Suggestions")}
          {suggestions.map((c) => (
            <div
              key={c.name}
              data-model-suggestion={c.name}
              style={{
                display: "grid", gridTemplateColumns: "1fr auto", gap: 8,
                alignItems: "center", padding: "6px 8px", borderRadius: 4,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg, fontWeight: 500 }}>
                    {c.name}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>{c.approx}</span>
                </div>
                <div style={{ fontFamily: T.sans, fontSize: 11.5, color: T.fg2, marginTop: 1 }}>
                  {c.blurb}
                </div>
              </div>
              <button
                onClick={() => startPull(c.name)}
                style={{
                  padding: "3px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
                  background: "transparent", color: T.fg2, fontFamily: T.sans,
                  fontSize: 11.5, cursor: "pointer",
                }}
              >
                Pull
              </button>
            </div>
          ))}
        </>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={`Delete ${confirmDelete || ""}?`}
        body={
          confirmDelete === activeModel
            ? `${confirmDelete} is your ACTIVE model — chats will fall back to another installed model. The download is removed from disk; you can download it again any time.`
            : engineBackend
              ? `This removes the model's files from Ekorbia's models folder. You can download it again from the catalog any time.`
              : `This removes the model from Ollama's local store. You can pull it again any time.`
        }
        confirmText="Delete"
        busy={deleteBusy}
        onConfirm={doDelete}
        onCancel={() => { if (!deleteBusy) setConfirmDelete(null); }}
      />
    </div>
  );
}

// ── Modal wrapper ──────────────────────────────────────────────────────────

function ModelManagerModal({ open, onClose, activeModel }) {
  // Esc closes. Capture phase so a stacked ConfirmDialog (which also
  // listens on capture + stops propagation) wins when it's open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose?.(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={() => onClose?.()}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Manage models"
        style={{
          width: 460, maxHeight: "78vh", overflowY: "auto",
          background: panelGrad(), border: `1px solid ${T.borderStrong}`,
          borderRadius: 8, boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          padding: "14px 16px 16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontFamily: T.serif, fontSize: 17, color: T.fg, flex: 1 }}>
            Manage models
          </div>
          <button
            onClick={() => onClose?.()}
            aria-label="Close"
            style={{
              border: "none", background: "transparent", color: T.fg3,
              fontSize: 16, cursor: "pointer", padding: 2,
            }}
          >
            ✕
          </button>
        </div>
        <ModelManagerPanel activeModel={activeModel} />
      </div>
    </div>
  );
}
