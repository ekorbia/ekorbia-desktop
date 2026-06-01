// settings.jsx -- Settings surface:
//   Hotkey constants + formatHotkey + hotkeyFromEvent + HotkeyCapture,
//   isEmbeddingModelName, AttachmentsSettings, PromptsFolderRow,
//   SettingsModal (tabbed: General / Prompts / Attachments).
// Depends on: tokens, atoms, icons.

const HOTKEY_DEFAULT = "Super+Shift+Space";
const HOTKEY_LS_KEY = "ekorbia.overlay.hotkey";
// Second slot: screenshot capture hotkey (Phase 5). Default
// Super+Shift+Digit1 — sits next to macOS's own Cmd+Shift+3/4/5 mental
// model but doesn't collide with any system-bound combination.
const SCREENSHOT_HOTKEY_DEFAULT = "Super+Shift+Digit1";
const SCREENSHOT_HOTKEY_LS_KEY = "ekorbia.screenshot.hotkey";

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
    try {
      const r = await fetch("http://localhost:11434/api/tags", {
        signal: AbortSignal.timeout(2500),
      });
      if (!r.ok) return;
      const data = await r.json();
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
      const r = await invoke("embedding_model_check");
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <span style={{ fontFamily: T.sans, fontSize: 13, color: T.fg2 }}>Embedding model</span>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {pickerMode === "dropdown" && pulledEmbedModels.length > 0 ? (
            <select
              value={pulledEmbedModels.includes(embedModel) ? embedModel : ""}
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
              {!embedModel && <option value="">— pick a model —</option>}
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
              placeholder="nomic-embed-text"
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
          placeholder="6"
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <span style={{ fontFamily: T.sans, fontSize: 13, color: T.fg2 }}>Folder file types</span>
        <SettingInput
          wide
          value={folderExts}
          onChange={setFolderExts}
          onCommit={() => persist("folder_exts", folderExts)}
          placeholder="md, markdown, txt, pdf"
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <span style={{ fontFamily: T.sans, fontSize: 13, color: T.fg2 }}>Folder ignore dirs</span>
        <SettingInput
          wide
          value={folderIgnore}
          onChange={setFolderIgnore}
          onCommit={() => persist("folder_ignore", folderIgnore)}
          placeholder=".git, node_modules, target, …"
        />
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
              color: info.oversized ? "#d8a87e" : T.fg3,
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
            color: "#d8a87e",
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
        color: T.fg3,
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
          width: 420,
          background: T.bg1,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 12,
          boxShadow: "0 30px 70px rgba(0,0,0,0.55)",
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
            { id: "prompts", label: "Prompts" },
            { id: "memory", label: "Memory" },
            { id: "attachments", label: "Attachments" },
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
                padding: "8px 14px",
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

              {/* Quick Query overlay: macOS + Windows (where transparent
                  + always-on-top windows + per-window vibrancy all work).
                  Linux falls through to Phase L2 — the overlay code path
                  isn't wired up there yet, so showing the hotkey setting
                  would be misleading. */}
              {!IS_LINUX && (
                <>
                  <SectionLabel label="Quick Query" />
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
                    {IS_MAC
                      ? "Click to capture. Needs at least one modifier (⌘/⌃/⌥)."
                      : "Click to capture. Needs at least one modifier (Win / Ctrl / Alt)."}
                  </div>
                </>
              )}

              {/* Screenshot capture: macOS only for now. Linux (Phase L3)
                  and Windows (Phase W3) need their own capture pipelines —
                  /usr/sbin/screencapture is mac-exclusive. */}
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
                    Captures a screen region (drag to select, Space for a window,
                    Esc to cancel) and opens it in a new chat with a vision model.
                  </div>
                </>
              )}

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

          {/* ── Prompts tab ──────────────────────────────────────── */}
          {activeTab === "prompts" && (
            <>
              <SectionLabel label="Prompts Folder" />
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
            </>
          )}

          {/* ── Memory tab ──────────────────────────────────────── */}
          {activeTab === "memory" && (
            <>
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
            </>
          )}

          {/* ── Attachments tab ──────────────────────────────────── */}
          {activeTab === "attachments" && (
            <>
              <SectionLabel label="Embedding" />
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
