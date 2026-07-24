// settings.jsx -- Settings surface:
//   Hotkey constants + formatHotkey + hotkeyFromEvent + HotkeyCapture,
//   isEmbeddingModelName, AttachmentsSettings, PromptsFolderRow,
//   SettingsModal (tabbed: General / Prompts / Attachments).
// Depends on: tokens, atoms, icons.

// Per-platform default for the overlay hotkey — must match what Rust's
// setup() registers in lib.rs, otherwise the Settings UI lies about what
// will actually fire when the user presses the combo. On Windows the
// SUPER (Win) key is heavily reserved by the OS for input-method
// switching (Win+Space cycles keyboard layouts), so we fall back to
// Alt+Space — the convention used by PowerToys Run / Raycast Windows /
// ChatGPT Desktop. macOS and Linux keep Cmd/Super+Shift+Space; on Linux
// the Settings row is hidden anyway (overlay deferred to Phase L2).
'use strict';
const HOTKEY_DEFAULT = IS_WIN ? "Alt+Space" : "Super+Shift+Space";
const HOTKEY_LS_KEY = "ekorbia.overlay.hotkey";
// Second slot: screenshot capture hotkey (Phase 5). Default
// Super+Shift+Digit1 — sits next to macOS's own Cmd+Shift+3/4/5 mental
// model but doesn't collide with any system-bound combination.
const SCREENSHOT_HOTKEY_DEFAULT = "Super+Shift+Digit1";
const SCREENSHOT_HOTKEY_LS_KEY = "ekorbia.screenshot.hotkey";
// Third slot: voice-dictation hotkey (Phase 3B). Opens the overlay already
// listening. Default ⌘⇧V / Alt+Shift+V — must mirror the Rust setup() default.
const VOICE_HOTKEY_DEFAULT = IS_WIN ? "Alt+Shift+KeyV" : "Super+Shift+KeyV";
const VOICE_HOTKEY_LS_KEY = "ekorbia.voice.hotkey";

// Hotkey helpers (HOTKEY_MOD_CODES, formatHotkey, hotkeyFromEvent) live in
// `ui/utils.js` so they're unit-testable under node:test. Re-published on
// window before this file loads — references resolve via bare-name lookup.

// Click-to-record button that captures the next keypress with modifiers.
// Calls onChange with the new spec (or onCancel on ⎋); the parent decides
// whether to commit it.
function HotkeyCapture({ value, onChange, onCancel }) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e) => {
      // Capture phase + stopPropagation: keep these events out of the rest
      // of the app (so we don't accidentally trigger composer Enter etc).
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        if (onCancel) onCancel();
        return;
      }
      const spec = hotkeyFromEvent(e);
      if (!spec) return; // bare modifier, or no modifier — keep listening
      setRecording(false);
      onChange(spec);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange, onCancel]);

  return (
    <button
      onClick={() => setRecording(true)}
      style={{
        minWidth: 110,
        height: 26,
        padding: "0 10px",
        background: recording ? T.bg4 : T.bg2,
        border: `1px solid ${recording ? T.amber : T.border}`,
        borderRadius: 6,
        color: recording ? T.amber : T.fg,
        fontFamily: T.mono,
        fontSize: 12,
        cursor: "pointer",
        textAlign: "center",
      }}
    >
      {recording ? "Press shortcut…" : formatHotkey(value)}
    </button>
  );
}

// Label + text input pair used by the WatchModal's add-watch form. Hoisted
// out of WatchModal so its component identity stays stable across the
// parent's re-renders — defining it inside WatchModal causes React to see
// a new component type on every keystroke, which unmounts and remounts
function isEmbeddingModelName(name) {
  if (!name) return false;
  const lc = name.toLowerCase();
  return (
    lc.includes("embed") ||
    lc.startsWith("bge") ||
    lc.startsWith("nomic") ||
    lc.startsWith("mxbai") ||
    lc.startsWith("all-minilm") ||
    lc.startsWith("snowflake-arctic-embed")
  );
}

// Small text input used by the Attachments settings rows. Hoisted out of
// AttachmentsSettings per CLAUDE.md's component-identity gotcha: defining
// it inside the parent gave it a new React component type per render, which
// caused the embedding-model field to LOSE FOCUS on every keystroke as
// React unmounted/remounted the input. Module-scope identity fixes that.
function SettingInput({ value, onChange, onCommit, placeholder, wide }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder={placeholder}
      style={{
        width: wide ? 280 : 140,
        background: T.bg2,
        border: `1px solid ${T.border}`,
        borderRadius: 4,
        color: T.fg,
        fontFamily: T.mono,
        fontSize: 11,
        padding: "3px 6px",
        outline: "none",
      }}
    />
  );
}

function AttachmentsSettings() {
  const invoke = getInvoke();
  const [embedModel, setEmbedModel] = useState("");
  const [topK, setTopK] = useState("");
  const [folderExts, setFolderExts] = useState("");
  const [folderIgnore, setFolderIgnore] = useState("");
  const [modelStatus, setModelStatus] = useState(null);
  const [savingKey, setSavingKey] = useState(null);
  // Pulled-model list from /api/tags, filtered to embedding-like names.
  // Refreshed on mount + every settings change so a fresh `ollama pull` is
  // reflected without restarting the app.
  const [pulledEmbedModels, setPulledEmbedModels] = useState([]);
  const [pickerMode, setPickerMode] = useState("dropdown"); // 'dropdown' | 'custom'

  // Initial load. Each setting_get returns null when unset; map to empty
  // string so the input renders as the placeholder (the Rust-side default).
  useEffect(() => {
    if (!invoke) return;
    (async () => {
      try {
        const m = await invoke("setting_get", { key: "embedding_model" });
        setEmbedModel(m || "");
        const k = await invoke("setting_get", { key: "top_k" });
        setTopK(k || "");
        const e = await invoke("setting_get", { key: "folder_exts" });
        setFolderExts(e || "");
        const ig = await invoke("setting_get", { key: "folder_ignore" });
        setFolderIgnore(ig || "");
      } catch (err) {
        console.error("settings load failed:", err);
      }
    })();
  }, [invoke]);

  // Fetch /api/tags and filter to embedding-capable names. Fast (single
  // local HTTP call); silent on failure — the dropdown just stays empty
  // and the user can switch to custom-input mode.
  const refreshPulledModels = async () => {
    if (!invoke) return;
    try {
      // Routed through Rust `llm_list_models` (see ollama.rs for the
      // WebView2 PNA story). 3s timeout enforced Rust-side; an IPC
      // error here just leaves the dropdown empty — the user can fall
      // back to custom-input mode if needed.
      const data = await invoke("llm_list_models");
      const names = (data.models || [])
        .map((m) => m.name)
        .filter(isEmbeddingModelName)
        .sort();
      setPulledEmbedModels(names);
    } catch {}
  };

  // Probe whether the configured embedding model is installed. Runs on
  // mount and after every model change so the status indicator stays in
  // sync with whatever the user typed.
  const recheckModel = async () => {
    if (!invoke) return;
    try {
      const r = await invoke("llm_embed_model_check");
      setModelStatus(r);
    } catch {
      setModelStatus(null);
    }
  };
  useEffect(() => {
    recheckModel();
    refreshPulledModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the current value doesn't match any pulled model, start in custom
  // mode so the user sees their string verbatim (instead of an empty
  // dropdown with their value floating in space).
  useEffect(() => {
    if (!embedModel) return;
    if (pulledEmbedModels.length === 0) return;
    if (!pulledEmbedModels.includes(embedModel)) {
      setPickerMode("custom");
    }
  }, [pulledEmbedModels, embedModel]);

  const persist = async (key, value) => {
    if (!invoke) return;
    setSavingKey(key);
    try {
      await invoke("setting_set", { key, value });
      if (key === "embedding_model") {
        await recheckModel();
        await refreshPulledModels();
      }
    } catch (e) {
      console.error(`setting_set ${key} failed:`, e);
    } finally {
      setSavingKey(null);
    }
  };

  const ok = modelStatus?.installed === true;
  const checked = modelStatus !== null;

  // When no embedding model is explicitly configured, default the picker to
  // the model actually in use rather than showing "— pick a model —": the
  // Rust-side default surfaced by the install probe (modelStatus.model) when
  // it's pulled, otherwise the first pulled embedding model. Display-only —
  // Rust already falls back to this same default for embedding, and choosing
  // any option still persists via onChange as before.
  const effectiveEmbed = modelStatus?.model;
  const selectedEmbed = pulledEmbedModels.includes(embedModel)
    ? embedModel
    : pulledEmbedModels.includes(effectiveEmbed)
      ? effectiveEmbed
      : pulledEmbedModels[0] || "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <span style={{ fontFamily: T.sans, fontSize: 13, color: T.fg2 }}>Embedding model</span>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {pickerMode === "dropdown" && pulledEmbedModels.length > 0 ? (
            <select
              value={selectedEmbed}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__custom__") {
                  setPickerMode("custom");
                  return;
                }
                setEmbedModel(v);
                persist("embedding_model", v);
              }}
              style={{
                width: 180,
                background: T.bg2,
                border: `1px solid ${T.border}`,
                borderRadius: 4,
                color: T.fg,
                fontFamily: T.mono,
                fontSize: 11,
                padding: "3px 6px",
                outline: "none",
                cursor: "pointer",
              }}
            >
              {!selectedEmbed && <option value="">— pick a model —</option>}
              {pulledEmbedModels.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
              <option value="__custom__">Other (type a name)…</option>
            </select>
          ) : (
            // Custom-input fallback. Used when no embedding-like models
            // are pulled, or the user picked "Other…", or the persisted
            // value doesn't match any installed model. Round-trip back to
            // dropdown via the small switch link below.
            <SettingInput
              value={embedModel}
              onChange={setEmbedModel}
              onCommit={() => persist("embedding_model", embedModel)}
              placeholder="e.g. nomic-embed-text"
            />
          )}
          {checked && (
            <span
              title={ok ? `${modelStatus.model} pulled` : `Not installed — run: ollama pull ${modelStatus.model}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                color: ok ? (T.green) : (T.red),
                fontFamily: T.mono,
                fontSize: 10,
              }}
            >
              ● {ok ? "pulled" : "not pulled"}
            </span>
          )}
        </div>
      </div>
      {pickerMode === "custom" && pulledEmbedModels.length > 0 && (
        <div style={{ textAlign: "right", marginTop: -4 }}>
          <button
            onClick={() => setPickerMode("dropdown")}
            style={{
              background: "none",
              border: "none",
              color: T.fg3,
              cursor: "pointer",
              fontFamily: T.mono,
              fontSize: 9.5,
              padding: 0,
              textDecoration: "underline",
            }}
          >
            ← pick from installed models
          </button>
        </div>
      )}
      {!ok && checked && (
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9.5,
            color: T.fg3,
            textAlign: "right",
            marginTop: -4,
          }}
        >
          Run: <span style={{ color: T.amber }}>ollama pull {modelStatus.model}</span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <span style={{ fontFamily: T.sans, fontSize: 13, color: T.fg2 }}>Top-k chunks per query</span>
        <SettingInput
          value={topK}
          onChange={setTopK}
          onCommit={() => persist("top_k", topK)}
        />
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.fg3, textAlign: "right", marginTop: -4 }}>
        Defaults to 6
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <span style={{ fontFamily: T.sans, fontSize: 13, color: T.fg2 }}>Folder file types</span>
        <SettingInput
          wide
          value={folderExts}
          onChange={setFolderExts}
          onCommit={() => persist("folder_exts", folderExts)}
        />
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.fg3, textAlign: "right", marginTop: -4 }}>
        Defaults to md, markdown, txt, pdf
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <span style={{ fontFamily: T.sans, fontSize: 13, color: T.fg2 }}>Folder ignore dirs</span>
        <SettingInput
          wide
          value={folderIgnore}
          onChange={setFolderIgnore}
          onCommit={() => persist("folder_ignore", folderIgnore)}
        />
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.fg3, textAlign: "right", marginTop: -4 }}>
        Defaults to .git, node_modules, target, …
      </div>
      {savingKey && (
        <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.fg3, textAlign: "right" }}>
          saving…
        </div>
      )}
    </div>
  );
}

function PromptsFolderRow({ onPromptsChanged }) {
  const invoke = getInvoke();
  const dialogApi = getDialogApi();
  const [path, setPath] = useState("");
  const [status, setStatus] = useState(null);

  // Initial path fetch. Done in an effect so the modal can open instantly;
  // the row briefly shows blank until Rust answers (which is essentially
  // immediate — a single SQLite read).
  useEffect(() => {
    if (!invoke) return;
    invoke("prompts_dir_get").then(setPath).catch(console.error);
  }, [invoke]);

  const applyPath = async (next) => {
    if (!invoke || !next) return;
    try {
      await invoke("prompts_dir_set", { path: next });
      setPath(next);
      setStatus({ ok: true, msg: "Folder updated. Reloading prompts…" });
      if (onPromptsChanged) await onPromptsChanged();
    } catch (e) {
      setStatus({ ok: false, msg: String(e) });
    }
  };

  const browse = async () => {
    if (!dialogApi) return;
    try {
      const picked = await dialogApi.open({
        directory: true,
        multiple: false,
        title: "Choose Prompts Folder",
      });
      if (picked) await applyPath(typeof picked === "string" ? picked : picked.path);
    } catch (e) {
      setStatus({ ok: false, msg: String(e) });
    }
  };

  // Native opener via the prompts_dir_reveal Tauri command — NOT
  // tauri-plugin-shell.open. The shell plugin's default capability scope
  // rejects bare filesystem paths (only allows mailto/tel/http URLs), so
  // the old shellApi.open(path) silently no-op'd. The Rust command re-
  // resolves the prompts dir itself so the caller has no path to pass.
  const reveal = async () => {
    if (!invoke) return;
    try {
      await invoke("prompts_dir_reveal");
    } catch (e) {
      console.error("prompts_dir_reveal failed:", e);
      window.ekToast?.({
        kind: "warn",
        title: "Could not reveal prompts folder",
        body: String(e),
      });
    }
  };

  // Reset to default works by clearing the override; Rust falls back to
  // ~/Documents/Ekorbia/Prompts and we just re-read the resolved path.
  const resetDefault = async () => {
    if (!invoke) return;
    try {
      await invoke("prompts_dir_set", { path: "" });
      const fresh = await invoke("prompts_dir_get");
      setPath(fresh);
      setStatus({ ok: true, msg: "Reset to default." });
      if (onPromptsChanged) await onPromptsChanged();
    } catch (e) {
      setStatus({ ok: false, msg: String(e) });
    }
  };

  const restoreBuiltins = async () => {
    if (!invoke) return;
    try {
      const n = await invoke("prompts_restore_builtins");
      setStatus({ ok: true, msg: `Restored ${n} built-in prompt${n === 1 ? "" : "s"}.` });
      if (onPromptsChanged) await onPromptsChanged();
    } catch (e) {
      setStatus({ ok: false, msg: String(e) });
    }
  };

  const Btn = ({ children, onClick, title }) => (
    <button
      onClick={onClick}
      title={title}
      style={{
        height: 22,
        padding: "0 8px",
        background: T.bg2,
        border: `1px solid ${T.border}`,
        borderRadius: 4,
        color: T.fg2,
        fontFamily: T.mono,
        fontSize: 10.5,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 10.5,
          color: T.fg2,
          background: T.bg2,
          border: `1px solid ${T.border}`,
          borderRadius: 4,
          padding: "5px 8px",
          // Prompts dirs deep in the home tree wrap onto multiple lines; let
          // them break mid-word so the modal doesn't blow out horizontally.
          wordBreak: "break-all",
        }}
        title={path}
      >
        {path || "—"}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Btn onClick={browse} title="Pick a different folder">Browse…</Btn>
        <Btn onClick={reveal} title="Open this folder in Finder">Reveal</Btn>
        <Btn onClick={resetDefault} title="Reset to ~/Documents/Ekorbia/Prompts">Reset</Btn>
        <Btn
          onClick={restoreBuiltins}
          title="Re-copy the built-in prompts (overwrites local edits to built-ins)"
        >
          Restore built-ins
        </Btn>
      </div>
      {status && (
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 10,
            color: status.ok ? T.fg2 : T.red,
          }}
        >
          {status.msg}
        </div>
      )}
    </div>
  );
}

// Memory-file settings UI (Phase 4a). Shows the current path + size,
// lets the user pick a different file via the OS dialog or reset to the
// default, and exposes an "Edit memory" button that opens the file in
// the OS default text editor (creating it with a small template if it
// doesn't exist yet).
function MemorySettings() {
  const invoke = getInvoke();
  const dialogApi = getDialogApi();
  const [info, setInfo] = useState(null); // { path, exists, bytes, oversized, unresolvable }
  const [status, setStatus] = useState(null);

  const refresh = async () => {
    if (!invoke) return;
    try {
      const next = await invoke("memory_info");
      setInfo(next);
    } catch (e) {
      console.error("memory_info failed:", e);
    }
  };
  useEffect(() => { refresh(); }, []);

  const browse = async () => {
    if (!dialogApi) return;
    try {
      // `save` returns a path the file *should* live at. Doesn't have to
      // exist yet — memory_open creates it on first edit if needed.
      const picked = await dialogApi.save({
        title: "Choose memory file",
        defaultPath: info?.path || undefined,
        filters: [
          { name: "Markdown", extensions: ["md", "markdown"] },
          { name: "Text", extensions: ["txt"] },
        ],
      });
      if (!picked) return;
      await invoke("memory_set_path", { path: picked });
      setStatus({ ok: true, msg: "Memory file path updated." });
      await refresh();
    } catch (e) {
      setStatus({ ok: false, msg: String(e) });
    }
  };

  const resetDefault = async () => {
    if (!invoke) return;
    try {
      // Empty string clears the override; current_memory_path() falls
      // back to ~/Documents/Ekorbia/memory.md.
      await invoke("memory_set_path", { path: "" });
      setStatus({ ok: true, msg: "Reset to default." });
      await refresh();
    } catch (e) {
      setStatus({ ok: false, msg: String(e) });
    }
  };

  const edit = async () => {
    if (!invoke) return;
    try {
      await invoke("memory_open");
      // Refresh after a short delay so size updates land in the UI
      // once the user has finished editing externally. We can't watch
      // the file for changes in v1, so this is "best-effort" — the
      // info refreshes on next Settings open anyway.
      setStatus({ ok: true, msg: "Opened in your default editor." });
      setTimeout(refresh, 1500);
    } catch (e) {
      setStatus({ ok: false, msg: String(e) });
    }
  };

  const fmtBytes = (n) => {
    if (n === 0) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  };

  // Local Btn (the one in PromptsFolderRow is scoped to its component and
  // doesn't expose `disabled`). Same visual style so the two settings
  // rows feel uniform. Disabled buttons drop interactivity + dim — still
  // visible so the user can tell what they *would* do if available.
  const Btn = ({ children, onClick, title, disabled }) => (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={!!disabled}
      style={{
        height: 22,
        padding: "0 8px",
        background: T.bg2,
        border: `1px solid ${T.border}`,
        borderRadius: 4,
        color: disabled ? T.fg3 : T.fg2,
        fontFamily: T.mono,
        fontSize: 10.5,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          background: T.bg2,
          border: `1px solid ${T.border}`,
          borderRadius: 6,
          fontFamily: T.mono,
          fontSize: 11,
          color: T.fg2,
          minHeight: 24,
        }}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {info?.path || "…"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Btn onClick={edit} disabled={!invoke || info?.unresolvable}>
          {info?.exists ? "Edit memory" : "Create & edit"}
        </Btn>
        <Btn onClick={browse} disabled={!dialogApi}>Choose file…</Btn>
        <Btn onClick={resetDefault} disabled={!invoke}>Reset to default</Btn>
        <span style={{ flex: 1 }} />
        {info && (
          <span
            style={{
              fontFamily: T.mono,
              fontSize: 10.5,
              color: info.oversized ? T.amber : T.fg3,
            }}
          >
            {info.exists ? fmtBytes(info.bytes) : "not yet created"}
          </span>
        )}
      </div>
      {info?.unresolvable && (
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 10,
            color: T.red,
            lineHeight: 1.5,
          }}
        >
          Could not resolve a default path. Use "Choose file…" to pick one
          manually.
        </div>
      )}
      {info?.oversized && (
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 10,
            color: T.amber,
            lineHeight: 1.5,
          }}
        >
          Memory is over 10 KB — it'll be added to the prompt on every send,
          which costs tokens. Trim if you can.
        </div>
      )}
      {status && (
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 10,
            color: status.ok ? T.fg2 : T.red,
          }}
        >
          {status.msg}
        </div>
      )}
    </div>
  );
}

function SettingsModal({ tweaks, setTweak, onPromptsChanged, chatCount = 0, onClearAllChats }) {
  const [open, setOpen] = useState(false);
  // Danger-zone state. Confirm modal sits above the settings modal at
  // zIndex 9999 (settings is 9998), so opening it while settings is up
  // is safe — the settings backdrop stays behind it.
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  // Hotkey lives in its own localStorage key (not in tweaks) because it has
  // out-of-band Rust plumbing — saving a value requires an IPC round-trip
  // that can fail, so it doesn't fit the simple key/value tweaks model.
  const [hotkey, setHotkey] = useState(() => {
    try {
      return localStorage.getItem(HOTKEY_LS_KEY) || HOTKEY_DEFAULT;
    } catch {
      return HOTKEY_DEFAULT;
    }
  });
  const [hotkeyError, setHotkeyError] = useState(null);
  // Screenshot hotkey (Phase 5) — same persistence pattern as the overlay
  // hotkey, separate localStorage slot so they don't collide.
  const [screenshotHotkey, setScreenshotHotkey] = useState(() => {
    try {
      return localStorage.getItem(SCREENSHOT_HOTKEY_LS_KEY) || SCREENSHOT_HOTKEY_DEFAULT;
    } catch {
      return SCREENSHOT_HOTKEY_DEFAULT;
    }
  });
  const [screenshotHotkeyError, setScreenshotHotkeyError] = useState(null);
  // Voice-dictation hotkey (Phase 3B) — same persistence pattern, own slot.
  const [voiceHotkey, setVoiceHotkey] = useState(() => {
    try {
      return localStorage.getItem(VOICE_HOTKEY_LS_KEY) || VOICE_HOTKEY_DEFAULT;
    } catch {
      return VOICE_HOTKEY_DEFAULT;
    }
  });
  const [voiceHotkeyError, setVoiceHotkeyError] = useState(null);
  const [activeTab, setActiveTab] = useState("general");

  useEffect(() => {
    const onMsg = (e) => {
      if (e.data?.type === "__activate_edit_mode") setOpen(true);
      if (e.data?.type === "__deactivate_edit_mode") setOpen(false);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // If Settings is closed for any reason (backdrop click, X button, or
  // external __deactivate_edit_mode message), reset the Danger-zone
  // confirm state so reopening Settings doesn't surface a stale modal.
  useEffect(() => {
    if (!open) {
      setClearConfirmOpen(false);
      setClearBusy(false);
    }
  }, [open]);

  // Persist a candidate hotkey: ask Rust to (re)register it first; only
  // commit to localStorage and visible state when registration succeeds.
  // If it fails (OS conflict, parse error), surface the message inline so
  // the user can pick something else without losing their previous binding.
  const applyHotkey = async (spec) => {
    const invoke = getInvoke();
    if (!invoke) {
      setHotkeyError("Tauri runtime not available");
      return;
    }
    try {
      await invoke("register_hotkey", { shortcut: spec });
      setHotkey(spec);
      setHotkeyError(null);
      try {
        localStorage.setItem(HOTKEY_LS_KEY, spec);
      } catch {}
    } catch (err) {
      setHotkeyError(String(err));
    }
  };

  // Apply a candidate screenshot hotkey. Mirrors applyHotkey but routes
  // through register_screenshot_hotkey so the two slots stay independent
  // (changing one never clobbers the other's registration).
  const applyScreenshotHotkey = async (spec) => {
    const invoke = getInvoke();
    if (!invoke) {
      setScreenshotHotkeyError("Tauri runtime not available");
      return;
    }
    try {
      await invoke("register_screenshot_hotkey", { shortcut: spec });
      setScreenshotHotkey(spec);
      setScreenshotHotkeyError(null);
      try {
        localStorage.setItem(SCREENSHOT_HOTKEY_LS_KEY, spec);
      } catch {}
    } catch (err) {
      setScreenshotHotkeyError(String(err));
    }
  };

  // Apply a candidate voice-dictation hotkey. Mirrors applyHotkey but routes
  // through register_voice_hotkey so the voice slot stays independent.
  const applyVoiceHotkey = async (spec) => {
    const invoke = getInvoke();
    if (!invoke) {
      setVoiceHotkeyError("Tauri runtime not available");
      return;
    }
    try {
      await invoke("register_voice_hotkey", { shortcut: spec });
      setVoiceHotkey(spec);
      setVoiceHotkeyError(null);
      try {
        localStorage.setItem(VOICE_HOTKEY_LS_KEY, spec);
      } catch {}
    } catch (err) {
      setVoiceHotkeyError(String(err));
    }
  };

  // Reset every applicable hotkey slot to its platform default. Each
  // apply* call re-registers with Rust and persists, so this is a true
  // reset, not just a UI value swap. Skips slots that don't apply on the
  // current platform (Quick Query is hidden on Linux; dictation + screenshot
  // are macOS-only).
  const resetHotkeys = () => {
    if (!IS_LINUX) applyHotkey(HOTKEY_DEFAULT);
    if (IS_MAC) {
      applyVoiceHotkey(VOICE_HOTKEY_DEFAULT);
      applyScreenshotHotkey(SCREENSHOT_HOTKEY_DEFAULT);
    }
  };

  if (!open) return null;

  const Row = ({ label, children }) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        minHeight: 32,
      }}
    >
      <span style={{ fontFamily: T.sans, fontSize: 13, color: T.fg2 }}>
        {label}
      </span>
      {children}
    </div>
  );

  const SectionLabel = ({ label }) => (
    <div
      style={{
        fontFamily: T.mono,
        fontSize: 10,
        fontWeight: 600,
        color: T.fg1,
        textTransform: "uppercase",
        letterSpacing: 0.7,
        paddingBottom: 2,
        marginTop: 8,
      }}
    >
      {label}
    </div>
  );

  const Toggle = ({ value, onChange }) => (
    <button
      onClick={() => onChange(!value)}
      style={{
        position: "relative",
        width: 36,
        height: 20,
        borderRadius: 999,
        background: value ? T.amber : T.bg4,
        border: "none",
        cursor: "pointer",
        flexShrink: 0,
        transition: "background 0.15s",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: value ? 19 : 3,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: value ? T.bg0 : T.fg3,
          transition: "left 0.15s",
        }}
      />
    </button>
  );

  // Confirm-modal handler. Awaits the parent's onClearAllChats (which
  // does the DB wipe + state reset), then closes both the confirm and
  // the settings modal so the user lands back in an empty fresh chat.
  // Errors are surfaced via the existing toast helper if available so
  // a failed DB call doesn't silently leave the user thinking history
  // was wiped when it wasn't.
  const handleConfirmClearAll = async () => {
    if (!onClearAllChats) return;
    setClearBusy(true);
    try {
      await onClearAllChats();
      setClearConfirmOpen(false);
      setOpen(false);
    } catch (e) {
      console.error("clear all chats failed:", e);
      window.ekToast?.({
        kind: "warn",
        title: "Could not clear chats",
        body: String(e),
      });
    } finally {
      setClearBusy(false);
    }
  };

  return (
    <>
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          // Wide enough that all six tabs (General…Files) fit inside the
          // strip's own 16px side padding — at 420 the last tab sat flush
          // against the dialog edge.
          width: 480,
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 12,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px",
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          <span
            style={{
              fontFamily: T.sans,
              fontSize: 14,
              fontWeight: 600,
              color: T.fg,
            }}
          >
            Settings
          </span>
          <button
            onClick={() => setOpen(false)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: T.fg3,
              padding: 4,
              borderRadius: 4,
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = T.fg)}
            onMouseLeave={(e) => (e.currentTarget.style.color = T.fg3)}
          >
            <I.X size={14} />
          </button>
        </div>

        {/* Tab strip */}
        <div
          style={{
            display: "flex",
            borderBottom: `1px solid ${T.border}`,
            padding: "0 16px",
          }}
        >
          {[
            { id: "general", label: "General" },
            { id: "backend", label: "Backend" },
            { id: "models", label: "Models" },
            // Voice input is macOS-only (the Whisper backend is macOS-gated).
            ...(IS_MAC ? [{ id: "voice", label: "Voice" }] : []),
            // Hotkeys: Quick Query is macOS+Windows; dictation + screenshot
            // are macOS-only — nothing to show on Linux, so hide the tab
            // there rather than render an empty pane.
            ...(!IS_LINUX ? [{ id: "hotkeys", label: "Hotkeys" }] : []),
            // "Files" collects the file/folder-backed settings that used to
            // be three separate tabs (prompts library, memory file,
            // attachment embedding).
            { id: "files", label: "Files" },
          ].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              style={{
                background: "none",
                border: "none",
                borderBottom:
                  activeTab === id
                    ? `2px solid ${T.amber}`
                    : "2px solid transparent",
                padding: "8px 11px",
                marginBottom: -1,
                cursor: "pointer",
                fontFamily: T.sans,
                fontSize: 12,
                fontWeight: activeTab === id ? 600 : 400,
                color: activeTab === id ? T.fg : T.fg3,
                transition: "color 0.1s",
              }}
              onMouseEnter={(e) => {
                if (activeTab !== id) e.currentTarget.style.color = T.fg2;
              }}
              onMouseLeave={(e) => {
                if (activeTab !== id) e.currentTarget.style.color = T.fg3;
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div
          style={{
            padding: "12px 16px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            maxHeight: "70vh",
            overflowY: "auto",
          }}
        >
          {/* ── General tab ─────────────────────────────────────── */}
          {activeTab === "general" && (
            <>
              <SectionLabel label="Appearance" />
              <Row label="Theme">
                <select
                  value={tweaks.theme}
                  onChange={(e) => setTweak("theme", e.target.value)}
                  style={{
                    background: T.bg2,
                    border: `1px solid ${T.border}`,
                    borderRadius: 6,
                    color: T.fg,
                    fontFamily: T.mono,
                    fontSize: 12,
                    padding: "4px 8px",
                    cursor: "pointer",
                  }}
                >
                  <option value="system">Match System</option>
                  {Object.entries(THEMES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </Row>

              <SectionLabel label="Layout" />
              <Row label="Show status bar">
                <Toggle
                  value={tweaks.showStatusBar}
                  onChange={(v) => setTweak("showStatusBar", v)}
                />
              </Row>
              <Row label="Show technical details">
                <Toggle
                  value={tweaks.showDetails}
                  onChange={(v) => setTweak("showDetails", v)}
                />
              </Row>

              <SectionLabel label="Help" />
              <Row label="Onboarding tour">
                <button
                  onClick={() => {
                    // Close settings first so the tour modal isn't
                    // stacked behind it. The setting flag is not
                    // touched — the tour's own onClose will re-set it
                    // when the user finishes/skips.
                    setOpen(false);
                    // Defer the open by one tick so the settings backdrop
                    // is fully unmounted before the tour mounts. Without
                    // this, focus + Esc handling can fight over which
                    // modal owns the keyboard.
                    setTimeout(() => {
                      window.ekOpenOnboarding?.();
                    }, 0);
                  }}
                  style={{
                    height: 22,
                    padding: "0 10px",
                    background: T.bg2,
                    border: `1px solid ${T.border}`,
                    borderRadius: 4,
                    color: T.fg2,
                    fontFamily: T.mono,
                    fontSize: 10.5,
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = T.bg3)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = T.bg2)}
                >
                  Show tour again
                </button>
              </Row>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  color: T.fg3,
                  lineHeight: 1.5,
                }}
              >
                A short tour of the hotkeys, attachments, memory file, and
                prompts library.
              </div>

              {/* ── Danger zone ─────────────────────────────────── */}
              {/* Bulk destructive actions live in their own visually
                  distinct section at the bottom of General so they sit
                  away from routine settings but stay discoverable. The
                  red-tinged border + "Danger zone" label cue the user
                  before they reach for the button. */}
              <div
                style={{
                  marginTop: 16,
                  padding: "10px 12px 12px",
                  border: `1px solid ${T.red}`,
                  borderRadius: 8,
                  // Faint red wash so the section reads as "danger" at a
                  // glance without overwhelming the modal body.
                  background: "rgba(180, 70, 70, 0.06)",
                }}
              >
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 10,
                    fontWeight: 600,
                    color: T.red,
                    textTransform: "uppercase",
                    letterSpacing: 0.7,
                    marginBottom: 6,
                  }}
                >
                  Danger zone
                </div>
                <Row label="Clear all chat history">
                  <button
                    onClick={() => setClearConfirmOpen(true)}
                    disabled={!onClearAllChats || chatCount === 0}
                    title={
                      chatCount === 0
                        ? "No chats to clear"
                        : `Permanently delete all ${chatCount} chat${chatCount === 1 ? "" : "s"}`
                    }
                    style={{
                      height: 24,
                      padding: "0 10px",
                      background: T.bg2,
                      border: `1px solid ${T.red}`,
                      borderRadius: 4,
                      color: chatCount === 0 ? T.fg3 : T.red,
                      fontFamily: T.mono,
                      fontSize: 10.5,
                      cursor: !onClearAllChats || chatCount === 0 ? "not-allowed" : "pointer",
                      opacity: !onClearAllChats || chatCount === 0 ? 0.6 : 1,
                    }}
                  >
                    Clear all chats…
                  </button>
                </Row>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 10,
                    color: T.fg3,
                    lineHeight: 1.5,
                    marginTop: 4,
                  }}
                >
                  Permanently deletes every chat and its messages. Saved files
                  on disk and your settings are kept.
                </div>
              </div>
            </>
          )}

          {/* ── Hotkeys tab ──────────────────────────────────────── */}
          {/* Global shortcuts, split out of General. Quick Query is       */}
          {/* macOS+Windows; dictation + screenshot are macOS-only, so the */}
          {/* tab is hidden on Linux (see the tab-strip gate above).       */}
          {activeTab === "hotkeys" && (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 12,
                  marginTop: 2,
                }}
              >
                <div
                  style={{
                    flex: 1,
                    fontFamily: T.mono,
                    fontSize: 10,
                    color: T.fg3,
                    lineHeight: 1.5,
                  }}
                >
                  Global keyboard shortcuts. Click one to record a new
                  combination — each needs at least one modifier{" "}
                  ({IS_MAC ? "⌘ / ⌃ / ⌥" : "Win / Ctrl / Alt"}).
                </div>
                <button
                  onClick={resetHotkeys}
                  title="Reset all shortcuts to their defaults"
                  style={{
                    flexShrink: 0,
                    height: 22,
                    padding: "0 10px",
                    background: T.bg2,
                    border: `1px solid ${T.border}`,
                    borderRadius: 4,
                    color: T.fg2,
                    fontFamily: T.mono,
                    fontSize: 10.5,
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = T.bg3)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = T.bg2)}
                >
                  Reset to defaults
                </button>
              </div>

              {!IS_LINUX && (
                <>
                  <SectionLabel label="Quick query" />
                  <Row label="Hotkey">
                    <HotkeyCapture value={hotkey} onChange={applyHotkey} />
                  </Row>
                  {hotkeyError && (
                    <div
                      style={{
                        marginTop: -2,
                        padding: "4px 0",
                        fontFamily: T.mono,
                        fontSize: 10.5,
                        color: T.red,
                        textAlign: "right",
                      }}
                    >
                      {hotkeyError}
                    </div>
                  )}
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: T.fg3,
                      lineHeight: 1.5,
                    }}
                  >
                    Opens the quick-query overlay from anywhere.
                  </div>
                </>
              )}

              {IS_MAC && (
                <>
                  <SectionLabel label="Voice dictation" />
                  <Row label="Hotkey">
                    <HotkeyCapture value={voiceHotkey} onChange={applyVoiceHotkey} />
                  </Row>
                  {voiceHotkeyError && (
                    <div
                      style={{
                        marginTop: -2,
                        padding: "4px 0",
                        fontFamily: T.mono,
                        fontSize: 10.5,
                        color: T.red,
                        textAlign: "right",
                      }}
                    >
                      {voiceHotkeyError}
                    </div>
                  )}
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: T.fg3,
                      lineHeight: 1.5,
                    }}
                  >
                    Opens the quick-query overlay and starts listening.
                  </div>
                </>
              )}

              {IS_MAC && (
                <>
                  <SectionLabel label="Screenshot" />
                  <Row label="Hotkey">
                    <HotkeyCapture
                      value={screenshotHotkey}
                      onChange={applyScreenshotHotkey}
                    />
                  </Row>
                  {screenshotHotkeyError && (
                    <div
                      style={{
                        marginTop: -2,
                        padding: "4px 0",
                        fontFamily: T.mono,
                        fontSize: 10.5,
                        color: T.red,
                        textAlign: "right",
                      }}
                    >
                      {screenshotHotkeyError}
                    </div>
                  )}
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: T.fg3,
                      lineHeight: 1.5,
                    }}
                  >
                    Captures a screen region (drag to select, Space for a
                    window, Esc to cancel) and opens it in a new chat with a
                    vision model.
                  </div>
                </>
              )}
            </>
          )}

          {/* ── Files tab (was Prompts + Memory + Attachments) ────── */}
          {activeTab === "files" && (
            <>
              <SectionLabel label="Prompts folder" />
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  color: T.fg3,
                  lineHeight: 1.5,
                  marginBottom: 4,
                }}
              >
                Prompts are stored as .md files. Pick any folder you like —
                drop it in a git repo to version or share your library.
              </div>
              <PromptsFolderRow onPromptsChanged={onPromptsChanged} />

              <SectionLabel label="Memory file" />
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  color: T.fg3,
                  lineHeight: 1.5,
                  marginBottom: 8,
                }}
              >
                A single markdown file injected into every chat as background
                context. Useful for facts about you, preferences, or anything
                you want every model to know. Read-only: the model can read it
                but cannot modify it — only you can.
              </div>
              <MemorySettings />

              <SectionLabel label="Attachments" />
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  color: T.fg3,
                  lineHeight: 1.5,
                  marginBottom: 4,
                }}
              >
                Large files and folders get chunked and embedded with the model
                below. Changing the model requires re-indexing — a banner will
                appear with a one-click action when chunks go stale.
              </div>
              <AttachmentsSettings />
            </>
          )}

          {/* ── Models tab ───────────────────────────────────────── */}
          {activeTab === "models" && (
            // ModelManagerPanel lives in model-manager.jsx (shared with
            // the ModelManagerModal opened from the composer picker).
            // The active model is read straight from localStorage rather
            // than prop-drilled through SettingsModal — same key + fallback
            // as readPersistedComposerModel in main.jsx.
            <ModelManagerPanel
              activeModel={
                localStorage.getItem("ekorbia.main.model") || "gemma4:latest"
              }
            />
          )}

          {/* ── Backend tab (no-Ollama plan, Phase 1 / L1) ────────── */}
          {activeTab === "backend" && (
            <>
              <SectionLabel label="Inference backend" />
              <BackendSettings />
            </>
          )}

          {/* ── Voice tab ─────────────────────────────────────────── */}
          {activeTab === "voice" && (
            <>
              <SectionLabel label="Voice input" />
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  color: T.fg3,
                  lineHeight: 1.5,
                  marginBottom: 8,
                }}
              >
                Push-to-talk dictation in the composer — click the mic, speak, then
                click again to insert the transcript. Audio is transcribed on your
                machine and never uploaded.
              </div>
              <VoiceSettings />
            </>
          )}

        </div>
      </div>
    </div>
    <ConfirmDialog
      open={clearConfirmOpen}
      title="Delete all chats?"
      body={
        <>
          This permanently deletes {chatCount} chat{chatCount === 1 ? "" : "s"}{" "}
          and all their messages. Saved files on disk and your settings are
          kept. This cannot be undone.
        </>
      }
      confirmText={`Delete all chat${chatCount === 1 ? "" : "s"}`}
      cancelText="Cancel"
      busy={clearBusy}
      onConfirm={handleConfirmClearAll}
      onCancel={() => { if (!clearBusy) setClearConfirmOpen(false); }}
    />
    </>
  );
}

// ── Backend settings (no-Ollama plan, Phases 1-2) ───────────────────────────
// Chooses which engine serves LLM traffic: Ollama (default), any
// OpenAI-compatible server (LM Studio, llama-server, vLLM, …), or the
// bundled engine (Ekorbia's own supervised llama-server — Phase 2).
// Saving applies live via llm_backend_config_set — the next send uses the
// new backend, no relaunch. "Test connection" validates the CANDIDATE
// URL/key via /v1/models before anything is saved; the engine card shows
// a live engine_status readout (binary + models folder) instead.
function BackendSettings() {
  const invoke = getInvoke();
  const [backendKind, setBackendKind] = useState("ollama");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testState, setTestState] = useState(null); // null | 'testing' | {ok, models, error}
  const [saveState, setSaveState] = useState(null); // null | 'saved' | error string
  const [loaded, setLoaded] = useState(false);
  // engine_status snapshot {binaryOk, binaryPath, binaryError, modelsDir,
  // modelCount} — fetched on mount and re-fetched when the engine card is
  // selected (a fetch-llama-server.sh run or a dropped .gguf should show
  // up without reopening Settings).
  const [engineInfo, setEngineInfo] = useState(null);

  useEffect(() => {
    invoke("llm_backend_config_get")
      .then((c) => {
        if (c) {
          setBackendKind(c.backend || "ollama");
          setBaseUrl(c.baseUrl || "");
          setApiKey(c.apiKey || "");
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  useEffect(() => {
    if (backendKind !== "engine") return;
    invoke("engine_status")
      .then((s) => setEngineInfo(s || null))
      .catch(() => setEngineInfo(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- invoke is stable
  }, [backendKind]);

  const save = async () => {
    setSaveState(null);
    try {
      await invoke("llm_backend_config_set", {
        backendKind,
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKey.trim() || null,
      });
      setSaveState("saved");
      setTimeout(() => setSaveState(null), 2500);
    } catch (e) {
      setSaveState(String(e));
    }
  };

  const test = async () => {
    setTestState("testing");
    try {
      const r = await invoke("llm_backend_test", {
        baseUrl,
        apiKey: apiKey.trim() || null,
      });
      setTestState(r || { ok: false, models: 0, error: "no response" });
    } catch (e) {
      setTestState({ ok: false, models: 0, error: String(e) });
    }
  };

  const optionCard = (id, title, blurb) => {
    const selected = backendKind === id;
    return (
      <button
        data-backend-option={id}
        onClick={() => setBackendKind(id)}
        style={{
          flex: 1,
          textAlign: "left",
          background: selected ? T.bg2 : "transparent",
          border: `1px solid ${selected ? "var(--ek-accent)" : T.border}`,
          borderRadius: 8,
          padding: "10px 12px",
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          gap: 3,
        }}
      >
        <span style={{ fontFamily: T.sans, fontSize: 12.5, fontWeight: 600, color: T.fg }}>
          {title}
        </span>
        <span style={{ fontFamily: T.sans, fontSize: 11, color: T.fg2, lineHeight: 1.45 }}>
          {blurb}
        </span>
      </button>
    );
  };

  const inputStyle = {
    width: "100%",
    background: T.bg1,
    color: T.fg,
    border: `1px solid ${T.border}`,
    borderRadius: 7,
    padding: "7px 10px",
    fontFamily: T.mono,
    fontSize: 12,
  };

  if (!loaded) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {optionCard(
          "ollama",
          "Ollama (default)",
          "The local engine Ekorbia manages for you — model downloads, warm-up, and capability detection all built in.",
        )}
        {optionCard(
          "engine",
          "Bundled engine",
          "Ekorbia runs llama.cpp itself — no Ollama, no separate install. Download models from the built-in catalog and go.",
        )}
        {optionCard(
          "openai",
          "Custom endpoint",
          "Any OpenAI-compatible server: LM Studio, llama-server, vLLM… Ekorbia talks to its /v1 API.",
        )}
      </div>

      {backendKind === "engine" && (
        <div
          data-backend-engine-info
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          {engineInfo && (
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 11,
                color: engineInfo.binaryOk ? T.green : T.red,
              }}
              data-backend-engine-binary
            >
              {engineInfo.binaryOk
                ? `✓ Engine ready (${engineInfo.modelCount} model${engineInfo.modelCount === 1 ? "" : "s"} in the folder)`
                : `✗ ${engineInfo.binaryError || "Engine binary missing"}`}
            </div>
          )}
          {engineInfo && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontFamily: T.mono,
                fontSize: 10.5,
                color: T.fg3,
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 340,
                }}
                title={engineInfo.modelsDir}
              >
                {engineInfo.modelsDir}
              </span>
              <button
                data-backend-engine-reveal
                onClick={() => invoke("engine_models_dir_reveal").catch(() => {})}
                style={{
                  background: T.bg2,
                  color: T.fg,
                  border: `1px solid ${T.border}`,
                  borderRadius: 7,
                  padding: "4px 10px",
                  fontFamily: T.sans,
                  fontSize: 11,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                Reveal models folder
              </button>
            </div>
          )}
          <div style={{ fontFamily: T.sans, fontSize: 10.5, color: T.fg3, lineHeight: 1.5 }}>
            One chat model and one embedding model stay loaded at a time;
            switching models swaps automatically and idle models unload
            after ~10 minutes. Vision works when a model has a matching
            projector file (<span style={{ fontFamily: T.mono }}>name.mmproj.gguf</span>)
            next to it.
          </div>
        </div>
      )}

      {backendKind === "openai" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontFamily: T.sans, fontSize: 11.5, color: T.fg2 }}>
            Base URL
          </label>
          <input
            data-backend-url
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="e.g. http://127.0.0.1:1234"
            spellCheck={false}
            style={inputStyle}
          />
          <label style={{ fontFamily: T.sans, fontSize: 11.5, color: T.fg2 }}>
            API key (optional)
          </label>
          <input
            data-backend-key
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Only if your server requires one"
            style={inputStyle}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              data-backend-test
              onClick={test}
              disabled={testState === "testing"}
              style={{
                background: T.bg2,
                color: T.fg,
                border: `1px solid ${T.border}`,
                borderRadius: 7,
                padding: "6px 12px",
                fontFamily: T.sans,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {testState === "testing" ? "Testing…" : "Test connection"}
            </button>
            {testState && testState !== "testing" && (
              <span
                data-backend-test-result
                style={{
                  fontFamily: T.mono,
                  fontSize: 11,
                  color: testState.ok ? T.green : T.red,
                }}
              >
                {testState.ok
                  ? `✓ Reachable — ${testState.models} model${testState.models === 1 ? "" : "s"}`
                  : `✗ ${testState.error || "Unreachable"}`}
              </span>
            )}
          </div>
          <div style={{ fontFamily: T.sans, fontSize: 10.5, color: T.fg3, lineHeight: 1.5 }}>
            The model picker lists whatever your server reports at /v1/models.
            In-app model downloads and deletes are managed by your server, so
            they're hidden on this backend — and capability badges use
            optimistic defaults (tools on, vision off), since there's no
            portable way to probe them.
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          data-backend-save
          onClick={save}
          className="ek-btn-primary"
          style={{
            background: "var(--ek-accent)",
            // T.bg0 (not --ek-accent-ink): the ink var resolves to the amber
            // itself on light themes, which vanished against the amber fill.
            // T.bg0 is the app-wide "text on an accent fill" convention and
            // contrasts on both themes.
            color: T.bg0,
            border: "none",
            borderRadius: 7,
            padding: "7px 16px",
            fontFamily: T.sans,
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Save
        </button>
        {saveState === "saved" && (
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.green }}>
            ✓ Applied — takes effect on the next message
          </span>
        )}
        {saveState && saveState !== "saved" && (
          <span data-backend-save-error style={{ fontFamily: T.mono, fontSize: 11, color: T.red }}>
            {saveState}
          </span>
        )}
      </div>
    </div>
  );
}
