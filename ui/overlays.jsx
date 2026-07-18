// overlays.jsx -- Floating overlays:
//   MODEL_COLORS + modelColor, ModelPicker (composer dropdown),
//   CommandPalette (Cmd+K), OllamaGate (warm-up modal).
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

function ModelPicker({ active, onPick, onClose }) {
  const [models, setModels] = useState(null); // null = loading
  const [error, setError] = useState("");
  const invoke = getInvoke();

  useEffect(() => {
    // Rust-side `llm_list_models` (Phase B.1 proxy) — see ollama.rs for why.
    if (!invoke) { setModels([]); setError("Ollama not running"); return; }
    invoke('llm_list_models')
      .then((data) => {
        // Sort alphabetically by name. /api/tags returns modified_at DESC
        // which is unstable across launches and surprising in a picker
        // (the active model's relative position would shift just from
        // re-pulling it). localeCompare gives a deterministic, case-
        // insensitive order.
        const sorted = (data.models || []).slice().sort((a, b) =>
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
  }, []);

  useEffect(() => {
    const onClick = (e) => {
      if (!e.target.closest("[data-model-picker]")) onClose();
    };
    setTimeout(() => document.addEventListener("click", onClick), 0);
    return () => document.removeEventListener("click", onClick);
  }, [onClose]);

  return (
    <div
      data-model-picker
      style={{
        position: "absolute",
        bottom: "calc(100% + 6px)",
        right: 0,
        width: 340,
        background: T.bg1,
        border: `1px solid ${T.borderStrong}`,
        borderRadius: 6,
        boxShadow: T.shadowPop,
        padding: 4,
        zIndex: 100,
        maxHeight: 360,
        overflowY: "auto",
      }}
    >
      <div
        style={{
          padding: "6px 10px 4px",
          fontFamily: T.mono,
          fontSize: 10,
          color: T.fg3,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        Local models · ollama
      </div>

      {models === null && (
        <div
          style={{
            padding: "12px 10px",
            fontFamily: T.mono,
            fontSize: 11,
            color: T.fg3,
          }}
        >
          <span className="typing-dot">●</span>{" "}
          <span className="typing-dot">●</span>{" "}
          <span className="typing-dot">●</span>
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "10px",
            fontFamily: T.mono,
            fontSize: 11,
            color: T.fg3,
          }}
        >
          {error}
        </div>
      )}

      {models && models.length === 0 && !error && (
        <div style={{ padding: "10px" }}>
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.fg3, marginBottom: 8 }}>
            No models pulled yet.
          </div>
          <button
            onClick={() => {
              window.ekOpenModelManager?.();
              onClose();
            }}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "none",
              background: T.amber,
              boxShadow: `0 5px 16px -6px ${T.amber}66, inset 0 1px 0 rgba(255,255,255,0.25)`,
              color: T.bg0,
              fontFamily: T.sans,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Download a model…
          </button>
        </div>
      )}

      {(models || []).map((m) => {
        const isActive = m.name === active;
        const color = modelColor(m.name);
        const size = m.details?.parameter_size || "";
        const quant = m.details?.quantization_level || "";
        const sizeOnDisk = formatBytes(m.size);
        return (
          <div
            key={m.name}
            onClick={() => {
              onPick(m.name);
              onClose();
            }}
            style={{
              padding: "7px 10px",
              borderRadius: 4,
              cursor: "pointer",
              background: isActive ? T.bg4 : "transparent",
              display: "grid",
              gridTemplateColumns: "auto 1fr auto",
              gap: 8,
              alignItems: "center",
            }}
            onMouseEnter={(e) =>
              !isActive && (e.currentTarget.style.background = T.bg3)
            }
            onMouseLeave={(e) =>
              !isActive && (e.currentTarget.style.background = "transparent")
            }
          >
            <ModelDot color={color} size={7} />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontFamily: T.sans,
                    fontSize: 12.5,
                    color: T.fg,
                    fontWeight: 500,
                  }}
                >
                  {m.name}
                </span>
                {size && (
                  <span
                    style={{ fontFamily: T.mono, fontSize: 10, color: T.fg2 }}
                  >
                    {size}
                  </span>
                )}
                {quant && (
                  <span
                    style={{ fontFamily: T.mono, fontSize: 9.5, color: T.fg3 }}
                  >
                    {quant}
                  </span>
                )}
              </div>
              {sizeOnDisk && (
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 10,
                    color: T.fg3,
                    marginTop: 1,
                  }}
                >
                  {sizeOnDisk} on disk
                </div>
              )}
            </div>
            {isActive && (
              <span
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  padding: "1px 5px",
                  borderRadius: 3,
                  background: T.green + "26",
                  color: T.green,
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                }}
              >
                active
              </span>
            )}
          </div>
        );
      })}

      {models && models.length > 0 && (
        <div
          onClick={() => {
            window.ekOpenModelManager?.();
            onClose();
          }}
          style={{
            padding: "7px 10px",
            marginTop: 4,
            borderTop: `1px solid ${T.border}`,
            borderRadius: 4,
            cursor: "pointer",
            fontFamily: T.sans,
            fontSize: 12,
            color: T.fg2,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = T.bg3)}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          Manage models…
        </div>
      )}
    </div>
  );
}
// Centered modal for picking the 2 or 3 models that will populate a
// compare-mode tab's columns. Distinct from ModelPicker (popover, single-
// select). Lifecycle: parent passes `open` to mount it; on `Done` the modal
// calls `onConfirm(selected)` with a 2- or 3-entry string array of model
// ids; on Cancel/backdrop click it calls `onClose()`. The compose-mode
// column-count cap (2 or 3) is enforced inside this component: a Done
// click outside that range is disabled.
function CompareModelPickerModal({ open, onClose, onConfirm }) {
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
        // Same alphabetical sort as the single-model ModelPicker so
        // both pickers feel consistent. Embed models (nomic-embed-text
        // etc.) stay in the list — caller may want to compare them too.
        const sorted = (data.models || []).slice().sort((a, b) =>
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
          width: 480,
          maxHeight: "70vh",
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 8,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          <div
            style={{
              fontFamily: T.sans,
              fontSize: 13,
              color: T.fg,
              fontWeight: 500,
            }}
          >
            New comparison chat
          </div>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 11,
              color: T.fg3,
              marginTop: 4,
            }}
          >
            Pick 2 or 3 models. Your first message goes to all of them in
            parallel; you pick a winner and the chat continues with that one.
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 4 }}>
          {models === null && (
            <div
              style={{
                padding: "12px 14px",
                fontFamily: T.mono,
                fontSize: 11,
                color: T.fg3,
              }}
            >
              <span className="typing-dot">●</span>{" "}
              <span className="typing-dot">●</span>{" "}
              <span className="typing-dot">●</span>
            </div>
          )}
          {error && (
            <div
              style={{
                padding: "12px 14px",
                fontFamily: T.mono,
                fontSize: 11,
                color: T.fg3,
              }}
            >
              {error}
            </div>
          )}
          {models &&
            models.length === 0 &&
            !error && (
              <div
                style={{
                  padding: "12px 14px",
                  fontFamily: T.mono,
                  fontSize: 11,
                  color: T.fg3,
                }}
              >
                No models pulled yet.
              </div>
            )}
          {(models || []).map((m) => {
            const isChecked = selected.has(m.name);
            const color = modelColor(m.name);
            const size = m.details?.parameter_size || "";
            const sizeOnDisk = formatBytes(m.size);
            return (
              <label
                key={m.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto auto 1fr auto",
                  gap: 10,
                  alignItems: "center",
                  padding: "7px 12px",
                  borderRadius: 4,
                  cursor: "pointer",
                  background: isChecked ? T.bg4 : "transparent",
                }}
                onMouseEnter={(e) =>
                  !isChecked && (e.currentTarget.style.background = T.bg3)
                }
                onMouseLeave={(e) =>
                  !isChecked &&
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggle(m.name)}
                  aria-label={`Compare with ${m.name}`}
                />
                <ModelDot color={color} size={7} />
                <div style={{ minWidth: 0 }}>
                  <span
                    style={{
                      fontFamily: T.sans,
                      fontSize: 12.5,
                      color: T.fg,
                      fontWeight: 500,
                    }}
                  >
                    {m.name}
                  </span>
                  {size && (
                    <span
                      style={{
                        fontFamily: T.mono,
                        fontSize: 10,
                        color: T.fg2,
                        marginLeft: 6,
                      }}
                    >
                      {size}
                    </span>
                  )}
                </div>
                {sizeOnDisk && (
                  <span
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: T.fg3,
                    }}
                  >
                    {sizeOnDisk}
                  </span>
                )}
              </label>
            );
          })}
        </div>

        <div
          style={{
            padding: "10px 16px",
            borderTop: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            style={{
              flex: 1,
              fontFamily: T.mono,
              fontSize: 11,
              color: canConfirm ? T.fg2 : T.fg3,
            }}
          >
            {selected.size === 0 && "Select 2 or 3 models"}
            {selected.size === 1 && "Pick 1 more"}
            {selected.size === 2 && "2 selected — Done, or add 1 more"}
            {selected.size === 3 && "3 selected"}
          </span>
          <button
            onClick={onClose}
            style={{
              padding: "5px 12px",
              background: "transparent",
              border: `1px solid ${T.border}`,
              borderRadius: 4,
              color: T.fg2,
              fontFamily: T.mono,
              fontSize: 11.5,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            disabled={!canConfirm}
            onClick={() => {
              if (!canConfirm) return;
              onConfirm(Array.from(selected));
            }}
            style={{
              padding: "5px 14px",
              background: canConfirm ? T.bg4 : T.bg2,
              border: `1px solid ${canConfirm ? T.borderStrong : T.border}`,
              borderRadius: 4,
              color: canConfirm ? T.fg : T.fg3,
              fontFamily: T.mono,
              fontSize: 11.5,
              cursor: canConfirm ? "pointer" : "not-allowed",
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function CommandPalette({ open, onClose, chats, onPick }) {
  const [q, setQ] = useState("");
  const inputRef = useRef(null);
  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const flat = useMemo(
    () =>
      chats.flatMap((s) => s.items.map((c) => ({ ...c, section: s.section }))),
    [chats],
  );
  const filtered = q.trim()
    ? flat.filter((c) => c.title.toLowerCase().includes(q.toLowerCase()))
    : flat.slice(0, 8);

  if (!open) return null;
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
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxHeight: "60vh",
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 8,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 14px",
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          <I.Search size={13} style={{ color: T.fg2 }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search chats, prompts, or run a command…"
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              color: T.fg,
              fontFamily: T.sans,
              fontSize: 14,
              padding: 0,
            }}
          />
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>
            esc
          </span>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 6, minHeight: 0 }}>
          {filtered.map((c, i) => {
            const m = MODELS_BY_ID[c.model];
            return (
              <div
                key={c.id}
                onClick={() => {
                  onPick(c);
                  onClose();
                }}
                style={{
                  padding: "7px 10px",
                  borderRadius: 5,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: i === 0 ? T.bg3 : "transparent",
                }}
              >
                <ModelDot color={m?.color} size={6} glow={false} />
                <span
                  style={{
                    flex: 1,
                    fontFamily: T.sans,
                    fontSize: 13,
                    color: T.fg,
                  }}
                >
                  {c.title}
                </span>
                <span
                  style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3 }}
                >
                  {c.section}
                </span>
              </div>
            );
          })}
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
            style={{
              height: 28,
              padding: "0 14px",
              background: T.bg2,
              border: `1px solid ${T.border}`,
              borderRadius: 6,
              color: T.fg,
              fontFamily: T.sans,
              fontSize: 12,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {cancelText}
          </button>
          <button
            onClick={() => { if (!busy) onConfirm?.(); }}
            disabled={busy}
            style={{
              height: 28,
              padding: "0 14px",
              background: T.red,
              border: `1px solid ${T.red}`,
              borderRadius: 6,
              color: "#fff",
              fontFamily: T.sans,
              fontSize: 12,
              fontWeight: 600,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.7 : 1,
            }}
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
                fontFamily: T.mono,
                fontSize: 11,
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
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.fg3 }}>{rec.approx}</span>
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
                    fontFamily: T.mono,
                    fontSize: 12,
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
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg2 }}>
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
              fontFamily: T.mono,
              fontSize: 11.5,
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
                style={{
                  padding: "7px 16px",
                  borderRadius: 6,
                  border: `1px solid ${T.border}`,
                  background: "transparent",
                  color: T.fg2,
                  fontFamily: T.sans,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Continue without Ollama
              </button>
              <button
                className="ek-btn-primary"
                onClick={startOllama}
                style={{
                  padding: "7px 16px",
                  borderRadius: 6,
                  border: "none",
                  background: T.amber,
                  boxShadow: `0 5px 16px -6px ${T.amber}66, inset 0 1px 0 rgba(255,255,255,0.25)`,
                  color: T.bg0,
                  fontFamily: T.sans,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {phase === "error" ? "Retry" : "Start Ollama"}
              </button>
            </>
          )}
          {phase === "recommend" && (
            <>
              <button
                onClick={onDismiss}
                style={{
                  padding: "7px 14px",
                  borderRadius: 6,
                  border: `1px solid ${T.border}`,
                  background: "transparent",
                  color: T.fg3,
                  fontFamily: T.sans,
                  fontSize: 12.5,
                  cursor: "pointer",
                }}
              >
                Skip for now
              </button>
              <button
                onClick={() => {
                  // Browse/pick a different model in the full manager.
                  onDismiss();
                  window.ekOpenModelManager?.();
                }}
                style={{
                  padding: "7px 14px",
                  borderRadius: 6,
                  border: `1px solid ${T.border}`,
                  background: "transparent",
                  color: T.fg2,
                  fontFamily: T.sans,
                  fontSize: 12.5,
                  cursor: "pointer",
                }}
              >
                Choose a different model
              </button>
              <button
                className="ek-btn-primary"
                onClick={downloadAndSetup}
                style={{
                  padding: "7px 16px",
                  borderRadius: 6,
                  border: "none",
                  background: T.amber,
                  boxShadow: `0 5px 16px -6px ${T.amber}66, inset 0 1px 0 rgba(255,255,255,0.25)`,
                  color: T.bg0,
                  fontFamily: T.sans,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
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
              style={{
                padding: "7px 16px",
                borderRadius: 6,
                border: `1px solid ${T.border}`,
                background: "transparent",
                color: T.fg2,
                fontFamily: T.sans,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
