// overlays.jsx -- Floating overlays:
//   MODEL_COLORS + modelColor, CompareModelPickerModal, ConfirmDialog,
//   the first-run gates (OllamaGate, EngineGate, EngineMigrationOffer).
// Depends on: tokens, atoms, icons. Byte formatting comes from
// utils.js `formatBytes` (formerly a local `fmt_size` here).

// Brand accent set (matches THEMES.one_dark / ekorbia.com) plus two
// extenders so eight models hash to distinct dots. Static hexes by design:
// a model keeps its color across theme switches.
'use strict';
const MODEL_COLORS = [
  "#f0934a",
  "#5fb0ff",
  "#7dd17a",
  "#c281f5",
  "#e8ca6a",
  "#6cc7d1",
  "#f17ba0",
  "#ff8b8b",
];

function modelColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return MODEL_COLORS[h % MODEL_COLORS.length];
}

// Centered modal for picking the 2 or 3 models that will populate a
// compare-mode tab's columns. Lifecycle: parent passes `open` to mount it; on `Done` the modal
// calls `onConfirm(selected)` with a 2- or 3-entry string array of model
// ids; on Cancel/backdrop click it calls `onClose()`. The compose-mode
// column-count cap (2 or 3) is enforced inside this component: a Done
// click outside that range is disabled.
// `nameOfModel(id)` → { name, detail } gives rows their plain names;
// without it they show the id.
// `sequential` adds the note that the models answer one after another
// (true on the bundled engine, which runs one chat model at a time).
function CompareModelPickerModal({ open, onClose, onConfirm, nameOfModel, sequential }) {
  const [models, setModels] = useState(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const invoke = getInvoke();

  useEffect(() => {
    if (!open) return;
    // Reset on each open so a previous session's selection doesn't leak.
    setSelected(new Set());
    setError("");
    setModels(null);
    // Rust-side `llm_list_models` (Phase B.1 proxy) — see ollama.rs for why.
    if (!invoke) { setModels([]); setError("Ollama not running"); return; }
    invoke('llm_list_models')
      .then((data) => {
        // Alphabetical, like every other model list. The model that reads documents
        // for search cannot answer a question, so it is not offered
        // (same rule as the workspace settings model list).
        const sorted = (data.models || []).filter((m) => !/embed/i.test((m && m.name) || "")).sort((a, b) =>
          (a.name || "").localeCompare(b.name || "", undefined, {
            sensitivity: "base",
          }),
        );
        setModels(sorted);
      })
      .catch(() => {
        setModels([]);
        setError("Ollama not running");
      });
  }, [open]);

  if (!open) return null;

  const toggle = (name) => {
    setSelected((curr) => {
      const next = new Set(curr);
      if (next.has(name)) {
        next.delete(name);
      } else if (next.size < 3) {
        // Hard cap at 3 (per v1 column-count decision). Clicking a 4th
        // checkbox silently no-ops — the help text below shows "2 or 3".
        next.add(name);
      }
      return next;
    });
  };

  const canConfirm = selected.size === 2 || selected.size === 3;
  const quiet = { padding: "10px 2px", fontFamily: T.sans, fontSize: 13, color: T.fg2 };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 100,
        zIndex: 1000,
      }}
    >
      <div
        data-compare-picker
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 500,
          maxHeight: "72vh",
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 14,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "18px 22px 12px" }}>
          <div style={{ fontFamily: T.sans, fontSize: 17, fontWeight: 600, color: T.fg }}>
            Compare models
          </div>
          <div style={ekHint({ fontSize: 12.5, marginTop: 3 })}>
            Choose two or three. Each answers the same question.
          </div>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "0 22px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {models === null && (
            <div style={quiet}>
              <span className="typing-dot">●</span>{" "}
              <span className="typing-dot">●</span>{" "}
              <span className="typing-dot">●</span>
            </div>
          )}
          {error && <div style={quiet}>{error}</div>}
          {models && models.length === 0 && !error && (
            <div style={quiet}>No models are installed yet.</div>
          )}
          {(models || []).map((m) => {
            const isChecked = selected.has(m.name);
            const sizeOnDisk = formatBytes(m.size);
            const plain = nameOfModel ? nameOfModel(m.name) : { name: m.name, detail: "" };
            // A fourth cannot be added: say so by greying the rest.
            const full = !isChecked && selected.size >= 3;
            return (
              <label
                key={m.name}
                data-compare-pick-row={m.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "18px minmax(0, 1fr) auto",
                  gap: 10,
                  alignItems: "center",
                  padding: "9px 12px",
                  border: `1px solid ${isChecked ? T.fg : T.border}`,
                  boxShadow: isChecked ? `0 0 0 1px ${T.fg}` : "none",
                  borderRadius: 10,
                  background: T.isLight ? T.bg0 : T.bg2,
                  cursor: full ? "default" : "pointer",
                  opacity: full ? 0.55 : 1,
                  flexShrink: 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggle(m.name)}
                  aria-label={`Compare with ${plain.name}`}
                  style={{ width: 16, height: 16, margin: 0, accentColor: T.fg, cursor: "inherit" }}
                />
                <div
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span
                    data-compare-pick-name
                    style={{ fontFamily: T.sans, fontSize: 13.5, fontWeight: 600, color: T.fg }}
                  >
                    {plain.name}
                  </span>
                  {plain.detail && (
                    <span style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2, marginLeft: 7 }}>
                      {plain.detail}
                    </span>
                  )}
                </div>
                {sizeOnDisk && (
                  <span style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2 }}>
                    {sizeOnDisk}
                  </span>
                )}
              </label>
            );
          })}
          {sequential && (
            <div data-compare-pick-hint style={ekHint({ marginTop: 2 })}>
              The models answer one after another, so this takes as long as
              all the answers together.
            </div>
          )}
        </div>

        <div
          style={{
            padding: "14px 22px 18px",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span data-compare-pick-count style={ekHint({ flex: 1 })}>
            {selected.size === 0 && "Choose two or three"}
            {selected.size === 1 && "1 chosen — choose one more"}
            {selected.size === 2 && "2 chosen"}
            {selected.size === 3 && "3 chosen"}
          </span>
          <button onClick={onClose} style={ekBtn("secondary")}>
            Cancel
          </button>
          <button
            data-compare-start
            disabled={!canConfirm}
            onClick={() => {
              if (!canConfirm) return;
              onConfirm(Array.from(selected));
            }}
            style={ekBtn("primary", { disabled: !canConfirm })}
          >
            Start comparing
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Confirm Dialog ─────────────────────────────────────────
// Reusable yes/no modal for destructive actions. Cancel is the default-
// focused button (Enter without moving focus = the safe choice); the
// primary action uses red styling so the destructive intent is obvious.
// Escape and backdrop-click both cancel.
//
// Props:
//   open        — bool. Parent controls visibility.
//   title       — short heading ("Delete all chats?").
//   body        — string OR React node. Multi-paragraph body welcome.
//   confirmText — button label (default "Confirm").
//   cancelText  — button label (default "Cancel").
//   busy        — bool. While true, both buttons are disabled and the
//                 confirm label shows "Working…". Use for the
//                 invoke()-in-flight window so double-clicks can't fire
//                 the destructive action twice.
//   onConfirm   — called on confirm click. May be async; the parent
//                 should set busy=true around it and dismiss after.
//   onCancel    — called on Cancel / Escape / backdrop click.
function ConfirmDialog({
  open,
  title,
  body,
  confirmText = "Confirm",
  cancelText = "Cancel",
  busy = false,
  onConfirm,
  onCancel,
}) {
  const cancelBtnRef = useRef(null);

  // Default focus on the safe button so the user can't accidentally
  // commit the destructive action by pressing Enter on whatever was
  // focused before the dialog opened. Mirror the timing pattern used
  // elsewhere in this file: defer one tick so the button is mounted.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => cancelBtnRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Escape cancels. Capture phase + stopPropagation so we don't also
  // dismiss whatever modal hosts this dialog (Settings, etc).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        e.stopPropagation();
        onCancel?.();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      onClick={() => { if (!busy) onCancel?.(); }}
      style={{
        position: "fixed",
        inset: 0,
        // One level above SettingsModal (9998) so the confirm sits on top.
        zIndex: 9999,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width: 380,
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 12,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "16px 18px 4px",
            fontFamily: T.sans,
            fontSize: 14,
            fontWeight: 600,
            color: T.fg,
          }}
        >
          {title}
        </div>
        <div
          style={{
            padding: "8px 18px 16px",
            fontFamily: T.sans,
            fontSize: 12.5,
            color: T.fg2,
            lineHeight: 1.5,
          }}
        >
          {body}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 14px 14px",
            borderTop: `1px solid ${T.border}`,
            background: T.bg0,
          }}
        >
          <button
            ref={cancelBtnRef}
            onClick={() => { if (!busy) onCancel?.(); }}
            disabled={busy}
            style={ekBtn("secondary", { disabled: busy })}
          >
            {cancelText}
          </button>
          <button
            onClick={() => { if (!busy) onConfirm?.(); }}
            disabled={busy}
            style={{ ...ekBtn("primary"), background: T.red, border: `1px solid ${T.red}`, color: "#fff", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Working…" : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Ollama Gate ─────────────────────────────────────────────
// open: controlled by parent. onReady: Ollama confirmed running+model present. onDismiss: user chose to skip.
function OllamaGate({ open, modelId, onReady, onDismiss, onModelInstalled }) {
  // phase: 'checking' | 'not-running' | 'recommend' | 'pulling' | 'starting' | 'error'
  // 'recommend' replaces the old passive 'no-model' phase: instead of
  // telling the user to run `ollama pull` in a terminal, we detect their
  // RAM, recommend a right-sized Gemma 4, and pull it in-app.
  const [phase, setPhase] = useState("checking");
  const [errorMsg, setErrorMsg] = useState("");
  // Guided-setup state.
  const [rec, setRec] = useState(null); // recommendGemmaModel() result
  const [alsoEmbed, setAlsoEmbed] = useState(true); // pull nomic-embed-text too
  const [showTerminal, setShowTerminal] = useState(false); // reveal the manual `ollama pull` box
  const [pullStep, setPullStep] = useState(null); // 'chat' | 'embed' — which sequential pull is live
  const [, forcePullTick] = useState(0); // bumped on pull progress to re-render the bar
  const invoke = getInvoke();

  const checkOllama = async () => {
    if (!invoke) return "not-running";
    try {
      // Rust-side `llm_list_models` (Phase B.1 proxy). The IPC throw on
      // failure replaces the previous `!resp.ok` + catch combo.
      const data = await invoke('llm_list_models');
      const names = (data.models || []).map((m) => m.name);
      const found = names.some(
        (n) => n === modelId || n.startsWith(modelId.split(":")[0]),
      );
      return found ? "ready" : "no-model";
    } catch {
      return "not-running";
    }
  };

  // Detect RAM and compute the recommended model. Failure → recommendation
  // for unknown RAM (a safe default), never blocks the flow.
  const loadRecommendation = async () => {
    let bytes = null;
    try {
      const p = await invoke('system_profile');
      bytes = p?.totalRamBytes ?? null;
    } catch { /* unknown RAM → recommendGemmaModel handles null */ }
    setRec(recommendGemmaModel(bytes));
  };

  // Run initial check whenever the modal opens.
  // Route a checkOllama() result to the right phase. Shared by the open
  // effect AND startOllama() so a "no model" outcome ALWAYS lands on the
  // guided 'recommend' card — never the bare 'no-model' string, which has
  // no body and no actions (a dead-end the user couldn't dismiss). That
  // regression is exactly what this routing prevents.
  const routeCheckResult = async (result) => {
    if (result === "ready") {
      onReady();
      return;
    }
    if (result === "no-model") {
      await loadRecommendation();
      setPhase("recommend");
      return;
    }
    setPhase(result); // 'not-running'
  };

  useEffect(() => {
    if (!open) return;
    setPhase("checking");
    setErrorMsg("");
    checkOllama().then(routeCheckResult);
  }, [open, modelId]);

  // Safety net: Esc always dismisses the gate. Every phase normally has a
  // skip/cancel action, but this guarantees the user can never get trapped
  // even if some future phase ships without one.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onDismiss?.(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  // Re-render while a guided pull streams progress. EK_ACTIVE_PULLS lives
  // in model-manager.jsx; we read it via the window-global ekGetPull() and
  // subscribe via ekPullsSubscribe() (both function-hoisted onto window).
  useEffect(() => {
    if (!open) return;
    const unsub = ekPullsSubscribe(() => forcePullTick((n) => n + 1));
    return unsub;
  }, [open]);

  // Is `name` actually present in Ollama right now? This is the source of
  // truth for "did the pull land" — we trust it over ekPullModel's
  // stream-completion detection, because Ollama's final status line varies
  // by version and a cached re-pull can finish before we latch `done`.
  const isModelInstalled = async (name) => {
    try {
      const data = await invoke("llm_list_models");
      return (data.models || []).some((m) => m.name === name);
    } catch {
      return false;
    }
  };

  // Guided download: pull the recommended chat model, then (optionally) the
  // embedding model, then hand the installed model to the parent (which
  // sets it active, persists it, warms it, and closes the gate).
  const downloadAndSetup = async () => {
    if (!rec) return;
    setErrorMsg("");
    setPhase("pulling");
    setPullStep("chat");
    const res = await ekPullModel(rec.model, { silent: true });
    // Verify against Ollama (source of truth), but surface the pull's own
    // error detail when it failed so the message is diagnostic, not generic.
    if (!(await isModelInstalled(rec.model))) {
      const detail = res && res.error ? ` (${res.error})` : "";
      setErrorMsg(
        `Couldn't download ${rec.model}${detail}. Check your connection and try again, or use "Choose a different model".`,
      );
      setPhase("recommend");
      return;
    }
    if (alsoEmbed) {
      setPullStep("embed");
      // Best-effort: a failed embedding model shouldn't block getting into
      // chat — folder search just won't work until it's installed later.
      await ekPullModel("nomic-embed-text", { silent: true });
    }
    onModelInstalled?.(rec.model);
  };

  const openOllamaDownload = () => {
    try { getShellApi()?.open("https://ollama.com/download"); } catch {}
  };

  const startOllama = async () => {
    setPhase("starting");
    setErrorMsg("");
    if (!invoke) {
      setPhase("error");
      setErrorMsg(
        "Tauri runtime not available — cannot start Ollama from the app.",
      );
      return;
    }
    try {
      // Rust verifies Ollama is actually listening on 11434 before returning Ok.
      await invoke("start_ollama");
    } catch (e) {
      setPhase("error");
      setErrorMsg(String(e));
      return;
    }
    // Confirm the model is available now that Ollama is up. Route through
    // the shared handler so "no model" lands on the guided card, not the
    // dead-end 'no-model' phase.
    await routeCheckResult(await checkOllama());
  };

  if (!open || phase === "checking") return null;

  const titles = {
    "not-running": "Ollama is not running",
    recommend: "Let's get you a model",
    pulling: "Setting things up…",
    starting: "Starting Ollama…",
    error: "Something went wrong",
  };
  // Header subtitle: the target model id only makes sense for the
  // Ollama-state phases; the guided phases speak for themselves.
  const subtitle =
    phase === "recommend" || phase === "pulling" ? "Local AI setup" : modelId;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        style={{
          width: 420,
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 12,
          padding: "28px 28px 24px",
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 28 }}>🦙</span>
          <div>
            <div
              style={{
                fontFamily: T.sans,
                fontSize: 15,
                fontWeight: 600,
                color: T.fg,
              }}
            >
              {titles[phase] || phase}
            </div>
            <div
              style={{
                fontFamily: T.sans,
                fontSize: 12.5,
                color: T.fg3,
                marginTop: 2,
              }}
            >
              {subtitle}
            </div>
          </div>
        </div>

        {/* Body */}
        {phase === "not-running" && (
          <div
            style={{
              fontFamily: T.sans,
              fontSize: 13,
              color: T.fg2,
              lineHeight: 1.6,
            }}
          >
            Ekorbia needs Ollama to run local AI models. Allow it to start
            Ollama automatically?
            <div style={{ marginTop: 8 }}>
              <span
                onClick={openOllamaDownload}
                style={{ color: T.amber, cursor: "pointer", textDecoration: "underline" }}
              >
                Don't have Ollama? Install it →
              </span>
            </div>
          </div>
        )}
        {phase === "recommend" && rec && (
          <>
            {errorMsg && (
              <div
                style={{
                  background: "rgba(200,80,80,0.1)",
                  border: "1px solid rgba(200,80,80,0.3)",
                  borderRadius: 6,
                  padding: "8px 12px",
                  fontFamily: T.sans,
                  fontSize: 12,
                  color: T.red,
                  lineHeight: 1.5,
                }}
              >
                {errorMsg}
              </div>
            )}
            <div style={{ fontFamily: T.sans, fontSize: 13, color: T.fg2, lineHeight: 1.6 }}>
              Ollama is running, but you don't have a model yet. Here's one
              sized for your machine — Ekorbia will download it for you.
            </div>
            {/* Recommended model card */}
            <div
              style={{
                background: T.bg2,
                border: `1px solid ${T.borderStrong}`,
                borderRadius: 8,
                padding: "12px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 600, color: T.fg, flex: 1 }}>
                  {rec.model}
                </span>
                <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg3 }}>{rec.approx}</span>
              </div>
              <div style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2, lineHeight: 1.5 }}>
                {rec.reason}
              </div>
              {rec.lowRam && (
                <div style={{ fontFamily: T.sans, fontSize: 11.5, color: T.amber, marginTop: 2 }}>
                  ⚠ Limited memory — responses may be slow. A smaller model may feel better.
                </div>
              )}
            </div>
            {/* Embedding model opt-in */}
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={alsoEmbed}
                onChange={(e) => setAlsoEmbed(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2, lineHeight: 1.5 }}>
                Also download <code style={{ fontFamily: T.mono, color: T.fg }}>nomic-embed-text</code>{" "}
                <span style={{ color: T.fg3 }}>(274 MB)</span> — needed for attaching folders and searching files.
              </span>
            </label>
            {/* Manual / terminal escape hatch */}
            <div>
              <span
                onClick={() => setShowTerminal((v) => !v)}
                style={{ fontFamily: T.sans, fontSize: 12, color: T.fg3, cursor: "pointer", textDecoration: "underline" }}
              >
                {showTerminal ? "Hide terminal option" : "I'll use the terminal instead"}
              </span>
              {showTerminal && (
                <div
                  style={{
                    marginTop: 8,
                    background: T.bg2,
                    border: `1px solid ${T.border}`,
                    borderRadius: 6,
                    padding: "8px 12px",
                    fontFamily: T.sans,
                    fontSize: 13,
                    color: T.amber,
                  }}
                >
                  ollama pull {rec.model}
                </div>
              )}
            </div>
          </>
        )}
        {phase === "pulling" && (
          <>
            <div style={{ fontFamily: T.sans, fontSize: 13, color: T.fg2, lineHeight: 1.6 }}>
              {alsoEmbed
                ? `Downloading ${pullStep === "embed" ? "the embedding model" : "your model"} — step ${pullStep === "embed" ? "2" : "1"} of 2`
                : "Downloading your model…"}
            </div>
            {(() => {
              // Read live progress for whichever model is currently pulling.
              const target = pullStep === "embed" ? "nomic-embed-text" : (rec ? rec.model : null);
              const prog = target ? ekGetPull(target) : null;
              const pct = prog && prog.pct !== null ? prog.pct : null;
              return (
                <div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg, fontWeight: 500, flex: 1 }}>
                      {target || "…"}
                    </span>
                    <span style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2 }}>
                      {pct !== null
                        ? `${pct}% · ${formatBytes(prog.completedBytes)} / ${formatBytes(prog.totalBytes)}`
                        : (prog && prog.statusLine) || "starting…"}
                    </span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: T.bg3, overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        width: pct !== null ? `${pct}%` : "30%",
                        background: T.amber,
                        borderRadius: 2,
                        transition: "width 200ms linear",
                        animation: pct === null ? "blink 1.1s steps(2) infinite" : "none",
                      }}
                    />
                  </div>
                </div>
              );
            })()}
          </>
        )}
        {phase === "starting" && (
          <div
            style={{
              fontFamily: T.sans,
              fontSize: 13,
              color: T.fg2,
              lineHeight: 1.6,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span className="typing-dot" style={{ color: T.amber }}>
              ●
            </span>
            <span className="typing-dot" style={{ color: T.amber }}>
              ●
            </span>
            <span className="typing-dot" style={{ color: T.amber }}>
              ●
            </span>
            <span style={{ marginLeft: 4 }}>
              Waiting for Ollama to respond…
            </span>
          </div>
        )}
        {phase === "error" && (
          <div
            style={{
              background: "rgba(200,80,80,0.1)",
              border: "1px solid rgba(200,80,80,0.3)",
              borderRadius: 6,
              padding: "10px 12px",
              fontFamily: T.sans,
              fontSize: 12.5,
              color: T.red,
              lineHeight: 1.6,
            }}
          >
            {errorMsg}
          </div>
        )}

        {/* Actions */}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 4,
          }}
        >
          {(phase === "not-running" || phase === "error") && (
            <>
              <button
                onClick={onDismiss}
                style={ekBtn("secondary")}
              >
                Continue without Ollama
              </button>
              <button
                className="ek-btn-primary"
                onClick={startOllama}
                style={ekBtn("primary")}
              >
                {phase === "error" ? "Retry" : "Start Ollama"}
              </button>
            </>
          )}
          {phase === "recommend" && (
            <>
              <button
                onClick={onDismiss}
                style={ekBtn("secondary")}
              >
                Skip for now
              </button>
              <button
                onClick={() => {
                  // Browse/pick a different model in the full manager.
                  onDismiss();
                  window.ekOpenModelManager?.();
                }}
                style={ekBtn("secondary")}
              >
                Choose a different model
              </button>
              <button
                className="ek-btn-primary"
                onClick={downloadAndSetup}
                style={ekBtn("primary")}
              >
                Download and set up
              </button>
            </>
          )}
          {phase === "pulling" && (
            <button
              onClick={() => {
                // Cancel whichever pull is live, then return to the card.
                if (rec) ekCancelPull(rec.model);
                ekCancelPull("nomic-embed-text");
                setPhase("recommend");
              }}
              style={ekBtn("secondary")}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Engine Gate (Phase 5) ───────────────────────────────────────────────
// The bundled-engine counterpart to OllamaGate. There's no external process
// to install or start, so the whole "is Ollama running / install Ollama /
// start Ollama" machinery evaporates: the only question is "do you have a
// model yet?" First run = RAM-aware catalog recommendation → in-app download
// → chatting. Shares the pull store (ekPullModel/ekGetPull, engine flavor)
// and recommendEngineModel with the rest of the app.
//
//   open: parent-controlled. modelId: the currently-active model (a GGUF
//   stem on the engine). onReady: an installed chat model is already active.
//   onModelInstalled(id): a model is now installed + should become active.
//   onDismiss: user skipped.
function EngineGate({ open, modelId, onReady, onDismiss, onModelInstalled }) {
  // phase: 'checking' | 'recommend' | 'pulling' | 'no-binary'
  const [phase, setPhase] = useState("checking");
  const [errorMsg, setErrorMsg] = useState("");
  const [rec, setRec] = useState(null); // recommendEngineModel() result
  const [alsoEmbed, setAlsoEmbed] = useState(true); // also pull nomic-embed-text
  const [pullStep, setPullStep] = useState(null); // 'chat' | 'embed'
  const [, forcePullTick] = useState(0);
  const [binaryError, setBinaryError] = useState("");
  const invoke = getInvoke();

  // Inspect engine state and decide where to land. Returns a routing object.
  // "Installed chat model" = a GGUF stem that isn't a known catalog embed
  // model — so a lone nomic-embed-text never reads as a chat model, but a
  // hand-placed GGUF still counts.
  const inspect = async () => {
    if (!invoke) return { phase: "no-binary" };
    // Engine binary present? In a shipped build it's bundled; this only
    // trips in a dev tree before scripts/fetch-llama-server.sh has run.
    try {
      const st = await invoke("engine_status");
      if (st && st.binaryOk === false) {
        setBinaryError(st.binaryError || "");
        return { phase: "no-binary" };
      }
    } catch { /* treat as usable — a real failure surfaces at download time */ }
    // engine_catalog returns { version, models: [...] } — unwrap to the
    // models array (same as the model manager). Passing the raw object here
    // would throw on `.filter`/`.some` and leave the gate stuck on "checking".
    let catalog = [];
    try { catalog = (await invoke("engine_catalog"))?.models || []; } catch { /* offline: empty */ }
    const embedIds = (catalog || [])
      .filter((m) => m.purpose === "embed")
      .map((m) => m.id);
    let names = [];
    try {
      const listed = await invoke("llm_list_models");
      names = (listed.models || []).map((m) => m.name);
    } catch { /* none */ }
    const chatNames = names.filter((n) => !embedIds.includes(n));
    if (chatNames.length) {
      if (chatNames.includes(modelId)) return { phase: "ready" };
      // Heal a stale default (e.g. an Ollama-style tag) that isn't on the
      // engine: switch to an installed model, preferring a catalog pick.
      const pick =
        chatNames.find((n) =>
          (catalog || []).some((m) => m.id === n && m.recommended),
        ) || chatNames[0];
      return { phase: "ready-switch", switchTo: pick };
    }
    // Nothing chat-capable installed → recommend a right-sized model.
    let bytes = null;
    try {
      const p = await invoke("system_profile");
      bytes = p?.totalRamBytes ?? null;
    } catch { /* unknown RAM → recommendEngineModel handles null */ }
    setRec(recommendEngineModel(catalog, bytes));
    return { phase: "recommend" };
  };

  useEffect(() => {
    if (!open) return;
    setPhase("checking");
    setErrorMsg("");
    inspect().then((r) => {
      if (r.phase === "ready") { onReady?.(); return; }
      if (r.phase === "ready-switch") { onModelInstalled?.(r.switchTo); return; }
      setPhase(r.phase);
    });
  }, [open, modelId]);

  // Esc always dismisses — no phase should ever trap the user.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onDismiss?.(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  // Re-render while a guided download streams progress.
  useEffect(() => {
    if (!open) return;
    const unsub = ekPullsSubscribe(() => forcePullTick((n) => n + 1));
    return unsub;
  }, [open]);

  // Source of truth for "did the download land": the engine's own model scan.
  const isInstalled = async (id) => {
    try {
      const data = await invoke("llm_list_models");
      return (data.models || []).some((m) => m.name === id);
    } catch { return false; }
  };

  // Download the recommended chat model, then (optionally) the embedding
  // model, then hand the installed model to the parent.
  const downloadAndSetup = async () => {
    if (!rec) return;
    setErrorMsg("");
    setPhase("pulling");
    setPullStep("chat");
    const res = await ekPullModel(rec.id, { engine: true, silent: true });
    if (!(await isInstalled(rec.id))) {
      const detail = res && res.error ? ` (${res.error})` : "";
      setErrorMsg(
        `Couldn't download ${rec.label}${detail}. Check your connection and try again, or choose a different model.`,
      );
      setPhase("recommend");
      return;
    }
    if (alsoEmbed) {
      setPullStep("embed");
      // Best-effort: a failed embedding model shouldn't block getting into
      // chat — folder search just won't work until it's installed later.
      await ekPullModel("nomic-embed-text", { engine: true, silent: true });
    }
    onModelInstalled?.(rec.id);
  };

  if (!open || phase === "checking") return null;

  const titles = {
    recommend: "Choose a model",
    pulling: "Downloading",
    "no-binary": "The built-in engine is missing",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(3px)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ek-model-choice-title"
        data-engine-gate
        data-phase={phase}
        style={{
          width: 460,
          maxWidth: "92vw",
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 12,
          padding: "22px 24px 20px",
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <BrandMark size={20} />
          <div id="ek-model-choice-title" style={{ fontFamily: T.sans, fontSize: 17, fontWeight: 600, color: T.fg }}>
            {titles[phase] || phase}
          </div>
        </div>

        {phase === "recommend" && rec && (
          <>
            {errorMsg && (
              <div data-engine-gate-error style={ekHint({ color: T.red })}>
                {errorMsg}
              </div>
            )}
            <div style={ekHint()}>
              Ekorbia answers with a model that runs on this Mac. This one fits your Mac's memory. It downloads
              once.
            </div>
            {/* The model on offer. */}
            <div
              data-engine-gate-model
              style={{
                background: T.isLight ? T.bg0 : T.bg2,
                border: `1px solid ${T.fg}`,
                boxShadow: `0 0 0 1px ${T.fg}`,
                borderRadius: 10,
                padding: "12px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 3,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 600, color: T.fg, flex: 1 }}>
                  {rec.label}
                </span>
                <span style={ekHint()}>{rec.approx}</span>
              </div>
              <div style={ekHint()}>
                {rec.reason}
                {rec.vision ? " Reads images." : ""}
              </div>
              {rec.lowRam && (
                <div data-engine-gate-low-memory style={ekHint({ color: T.amber, marginTop: 2 })}>
                  Limited memory: replies may be slow. A smaller model may feel better.
                </div>
              )}
            </div>
            {/* The small model that searches documents. */}
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                data-engine-gate-search-model
                checked={alsoEmbed}
                onChange={(e) => setAlsoEmbed(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span style={ekHint()}>
                <span style={{ color: T.fg }}>Also download the model that searches your documents</span> (274 MB).
                Attached folders need it.
              </span>
            </label>
          </>
        )}
        {phase === "pulling" && (
          <>
            <div style={ekHint()}>
              {alsoEmbed
                ? pullStep === "embed"
                  ? "Step 2 of 2: the model that searches your documents."
                  : "Step 1 of 2: your model."
                : "Your model is on its way."}
            </div>
            {(() => {
              const target = pullStep === "embed" ? "nomic-embed-text" : (rec ? rec.id : null);
              const label = pullStep === "embed" ? "Search model" : (rec ? rec.label : "…");
              const prog = target ? ekGetPull(target) : null;
              const pct = prog && prog.pct !== null ? prog.pct : null;
              return (
                <div data-engine-gate-progress>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                    <span style={ekHeading({ flex: 1 })}>{label}</span>
                    <span style={ekHint()}>
                      {pct !== null
                        ? `${pct}% · ${formatBytes(prog.completedBytes)} of ${formatBytes(prog.totalBytes)}`
                        : (prog && prog.statusLine) || "Starting…"}
                    </span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: T.bg3, overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        width: pct !== null ? `${pct}%` : "30%",
                        background: T.fg,
                        borderRadius: 2,
                        transition: "width 200ms linear",
                        animation: pct === null ? "blink 1.1s steps(2) infinite" : "none",
                      }}
                    />
                  </div>
                </div>
              );
            })()}
          </>
        )}
        {phase === "no-binary" && (
          <div style={ekHint()}>
            This copy of Ekorbia was built without its engine.
            {binaryError && (
              <div
                style={{
                  marginTop: 8,
                  background: T.isLight ? T.bg0 : T.bg2,
                  border: `1px solid ${T.border}`,
                  borderRadius: 8,
                  padding: "8px 12px",
                  overflowWrap: "anywhere",
                }}
              >
                {binaryError}
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              Ekorbia can use Ollama or another server instead: Settings → Advanced.
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
          {phase === "recommend" && (
            <button data-engine-gate-skip onClick={onDismiss} style={ekBtn("quiet")}>
              Skip for now
            </button>
          )}
          <span style={{ flex: 1 }} />
          {phase === "no-binary" && (
            <button onClick={onDismiss} style={ekBtn("primary")}>
              Continue
            </button>
          )}
          {phase === "recommend" && (
            <>
              <button
                data-engine-gate-other
                onClick={() => { onDismiss?.(); window.ekOpenModelManager?.(); }}
                style={ekBtn("secondary")}
              >
                Choose another
              </button>
              <button data-engine-gate-download onClick={downloadAndSetup} style={ekBtn("primary")}>
                Download
              </button>
            </>
          )}
          {phase === "pulling" && (
            <button
              onClick={() => {
                if (rec) ekCancelPull(rec.id);
                ekCancelPull("nomic-embed-text");
                setPhase("recommend");
              }}
              style={ekBtn("secondary")}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Engine migration offer (Phase 5) ────────────────────────────────────
// One-time nudge shown to EXISTING Ollama users after the update that adds
// the bundled engine. They keep working on Ollama by default (nothing
// breaks); this just surfaces the new capability once and lets them choose.
// The caller persists the "offered" flag + the chosen backend.
function EngineMigrationOffer({ open, onKeepOllama, onSwitchToEngine, onDismiss }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onDismiss?.(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        style={{
          width: 440,
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 12,
          padding: "28px 28px 24px",
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <BrandMark size={20} />
          <div style={{ fontFamily: T.sans, fontSize: 15, fontWeight: 600, color: T.fg }}>
            Ekorbia can run models itself now
          </div>
        </div>
        <div style={{ fontFamily: T.sans, fontSize: 13, color: T.fg2, lineHeight: 1.65 }}>
          You're all set up with Ollama, and it'll keep working. Ekorbia can
          now download and run models on its own too — no Ollama needed. Switch
          to the bundled engine, or keep your current setup. You can change
          this any time under <span style={{ color: T.fg }}>Settings → Advanced</span>.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button
            onClick={onKeepOllama}
            style={ekBtn("secondary")}
          >
            Keep Ollama
          </button>
          <button
            className="ek-btn-primary"
            onClick={onSwitchToEngine}
            style={ekBtn("primary")}
          >
            Switch to bundled engine
          </button>
        </div>
      </div>
    </div>
  );
}
