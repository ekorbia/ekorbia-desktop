// overlays.jsx -- Floating overlays:
//   MODEL_COLORS + modelColor, ModelPicker (composer dropdown),
//   CommandPalette (Cmd+K), OllamaGate (warm-up modal).
// Depends on: tokens, atoms, icons. Byte formatting comes from
// utils.js `formatBytes` (formerly a local `fmt_size` here).

const MODEL_COLORS = [
  "#d48a50",
  "#7ea7d8",
  "#9bbf83",
  "#c89bd0",
  "#d8c97e",
  "#83b4bf",
  "#b88f6a",
  "#bf8383",
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
    // Rust-side `ollama_tags` (Phase B.1 proxy) — see ollama.rs for why.
    if (!invoke) { setModels([]); setError("Ollama not running"); return; }
    invoke('ollama_tags')
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
        boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
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
              color: "#1a1008",
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
                  background: "rgba(155,191,131,0.15)",
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
    // Rust-side `ollama_tags` (Phase B.1 proxy) — see ollama.rs for why.
    if (!invoke) { setModels([]); setError("Ollama not running"); return; }
    invoke('ollama_tags')
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
          background: T.bg1,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 8,
          boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
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
          background: T.bg1,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 8,
          boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
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
          background: T.bg1,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 12,
          boxShadow: "0 30px 70px rgba(0,0,0,0.55)",
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
function OllamaGate({ open, modelId, onReady, onDismiss }) {
  // phase: 'checking' | 'not-running' | 'no-model' | 'starting' | 'error'
  const [phase, setPhase] = useState("checking");
  const [errorMsg, setErrorMsg] = useState("");
  const pollRef = useRef(null);
  const pollCount = useRef(0);
  // Shared by checkOllama() and startOllama() below.
  const invoke = getInvoke();

  const stopPolling = () => {
    clearInterval(pollRef.current);
    pollRef.current = null;
  };

  const checkOllama = async () => {
    if (!invoke) return "not-running";
    try {
      // Rust-side `ollama_tags` (Phase B.1 proxy). The IPC throw on
      // failure replaces the previous `!resp.ok` + catch combo.
      const data = await invoke('ollama_tags');
      const names = (data.models || []).map((m) => m.name);
      const found = names.some(
        (n) => n === modelId || n.startsWith(modelId.split(":")[0]),
      );
      return found ? "ready" : "no-model";
    } catch {
      return "not-running";
    }
  };

  // Run initial check whenever the modal opens
  useEffect(() => {
    if (!open) return;
    setPhase("checking");
    setErrorMsg("");
    checkOllama().then((result) => {
      if (result === "ready") {
        onReady();
      } else setPhase(result);
    });
    return stopPolling;
  }, [open, modelId]);

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
    // Confirm the model is available now that Ollama is up.
    const result = await checkOllama();
    if (result === "ready") onReady();
    else setPhase(result);
  };

  if (!open || phase === "checking") return null;

  const titles = {
    "not-running": "Ollama is not running",
    "no-model": "Model not found",
    starting: "Starting Ollama…",
    error: "Failed to start Ollama",
  };

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
          background: T.bg1,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 12,
          padding: "28px 28px 24px",
          boxShadow: "0 40px 80px rgba(0,0,0,0.6)",
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
              {modelId}
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
          </div>
        )}
        {phase === "no-model" && (
          <>
            <div
              style={{
                fontFamily: T.sans,
                fontSize: 13,
                color: T.fg2,
                lineHeight: 1.6,
              }}
            >
              Ollama is running but{" "}
              <code style={{ fontFamily: T.mono, color: T.amber }}>
                {modelId}
              </code>{" "}
              isn't pulled yet. Run this in your terminal:
            </div>
            <div
              style={{
                background: T.bg2,
                border: `1px solid ${T.border}`,
                borderRadius: 6,
                padding: "8px 12px",
                fontFamily: T.mono,
                fontSize: 12,
                color: T.amber,
              }}
            >
              ollama pull {modelId}
            </div>
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
              color: "#e07070",
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
                onClick={startOllama}
                style={{
                  padding: "7px 16px",
                  borderRadius: 6,
                  border: "none",
                  background: T.amber,
                  color: "#1a1008",
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
          {phase === "no-model" && (
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
                Continue anyway
              </button>
              <button
                onClick={() => {
                  // Hand off to the in-app model manager; dismiss the gate
                  // so the two modals don't stack.
                  onDismiss();
                  window.ekOpenModelManager?.();
                }}
                style={{
                  padding: "7px 16px",
                  borderRadius: 6,
                  border: "none",
                  background: T.amber,
                  color: "#1a1008",
                  fontFamily: T.sans,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Download a model…
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
