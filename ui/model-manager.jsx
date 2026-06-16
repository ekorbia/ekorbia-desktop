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

// Start pulling `model`. Resolves true when Ollama reports
// {"status":"success"}; false on error, cancel, or early stream end.
// opts.silent suppresses the completion/error toasts (the guided
// first-run renders its own status and doesn't want double feedback).
async function ekPullModel(model, opts) {
  const silent = !!(opts && opts.silent);
  const invoke = getInvoke();
  model = (model || "").trim();
  if (!invoke || !model) return false;
  if (EK_PULL_PROMISES.has(model)) return EK_PULL_PROMISES.get(model);

  const requestId = `pull:${model}:${genId()}`;
  const seed = accumulatePullProgress(null, null);
  seed.model = model;
  seed.requestId = requestId;
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
      EK_ACTIVE_PULLS.set(model, next);
      ekPullsNotify();
    };
  }

  const run = (async () => {
    try {
      await invoke("ollama_pull", { requestId, model, onProgress: ch });
      const last = EK_ACTIVE_PULLS.get(model);
      if (last && last.error) {
        if (!silent) {
          window.ekToast?.({
            kind: "error",
            title: `Could not pull ${model}`,
            body: last.error,
          });
        }
        return false;
      }
      // The command resolving WITHOUT a success line means the stream was
      // cancelled (or Ollama closed early) — not a completed download.
      if (!last || !last.done) return false;
      if (!silent) {
        window.ekToast?.({
          kind: "success",
          title: `${model} downloaded`,
          body: "It now appears in the model picker.",
        });
      }
      return true;
    } catch (e) {
      if (!silent) {
        window.ekToast?.({
          kind: "error",
          title: `Could not pull ${model}`,
          body: String(e),
        });
      }
      return false;
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
  // Rust flips the cancel flag; ollama_pull resolves Ok and the finally
  // block above cleans the store. Fire-and-forget by design.
  invoke("ollama_pull_cancel", { requestId: cur.requestId }).catch(() => {});
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

  const refreshModels = () => {
    if (!invoke) { setModels([]); setLoadError("Ollama not running"); return; }
    invoke("ollama_tags")
      .then((data) => {
        const sorted = (data.models || []).slice().sort((a, b) =>
          (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }),
        );
        setModels(sorted);
        setLoadError("");
      })
      .catch(() => { setModels([]); setLoadError("Ollama not running"); });
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
      if (someoneFinished) refreshModels();
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
      await invoke("ollama_delete", { model });
      window.ekToast?.({ kind: "success", title: `${model} deleted` });
      refreshModels();
    } catch (e) {
      window.ekToast?.({ kind: "error", title: `Could not delete ${model}`, body: String(e) });
    } finally {
      setDeleteBusy(false);
      setConfirmDelete(null);
    }
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
                      background: "rgba(155,191,131,0.15)", color: T.green,
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
            <button
              onClick={() => setConfirmDelete(m.name)}
              title={`Delete ${m.name} from Ollama`}
              style={{
                padding: "3px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
                background: "transparent", color: T.fg3, fontFamily: T.sans,
                fontSize: 11.5, cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = T.red || "#bf8383"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = T.fg3; }}
            >
              Delete
            </button>
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

      {sectionLabel("Download a model")}
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
            color: pullInput.trim() ? "#1a1008" : T.fg3,
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

      {suggestions.length > 0 && (
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
            ? `${confirmDelete} is your ACTIVE model — chats will fall back to another installed model. The download is removed from disk; you can pull it again any time.`
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
          background: T.bg1, border: `1px solid ${T.borderStrong}`,
          borderRadius: 8, boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
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
