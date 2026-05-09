// toast.jsx -- Global ToastHost (window.ekToast) + StaleEmbeddingsBanner.
// Depends on: tokens, atoms, icons.

// Toast lifetimes, keyed by `kind`. `success` is short — the result is
// already on screen (e.g. the exported file lands on disk before the toast
// even appears). `error` is long so the user has time to read the message
// before it auto-dismisses; the X dismiss is always available regardless.
const TOAST_DURATION_MS = { success: 4000, info: 6000, warn: 9000, error: 15000 };

function ToastHost() {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  useEffect(() => {
    // Expose a singleton push function on window so any file (main.jsx,
    // components.jsx, future overlay handoff) can call it without prop-
    // drilling. Returns the toast id so callers can dismiss programmatically.
    window.ekToast = (opts) => {
      const id = ++idRef.current;
      const kind = opts?.kind || "info";
      const t = {
        id,
        kind,
        title: opts?.title || "",
        body: opts?.body || "",
        action: opts?.action || null,
      };
      setToasts((ts) => [...ts, t]);
      const ttl = TOAST_DURATION_MS[kind] ?? TOAST_DURATION_MS.info;
      setTimeout(() => {
        setToasts((ts) => ts.filter((x) => x.id !== id));
      }, ttl);
      return id;
    };
    return () => { delete window.ekToast; };
  }, []);

  const dismiss = (id) => setToasts((ts) => ts.filter((t) => t.id !== id));

  if (toasts.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 380,
        pointerEvents: "none", // children opt in — gap stays click-through
      }}
    >
      {toasts.map((t) => {
        // Accent strip color: red on error, amber on warn, green on
        // success, neutral fg2 on info / unknown. `success` shares the
        // green from the watch / file-saved chips so the visual
        // vocabulary stays consistent.
        const accent =
          t.kind === "error"
            ? T.red
            : t.kind === "warn"
              ? T.amber
              : t.kind === "success"
                ? T.green
                : T.fg2;
        return (
          <div
            key={t.id}
            style={{
              pointerEvents: "auto",
              background: T.bg1,
              border: `1px solid ${T.borderStrong}`,
              borderLeft: `3px solid ${accent}`,
              borderRadius: 6,
              padding: "10px 12px",
              boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontFamily: T.sans,
              fontSize: 12,
              color: T.fg,
              animation: "ek-toast-in 0.18s ease-out",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <div style={{ flex: 1 }}>
                {t.title && (
                  <div style={{ fontWeight: 600, marginBottom: t.body ? 2 : 0 }}>
                    {t.title}
                  </div>
                )}
                {t.body && (
                  <div
                    style={{
                      fontFamily: t.body.includes("ollama ") ? T.mono : T.sans,
                      fontSize: 11.5,
                      color: T.fg2,
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {t.body}
                  </div>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                style={{
                  background: "none",
                  border: "none",
                  color: T.fg3,
                  cursor: "pointer",
                  padding: 0,
                  marginLeft: 4,
                  display: "inline-flex",
                }}
              >
                <I.X size={10} />
              </button>
            </div>
            {t.action && (
              <button
                onClick={() => { t.action.onClick?.(); dismiss(t.id); }}
                style={{
                  alignSelf: "flex-start",
                  marginTop: 4,
                  padding: "3px 10px",
                  background: accent,
                  border: "none",
                  borderRadius: 4,
                  color: T.bg0,
                  cursor: "pointer",
                  fontFamily: T.mono,
                  fontSize: 10.5,
                  fontWeight: 600,
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Banner shown above the chat when the configured embedding model differs
// from what existing chunks were embedded with. Retrieval filters by the
// current model so stale chunks are invisible until reindexed — the banner
// surfaces that and offers a one-click re-index across all affected
// attachments. Dismissible (state lives in main.jsx); the dismiss is
// session-only since the underlying staleness doesn't go away on its own.
function StaleEmbeddingsBanner({ count, model, onReindex, onDismiss, busy }) {
  if (!count) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 14px",
        background: T.amber + "15",
        borderBottom: `1px solid ${T.amber + "55"}`,
        fontFamily: T.sans,
        fontSize: 12,
        color: T.fg,
      }}
    >
      <span style={{ color: T.amber, fontSize: 14 }}>⚠</span>
      <span style={{ flex: 1, lineHeight: 1.45 }}>
        {count} attachment{count === 1 ? "" : "s"} {count === 1 ? "was" : "were"}{" "}
        embedded with a different model. Re-index{" "}
        {count === 1 ? "it" : "them"} with{" "}
        <span style={{ fontFamily: T.mono, color: T.amber }}>{model || "the current model"}</span>{" "}
        to make them searchable again.
      </span>
      <button
        onClick={onReindex}
        disabled={busy}
        style={{
          padding: "4px 10px",
          background: busy ? T.bg3 : T.amber,
          border: "none",
          borderRadius: 4,
          color: busy ? T.fg3 : T.bg0,
          cursor: busy ? "default" : "pointer",
          fontFamily: T.mono,
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {busy ? "Queuing…" : `Re-index ${count}`}
      </button>
      <button
        onClick={onDismiss}
        title="Dismiss (banner will reappear next launch if anything is still stale)"
        style={{
          background: "none",
          border: "none",
          color: T.fg3,
          cursor: "pointer",
          padding: 0,
          display: "inline-flex",
        }}
      >
        <I.X size={11} />
      </button>
    </div>
  );
}
