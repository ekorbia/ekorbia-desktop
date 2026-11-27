// settings.jsx -- Settings surface:
//   Hotkey constants + formatHotkey + hotkeyFromEvent + HotkeyCapture,
//   isEmbeddingModelName, AttachmentsSettings,
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
// Fourth slot: selection actions. Opens the overlay on whatever text is on
// the clipboard. Default ⌘⇧E — must mirror the Rust setup() default. The
// overlay window reads this same key to name the hotkey in its empty-clipboard
// hint, so both windows agree after a rebind.
const SELECTION_HOTKEY_DEFAULT = "Super+Shift+KeyE";
const SELECTION_HOTKEY_LS_KEY = "ekorbia.selection.hotkey";

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
        borderRadius: 8,
        color: recording ? T.amber : T.fg,
        fontFamily: T.sans,
        fontSize: 13,
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
      style={ekField({ width: wide ? 280 : 140, padding: "5px 9px" })}
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
        <span style={ekLabel()}>Embedding model</span>
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
                borderRadius: 8,
                color: T.fg,
                fontFamily: T.sans,
                fontSize: 12.5,
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
                fontFamily: T.sans,
                fontSize: 12,
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
              color: T.fg2,
              cursor: "pointer",
              fontFamily: T.sans,
              fontSize: 12,
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
            fontFamily: T.sans,
            fontSize: 12,
            color: T.fg2,
            textAlign: "right",
            marginTop: -4,
          }}
        >
          Run: <span style={{ color: T.amber }}>ollama pull {modelStatus.model}</span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <span style={ekLabel()}>Top-k chunks per query</span>
        <SettingInput
          value={topK}
          onChange={setTopK}
          onCommit={() => persist("top_k", topK)}
        />
      </div>
      <div style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2, textAlign: "right", marginTop: -4 }}>
        Defaults to 6
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <span style={ekLabel()}>Folder file types</span>
        <SettingInput
          wide
          value={folderExts}
          onChange={setFolderExts}
          onCommit={() => persist("folder_exts", folderExts)}
        />
      </div>
      <div style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2, textAlign: "right", marginTop: -4 }}>
        Defaults to md, markdown, txt, pdf
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <span style={ekLabel()}>Folder ignore dirs</span>
        <SettingInput
          wide
          value={folderIgnore}
          onChange={setFolderIgnore}
          onCommit={() => persist("folder_ignore", folderIgnore)}
        />
      </div>
      <div style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2, textAlign: "right", marginTop: -4 }}>
        Defaults to .git, node_modules, target, …
      </div>
      {savingKey && (
        <div style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2, textAlign: "right" }}>
          saving…
        </div>
      )}
    </div>
  );
}

// ─── Settings → Models ──────────────────────────────────────
// The app's default model, in plain names. For the bundled engine these
// are the three tiers modelTiers (utils.js) works out from the catalog
// and this Mac's memory — Fast, Balanced, Most capable — each of which can
// be downloaded, and any installed one made the default. Several can be
// installed side by side (Compare needs two). A workspace uses the default
// unless its own settings name another model.
//
// On Ollama or a custom server there is no catalog to name things from,
// so the pane lists that backend's models under their own names.
//
// Everything else about models (the rest of the catalog, a model from a
// link, removal, other servers) is under Advanced.
function ModelsSettings({ defaultModel = "", onDefaultModel, spaces = [], onOpenAdvanced }) {
  const invoke = getInvoke();
  const [backend, setBackend] = useState(null); // 'engine' | 'ollama' | 'openai' | null (loading)
  const [catalog, setCatalog] = useState([]);
  const [ramBytes, setRamBytes] = useState(0);
  const [installed, setInstalled] = useState(null); // string[] | null while unknown
  const [, bump] = useState(0);

  const refreshInstalled = async () => {
    if (!invoke) return;
    try {
      const data = await invoke("llm_list_models");
      setInstalled(((data && data.models) || []).map((m) => m.name));
    } catch {
      setInstalled([]);
    }
  };

  useEffect(() => {
    if (!invoke) return undefined;
    let alive = true;
    (async () => {
      let kind = "ollama";
      try {
        const c = await invoke("llm_backend_config_get");
        kind = (c && c.backend) || "ollama";
      } catch {}
      if (!alive) return;
      setBackend(kind);
      if (kind === "engine") {
        try {
          const [cat, prof] = await Promise.all([
            invoke("engine_catalog"),
            invoke("system_profile"),
          ]);
          if (!alive) return;
          // engine_catalog returns { version, models } — never a bare array.
          setCatalog((cat && cat.models) || []);
          setRamBytes((prof && prof.totalRamBytes) || 0);
        } catch {}
      }
      refreshInstalled();
    })();
    // Re-render on every download tick; re-read what is installed when one ends.
    const unsubscribe = ekPullsSubscribe(() => bump((n) => n + 1));
    return () => {
      alive = false;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = async (id) => {
    const res = await ekPullModel(id, { engine: true });
    if (res && res.ok) refreshInstalled();
  };

  const tiers = modelTiers(catalog, ramBytes);
  const isInstalled = (id) => Array.isArray(installed) && installed.includes(id);
  const usedBy = (id) => (spaces || []).filter((s) => s && s.defaultModel === id).length;
  const gb = (bytes) => `${((bytes || 0) / 1e9).toFixed(1)} GB`;
  const memoryGb = ramBytes > 0 ? Math.round(ramBytes / (1024 * 1024 * 1024)) : 0;

  const hint = { fontFamily: T.sans, fontSize: 12.5, color: T.fg2, lineHeight: 1.5 };
  const pill = {
    fontFamily: T.sans, fontSize: 12, fontWeight: 500, color: T.amber,
    background: T.amber + "1f", borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap",
  };
  const button = {
    height: 26, padding: "0 11px", border: `1px solid ${T.border}`, borderRadius: 7,
    background: T.bg0, color: T.fg, fontFamily: T.sans, fontSize: 12, fontWeight: 500,
    cursor: "pointer", whiteSpace: "nowrap",
  };
  const link = {
    border: "none", background: "transparent", padding: 0, cursor: "pointer",
    color: T.amber, fontFamily: T.sans, fontSize: 12, whiteSpace: "nowrap",
  };

  // One row: a model, what it is for, and the one thing you can do with it.
  const row = ({ id, name, detail, blurb, size, tier }) => {
    const pull = ekGetPull(id);
    const here = isInstalled(id);
    const isDefault = id === defaultModel;
    return (
      <div
        key={id}
        data-model-row={id}
        data-model-tier={tier || undefined}
        data-default={isDefault ? "true" : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 12,
          border: `1px solid ${isDefault ? T.fg : T.border}`,
          boxShadow: isDefault ? `0 0 0 1px ${T.fg}` : "none",
          borderRadius: 10, padding: "10px 12px",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span data-model-name style={{ fontFamily: T.sans, fontSize: 13.5, fontWeight: 600, color: T.fg }}>{name}</span>
            {(detail || size) && (
              <span data-model-detail style={{ fontFamily: T.sans, fontSize: 11.5, color: T.fg3 }}>
                {[detail, size].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
          {blurb && <div style={{ ...hint, fontSize: 12 }}>{blurb}</div>}
        </div>
        {pull ? (
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span data-model-progress style={{ ...hint, fontSize: 12 }}>
              {typeof pull.pct === "number" ? `${pull.pct}%` : "Starting…"}
            </span>
            <button type="button" style={link} onClick={() => ekCancelPull(id)}>Cancel</button>
          </span>
        ) : !here && backend === "engine" ? (
          <button type="button" data-model-download={id} style={button} onClick={() => download(id)}>
            Download
          </button>
        ) : isDefault ? (
          <span data-model-is-default style={pill}>Default</span>
        ) : (
          <button
            type="button"
            data-model-make-default={id}
            style={link}
            onClick={() => onDefaultModel && onDefaultModel(id)}
          >
            Make default
          </button>
        )}
      </div>
    );
  };

  if (backend === null) {
    return <div data-models-settings style={hint}>Looking for models…</div>;
  }

  let rows;
  if (backend === "engine") {
    rows = MODEL_TIER_ORDER.filter((t) => tiers[t]).map((t) => ({
      id: tiers[t].id,
      tier: t,
      name: MODEL_TIER_INFO[t].name,
      detail: tiers[t].label || tiers[t].id,
      size: gb(tiers[t].totalBytes),
      blurb: MODEL_TIER_INFO[t].blurb,
    }));
    // A default chosen under Advanced that is not one of the three still
    // has to be visible here.
    if (defaultModel && !rows.some((r) => r.id === defaultModel)) {
      const d = describeModel(defaultModel, tiers, catalog);
      rows.push({ id: defaultModel, tier: null, name: d.name, detail: "", size: "", blurb: "Chosen under Advanced." });
    }
  } else {
    rows = (installed || []).map((id) => ({ id, tier: null, name: id, detail: "", size: "", blurb: "" }));
  }
  const used = rows
    .map((r) => ({ r, n: usedBy(r.id) }))
    .filter(({ n }) => n > 0);

  return (
    <div data-models-settings data-backend={backend} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontFamily: T.sans, fontSize: 17, fontWeight: 600, color: T.fg }}>Models</div>
      <div style={{ ...hint, marginTop: -4 }}>
        {backend === "engine"
          ? `${memoryGb ? `Sized for this Mac, which has ${memoryGb} GB of memory. ` : ""}Workspaces use the default unless you choose another for them.`
          : `These come from ${backend === "ollama" ? "Ollama" : "your server"}. Workspaces use the default unless you choose another for them.`}
      </div>
      {rows.length === 0 && (
        <div data-models-empty style={hint}>
          {backend === "engine" ? "No models are listed for this Mac." : "No models found there yet."}
        </div>
      )}
      {rows.map(row)}
      {used.map(({ r, n }) => (
        <div key={`used-${r.id}`} data-model-used-by={r.id} style={{ ...hint, fontSize: 12 }}>
          {r.name} is used by {n === 1 ? "1 workspace" : `${n} workspaces`}.
        </div>
      ))}
      <div style={{ ...hint, fontSize: 12, marginTop: 4 }}>
        <button type="button" data-models-open-advanced style={link} onClick={() => onOpenAdvanced && onOpenAdvanced()}>
          Advanced
        </button>{" "}
        has the other catalog models, a model from a link, and other servers.
      </div>
    </div>
  );
}

// Settings is grouped by what you want to do. The four panes most people
// need come first; "Advanced" holds everything that only makes sense if
// you know how the app works underneath (which server answers, every
// model in the catalog, where files are kept, how attachments are read).
//
//   defaultModel / onDefaultModel — the app-wide model (main.jsx owns it)
//   spaces                        — to say which workspaces use a model
function SettingsModal({ tweaks, setTweak, onPromptsChanged, chatCount = 0, onClearAllChats, defaultModel = "", onDefaultModel, spaces = [], templates = [], onSaveTemplate, onDeleteTemplate, onDuplicateTemplate, onToggleTemplateStar, backendKind = "engine", backendBaseUrl = null, nameOfModel, modelLabels = {}, watchesPane = null }) {
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
  // Selection-actions hotkey — same persistence pattern, own slot.
  const [selectionHotkey, setSelectionHotkey] = useState(() => {
    try {
      return (
        localStorage.getItem(SELECTION_HOTKEY_LS_KEY) ||
        SELECTION_HOTKEY_DEFAULT
      );
    } catch {
      return SELECTION_HOTKEY_DEFAULT;
    }
  });
  const [selectionHotkeyError, setSelectionHotkeyError] = useState(null);
  const [activeTab, setActiveTab] = useState("general");
  const [templateRequest, setTemplateRequest] = useState(null);

  useEffect(() => {
    const onMsg = (e) => {
      if (e.data?.type === "__activate_edit_mode") {
        setOpen(true);
        // Optional: which pane to show, and which template to open in it
        // ("new" for a blank one). Without them Settings opens as it was.
        if (e.data.tab) setActiveTab(e.data.tab);
        if (e.data.tab === "templates" && e.data.template) {
          setTemplateRequest((r) => ({ id: e.data.template, n: (r ? r.n : 0) + 1 }));
        }
      }
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

  // Apply a candidate selection-actions hotkey. Mirrors applyHotkey but
  // routes through register_selection_hotkey so the selection slot stays
  // independent.
  const applySelectionHotkey = async (spec) => {
    const invoke = getInvoke();
    if (!invoke) {
      setSelectionHotkeyError("Tauri runtime not available");
      return;
    }
    try {
      await invoke("register_selection_hotkey", { shortcut: spec });
      setSelectionHotkey(spec);
      setSelectionHotkeyError(null);
      try {
        localStorage.setItem(SELECTION_HOTKEY_LS_KEY, spec);
      } catch {}
    } catch (err) {
      setSelectionHotkeyError(String(err));
    }
  };

  // Reset every applicable hotkey slot to its platform default. Each
  // apply* call re-registers with Rust and persists, so this is a true
  // reset, not just a UI value swap. Skips slots that don't apply on the
  // current platform (Quick Query is hidden on Linux; dictation, screenshot
  // and selection actions are macOS-only).
  const resetHotkeys = () => {
    if (!IS_LINUX) applyHotkey(HOTKEY_DEFAULT);
    if (IS_MAC) {
      applyVoiceHotkey(VOICE_HOTKEY_DEFAULT);
      applyScreenshotHotkey(SCREENSHOT_HOTKEY_DEFAULT);
      applySelectionHotkey(SELECTION_HOTKEY_DEFAULT);
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
      <span style={ekLabel()}>{label}</span>
      {children}
    </div>
  );

  const SectionLabel = ({ label }) => (
    <div style={ekHeading({ marginTop: 10, paddingBottom: 2 })}>{label}</div>
  );

  const Toggle = ({ value, onChange }) => (
    <EkToggle value={value} onChange={onChange} />
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
          // A list of panes down the left, the pane itself on the right.
          width: 720,
          maxWidth: "calc(100vw - 32px)",
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
              color: T.fg2,
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

        <div style={{ display: "flex", minHeight: 0 }}>
        {/* Panes, listed down the left. */}
        <div
          data-settings-nav
          style={{
            width: 150,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            padding: 8,
            borderRight: `1px solid ${T.border}`,
          }}
        >
          {[
            { id: "general", label: "General" },
            { id: "models", label: "Models" },
            { id: "templates", label: "Templates" },
            { id: "watches", label: "Watches" },
            // Dictation is macOS-only (the Whisper backend is macOS-gated).
            ...(IS_MAC ? [{ id: "voice", label: "Dictation" }] : []),
            // Shortcuts: Quick Query is macOS+Windows; dictation + screenshot
            // are macOS-only — nothing to show on Linux.
            ...(!IS_LINUX ? [{ id: "hotkeys", label: "Shortcuts" }] : []),
            { id: "privacy", label: "Privacy" },
            { id: "advanced", label: "Advanced" },
          ].map(({ id, label }) => (
            <button
              key={id}
              data-settings-tab={id}
              onClick={() => setActiveTab(id)}
              style={{
                textAlign: "left",
                background: activeTab === id ? T.bg3 : "transparent",
                border: "none",
                borderRadius: 7,
                padding: "6px 10px",
                cursor: "pointer",
                fontFamily: T.sans,
                fontSize: 13,
                fontWeight: activeTab === id ? 600 : 400,
                color: activeTab === id ? T.fg : T.fg1,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div
          data-settings-body
          style={{
            flex: 1,
            minWidth: 0,
            padding: "14px 20px 20px",
            // A grid of content-height rows, NOT a flex column: this box
            // has a fixed height, and a flex column squeezes any child
            // that allows it (the model manager sets minHeight 0) — its
            // contents then spill over the sections below it.
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            gridAutoRows: "max-content",
            alignContent: "start",
            rowGap: 6,
            height: "min(70vh, 520px)",
            overflowY: "auto",
          }}
        >
          {/* ── General tab ─────────────────────────────────────── */}
          {activeTab === "general" && (
            <>
              <SectionLabel label="Appearance" />
              <Row label="Look">
                <select
                  data-look-select
                  aria-label="Look"
                  value={normalizeLook(tweaks.theme)}
                  onChange={(e) => setTweak("theme", e.target.value)}
                  style={ekField({ width: "auto", padding: "5px 9px", cursor: "pointer" })}
                >
                  {LOOK_CHOICES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Row>

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
                    fontFamily: T.sans,
                    fontSize: 12,
                    fontWeight: 600,
                    color: T.red,
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
                    style={ekBtn("danger", { small: true, disabled: chatCount === 0 })}
                  >
                    Clear all chats…
                  </button>
                </Row>
                <div
                  style={{
                    fontFamily: T.sans,
                    fontSize: 12,
                    color: T.fg2,
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
                    fontFamily: T.sans,
                    fontSize: 12,
                    color: T.fg2,
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
                  style={ekBtn("secondary", { small: true })}
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
                        fontFamily: T.sans,
                        fontSize: 12,
                        color: T.red,
                        textAlign: "right",
                      }}
                    >
                      {hotkeyError}
                    </div>
                  )}
                  <div
                    style={{
                      fontFamily: T.sans,
                      fontSize: 12,
                      color: T.fg2,
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
                        fontFamily: T.sans,
                        fontSize: 12,
                        color: T.red,
                        textAlign: "right",
                      }}
                    >
                      {voiceHotkeyError}
                    </div>
                  )}
                  <div
                    style={{
                      fontFamily: T.sans,
                      fontSize: 12,
                      color: T.fg2,
                      lineHeight: 1.5,
                    }}
                  >
                    Opens the quick-query overlay and starts listening.
                  </div>
                </>
              )}

              {IS_MAC && (
                <>
                  <SectionLabel label="Selection actions" />
                  <Row label="Hotkey">
                    <HotkeyCapture
                      value={selectionHotkey}
                      onChange={applySelectionHotkey}
                    />
                  </Row>
                  {selectionHotkeyError && (
                    <div
                      style={{
                        marginTop: -2,
                        padding: "4px 0",
                        fontFamily: T.sans,
                        fontSize: 12,
                        color: T.red,
                        textAlign: "right",
                      }}
                    >
                      {selectionHotkeyError}
                    </div>
                  )}
                  <div
                    style={{
                      fontFamily: T.sans,
                      fontSize: 12,
                      color: T.fg2,
                      lineHeight: 1.5,
                    }}
                  >
                    Copy text in any app, then press this to summarize,
                    rewrite, fix or explain it — or type your own
                    instruction for it.
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
                        fontFamily: T.sans,
                        fontSize: 12,
                        color: T.red,
                        textAlign: "right",
                      }}
                    >
                      {screenshotHotkeyError}
                    </div>
                  )}
                  <div
                    style={{
                      fontFamily: T.sans,
                      fontSize: 12,
                      color: T.fg2,
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

          {/* ── Models: the app's default, in plain names ───────── */}
          {activeTab === "models" && (
            <ModelsSettings
              defaultModel={defaultModel}
              onDefaultModel={onDefaultModel}
              spaces={spaces}
              onOpenAdvanced={() => setActiveTab("advanced")}
            />
          )}

          {/* ── Advanced: what only makes sense if you know how the app
              works underneath. Was the Backend, Models and Files tabs. ── */}
          {activeTab === "templates" && (
            <TemplatesSettings
              templates={templates}
              onSave={onSaveTemplate}
              onDelete={onDeleteTemplate}
              onDuplicate={onDuplicateTemplate}
              onToggleStar={onToggleTemplateStar}
              onChanged={onPromptsChanged}
              openRequest={templateRequest}
            />
          )}

          {activeTab === "watches" && (
            <div data-watches-settings style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <div style={{ fontFamily: T.sans, fontSize: 17, fontWeight: 600, color: T.fg }}>Watches</div>
                <div style={ekHint({ fontSize: 12.5, marginTop: 3 })}>
                  A watch keeps an eye on a folder and summarises each new
                  file into a notes file, using a template you choose.
                </div>
              </div>
              {watchesPane}
            </div>
          )}

          {activeTab === "privacy" && (
            <PrivacySettings
              backendKind={backendKind}
              baseUrl={backendBaseUrl}
              nameOfModel={nameOfModel}
              modelLabels={modelLabels}
            />
          )}

          {activeTab === "advanced" && (
            <>
              <SectionLabel label="Engine and servers" />
              <BackendSettings />

              <SectionLabel label="Every model" />
              {/* ModelManagerPanel lives in model-manager.jsx: the whole
                  catalog, a model from a link, and removal. */}
              <ModelManagerPanel activeModel={defaultModel || "gemma4:latest"} />

              <SectionLabel label="Attachments" />
              <div
                style={{
                  fontFamily: T.sans,
                  fontSize: 12,
                  color: T.fg2,
                  lineHeight: 1.5,
                  marginBottom: 4,
                }}
              >
                Large files and folders get chunked and embedded with the model
                below. Changing the model requires re-indexing — a banner will
                appear with a one-click action when chunks go stale.
              </div>
              <AttachmentsSettings />

              <SectionLabel label="Replies" />
              <Row label="Show technical details">
                <Toggle
                  value={tweaks.showDetails}
                  onChange={(v) => setTweak("showDetails", v)}
                />
              </Row>
            </>
          )}

          {/* ── Voice tab ─────────────────────────────────────────── */}
          {activeTab === "voice" && (
            <>
              <SectionLabel label="Voice input" />
              <div
                style={{
                  fontFamily: T.sans,
                  fontSize: 12,
                  color: T.fg2,
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

// ── Engine settings (0.8.0) ─────────────────────────────────────────────────
// The bundled engine's two user settings, inside Settings → Backend's
// engine card: the context window and Thinking. Each control saves the
// moment it changes (`engine_tuning_set` persists + applies in Rust) —
// independent of the Backend tab's own Save button, which only picks the
// backend. Rust answers with the status it applied; that goes back to the
// card (`onChanged`) and out on `ekorbia:engine-tuning`, which App listens
// for so the token footer's budget and the send pre-flight follow at once.
//
// What "applies" means, so the hints stay honest: a new window takes a
// model reload, which the engine does by itself on the next message (never
// under a reply in flight); Thinking is a per-request opt-in, so it takes
// effect on the next message with no reload. The window list and its
// default come from Rust (`chatCtxChoices` / `chatCtxDefault`) — never
// hardcode sizes here.
function EngineTuning({ info, onChanged }) {
  const invoke = getInvoke();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const choices = Array.isArray(info?.chatCtxChoices) ? info.chatCtxChoices : null;
  if (!choices || !choices.length) return null;

  const apply = async (patch) => {
    setBusy(true);
    setError(null);
    try {
      // Explicit nulls: "leave that setting alone".
      const st = await invoke("engine_tuning_set", { chatCtx: null, thinking: null, ...patch });
      if (st) {
        onChanged?.(st);
        window.dispatchEvent(new CustomEvent("ekorbia:engine-tuning", { detail: st }));
      }
    } catch (e) {
      setError(String(e?.message || e || "Couldn't save the setting."));
    }
    setBusy(false);
  };

  const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 };
  const labelStyle = { fontFamily: T.sans, fontSize: 12.5, color: T.fg };
  const hintStyle = { fontFamily: T.sans, fontSize: 12, color: T.fg2, lineHeight: 1.5, marginTop: 3 };
  const thinking = !!info.thinking;

  return (
    <div
      data-engine-tuning
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "10px 12px",
        border: `1px solid ${T.border}`,
        borderRadius: 8,
        opacity: busy ? 0.7 : 1,
      }}
    >
      <div>
        <div style={rowStyle}>
          <label htmlFor="ek-engine-ctx" style={labelStyle}>Context window</label>
          <select
            id="ek-engine-ctx"
            data-engine-ctx
            value={String(info.chatCtx)}
            disabled={busy}
            onChange={(e) => apply({ chatCtx: Number(e.target.value) })}
            style={{
              background: T.bg2,
              border: `1px solid ${T.border}`,
              borderRadius: 8,
              color: T.fg,
              fontFamily: T.sans,
              fontSize: 13,
              padding: "4px 8px",
              cursor: "pointer",
            }}
          >
            {choices.map((n) => (
              <option key={n} value={String(n)}>
                {ctxSizeLabel(n)}{n === info.chatCtxDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div style={hintStyle}>
          How much the model keeps in view at once: the chat so far, your
          message and its reply. Bigger windows use more memory, and a
          paste that fills one takes minutes to read. Takes effect on your
          next message; the model reloads once.
        </div>
      </div>

      <div>
        <div style={rowStyle}>
          <span id="ek-engine-thinking-label" style={labelStyle}>Thinking</span>
          <button
            type="button"
            role="switch"
            aria-checked={thinking}
            aria-labelledby="ek-engine-thinking-label"
            data-engine-thinking
            disabled={busy}
            onClick={() => apply({ thinking: !thinking })}
            style={{
              position: "relative",
              width: 34,
              height: 20,
              padding: 0,
              borderRadius: 10,
              background: thinking ? T.fg : T.bg4,
              border: "none",
              cursor: "pointer",
              flexShrink: 0,
              transition: "background 0.12s ease",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: thinking ? 16 : 2,
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: T.bg0,
                boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
                transition: "left 0.12s ease",
              }}
            />
          </button>
        </div>
        <div style={hintStyle}>
          Lets models that can reason think before they answer in chat —
          slower, often better on hard questions. You can open what they
          thought above each reply. The quick-query overlay and Watches
          always answer directly.
        </div>
      </div>

      {error && (
        <div data-engine-tuning-error style={{ fontFamily: T.sans, fontSize: 12.5, color: T.red }}>
          {error}
        </div>
      )}
    </div>
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
          border: `1px solid ${selected ? T.fg : T.border}`,
          boxShadow: selected ? `0 0 0 1px ${T.fg}` : "none",
          borderRadius: 10,
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
        <span style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2, lineHeight: 1.45 }}>
          {blurb}
        </span>
      </button>
    );
  };

  const inputStyle = ekField();

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
                fontFamily: T.sans,
                fontSize: 12.5,
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
                fontFamily: T.sans,
                fontSize: 12,
                color: T.fg2,
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
                style={ekBtn("secondary", { small: true })}
              >
                Reveal models folder
              </button>
            </div>
          )}
          <EngineTuning info={engineInfo} onChanged={setEngineInfo} />
          <div style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2, lineHeight: 1.5 }}>
            One chat model and one embedding model stay loaded at a time;
            switching models swaps automatically and idle models unload
            after ~10 minutes. Vision works when a model has a matching
            projector file (<span style={{ fontFamily: T.sans }}>name.mmproj.gguf</span>)
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
              style={ekBtn("secondary", { disabled: testState === "testing" })}
            >
              {testState === "testing" ? "Testing…" : "Test connection"}
            </button>
            {testState && testState !== "testing" && (
              <span
                data-backend-test-result
                style={{
                  fontFamily: T.sans,
                  fontSize: 12.5,
                  color: testState.ok ? T.green : T.red,
                }}
              >
                {testState.ok
                  ? `✓ Reachable — ${testState.models} model${testState.models === 1 ? "" : "s"}`
                  : `✗ ${testState.error || "Unreachable"}`}
              </span>
            )}
          </div>
          <div style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2, lineHeight: 1.5 }}>
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
          style={ekBtn("primary")}
        >
          Save
        </button>
        {saveState === "saved" && (
          <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.green }}>
            ✓ Applied — takes effect on the next message
          </span>
        )}
        {saveState && saveState !== "saved" && (
          <span data-backend-save-error style={{ fontFamily: T.sans, fontSize: 12.5, color: T.red }}>
            {saveState}
          </span>
        )}
      </div>
    </div>
  );
}
