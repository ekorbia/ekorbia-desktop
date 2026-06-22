// voice.jsx — local push-to-talk voice dictation (Phase 1).
//
//   • VoiceMicButton — the composer mic button. Click to record, click again
//     to stop + transcribe; the text is inserted at the caret. First use with
//     no model installed opens VoiceSetupModal.
//   • VoiceModelPanel — installed/downloadable Whisper models with streamed
//     progress; shared by VoiceSetupModal and the Settings → Voice tab.
//   • Module-scope download store (mirrors model-manager.jsx's pull store) so
//     a download survives the modal closing and any surface can render it.
//
// Whisper models are English-first for Phase 1 (speed); multilingual + a
// language picker land in Phase 2. Audio is captured + transcribed entirely
// on-device — see src-tauri/src/voice.rs. Depends on: tokens (T), icons (I),
// utils.js (getInvoke, getChannel, genId, formatBytes, voiceModelProgress,
// formatClock), toast.jsx (window.ekToast).

// Curated English models (Phase 1). `approx` is the download size, shown to
// set expectations. base.en is the recommended default — the Phase 0 spike
// measured ~150 ms for 11 s of audio on an M1 Max with near-perfect accuracy.
const VOICE_MODELS = [
  {
    name: "base.en",
    approx: "142 MB",
    blurb: "Recommended — fast and accurate (English)",
    recommended: true,
  },
  { name: "tiny.en", approx: "75 MB", blurb: "Fastest, lowest memory (English)" },
  { name: "small.en", approx: "466 MB", blurb: "Most accurate; a little slower (English)" },
];

const VOICE_MODEL_KEY = "ekorbia.voice.model";

// Selected dictation model (the Whisper model — independent of the chat
// model). Function declarations so other scripts can read/write the choice.
function getVoiceModel() {
  try {
    return localStorage.getItem(VOICE_MODEL_KEY) || "base.en";
  } catch (_) {
    return "base.en";
  }
}
function setVoiceModel(name) {
  try {
    localStorage.setItem(VOICE_MODEL_KEY, name);
  } catch (_) {
    /* private mode / storage disabled — fall back to the default */
  }
}

// ── Download store (module scope; read cross-script via hoisted functions) ───

const EK_VOICE_DLS = new Map(); // name -> progress state ({...voiceModelProgress, name, requestId})
const EK_VOICE_DL_LISTENERS = new Set();
const EK_VOICE_DL_PROMISES = new Map(); // name -> in-flight promise

function ekVoiceDlNotify() {
  EK_VOICE_DL_LISTENERS.forEach((fn) => {
    try {
      fn();
    } catch (_) {
      /* a broken listener must not stall downloads */
    }
  });
}

function ekVoiceDownloadsSubscribe(fn) {
  EK_VOICE_DL_LISTENERS.add(fn);
  return () => EK_VOICE_DL_LISTENERS.delete(fn);
}

function ekGetVoiceDownload(name) {
  return EK_VOICE_DLS.get(name) || null;
}

function ekVoiceCancelDownload(name) {
  const cur = EK_VOICE_DLS.get(name);
  const invoke = getInvoke();
  if (!cur || !invoke) return;
  invoke("voice_model_download_cancel", { requestId: cur.requestId }).catch(() => {});
}

// Start downloading a Whisper model. Resolves { ok, error }. Mirrors
// ekPullModel in model-manager.jsx (single in-flight per model; survives
// modal close).
async function ekVoiceDownload(name) {
  const invoke = getInvoke();
  name = (name || "").trim();
  if (!invoke || !name) return { ok: false, error: "Voice models unavailable" };
  if (EK_VOICE_DL_PROMISES.has(name)) return EK_VOICE_DL_PROMISES.get(name);

  const requestId = `voicedl:${name}:${genId()}`;
  const seed = voiceModelProgress(null);
  seed.name = name;
  seed.requestId = requestId;
  EK_VOICE_DLS.set(name, seed);
  ekVoiceDlNotify();

  const Channel = getChannel();
  const ch = Channel ? new Channel() : null;
  if (ch) {
    ch.onmessage = (chunk) => {
      const cur = EK_VOICE_DLS.get(name);
      if (!cur) return;
      const next = voiceModelProgress(chunk);
      next.name = name;
      next.requestId = cur.requestId;
      EK_VOICE_DLS.set(name, next);
      ekVoiceDlNotify();
    };
  }

  const run = (async () => {
    try {
      await invoke("voice_model_download", { name, requestId, onProgress: ch });
      const last = EK_VOICE_DLS.get(name);
      if (last && last.error) {
        window.ekToast?.({ kind: "error", title: `Couldn't download ${name}`, body: last.error });
        return { ok: false, error: last.error };
      }
      if (!last || !last.done) {
        return { ok: false, error: "Download didn't complete (cancelled or interrupted)" };
      }
      window.ekToast?.({ kind: "success", title: `Voice model ${name} ready` });
      return { ok: true, error: null };
    } catch (e) {
      window.ekToast?.({ kind: "error", title: `Couldn't download ${name}`, body: String(e) });
      return { ok: false, error: String(e) };
    } finally {
      EK_VOICE_DLS.delete(name);
      EK_VOICE_DL_PROMISES.delete(name);
      ekVoiceDlNotify();
    }
  })();
  EK_VOICE_DL_PROMISES.set(name, run);
  return run;
}

// ── Model panel (shared by setup modal + Settings → Voice) ───────────────────

function VoiceModelPanel({ compact }) {
  const [installed, setInstalled] = useState(null); // null = loading
  const [selected, setSelected] = useState(getVoiceModel());
  const [, setTick] = useState(0); // bumped on download progress
  const prevDownloadingRef = useRef(new Set());
  const invoke = getInvoke();

  const refreshInstalled = () => {
    if (!invoke) {
      setInstalled([]);
      return;
    }
    invoke("voice_models_installed")
      .then((list) => setInstalled(Array.isArray(list) ? list : []))
      .catch(() => setInstalled([]));
  };

  useEffect(() => {
    refreshInstalled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render on download progress; refresh the installed list whenever a
  // download leaves the store (finished or cancelled).
  useEffect(() => {
    return ekVoiceDownloadsSubscribe(() => {
      const now = new Set(EK_VOICE_DLS.keys());
      const prev = prevDownloadingRef.current;
      let finished = false;
      prev.forEach((n) => {
        if (!now.has(n)) finished = true;
      });
      prevDownloadingRef.current = now;
      setTick((t) => t + 1);
      if (finished) refreshInstalled();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installedSet = new Set(installed || []);
  const pickDefault = (name) => {
    setVoiceModel(name);
    setSelected(name);
  };

  const doDelete = async (name) => {
    if (!invoke) return;
    try {
      await invoke("voice_model_delete", { name });
      window.ekToast?.({ kind: "success", title: `Removed ${name}` });
    } catch (e) {
      window.ekToast?.({ kind: "error", title: `Couldn't remove ${name}`, body: String(e) });
    }
    refreshInstalled();
  };

  return (
    <div data-voice-panel style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {VOICE_MODELS.map((m) => {
        const isInstalled = installedSet.has(m.name);
        const dl = ekGetVoiceDownload(m.name);
        const isDefault = selected === m.name;
        return (
          <div
            key={m.name}
            data-voice-model={m.name}
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr auto",
              gap: 8,
              alignItems: "center",
              padding: "7px 8px",
              borderRadius: 5,
              background: isDefault && isInstalled ? T.bg2 : "transparent",
            }}
          >
            <ModelDot color={isInstalled ? T.green : T.fg3} size={7} />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg, fontWeight: 500 }}>
                  {m.name}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>{m.approx}</span>
                {m.recommended && (
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
                    recommended
                  </span>
                )}
                {isDefault && isInstalled && (
                  <span style={{ fontFamily: T.mono, fontSize: 9, color: T.fg3 }}>· default</span>
                )}
              </div>
              <div style={{ fontFamily: T.sans, fontSize: 11.5, color: T.fg2, marginTop: 1 }}>
                {m.blurb}
              </div>
              {dl && (
                <div
                  style={{
                    marginTop: 5,
                    height: 4,
                    borderRadius: 2,
                    background: T.bg3,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: dl.pct !== null ? `${dl.pct}%` : "30%",
                      background: T.amber,
                      borderRadius: 2,
                      transition: "width 200ms linear",
                      animation: dl.pct === null ? "blink 1.1s steps(2) infinite" : "none",
                    }}
                  />
                </div>
              )}
            </div>

            {/* Action column */}
            {dl ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg2 }}>
                  {dl.pct !== null ? `${dl.pct}%` : "…"}
                </span>
                <button onClick={() => ekVoiceCancelDownload(m.name)} style={ghostBtn()}>
                  Cancel
                </button>
              </div>
            ) : isInstalled ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {!isDefault && (
                  <button onClick={() => pickDefault(m.name)} style={ghostBtn()}>
                    Use
                  </button>
                )}
                <button onClick={() => doDelete(m.name)} style={ghostBtn()} title={`Remove ${m.name}`}>
                  Remove
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  ekVoiceDownload(m.name);
                  // First download becomes the default if nothing is set yet.
                  if (!installedSet.size) pickDefault(m.name);
                }}
                style={{
                  padding: "4px 12px",
                  borderRadius: 5,
                  border: "none",
                  background: T.amber,
                  color: "#1a1008",
                  fontFamily: T.sans,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Download
              </button>
            )}
          </div>
        );
      })}

      {!compact && (
        <div style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3, padding: "8px 2px 0", lineHeight: 1.5 }}>
          Models download once from Hugging Face, then run fully offline. Audio is
          transcribed on your machine and never uploaded.
        </div>
      )}
    </div>
  );
}

function ghostBtn() {
  return {
    padding: "3px 10px",
    borderRadius: 4,
    border: `1px solid ${T.border}`,
    background: "transparent",
    color: T.fg2,
    fontFamily: T.sans,
    fontSize: 11.5,
    cursor: "pointer",
  };
}

// ── Setup modal (first-use, when no model is installed) ──────────────────────

function VoiceSetupModal({ open, onClose }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      onClick={() => onClose?.()}
      style={{
        position: "fixed",
        inset: 0,
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
        aria-label="Set up voice input"
        style={{
          width: 440,
          maxHeight: "78vh",
          overflowY: "auto",
          background: T.bg1,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 8,
          boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
          padding: "16px 18px 18px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontFamily: T.serif, fontSize: 17, color: T.fg, flex: 1 }}>
            Set up voice input
          </div>
          <button onClick={() => onClose?.()} aria-label="Close" style={{ border: "none", background: "transparent", color: T.fg3, fontSize: 16, cursor: "pointer", padding: 2 }}>
            ✕
          </button>
        </div>
        <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg2, lineHeight: 1.5, marginBottom: 10 }}>
          Download a speech model to dictate into the composer. Transcription runs
          entirely on your machine.
        </div>
        <VoiceModelPanel />
      </div>
    </div>
  );
}

// Settings → Voice tab body.
function VoiceSettings() {
  return (
    <>
      <div style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3, textTransform: "uppercase", letterSpacing: 0.6, padding: "2px 2px 8px" }}>
        Speech models
      </div>
      <VoiceModelPanel />
    </>
  );
}

// ── Composer mic button ──────────────────────────────────────────────────────
//
// Click to record, click again to stop + transcribe. Escape cancels. The mic
// is pre-warmed on first hover so the first dictation isn't slowed by the
// one-time model load.

function VoiceMicButton({ onInsert, disabled }) {
  const [phase, setPhase] = useState("idle"); // idle | starting | recording | transcribing
  const [elapsed, setElapsed] = useState(0);
  const [hasModel, setHasModel] = useState(true); // optimistic; checked on mount
  const [setupOpen, setSetupOpen] = useState(false);
  const sessionRef = useRef(null);
  const prewarmedRef = useRef(false);
  const invoke = getInvoke();

  const checkModel = () => {
    if (!invoke) {
      setHasModel(false);
      return;
    }
    invoke("voice_models_installed")
      .then((list) => setHasModel(Array.isArray(list) && list.includes(getVoiceModel())))
      .catch(() => setHasModel(false));
  };

  useEffect(() => {
    checkModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recording timer.
  useEffect(() => {
    if (phase !== "recording") return;
    const t0 = Date.now();
    setElapsed(0);
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(iv);
  }, [phase]);

  // Escape cancels an in-progress recording.
  useEffect(() => {
    if (phase !== "recording") return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelRecording();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const prewarm = () => {
    if (prewarmedRef.current || !invoke) return;
    prewarmedRef.current = true;
    invoke("voice_prewarm", { model: getVoiceModel() }).catch(() => {});
  };

  const startRecording = async () => {
    if (!invoke) return;
    const id = `voice:${genId()}`;
    sessionRef.current = id;
    setPhase("starting");
    try {
      await invoke("voice_record_start", { sessionId: id });
      setPhase("recording");
    } catch (e) {
      setPhase("idle");
      sessionRef.current = null;
      window.ekToast?.({
        kind: "error",
        title: "Couldn't start the microphone",
        body: String(e),
      });
    }
  };

  const stopRecording = async () => {
    const id = sessionRef.current;
    if (!invoke || !id) {
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    try {
      const r =
        (await invoke("voice_record_stop", {
          sessionId: id,
          model: getVoiceModel(),
          language: null,
        })) || {};
      if (r.captured && r.text) {
        onInsert?.(r.text);
      } else if (r.captured && !r.text) {
        window.ekToast?.({ kind: "info", title: "Didn't catch any words", body: "Try speaking a little longer." });
      } else {
        window.ekToast?.({
          kind: "warn",
          title: "No audio captured",
          body: "If you just allowed microphone access, click the mic and try again. Otherwise enable Ekorbia under System Settings → Privacy & Security → Microphone.",
        });
      }
    } catch (e) {
      window.ekToast?.({ kind: "error", title: "Transcription failed", body: String(e) });
    } finally {
      setPhase("idle");
      sessionRef.current = null;
    }
  };

  const cancelRecording = () => {
    const id = sessionRef.current;
    if (invoke && id) invoke("voice_record_cancel", { sessionId: id }).catch(() => {});
    sessionRef.current = null;
    setPhase("idle");
  };

  const onClick = () => {
    if (disabled) return;
    if (phase === "recording") {
      stopRecording();
      return;
    }
    if (phase !== "idle") return; // starting / transcribing — ignore
    if (!hasModel) {
      setSetupOpen(true);
      return;
    }
    startRecording();
  };

  const recording = phase === "recording";
  const busy = phase === "starting" || phase === "transcribing";
  const title = recording
    ? "Stop and transcribe (Esc to cancel)"
    : busy
      ? "Working…"
      : hasModel
        ? "Dictate (voice input)"
        : "Set up voice input";

  return (
    <>
      <button
        data-voice-mic
        data-phase={phase}
        onClick={onClick}
        onMouseEnter={prewarm}
        disabled={disabled || busy}
        title={title}
        style={{
          height: 24,
          minWidth: 24,
          padding: recording ? "0 8px" : 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
          background: recording ? "rgba(191,131,131,0.18)" : "transparent",
          border: "none",
          borderRadius: 5,
          cursor: disabled || busy ? "default" : "pointer",
          color: recording ? T.red || "#bf8383" : T.fg2,
          fontFamily: T.mono,
          fontSize: 11,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <I.Mic
          size={13}
          style={{
            opacity: busy ? 0.5 : 1,
            animation: recording ? "blink 1.1s steps(2) infinite" : "none",
          }}
        />
        {recording && <span>{formatClock(elapsed)}</span>}
        {phase === "transcribing" && <span style={{ opacity: 0.7 }}>…</span>}
      </button>
      <VoiceSetupModal
        open={setupOpen}
        onClose={() => {
          setSetupOpen(false);
          checkModel();
        }}
      />
    </>
  );
}
