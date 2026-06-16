// main.jsx — Ekorbia top-level

const { useState: useS, useEffect: useE, useRef: useR } = React;

// Theme palettes. Each theme defines all tokens that can plausibly invert
// between light and dark — bg0..bg4, fg/fg1..fg3, border/borderStrong,
// amber. Applied via Object.assign(T, ...) below.
const THEMES = {
  one_dark: {
    bg0:'#0a0a0c', bg1:'#15151a', bg2:'#1c1c22', bg3:'#272730', bg4:'#33333d',
    fg:'#e6e3dc', fg1:'#b8b4ab', fg2:'#8a877e', fg3:'#5e5c54',
    border:'#2e2e38', borderStrong:'#3d3d48',
    amber:'#d48a50', label:'one dark',
  },
  one_light: {
    bg0:'#fafafa', bg1:'#f0f0f0', bg2:'#e7e7e7', bg3:'#d8d8d8', bg4:'#c4c4c4',
    fg:'#383a42', fg1:'#5c5f66', fg2:'#828489', fg3:'#a0a1a7',
    border:'#d4d4d4', borderStrong:'#bcbcbc',
    amber:'#b15c13', label:'one light',
  },
  ayu_dark: {
    bg0:'#0d1017', bg1:'#131721', bg2:'#1b202a', bg3:'#232a35', bg4:'#2d3540',
    fg:'#bfbdb6', fg1:'#9a9890', fg2:'#787570', fg3:'#5a5852',
    border:'#262d38', borderStrong:'#3a4150',
    amber:'#e6b450', label:'ayu dark',
  },
  ayu_mirage: {
    bg0:'#1f2430', bg1:'#232834', bg2:'#2a2f3d', bg3:'#343a4b', bg4:'#3d4456',
    fg:'#cccac2', fg1:'#b3b1a8', fg2:'#8a8780', fg3:'#5c6773',
    border:'#2d3340', borderStrong:'#3d4456',
    amber:'#ffcc66', label:'ayu mirage',
  },
  ayu_light: {
    bg0:'#fcfcfc', bg1:'#f3f4f5', bg2:'#e8eaeb', bg3:'#dcdfe2', bg4:'#c8ccd0',
    fg:'#5c6166', fg1:'#787c80', fg2:'#959a9f', fg3:'#b3b8bd',
    border:'#dcdfe2', borderStrong:'#bcc0c5',
    amber:'#fa8d3e', label:'ayu light',
  },
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "one_dark",
  "fontScale": 1.0,
  "density": "comfortable",
  "showStatusBar": true
}/*EDITMODE-END*/;

// ── Helper functions ──────────────────────────────────────────────────────────
//
// bucketChatsByDate lives in ui/utils.js (unit-tested under node:test).
// It returns `{ dateSections }` — the Today/Yesterday/Last 7 days/Last 30
// days/Older bucketing of chats. Per-Space filtering happens BEFORE the
// helper is called (in the mount effect and reload helpers below), so
// this function only ever sees the chats that belong in the active view.
//
// relativeTime, tryParseJson, genId also live in `ui/utils.js`. All of
// these are on `window` before main.jsx loads (script-tag order in
// ui/index.html), so they're available as bare names below.

// EMPTY_HISTORY is the canonical empty sidebar shape. Used as the initial
// state, the "wipe all chats" reset value, and the safe fallback when a
// load fails. Keeping it as a const (rather than constructing inline at
// each callsite) makes the shape easy to grep for during refactors.
const EMPTY_HISTORY = { dateSections: [] };

// Stable empty fallback for the Composer's lockedPromptSlugs prop. Hoisted
// so the prop reference is reference-equal across renders when the chat
// has no Space (or its Space has no locked pins) — keeps React.memo
// children from re-rendering on every parent update.
const EMPTY_LOCKED_SET = new Set();

// Does any date section in `hs` contain a chat with this id? Used to
// short-circuit prepend-to-sidebar mutations so we don't double-add a chat
// that's already represented (race between handleSend's setHistory and the
// overlay:open_chat listener firing during the same tick).
function sidebarContainsChatId(hs, chatId) {
  return (hs.dateSections || []).some((s) => s.items.some((c) => c.id === chatId));
}

// Prepend a sidebar-item to the Today date section, creating the section
// if it doesn't exist yet. Brand-new chats from the composer or overlay
// always start at the top of Today; the user can move them into a Space
// via drag-and-drop or the right-click "Move to Space" submenu.
function prependChatToToday(hs, item) {
  const dateSections = hs.dateSections || [];
  const todayIdx = dateSections.findIndex((s) => s.section === 'Today');
  if (todayIdx >= 0) {
    return {
      ...hs,
      dateSections: dateSections.map((s, i) =>
        i === todayIdx ? { ...s, items: [item, ...s.items] } : s,
      ),
    };
  }
  return {
    ...hs,
    dateSections: [{ section: 'Today', items: [item] }, ...dateSections],
  };
}

// Apply `mapItem` to every chat-item across all date sections. Used by
// renameChat to update a chat's title wherever it lives.
function mapItemsAcrossHistory(hs, mapItem) {
  return {
    dateSections: (hs.dateSections || []).map((s) => ({
      ...s,
      items: s.items.map(mapItem),
    })),
  };
}

// Remove a single chat from history. Empty date sections are pruned so
// the sidebar doesn't show a "Today" header with no items underneath.
function removeChatFromHistory(hs, chatId) {
  return {
    dateSections: (hs.dateSections || [])
      .map((s) => ({ ...s, items: s.items.filter((c) => c.id !== chatId) }))
      .filter((s) => s.items.length),
  };
}

// Persist a piece of state to localStorage so it survives app restart.
// Initial value comes from localStorage if present; otherwise falls back to
// `defaultValue`. localStorage in the Tauri webview is stored in the app's
// data dir, so it persists across launches without needing SQLite for
// trivial UI state.
function usePersistedState(key, defaultValue) {
  const [value, setValue] = useS(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw);
    } catch {}
    return defaultValue;
  });
  useE(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }, [key, value]);
  return [value, setValue];
}

// Composer-model persistence. Stored as a raw string (not JSON) so the
// value is human-readable in devtools and matches the overlay's storage
// format (overlay.jsx uses `ekorbia.overlay.model` the same way).
const COMPOSER_MODEL_LS_KEY = 'ekorbia.main.model';
const COMPOSER_FALLBACK_MODEL = 'gemma4:latest';
// Hard cap on tool-call iterations within a single chat send. Each iteration
// is one round-trip to /api/chat. Without a cap a misbehaving model could
// loop indefinitely emitting tool_calls. Set conservatively — most legitimate
// flows finish in 1-3 iterations (initial response → tool call → final text).
const MAX_TOOL_ITERATIONS = 8;

function readPersistedComposerModel() {
  try {
    const stored = localStorage.getItem(COMPOSER_MODEL_LS_KEY);
    if (stored) return stored;
  } catch {}
  return COMPOSER_FALLBACK_MODEL;
}

// Write the user's preferred default model to localStorage. Called ONLY
// when the user explicitly picks a model via the Composer dropdown — not
// when opening a historical chat (that would drift the default away
// from what the user actually prefers).
function persistComposerModel(id) {
  try { localStorage.setItem(COMPOSER_MODEL_LS_KEY, id); } catch {}
}

// ── Output-dir permission modal ───────────────────────────────────────────
//
// Fires the first time a chat's model tries to use the write_file tool with
// no `output_dir` set. The Rust side emits `chat:needs_output_dir` and
// suspends the tool call until the user makes a choice via chat_set_output_dir.
//
// Three resolutions:
//   Allow         — set output_dir = props.suggested (Rust-supplied default,
//                    typically ~/Documents/Ekorbia/Outputs/<slug>/)
//   Choose folder — opens the dialog plugin so the user picks a custom path
//   Block always  — set output_dir = "" (sentinel that suppresses the modal
//                    for future tool calls in this chat; surfaces as a
//                    warn toast on subsequent attempts)
//
// The component is hoisted to module scope per CLAUDE.md's "modal components
// must be hoisted" rule — defining it inside App would cause focus loss on
// every keystroke as React tears down + remounts on each parent render.
function OutputDirModal({ chatId, chatTitle, suggested, onClose, invoke }) {
  const [chosen, setChosen] = useS(suggested || '');

  const submit = async (dir) => {
    try {
      await invoke('chat_set_output_dir', { chatId, dir });
      onClose(dir);
    } catch (e) {
      window.ekToast?.({
        kind: 'error',
        title: 'Could not set output folder',
        body: String(e),
      });
    }
  };

  const pickFolder = async () => {
    const dialogApi = getDialogApi();
    if (!dialogApi) return;
    try {
      const picked = await dialogApi.open({
        directory: true,
        multiple: false,
        defaultPath: chosen || undefined,
      });
      if (typeof picked === 'string' && picked) setChosen(picked);
    } catch (_) { /* user cancelled */ }
  };

  return (
    <div
      role="dialog"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 440, padding: 18,
          background: T.bg1,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 10,
          fontFamily: T.sans,
          color: T.fg,
          boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ fontFamily: T.serif, fontSize: 18, marginBottom: 6 }}>
          Allow this chat to save files?
        </div>
        <div style={{ color: T.fg1, fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
          The model in <em>{chatTitle || 'this chat'}</em> wants to write files
          to a folder. Files will be saved to this directory — nothing outside it.
        </div>
        <label style={{ display: 'block', color: T.fg2, fontSize: 11, marginBottom: 4 }}>
          Output folder
        </label>
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          <input
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
            spellCheck={false}
            style={{
              flex: 1, padding: '6px 8px',
              background: T.bg2,
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              color: T.fg,
              fontFamily: T.mono,
              fontSize: 12,
            }}
          />
          <button
            onClick={pickFolder}
            style={{
              padding: '0 10px',
              background: T.bg2,
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              color: T.fg1,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >Browse…</button>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={() => submit('')}
            title="Block file writes from this chat. The model will see an error and can adjust."
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              color: T.fg2,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >Block always</button>
          <button
            onClick={() => onClose(null)}
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              color: T.fg2,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >Not now</button>
          <button
            onClick={() => submit(chosen)}
            disabled={!chosen}
            style={{
              padding: '6px 14px',
              background: chosen ? T.amber : T.bg3,
              border: 'none',
              borderRadius: 5,
              color: chosen ? T.bg0 : T.fg3,
              cursor: chosen ? 'pointer' : 'not-allowed',
              fontSize: 12,
              fontWeight: 600,
            }}
          >Allow</button>
        </div>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  // Fallback to a rejecting stub so call sites can `await invoke(...)`
  // unconditionally — non-Tauri (pure-browser dev) has no IPC bridge.
  const invoke = getInvoke() ?? (() => Promise.reject('no tauri'));

  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const theme = THEMES[tweaks.theme] || THEMES.one_dark;

  // Apply theme tokens to T (mutate in place — components read T at render).
  // Includes fg1/fg2/fg3 + border tokens so light themes don't end up with
  // dark-theme borders and washed-out muted text on a white background.
  Object.assign(T, {
    bg0: theme.bg0, bg1: theme.bg1, bg2: theme.bg2, bg3: theme.bg3, bg4: theme.bg4,
    fg: theme.fg, fg1: theme.fg1, fg2: theme.fg2, fg3: theme.fg3,
    border: theme.border, borderStrong: theme.borderStrong,
    amber: theme.amber,
  });

  // Tabs (multi-chat). The welcome tab is the empty "new chat" the user
  // sees at startup. Its id is freshly generated each launch — a literal
  // string like 'welcome' would collide with any chat the user previously
  // saved from a prior welcome tab, leaving the sidebar entry unable to
  // re-open into the editor (the empty in-memory chat would shadow the
  // saved messages). Using `useRef(() => genId())` would also work but
  // useState's lazy initialiser already runs exactly once.
  const welcomeIdRef = useR(null);
  if (welcomeIdRef.current === null) welcomeIdRef.current = genId();
  const welcomeId = welcomeIdRef.current;
  const [tabs, setTabs] = useS(() => [
    { id: welcomeIdRef.current, title: 'New chat', model: readPersistedComposerModel() },
  ]);
  const [activeTab, setActiveTab] = useS(welcomeId);
  const [sidebarOpen, setSidebarOpen] = usePersistedState('ekorbia.sidebar.open', true);
  const [rightPanelOpen, setRightPanelOpen] = usePersistedState('ekorbia.rightpanel.open', true);
  const [sidebarWidth, setSidebarWidth] = usePersistedState('ekorbia.sidebar.width', 220);
  const [rightPanelWidth, setRightPanelWidth] = usePersistedState('ekorbia.rightpanel.width', 380);
  // Which tab is showing in the right panel: 'prompts' or 'watches'.
  const [rightPanelTab, setRightPanelTab] = usePersistedState('ekorbia.rightpanel.tab', 'prompts');
  const sidebarStartRef = useR(220);
  const rightPanelStartRef = useR(380);
  // Bumped every time a new watch is created so the WatchPanel reloads its
  // list. Lets the modal-created-watch flow stay one-way (modal → panel)
  // without lifting the watches state up to the App.
  const [watchPanelRefreshKey, setWatchPanelRefreshKey] = useS(0);
  // Transient "the user just clicked an OS notification for this watch"
  // signal. Bumping `key` triggers a useEffect in WatchPanel that sets the
  // panel filter to `watchId`. Set by the notification-hint listener below
  // when a window-focus event arrives within 5s of a hint — see the
  // explanatory comment in flush_notify_batch on the Rust side.
  const [watchFocusFilter, setWatchFocusFilter] = useS({ watchId: null, key: 0 });
  const notificationHintRef = useR({ watchId: null, ts: 0 });
  // OS notification permission state — 'granted' / 'default' / null
  // (still checking). The plugin's isPermissionGranted() returns a bool;
  // we keep the tri-state for the modal's UI logic. Checked once at
  // startup, re-checked whenever WatchModal calls refreshNotifPermission
  // after the user clicks "Request permission". On non-Tauri (dev) and
  // on plugin errors, we fail-open as 'granted' so the strip doesn't
  // get stuck blocking the UI.
  const [notifPermission, setNotifPermission] = useS(null);
  const refreshNotifPermission = React.useCallback(async () => {
    const notifApi = getNotificationApi();
    if (!notifApi?.isPermissionGranted) {
      setNotifPermission('granted');
      return;
    }
    try {
      const granted = await notifApi.isPermissionGranted();
      setNotifPermission(granted ? 'granted' : 'default');
    } catch (e) {
      console.error('isPermissionGranted failed:', e);
      setNotifPermission('granted');
    }
  }, []);
  useE(() => { refreshNotifPermission(); }, [refreshNotifPermission]);
  // seedKey/seedText drive the Composer's pre-fill on demand. The key is a
  // counter, not a boolean, so each "seed me" event is distinct — React's
  // useEffect inside Composer only seeds when this changes.
  const [composerSeedKey, setComposerSeedKey] = useS(0);
  const [composerSeedText, setComposerSeedText] = useS("");
  const [query, setQuery] = useS('');
  // Full-text-search hits across message content. Populated by a debounced
  // call to the Rust `search_chats` command whenever `query` changes; an
  // empty list both at startup (no query) and during the debounce window.
  const [messageHits, setMessageHits] = useS([]);
  // Default-selected prompt: just the first one the backend returns.
  // Hardcoding a slug here would silently break if the user deletes it.
  const [selectedPromptId, setSelectedPromptId] = useS(null);
  // Empty until the file-system-backed `prompts_list` resolves on mount.
  // Built-ins are seeded by Rust at startup so this won't stay empty long.
  const [prompts, setPrompts] = useS([]);
  // Per-chat attached-prompts map. Each tab has its own attached set;
  // switching tabs swaps what the Composer chip strip shows. Parallel
  // to chatAttachments above — sparse, keyed by chatId. Hydrated on
  // openChatInTab from the last user message's promptsJson so reopening
  // an old chat lands on the same setup the user left it in.
  //
  // Mutator helpers below operate on the active tab's slice. External
  // sites that need to set a specific chat's slice (overlay handoff,
  // watch-notes flow, prompt deletion) use setAttachedPromptsByChat
  // directly with a function updater.
  const [attachedPromptsByChat, setAttachedPromptsByChat] = useS({});
  const attachedPromptIds = attachedPromptsByChat[activeTab] || [];
  const attachedPrompts = attachedPromptIds.map(id => prompts.find(p => p.id === id)).filter(Boolean);
  const togglePromptAttach = (p) => {
    setAttachedPromptsByChat(m => {
      const curr = m[activeTab] || [];
      const next = curr.includes(p.id) ? curr.filter(x => x !== p.id) : [...curr, p.id];
      return { ...m, [activeTab]: next };
    });
  };
  const detachPrompt = (id) => {
    setAttachedPromptsByChat(m => ({
      ...m,
      [activeTab]: (m[activeTab] || []).filter(x => x !== id),
    }));
  };

  // ── Chat attachments ──────────────────────────────────────────────────────
  // Map of chatId → Attachment[] mirrors the Rust `attachments` table. The
  // map is sparse — only chats the user has interacted with this session
  // appear. `attachment_list` is called lazily when a chat opens (see
  // openChatInTab) so old chats reload their attachments correctly.
  const [chatAttachments, setChatAttachments] = useS({});
  const attachments = chatAttachments[activeTab] || [];
  // In-memory caches of model → capability bits. Populated by
  // model_capabilities; gate the "VISION" / "TOOL" badges and are
  // checked before encoding base64 / enabling write_file tool injection
  // (the Rust side double-checks anyway).
  const [modelVisionMap, setModelVisionMap] = useS({});
  const [modelToolsMap, setModelToolsMap] = useS({});
  // Thinking-capable (reasoning) models — qwen3.x, deepseek-r1, gpt-oss, …
  // Ollama auto-enables thinking on these, so we send `think: false` to
  // keep chat snappy. The map gates that flag: sending `think` to a
  // non-thinking model is a 400 error, so we ONLY set it when true here.
  const [modelThinkingMap, setModelThinkingMap] = useS({});
  const activeModelHasVision = !!modelVisionMap[modelId];
  const activeModelHasTools = !!modelToolsMap[modelId];

  // Permission-modal state for the write_file tool. Set when Rust emits
  // chat:needs_output_dir (the model tried to write but the chat has no
  // output_dir picked yet). Cleared on user choice or dismissal.
  const [outputDirReq, setOutputDirReq] = useS(null); // { chatId, chatTitle, suggested } | null
  // When handleSend's tool loop hits `permission_required`, it awaits the
  // user's modal choice via this ref. The modal's onClose populates it
  // with the resolution: a path string (Allow), "" (Block always), or
  // null (Not now / dismissed). Single-shot — cleared on resolve.
  const outputDirResolverRef = useR(null);
  // Tool schemas fetched once from Rust so we can pass them in the /api/chat
  // request body. Loaded lazily on first tool-capable send.
  const toolSchemasRef = useR(null);

  // Embedding-model-change banner state. `staleAttachments` is the number
  // of attachments whose chunks were embedded with a model other than the
  // currently-configured one. When > 0, a banner above the chat offers a
  // one-click reindex. Re-checked on every attachment status_changed event
  // plus a low-frequency poll to catch settings changes.
  const [staleAttachments, setStaleAttachments] = useS({ count: 0, currentModel: '' });
  const [reindexingStale, setReindexingStale] = useS(false);
  const refreshStaleCount = async () => {
    try {
      const r = await invoke('embedding_stale_count');
      setStaleAttachments(r || { count: 0, currentModel: '' });
    } catch {
      // Quiet — banner just won't appear.
    }
  };
  useE(() => {
    refreshStaleCount();
    const iv = setInterval(refreshStaleCount, 15000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onReindexAllStale = async () => {
    setReindexingStale(true);
    try {
      await invoke('attachment_reindex_stale');
      // The reindex is async on the backend; status_changed events will
      // flip individual chips to 'indexing' as they kick off. We optimistically
      // clear the banner count — the next stale-count refresh will catch
      // any that legitimately failed to start.
      setStaleAttachments({ count: 0, currentModel: staleAttachments.currentModel });
    } catch (e) {
      console.error('reindex stale failed:', e);
    } finally {
      setReindexingStale(false);
    }
  };

  const refreshAttachments = async (chatId) => {
    if (!chatId) return;
    try {
      const rows = await invoke('attachment_list', { chatId });
      setChatAttachments((m) => ({ ...m, [chatId]: rows || [] }));
    } catch (e) {
      console.error('attachment_list failed:', e);
    }
  };

  // File picker → Rust persist → refresh in-memory cache. Rejection of
  // unsupported types happens in Rust; surface as a console error rather
  // than a noisy dialog (the picker filter already steers users to
  // supported types). Before persisting, we probe whether the embedding
  // model is installed — if not, the user sees a friendly hint with the
  // exact `ollama pull` command they need to run. We still PROCEED with the
  // attach so they can see the chip status and retry later.
  const onAttachFile = async () => {
    const dialogApi = getDialogApi();
    if (!dialogApi) return;
    try {
      const picked = await dialogApi.open({
        multiple: true,
        filters: [
          { name: 'Documents & images',
            extensions: ['txt', 'md', 'markdown', 'pdf', 'png', 'jpg', 'jpeg', 'webp'] },
        ],
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      if (paths.length === 0) return;
      const added = await invoke('attachment_add_files', { chatId: activeTab, paths });
      setChatAttachments((m) => ({
        ...m,
        [activeTab]: [...(m[activeTab] || []), ...(added || [])],
      }));
      // If any of the new attachments is large enough to need indexing,
      // verify the embedding model is pulled. The check is fast (one
      // /api/show call with a 3s timeout) and only fires when relevant —
      // small files / images skip it. We don't block the attach on the
      // check; the alert is just an FYI.
      const needsIndex = (added || []).some((a) => a.status === 'indexing');
      if (needsIndex) {
        try {
          const check = await invoke('embedding_model_check');
          if (check && !check.installed) {
            window.ekToast?.({
              kind: 'warn',
              title: `Embedding model "${check.model}" not installed`,
              body: `Large files won't be searchable until you run:\n    ollama pull ${check.model}\n\nThen click the chip's ↻ to retry.`,
            });
          }
        } catch (e) {
          // Silent — Ollama down, etc. The chip will eventually show 'error'.
        }
      }
    } catch (e) {
      // User-actionable errors (too big, unsupported type, missing file)
      // become a toast — never block the UI on a confirm dialog.
      console.error('attachment add failed:', e);
      window.ekToast?.({ kind: 'error', title: 'Attach failed', body: String(e) });
    }
  };

  // Folder attach. Same dialog plugin, just with `directory: true` —
  // returns a single absolute path (or array when multi-select), which we
  // hand to Rust to register a folder attachment + spawn the walker. Like
  // file attach we proactively probe the embedding model since folder
  // indexing definitely needs it.
  const onAttachFolder = async () => {
    const dialogApi = getDialogApi();
    if (!dialogApi) return;
    try {
      const picked = await dialogApi.open({
        directory: true,
        multiple: false,
      });
      if (!picked) return;
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      const added = await invoke('attachment_add_folder', { chatId: activeTab, path });
      if (added) {
        setChatAttachments((m) => ({
          ...m,
          [activeTab]: [...(m[activeTab] || []), added],
        }));
      }
      // Embedding-model check (same as onAttachFile). Folders always need
      // the model — there's no small-file fast path here.
      try {
        const check = await invoke('embedding_model_check');
        if (check && !check.installed) {
          window.ekToast?.({
            kind: 'warn',
            title: `Embedding model "${check.model}" not installed`,
            body: `Folder won't be searchable until you run:\n    ollama pull ${check.model}\n\nThen click the chip's ↻ to retry.`,
          });
        }
      } catch {}
    } catch (e) {
      console.error('attachment_add_folder failed:', e);
      window.ekToast?.({ kind: 'error', title: 'Folder attach failed', body: String(e) });
    }
  };

  const onDetachAttachment = async (id) => {
    try {
      await invoke('attachment_remove', { id });
    } catch (e) {
      console.error('attachment_remove failed:', e);
    }
    setChatAttachments((m) => ({
      ...m,
      [activeTab]: (m[activeTab] || []).filter((a) => a.id !== id),
    }));
  };

  // Re-run the embedding pipeline for one attachment. Used by the chip's
  // "retry" affordance when status === 'error'. The Rust side flips status
  // back to 'indexing' immediately and emits a status_changed event when
  // done, so the UI updates without an extra refresh here.
  const onReindexAttachment = async (id) => {
    try {
      await invoke('attachment_reindex', { id });
    } catch (e) {
      console.error('attachment_reindex failed:', e);
      window.ekToast?.({ kind: 'error', title: 'Re-index failed', body: String(e) });
    }
  };

  // Patch a single attachment's status in the per-chat map. Called from the
  // status_changed event listener; finds the matching row across all chats
  // (we don't carry chatId in the event payload — the id is globally unique).
  // For folder attachments, `done`/`total` are optional progress fields
  // that get attached to the row so the chip can render "(N/M indexed)".
  const patchAttachmentStatus = (payload) => {
    const { id, status, error, done, total, phase } = payload || {};
    if (!id) return;
    setChatAttachments((m) => {
      const next = { ...m };
      for (const k of Object.keys(next)) {
        const list = next[k];
        const idx = list.findIndex((a) => a.id === id);
        if (idx >= 0) {
          const updated = [...list];
          const prev = updated[idx];
          updated[idx] = {
            ...prev,
            status: status || prev.status,
            error: error ?? prev.error ?? null,
            // Phase 3: progress fields. `done` is the live indexed-files
            // count; mirror it into fileCount so the chip can use one
            // source of truth for both live progress and post-index
            // "N files" rendering. progressTotal is the walker's cap
            // (only known once the walk finishes).
            ...(typeof done === 'number' ? { fileCount: done } : {}),
            ...(typeof total === 'number' ? { progressTotal: total } : {}),
            // Phase 4.5: sub-phase for folder indexing — 'walking' while
            // the walker is enumerating files, 'embedding' once per-file
            // indexing starts. Cleared on terminal status transitions
            // because the chip's label logic keys off status at that point.
            ...(phase ? { phase } : {}),
            ...(status === 'ready' || status === 'error' ? { phase: null } : {}),
          };
          next[k] = updated;
        }
      }
      return next;
    });
  };

  useE(() => {
    const eventApi = getEventApi();
    if (!eventApi) return;
    let unlisten = null;
    eventApi
      .listen('attachment:status_changed', (e) => {
        if (e?.payload?.id) patchAttachmentStatus(e.payload);
        // Terminal status transitions can swing the stale count (a reindex
        // completing turns a stale attachment current). Cheap to re-check.
        if (e?.payload?.status === 'ready' || e?.payload?.status === 'error') {
          refreshStaleCount();
        }
      })
      .then((u) => { unlisten = u; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  // Screenshot capture (Phase 5). Rust spawns `screencapture -i` on hotkey
  // press; when the user finishes the selection, Rust emits this event
  // with the temp file path. We open a new chat tab with the screenshot
  // pre-attached + swap to a vision-capable model if the active one
  // doesn't have vision. User cancels of the selector are silent — no
  // event fires, so no UI work happens here.
  useE(() => {
    const eventApi = getEventApi();
    if (!eventApi) return;
    let unlisten = null;
    eventApi
      .listen('screenshot:captured', (e) => {
        const path = e?.payload;
        if (!path || typeof path !== 'string') return;
        // Indirect through the ref so we always run the latest closure
        // (reads modelId / modelVisionMap fresh, not mount-time snapshots).
        screenshotHandlerRef.current?.(path);
      })
      .then((u) => { unlisten = u; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  // Surface spawn failures from screencapture (binary missing, permissions
  // denied, etc.). User cancels never reach here — Rust just doesn't emit.
  useE(() => {
    const eventApi = getEventApi();
    if (!eventApi) return;
    let unlisten = null;
    eventApi
      .listen('screenshot:failed', (e) => {
        const msg = typeof e?.payload === 'string' ? e.payload : 'unknown error';
        window.ekToast?.({
          kind: 'error',
          title: 'Screenshot failed',
          body: msg,
        });
      })
      .then((u) => { unlisten = u; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  // First write_file tool call in a chat with no output_dir surfaces this
  // event. The Rust loop suspends the tool execution; user choice (Allow /
  // Block) feeds back via chat_set_output_dir and the tool call resumes.
  // "Not now" closes without persisting — the next tool attempt re-fires
  // the event. Multiple events arriving back-to-back collapse to the most
  // recent (last writer wins) — Rust only re-fires after a previous
  // dismissal, so this is safe.
  useE(() => {
    const eventApi = getEventApi();
    if (!eventApi) return;
    let unlisten = null;
    eventApi
      .listen('chat:needs_output_dir', (e) => {
        const p = e?.payload || {};
        if (!p.chatId) return;
        setOutputDirReq({
          chatId: p.chatId,
          chatTitle: p.chatTitle || '',
          suggested: p.suggested || '',
        });
      })
      .then((u) => { unlisten = u; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  // Notification focus-hint plumbing. Rust emits `watch:focus_hint` right
  // before showing an OS notification; we stash the watchId + timestamp in
  // a ref. The companion window-focus listener (below) reads the ref and
  // — if the focus event arrives within FOCUS_HINT_WINDOW_MS of the hint
  // — switches the right panel to Watches and filters the activity feed
  // to the firing watch. The narrow time window keeps false positives
  // (the user tabbing into Ekorbia for unrelated reasons) bounded.
  useE(() => {
    const eventApi = getEventApi();
    if (!eventApi) return;
    let unlisten = null;
    eventApi
      .listen('watch:focus_hint', (e) => {
        const watchId = e?.payload;
        if (typeof watchId === 'string' && watchId) {
          notificationHintRef.current = { watchId, ts: Date.now() };
        }
      })
      .then((u) => { unlisten = u; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  // The Tauri v2 window-focus event fires whenever the main window becomes
  // active. If a notification hint is fresh (<5s), treat this as a click-
  // through, switch tabs, and bump the focus-filter key so WatchPanel
  // applies the filter via its useEffect. Stale hints are discarded.
  useE(() => {
    const winApi = getWindowApi();
    if (!winApi) return;
    const FOCUS_HINT_WINDOW_MS = 5000;
    const current = winApi?.getCurrentWindow?.() ?? winApi?.getCurrent?.();
    if (!current?.listen) return;
    let unlisten = null;
    current
      .listen('tauri://focus', () => {
        const hint = notificationHintRef.current;
        if (!hint?.watchId) return;
        if (Date.now() - hint.ts > FOCUS_HINT_WINDOW_MS) return;
        // Consume the hint so a later unrelated focus doesn't re-trigger.
        notificationHintRef.current = { watchId: null, ts: 0 };
        setRightPanelOpen(true);
        setRightPanelTab('watches');
        setWatchFocusFilter((f) => ({ watchId: hint.watchId, key: f.key + 1 }));
      })
      .then((u) => { unlisten = u; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  // Look up capabilities (vision + tools) for a model in one round-trip,
  // caching the result in memory. Failure (Ollama down, model not pulled)
  // is treated as no-capabilities — we don't want a transient error to
  // block image attachments or disable tool use forever, so the cache only
  // records *successful* lookups. Rust still gates the actual usage.
  const probeModelCapabilities = async (model) => {
    if (!model) return;
    if (
      modelVisionMap[model] !== undefined &&
      modelToolsMap[model] !== undefined &&
      modelThinkingMap[model] !== undefined
    ) return;
    try {
      const caps = await invoke('model_capabilities', { model });
      setModelVisionMap((m) => ({ ...m, [model]: !!caps?.vision }));
      setModelToolsMap((m) => ({ ...m, [model]: !!caps?.tools }));
      setModelThinkingMap((m) => ({ ...m, [model]: !!caps?.thinking }));
    } catch (e) {
      // Silent — badges just won't show. Rust still gates encoding/tooling.
    }
  };
  useE(() => { probeModelCapabilities(modelId); }, [modelId]);

  // Chat state — keyed by tab/chat id
  const [chats, setChats] = useS(() => ({
    [welcomeIdRef.current]: { id: welcomeIdRef.current, title: 'New chat', messages: [], loaded: true },
  }));
  // Ephemeral (private-mode) chat ids. Kept in a ref so persistence helpers
  // can check it synchronously without depending on React state having
  // flushed — important during streams that span tab closure: if the user
  // closes a private tab mid-stream, chats[id] disappears from state but
  // we still want the in-flight assistant message to NOT hit the DB. The
  // ref retains the "this id is private" decision even after the chat is
  // gone from `chats`. Entries are never explicitly removed (stale ids
  // pile up, but the Set size is bounded by sessions-worth of clicks —
  // not a memory concern, and pruning would re-introduce the close-mid-
  // stream bug we just avoided).
  const ephemeralChatIdsRef = useR(new Set());
  const isEphemeralChat = (chatId) => ephemeralChatIdsRef.current.has(chatId);

  // Persistence wrappers that gate every DB write on the ephemeral flag.
  // Use these instead of `invoke('db_upsert_chat', ...)` etc. so private
  // chats genuinely never touch SQLite — not just "we tried not to".
  const persistChat = (chatPayload) => {
    if (isEphemeralChat(chatPayload.id)) return Promise.resolve();
    return invoke('db_upsert_chat', { chat: chatPayload });
  };

  // Look up the multi-model persistence fields for a chat from current
  // tabs state. Every persistChat caller spreads the result so a routine
  // single-field UPDATE (e.g. renameChat bumping title) doesn't blank
  // out the multi-pending state on the row — the Rust ON CONFLICT DO
  // UPDATE SET clause writes whatever we send. Returns {tabType: null,
  // multiModels: null} for single-mode chats, which preserves the
  // existing row's NULLs.
  const multiFieldsForChat = (chatId) => {
    // Despite the name, this returns every "pipeline-owned" column on
    // the chats row that the UI tracks per-tab and needs to round-trip
    // through persistChat — currently tabType + multiModels (compare-
    // mode) and spaceId (Spaces). Renaming would touch 5+ call sites
    // without changing behaviour; the inline comment compensates.
    const tab = tabs.find(t => t.id === chatId);
    return {
      tabType: tab?.tabType || null,
      multiModels: Array.isArray(tab?.models)
        ? JSON.stringify(tab.models)
        : null,
      // Space membership at the tab/chat level. Persists with the chat
      // row on every send so a fresh launch lands the chat back inside
      // its Space without a separate write path. `db_upsert_chat`'s SET
      // clause deliberately omits `space_id` (pinned by the P0 test
      // `upsert_chat_does_not_clobber_space_id_on_update`), so this
      // value is only written on the INSERT branch — i.e. when a chat
      // first materialises in the DB on its first send. Re-saves of an
      // existing chat preserve whatever the DB already had, even if
      // this value is null because the tab pre-dates the column.
      spaceId: tab?.spaceId || null,
    };
  };
  const persistMessage = (msgPayload) => {
    if (isEphemeralChat(msgPayload.chatId)) return Promise.resolve();
    return invoke('db_upsert_message', { msg: msgPayload });
  };
  const persistTruncate = (chatId, fromMessageId) => {
    if (isEphemeralChat(chatId)) return Promise.resolve();
    return invoke('db_truncate_chat_from', { chatId, fromMessageId });
  };
  const chat = chats[activeTab] ?? { id: activeTab, title: 'New chat', messages: [] };
  const setChat = (updater) => setChats(cs => ({
    ...cs,
    [activeTab]: typeof updater === 'function' ? updater(cs[activeTab] ?? { id: activeTab, title: 'New chat', messages: [] }) : updater,
  }));

  const [modelId, setModelId] = useS(readPersistedComposerModel);
  // Build a display object — fall back to a minimal stub for models not in the static list
  const model = MODELS_BY_ID[modelId] || { id: modelId, name: modelId, color: '#9bbf83' };
  const [streaming, setStreaming] = useS(false);
  const [ramUsed, setRamUsed] = useS(28);

  // Sidebar shape: `{ dateSections: [...] }`. dateSections holds the
  // Today/Yesterday/… bucketing of chats in the current view (already
  // filtered by activeSpaceId when one is set). See EMPTY_HISTORY and
  // the helpers above for shape details.
  const [history, setHistory] = useS(EMPTY_HISTORY);

  // ── Spaces (workspace bundles) ─────────────────────────────────────────
  //
  // `spaces` holds every Space row from `space_list` (canonical ordering:
  // sort_index ASC, created_at ASC). It's the source-of-truth for the
  // sidebar Spaces section AND for the "Move to Space" submenu.
  //
  // `activeSpaceId` is the currently-selected Space's id. `null` means
  // the "All chats" pseudo-row is active and no filter is applied. The
  // value persists across launches via localStorage so the user lands
  // back in their last Space on relaunch. If a persisted id no longer
  // resolves to a live Space (e.g. the user deleted it on another
  // machine + the DB is shared), the mount effect downgrades to `null`
  // before any Sidebar render so the sidebar never shows a stale filter.
  const [spaces, setSpaces] = useS([]);
  // Locked-pin slug index — `{ [spaceId]: Set<slug> }`. Each entry is the
  // set of prompt slugs whose `space_prompts.locked` row is 1 for that
  // Space. Used by the Composer to suppress the × on locked prompt chips
  // so the user can't detach a Space-mandated prompt from a single chat.
  // Refreshed:
  //   • on mount, immediately after `space_list`,
  //   • by `reloadHistory`, which fires after every Space mutation
  //     (create / rename / recolor / delete + `saveSpaceSettings`).
  // Spaces that aren't in the map (yet) resolve to an empty Set at the
  // Composer prop boundary, so the picker behaves as if nothing is locked
  // — safer than throwing during the brief moment between mount and load.
  const [lockedSlugsBySpace, setLockedSlugsBySpace] = useS({});
  const ACTIVE_SPACE_LS_KEY = 'ekorbia.activeSpaceId';
  const [activeSpaceId, setActiveSpaceId] = useS(() => {
    try {
      const raw = localStorage.getItem(ACTIVE_SPACE_LS_KEY);
      return raw && raw !== 'null' ? raw : null;
    } catch {
      return null;
    }
  });
  useE(() => {
    try {
      if (activeSpaceId) localStorage.setItem(ACTIVE_SPACE_LS_KEY, activeSpaceId);
      else localStorage.removeItem(ACTIVE_SPACE_LS_KEY);
    } catch {}
  }, [activeSpaceId]);

  // ── Backend load on mount ───────────────────────────────────────────────────
  // Prompts now live as Markdown files in the configured prompts directory.
  // Rust already seeds built-ins on startup, so prompts_list returns the
  // baseline set on first launch and any user additions thereafter.
  // Plain function (not useCallback) — `invoke` is recomputed every render so
  // memoizing on it would miss; we just call this from the mount effect and
  // pass it down by reference. Identity changes don't matter here.
  const refreshPrompts = async () => {
    try {
      const rows = await invoke('prompts_list');
      const mapped = rows.map((r) => ({
        ...r,
        favorite: r.favorite ?? null,
        updated: relativeTime(r.updatedAt),
      }));
      setPrompts(mapped);
      // Seed a sensible selection on first load — first item by recency.
      setSelectedPromptId((curr) =>
        curr && mapped.some((p) => p.id === curr) ? curr : (mapped[0]?.id ?? null),
      );
    } catch (e) {
      console.error('prompts_list failed:', e);
      setPrompts([]);
    }
  };

  useE(() => {
    (async () => {
      try {
        // Load chats + spaces together so the sidebar reshape sees both
        // in one pass. Promise.all keeps startup latency at max(t1, t2)
        // rather than the sum.
        const [chatRows, spaceRows] = await Promise.all([
          invoke('db_load_chats'),
          invoke('space_list'),
        ]);
        setSpaces(spaceRows || []);
        // Kick off the locked-pin index alongside Space load. Fire-and-
        // forget — `lockedSlugsBySpace` starts as {} so the Composer
        // simply treats every chip as unlocked until this lands.
        refreshLockedSlugsForAllSpaces(spaceRows || []);
        // Downgrade activeSpaceId to null if the persisted id no longer
        // resolves — protects against stale localStorage after a Space
        // was deleted on another machine (or before this build shipped).
        const liveIds = new Set((spaceRows || []).map((s) => s.id));
        const safeActiveSpace = activeSpaceId && liveIds.has(activeSpaceId) ? activeSpaceId : null;
        if (safeActiveSpace !== activeSpaceId) setActiveSpaceId(safeActiveSpace);
        const filteredChats = safeActiveSpace
          ? (chatRows || []).filter((c) => c.spaceId === safeActiveSpace)
          : (chatRows || []);
        setHistory(bucketChatsByDate(filteredChats));
        // Auto-open the most-recently-updated chat on launch so the app
        // resumes where the user left off instead of dumping them into a
        // blank "New chat". chatRows is ordered `updated_at DESC` by the
        // Rust side (see chat.rs: db_load_chats), so [0] is freshest.
        //
        // First-run / cleared-history (empty list) intentionally falls
        // through to the welcome tab the lazy useState initialisers
        // already set up — no-history users still get the friendly
        // empty composer.
        //
        // We open the historical chat then strip the welcome tab so the
        // user lands on a single tab (the loaded chat), not two. The
        // welcome id was generated fresh this launch (welcomeIdRef), so
        // it can never collide with a real persisted chat id — safe to
        // delete from `chats` unconditionally.
        if (Array.isArray(chatRows) && chatRows.length > 0) {
          const newest = chatRows[0];
          // Forward multi-model fields so a relaunch lands the user back
          // in compare mode rather than a single-model view of the same
          // chat id. multiModels is JSON on the row; parse here.
          const parsedModels = newest.multiModels
            ? tryParseJson(newest.multiModels, null)
            : null;
          try {
            await openChatInTab({
              id: newest.id,
              title: newest.title,
              model: newest.model,
              tabType: newest.tabType || null,
              models: Array.isArray(parsedModels) ? parsedModels : null,
            });
            setTabs(ts => ts.filter(t => t.id !== welcomeId));
            setChats(cs => { const n = { ...cs }; delete n[welcomeId]; return n; });
          } catch (openErr) {
            // Don't block startup on a failed auto-open — the user can
            // still click the chat in the sidebar. Leave the welcome
            // tab in place as a usable fallback.
            console.error('auto-open newest chat failed:', openErr);
          }
        }
      } catch (e) {
        console.error('chat load failed:', e);
      }
      await refreshPrompts();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  // Keyboard shortcuts
  useE(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === '\\') { e.preventDefault(); setSidebarOpen(o => !o); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Debounced full-text-search across message content. Empty query clears
  // hits immediately (no debounce — feels instant on backspace). A non-empty
  // query waits 150ms before invoking so each keystroke doesn't trigger a
  // round-trip. The Rust command sanitises the query (strips operators,
  // appends `*` for prefix matching), so we can pass it through unprocessed.
  useE(() => {
    if (!query.trim()) {
      setMessageHits([]);
      return;
    }
    const t = setTimeout(() => {
      invoke('search_chats', { query: query.trim() })
        .then((hits) => setMessageHits(Array.isArray(hits) ? hits : []))
        .catch((err) => {
          console.error('search_chats failed:', err);
          setMessageHits([]);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

  // Push the user's persisted quick-query hotkey into the OS-level binding.
  // Rust's setup() already registered the default (Super+Shift+Space) so
  // the overlay is reachable before this runs — this call re-registers
  // with the user's choice if they've customised it.
  //
  // Linux is skipped because the overlay isn't wired up there yet (Phase
  // L2). Calling register_hotkey would still register an OS-level shortcut
  // that does nothing on press — antisocial to the user's other apps.
  useE(() => {
    if (IS_LINUX) return;
    let stored = null;
    try { stored = localStorage.getItem('ekorbia.overlay.hotkey'); } catch {}
    if (stored) {
      invoke('register_hotkey', { shortcut: stored }).catch((err) => {
        console.error('Failed to apply stored hotkey, falling back:', err);
        // If the stored hotkey is now invalid (e.g. user moved OS versions
        // and the combo conflicts), Rust's startup default keeps working.
      });
    }
  }, []);

  // Same bootstrap for the screenshot hotkey (Phase 5). Rust's setup()
  // registered Super+Shift+Digit1 as the default; this call re-registers
  // with the user's customisation if any. Independent of the overlay
  // bootstrap above because register_screenshot_hotkey operates on its
  // own registry slot.
  //
  // macOS only: screencapture(1) doesn't exist on Linux / Windows yet, so
  // there's no capture pipeline to bind a hotkey to. Phases L3 / W3 will
  // wire platform-specific capture (grim+slurp / ms-screenclip:) and lift
  // this gate.
  useE(() => {
    if (!IS_MAC) return;
    let stored = null;
    try { stored = localStorage.getItem('ekorbia.screenshot.hotkey'); } catch {}
    if (stored) {
      invoke('register_screenshot_hotkey', { shortcut: stored }).catch((err) => {
        console.error('Failed to apply stored screenshot hotkey, falling back:', err);
      });
    }
  }, []);

  // First-launch onboarding gate (Phase 6). We read the completion flag
  // from app_settings — null/empty means "never finished the tour", so
  // open it. Any other value (we write "1" on completion) keeps it hidden.
  // Settings live in SQLite rather than localStorage because (a) they
  // survive an explicit localStorage wipe, and (b) the tour is something
  // we'd want to re-trigger via a one-line `setting_set` if a future
  // release reworks it substantially.
  //
  // Also expose window.ekOpenOnboarding so SettingsModal's "Show tour
  // again" button (and anything else that wants to nudge users back into
  // the tour) can reopen without lifting state up to App.
  useE(() => {
    const opener = () => setOnboardingOpen(true);
    window.ekOpenOnboarding = opener;
    invoke('setting_get', { key: 'onboarding.completed' })
      .then((v) => {
        // get_setting returns Option<String>: null when unset; we also
        // treat empty string as unset so a future "reset the tour"
        // setting_set('','') re-fires it cleanly.
        if (!v) setOnboardingOpen(true);
      })
      .catch((err) => {
        // setting_get can't fail without DB lock contention; if it
        // somehow does, fail closed (don't show) so we don't pester a
        // returning user. The Settings → Help "Show tour again" button
        // still gives them an out.
        console.error('onboarding setting_get failed:', err);
      });
    return () => {
      // Only clear if it's still our handle — defensive in case a hot
      // reload (dev) or future code installs a replacement.
      if (window.ekOpenOnboarding === opener) {
        delete window.ekOpenOnboarding;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expose window.ekOpenModelManager so any surface (composer ModelPicker
  // footer/empty-state, OllamaGate's no-model phase, Settings) can open
  // the model download/delete modal without lifting state up to App.
  // Same register/cleanup pattern as window.ekOpenOnboarding above.
  useE(() => {
    const opener = () => setModelManagerOpen(true);
    window.ekOpenModelManager = opener;
    return () => {
      if (window.ekOpenModelManager === opener) {
        delete window.ekOpenModelManager;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close handler — invoked from Skip, Get started, ⎋, and the
  // dot-indicator's last-slide Next path. Writes the completion flag
  // synchronously-ish (fire-and-forget; the worst case of a failed write
  // is the tour re-opening once more on next launch — not a data loss
  // bug, just a minor annoyance).
  const closeOnboarding = React.useCallback(() => {
    setOnboardingOpen(false);
    invoke('setting_set', { key: 'onboarding.completed', value: '1' })
      .catch((err) => console.error('onboarding setting_set failed:', err));
  }, [invoke]);

  // Persist the composer's model whenever the user changes it (via the
  // model picker, or implicitly by opening an old chat). Next launch reads
  // this back through readPersistedComposerModel(); see also the validation
  // NOTE: we deliberately do NOT auto-persist modelId to localStorage.
  // localStorage[COMPOSER_MODEL_LS_KEY] is the user's STABLE preferred
  // model for new chats; it should only change when the user explicitly
  // picks via the Composer dropdown. Opening a historical chat shifts
  // the active modelId for display, but mustn't drift the default for
  // the next "+ New chat" the user creates. See onModelChange in the
  // Composer mount below: it calls persistComposerModel(id) to update
  // both the state and the localStorage key together.

  // One-shot validation: at startup, ask Ollama what's actually pulled and
  // — if our persisted/default choice isn't installed — fall back to the
  // first available model. This is what stops a fresh install (or a new
  // machine) from sitting on `gemma4:26b` when the user has llama3 only.
  // Failures are silent: if Ollama is down, the StatusBar surfaces it and
  // the user can fix the model later via the picker.
  useE(() => {
    // Routed through the Rust `ollama_tags` command rather than direct
    // fetch — see ollama.rs comment block for the WebView2 PNA story.
    // 3s timeout is now applied Rust-side; failures throw an IPC error
    // which we swallow (the StatusBar shows the real "not running" state).
    invoke('ollama_tags')
      .then((data) => {
        const pulled = (data.models || []).map((m) => m.name);
        if (pulled.length === 0) return;
        // Use the setState callback form so this works regardless of when
        // the effect resolves relative to other state updates at mount.
        setModelId((curr) => (pulled.includes(curr) ? curr : pulled[0]));
        // Sync the welcome tab so its composer-displayed model matches.
        // We deliberately don't touch other tabs — their `model` is a
        // historical fact about the conversation, not a preference.
        setTabs((ts) =>
          ts.map((t) =>
            t.id === welcomeId && !pulled.includes(t.model)
              ? { ...t, model: pulled[0] }
              : t,
          ),
        );
      })
      .catch(() => {});
  }, []);

  const streamingRef = useR(false);
  const abortRef = useR(null);
  const streamAccumulatedRef = useR('');
  const streamMsgIdRef = useR(null);

  // ── Multi-model compare mode (Phase 3) ───────────────────────────────
  // Per-stream Maps keyed by assistant-message id. Distinct from the
  // singleton streamingRef/abortRef above, which the single-model
  // handleSend path continues to use unchanged. Each fanned-out column
  // has its own slot here:
  //   • multiStreamControllersRef.get(asstId) — AbortController for
  //     that column's fetch; deleted when the stream completes or aborts.
  //   • multiStreamAccumRef.get(asstId) — rolling content accumulator;
  //     the finalize step reads this as the last-known content when a
  //     stream completes (or aborts mid-flight). Cleared after persist.
  const multiStreamControllersRef = useR(new Map());
  const multiStreamAccumRef = useR(new Map());

  // Execute a single file write. Handles the permission-required dance:
  // when Rust emits chat:needs_output_dir, the modal renders and user
  // choice flows back via outputDirResolverRef. On Allow we retry once;
  // on Block we surface a user-blocked error; on dismiss ("Not now") the
  // call returns silently — the caller (tool loop OR heuristic save) gets
  // a refusal it can reason about, but we don't toast it (the user just
  // clicked "no").
  //
  // The `command` parameter switches between:
  //   - 'tool_write_file' (default): model-driven saves via the tool loop.
  //     chat_files.source = 'tool'.
  //   - 'chat_save_manual_file': user-driven saves via the heuristic
  //     Save buttons in chat.jsx. chat_files.source = 'manual'. Same
  //     sandbox + permission flow.
  const executeWriteFile = async (chatId, messageId, path, contents, command = 'tool_write_file') => {
    const argPath = String(path || '');
    const argContents = String(contents || '');
    const callOnce = async () => {
      const r = await invoke(command, {
        chatId, messageId, path: argPath, contents: argContents,
      });
      return {
        ok: true,
        // id is the chat_files row id, threaded through so Reveal/Open
        // affordances on the chip can call the native opener commands
        // (chat_file_reveal / chat_file_open) which take a fileId arg.
        // Without this, freshly-saved chips would lack a fileId and the
        // buttons would no-op (the JS-side absPath path was removed when
        // we abandoned the shell plugin due to its scope regex).
        id: r.id,
        relPath: r.relPath,
        bytes: r.bytes,
        version: r.version,
        absPath: r.absPath,
      };
    };
    try {
      return await callOnce();
    } catch (e) {
      const errStr = String(e);
      if (errStr.includes('permission_required')) {
        const dir = await new Promise((resolve) => {
          outputDirResolverRef.current = resolve;
        });
        if (dir === null) {
          return { ok: false, error: 'user declined to allow file saves', silent: true };
        }
        if (dir === '') {
          return { ok: false, error: 'user has blocked file saves on this chat' };
        }
        try { return await callOnce(); }
        catch (e2) { return { ok: false, error: String(e2) }; }
      }
      return { ok: false, error: errStr };
    }
  };

  // Register window.ekSaveModelFile — the heuristic-fallback bridge for
  // chat.jsx's per-block Save buttons. Calls executeWriteFile with the
  // 'manual' source command, toasts the result, and patches the
  // assistant message's toolResults so the green chip strip surfaces the
  // newly-saved file alongside any tool-driven saves. Mount-once: the
  // closure captures stable refs (setChats setter, outputDirResolverRef);
  // executeWriteFile reads through to those at call time.
  useE(() => {
    window.ekSaveModelFile = async ({ chatId, messageId, path, contents }) => {
      const result = await executeWriteFile(
        chatId, messageId, path, contents, 'chat_save_manual_file'
      );
      if (result.ok) {
        window.ekToast?.({
          kind: 'info',
          title: `Saved ${result.relPath}`,
          body: `${result.bytes} bytes · v${result.version}`,
        });
        // Mirror the live tool-write path: stash on the message so the
        // chip strip renders it like any other saved file.
        setChats(cs => {
          const c = cs[chatId];
          if (!c) return cs;
          const msgs = c.messages.map(m => {
            if (m.id !== messageId) return m;
            return {
              ...m,
              toolResults: [
                ...(m.toolResults || []),
                {
                  callId: `manual-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
                  // Same as the tool-loop chip: fileId drives the native
                  // opener commands; absPath stays for debug display only.
                  fileId: result.id,
                  relPath: result.relPath,
                  bytes: result.bytes,
                  version: result.version,
                  absPath: result.absPath,
                },
              ],
            };
          });
          return { ...cs, [chatId]: { ...c, messages: msgs } };
        });
      } else if (!result.silent) {
        window.ekToast?.({
          kind: 'warn',
          title: 'Could not save file',
          body: result.error || 'unknown error',
        });
      }
      return result;
    };
    return () => { try { delete window.ekSaveModelFile; } catch (_) {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = async (text, options = {}) => {
    // `options.baseMessages` lets edit-and-resubmit / retry pass a truncated
    // list of prior messages. React state updates (setChat) are async, so
    // these flows can't just truncate the chat then immediately call
    // handleSend — the closure here would still read the pre-truncation
    // chat.messages. Passing the truncated list explicitly bypasses that
    // race. When undefined, we fall back to the live chat.messages (the
    // normal user-typed-then-clicked-Send path).
    const baseMessages = options.baseMessages ?? chat.messages;

    // Prepare attached-file payload first so we know if there's a system
    // block to merge with the attached-prompts content and whether to pass
    // images on the user message. Returns an empty payload (no system block,
    // no images) when this chat has no attachments.
    let attachPayload = { systemBlock: '', images: [], sources: [], imagesSkipped: false };
    if (attachments.length > 0) {
      try {
        attachPayload = await invoke('attachment_prepare_for_send', {
          chatId: activeTab,
          model: modelId,
          // The user's message text — Rust embeds it and retrieves top-k
          // chunks from any large indexed attachments. Small files still
          // get inlined whole regardless of the query.
          query: text,
        }) || attachPayload;
      } catch (e) {
        console.error('attachment_prepare_for_send failed:', e);
      }
    }
    const promptSystem = attachedPrompts.map(p => p.body).join('\n\n');
    // Resolve the Space's system prompt (if this chat is inside a Space)
    // and prepend it as a first-send-only system message. Same lifecycle
    // as `promptSystem`: re-sending the same Space prompt prefix every
    // turn would waste tokens. We resolve from the LIVE spaces array, so
    // editing a Space's prompt mid-conversation only affects future
    // chats (existing chats keep what the model already saw).
    //
    // chat.spaceId is populated by openChatInTab (DB rehydration) AND by
    // newTab/confirmCompareModels (live creation). Both paths land in
    // chats[id].spaceId so this lookup is the single source of truth.
    // The Space row itself is read for its memoryPath (Space memory
    // injection below). Space framing used to be a free-form
    // `systemPrompt` field here; it's now expressed as locked pinned
    // prompts that arrive via `attachedPrompts` like any other prompt.
    const chatSpaceId = chat.spaceId || null;
    const chatSpace = chatSpaceId ? (spaces || []).find(s => s.id === chatSpaceId) || null : null;
    // `isNewChat` drives two things that are wrong for truncate-and-resend:
    //   1. Appending the chat to the sidebar `history` array — which would
    //      create a duplicate row when an edit/retry truncates everything
    //      and the chat already lives in history under the same id.
    //   2. Auto-titling from the first message text — which would clobber
    //      a chat the user has been having for a while.
    // `options.isContinuation` lets truncateAndResend explicitly say "this
    // chat already exists, don't re-do new-chat side effects" even when
    // baseMessages is empty after the truncation.
    const isNewChat = options.isContinuation ? false : baseMessages.length === 0;
    // Auto-title from the first message ONLY if the user hasn't already set
    // a custom title (via the ChatPane click-to-edit). Without this check, a
    // pre-send rename would be silently overwritten by the auto-title.
    const hasCustomTitle = chat.title && chat.title !== 'New chat';
    const title = isNewChat && !hasCustomTitle
      ? (text.trim().slice(0, 40) || 'New chat')
      : chat.title;
    const priorMessages = baseMessages.map(m => ({ role: m.role, content: m.content }));
    // Prompt system content keeps its historical "first-send-only" treatment
    // — re-sending the same prompt prefix each turn would waste tokens. The
    // attachment system block is different: its content can change between
    // turns (user adds/removes files), so it's sent every send as a fresh
    // system message right at the start.
    const promptSystemMessages = (promptSystem && isNewChat)
      ? [{ role: 'system', content: promptSystem }]
      : [];
    const attachmentSystemMessages = attachPayload.systemBlock
      ? [{ role: 'system', content: attachPayload.systemBlock }]
      : [];
    // Memory file (Phase 4a): a single user-edited markdown file injected
    // as a system message on every send. Wrapped in <user_memory> tags so
    // the model can distinguish "stuff the user wrote about themselves"
    // from the rest of the system prompt. memory_read returns null when
    // the file is missing, empty, or unreadable — in those cases we add
    // no message at all (no point burning tokens on an empty wrapper).
    // Sent every send (not first-only like prompts) because the user
    // expects "memory" to follow the conversation; if they edit memory.md
    // mid-chat, the next turn should reflect the change.
    let memoryContent = null;
    try {
      memoryContent = await invoke('memory_read');
    } catch (e) {
      console.error('memory_read failed:', e);
    }
    // Space-scoped memory (Phase 5). If the chat lives in a Space AND
    // that Space has a memory_path configured, read it and append to
    // the memory block AFTER the global memory. The Space memory
    // overlays on top — the global file sets stable facts ("I'm based
    // in Portland"), the Space file sets project-specific context
    // ("the novel's protagonist is named Maya"). Sent every send like
    // global memory, for the same "edit-and-see-it" reason.
    let spaceMemoryContent = null;
    if (chatSpace?.memoryPath) {
      try {
        spaceMemoryContent = await invoke('space_memory_read', { path: chatSpace.memoryPath });
      } catch (e) {
        console.error('space_memory_read failed:', e);
      }
    }
    const memorySystemMessages = [];
    if (memoryContent) {
      memorySystemMessages.push({
        role: 'system',
        content: `<user_memory>\n${memoryContent.trim()}\n</user_memory>`,
      });
    }
    if (spaceMemoryContent) {
      // Distinct wrapper tag so models that key off the existing tag
      // don't confuse Space memory with the global file. Same idea
      // works without strict tag handling on either side.
      memorySystemMessages.push({
        role: 'system',
        content: `<space_memory>\n${spaceMemoryContent.trim()}\n</space_memory>`,
      });
    }
    const userContent = (promptSystem && !isNewChat) ? `${promptSystem}\n\n${text}` : text;
    const nowTs = Math.floor(Date.now() / 1000);

    const userId = genId();
    const asstId = genId();
    streamMsgIdRef.current = asstId;
    streamAccumulatedRef.current = '';

    const userMsg = {
      id: userId,
      role: 'user', content: text, time: now(),
      // Resolve favorite → color here so historical messages keep their tint
      // even if the underlying prompt's favorite is later cleared or changed.
      prompts: attachedPrompts.length ? attachedPrompts.map(p => {
        const fav = p.favorite ? FAVORITE_COLOR_MAP[p.favorite] : null;
        return { id: p.id, name: p.name, color: fav?.color || null };
      }) : undefined,
    };
    // Snapshot of citation sources at send time, attached to the assistant
    // message so its Sources footer renders the right files even if the user
    // later detaches them. Undefined when there were no attachments.
    const asstSources = attachPayload.sources?.length ? attachPayload.sources : undefined;
    const asstImagesSkipped = attachPayload.imagesSkipped || undefined;

    setStreaming(true);
    streamingRef.current = true;

    setChat(c => ({
      ...c,
      title,
      messages: [
        ...c.messages,
        userMsg,
        {
          id: asstId, role: 'assistant', model: modelId, time: now(),
          content: '', streaming: true,
          sources: asstSources,
          imagesSkipped: asstImagesSkipped,
        },
      ],
    }));

    // Persist new chat and user message. For ephemeral chats:
    //   • persistChat / persistMessage are no-ops (gated on ephemeral ref)
    //   • setHistory is skipped — private chats don't appear in the
    //     sidebar history list. The tab itself still appears in the tab
    //     bar with its lock indicator (set by newPrivateTab) so the user
    //     can navigate while it's alive; closing the tab makes it gone.
    const ephemeral = isEphemeralChat(activeTab);
    if (isNewChat) {
      setTabs(ts => ts.map(t => t.id === activeTab ? { ...t, title } : t));
      if (!ephemeral) {
        // Brand-new chats from the composer always land at the top of
        // Today. The user can drag them onto a Space row (or use the
        // right-click "Move to Space" submenu) to file afterwards.
        const newItem = {
          id: activeTab, title, model: modelId, when: 'now',
          spaceId: null,
        };
        setHistory(hs => prependChatToToday(hs, newItem));
      }
      persistChat({ id: activeTab, title, model: modelId, createdAt: nowTs, updatedAt: nowTs, ...multiFieldsForChat(activeTab) }).catch(console.error);
    } else {
      persistChat({ id: activeTab, title, model: modelId, createdAt: nowTs, updatedAt: nowTs, ...multiFieldsForChat(activeTab) }).catch(console.error);
    }

    const seq = priorMessages.length;
    persistMessage({
      id: userId, chatId: activeTab, role: 'user', content: text,
      model: null, time: userMsg.time,
      tokensIn: null, tokensOut: null, tokensMs: null,
      promptsJson: userMsg.prompts ? JSON.stringify(userMsg.prompts) : null,
      seq,
    }).catch(console.error);

    // Phase B.2: streaming runs through Rust's ollama_chat_stream rather
    // than a direct fetch (WebView2 PNA gate on Windows blocks the
    // browser-side request). `abortRef` now holds the in-flight request
    // id rather than an AbortController; handleStop translates a click
    // into an invoke('ollama_chat_stream_cancel') call.
    abortRef.current = asstId;

    let accumulated = '';
    let tokensIn = 0, tokensOut = 0, startMs = Date.now();
    let ollamaOk = false;

    // Tool-use loop. When the active model supports tools (modelHasTools)
    // and the user hasn't blocked file saves on this chat (output_dir !== ''),
    // we include the write_file schema in the request. The model may
    // respond with `tool_calls`; we execute them via tool_write_file, append
    // tool-response messages, and re-fetch /api/chat. Loop terminates when
    // the model responds with no tool_calls (or MAX_TOOL_ITERATIONS hits).
    //
    // When tools are off (text-only models, or user-blocked chats), the
    // loop runs exactly once and behaves exactly like the pre-tool-use
    // streaming path — no tools field in the body, no tool_calls in the
    // response, no permission modal.

    // Build the user-role message. Vision-capable + image-attached → set
    // images: [base64,...]. The Rust side already filtered out images
    // for non-vision models, so this is safe.
    const userMessage = { role: 'user', content: userContent };
    if (attachPayload.images?.length) {
      userMessage.images = attachPayload.images;
    }

    // Resolve current output_dir up front: lets us skip including tools at
    // all when the user has explicitly blocked saves (output_dir === '').
    // NULL/undefined means "never asked" — we still pass tools through and
    // the modal fires on the first tool_call.
    let currentOutputDir = null;
    if (activeModelHasTools) {
      try { currentOutputDir = await invoke('chat_output_dir', { chatId: activeTab }); }
      catch (_) { currentOutputDir = null; }
    }
    const includeTools = activeModelHasTools && currentOutputDir !== '';
    if (includeTools && !toolSchemasRef.current) {
      try { toolSchemasRef.current = (await invoke('chat_tool_schemas')) || []; }
      catch (_) { toolSchemasRef.current = []; }
    }

    // Mutable conversation array — extended each tool iteration with the
    // assistant's tool_calls turn + the tool-result responses, then re-sent.
    // System message ordering:
    //   memory   — durable facts about the user (every send)
    //   prompts  — first-send-only system prompt(s) the user attached.
    //              This includes the Space's "locked" pinned prompts
    //              (auto-attached at chat creation, can't be detached
    //              per-chat in the composer — replaces the earlier
    //              standalone Space "system_prompt" field).
    //   attach   — attachment context for this send (top-k chunks etc.)
    //   prior    — the rolling conversation history
    //   user     — this turn's user message
    // Memory goes first because it's the most stable / general context;
    // attachments + prompts ride at the end. Ordering matters because
    // many models weight earlier system messages more heavily.
    const convoMessages = [
      ...memorySystemMessages,
      ...attachmentSystemMessages,
      ...promptSystemMessages,
      ...priorMessages,
      userMessage,
    ];

    // Accumulate across iterations for final persistence.
    // - allToolCalls: every tool_call this send produced, stored as
    //   tool_calls_json on the assistant message for history.
    // - toolResultMessages: role='tool' rows to persist after the loop.
    // - allToolResults: just the successful saves, threaded onto the
    //   live assistant message so chat.jsx can render the chip row.
    //   On chat reload, the equivalent comes from chat_files_list.
    const allToolCalls = [];
    const toolResultMessages = [];
    const allToolResults = [];

    try {
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        if (!streamingRef.current) break;
        const body = {
          model: modelId,
          messages: convoMessages,
          stream: true,
        };
        if (includeTools && toolSchemasRef.current?.length) {
          body.tools = toolSchemasRef.current;
        }
        // Reasoning models default thinking ON in Ollama, which streams a
        // long chain-of-thought into a `thinking` field we don't render —
        // so the chat looks frozen for seconds before the answer. Force it
        // off for snappy replies (helper no-ops for non-thinking models;
        // sending `think` to them is a 400).
        applyThinkPref(body, modelThinkingMap[modelId]);

        let turnContent = '';
        let turnToolCalls = [];
        // Channel<serde_json::Value>: Rust's ollama_chat_stream parses
        // each NDJSON line from Ollama into an object and forwards it
        // here. The UI's per-chunk handling is unchanged from when this
        // was inline JSON.parse() — just receives pre-parsed objects.
        const Channel = getChannel();
        const channel = new Channel();
        const consumeChunk = (obj) => {
          if (!obj) return;
          if (obj.message?.content) {
            turnContent += obj.message.content;
            accumulated += obj.message.content;
            streamAccumulatedRef.current = accumulated;
            const snap = accumulated;
            setChat(c => {
              const msgs = [...c.messages];
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: snap };
              return { ...c, messages: msgs };
            });
          }
          if (obj.message?.tool_calls?.length) {
            turnToolCalls = turnToolCalls.concat(obj.message.tool_calls);
          }
          if (obj.done) {
            // tokensIn is the prompt-eval count of the LATEST request —
            // it grows each iteration as we append tool responses, so
            // overwriting (not summing) gives a meaningful total.
            tokensIn = obj.prompt_eval_count ?? tokensIn;
            tokensOut += obj.eval_count ?? 0;
          }
        };
        channel.onmessage = consumeChunk;

        try {
          await invoke('ollama_chat_stream', {
            requestId: asstId,
            body,
            onChunk: channel,
          });
          ollamaOk = true;
        } catch (e) {
          // Rust returns Err when Ollama is unreachable / non-2xx. We
          // surface the same "ollama not running" UX the old fetch
          // failure produced — set the flag and break the tool loop.
          ollamaOk = false;
          break;
        }

        // No tool_calls? Final turn — stop.
        if (turnToolCalls.length === 0) break;

        // Tool-call turn. Push the assistant message (with tool_calls) into
        // the convo so the next request preserves the Ollama-required
        // user → assistant(tool_calls) → tool → assistant interleave.
        allToolCalls.push(...turnToolCalls);
        convoMessages.push({
          role: 'assistant',
          content: turnContent,
          tool_calls: turnToolCalls,
        });

        // Execute each tool call serially. JS-side validation is light;
        // the heavy lifting (sandbox, atomic write, chat_files row) lives
        // in the tool_write_file Rust command.
        for (const call of turnToolCalls) {
          const callId = call.id || call.function?.name || `call_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
          const name = call.function?.name;
          let args = call.function?.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (_) { args = {}; }
          }
          args = args || {};

          let result;
          if (name !== 'write_file') {
            result = { ok: false, error: `unknown tool: ${name}` };
          } else {
            result = await executeWriteFile(activeTab, asstId, args.path, args.contents);
          }

          // Toast each save (success or failure). Image-only "user
          // declined" path stays silent — the model still sees the
          // refusal in the tool result and can react.
          if (result.ok) {
            // Stash the live result so the assistant message can render
            // its file chip when the loop finishes. fileId = chat_files
            // row id; the chip uses it to call chat_file_reveal /
            // chat_file_open without needing absPath on the JS side.
            allToolResults.push({
              callId,
              fileId: result.id,
              relPath: result.relPath,
              bytes: result.bytes,
              version: result.version,
              absPath: result.absPath,
            });
            window.ekToast?.({
              kind: 'info',
              title: `Saved ${result.relPath}`,
              body: `${result.bytes} bytes · v${result.version}`,
            });
          } else if (!result.silent) {
            window.ekToast?.({
              kind: 'warn',
              title: 'Could not save file',
              body: result.error || 'unknown error',
            });
          }

          // Append the tool response to the convo for the next iteration.
          // Content must be a string per Ollama's tool-result format.
          convoMessages.push({
            role: 'tool',
            tool_call_id: callId,
            content: JSON.stringify(result),
          });
          toolResultMessages.push({ callId, content: JSON.stringify(result) });
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {}
    }

    if (!ollamaOk && streamingRef.current) {
      accumulated = `Ollama isn't running on localhost:11434. Start it with \`ollama serve\` and make sure the model "${modelId}" is pulled (\`ollama pull ${modelId}\`).`;
      streamAccumulatedRef.current = accumulated;
    }

    const elapsedMs = Date.now() - startMs;
    const finalContent = accumulated;
    const finalTokens = (tokensIn || tokensOut) ? { in: tokensIn, out: tokensOut, ms: elapsedMs } : undefined;

    setChat(c => {
      const msgs = [...c.messages];
      msgs[msgs.length - 1] = {
        ...msgs[msgs.length - 1],
        content: finalContent || msgs[msgs.length - 1].content,
        streaming: false,
        tokens: finalTokens,
        // toolResults drives the saved-file chips above the assistant text
        // in chat.jsx Message. undefined when the model didn't use tools
        // so the chip strip simply isn't rendered.
        toolResults: allToolResults.length ? allToolResults : undefined,
      };
      return { ...c, messages: msgs };
    });

    // Persist assistant message. sources_json is a JSON object wrapping
    // both the citation array and a flag for skipped images so historical
    // chats keep their "model couldn't see this image" hint even after
    // reload. Null when neither applies — keeps row size minimal for the
    // common no-attachments case.
    const sourcesBlob = (asstSources?.length || asstImagesSkipped)
      ? JSON.stringify({ items: asstSources || [], imagesSkipped: !!asstImagesSkipped })
      : null;
    // toolCallsJson captures every tool_call the model emitted during this
    // send (possibly across multiple iterations). Persisted on the single
    // assistant message id so Phase 4 can render saved-file chips above
    // the assistant text without needing to walk separate intermediate
    // assistant rows. Null when no tools were used → row stays compact.
    const toolCallsBlob = allToolCalls.length
      ? JSON.stringify(allToolCalls)
      : null;
    persistMessage({
      id: asstId, chatId: activeTab, role: 'assistant',
      content: finalContent || streamAccumulatedRef.current,
      model: modelId, time: now(),
      tokensIn: finalTokens?.in ?? null, tokensOut: finalTokens?.out ?? null, tokensMs: finalTokens?.ms ?? null,
      promptsJson: null,
      sourcesJson: sourcesBlob,
      toolCallsJson: toolCallsBlob,
      toolCallId: null,
      seq: seq + 1,
    }).catch(console.error);

    // Persist each tool-result message as its own row (role='tool',
    // tool_call_id set, content = JSON-encoded result). Sequenced AFTER
    // the assistant row to keep the on-reload ordering sensible — the
    // assistant emitted these calls before the responses came back, so
    // the order is user → assistant(+tool_calls) → tool ... → end.
    // Note: when the tool loop ran multiple iterations, all tool rows
    // collapse here at the tail. For v1 this is acceptable; full multi-
    // turn replay fidelity would need separate assistant rows per
    // iteration and is a Phase-4+ concern.
    let toolSeq = seq + 2;
    for (const tr of toolResultMessages) {
      persistMessage({
        id: `${asstId}-t-${tr.callId}`,
        chatId: activeTab,
        role: 'tool',
        content: tr.content,
        model: null,
        time: now(),
        tokensIn: null, tokensOut: null, tokensMs: null,
        promptsJson: null,
        sourcesJson: null,
        toolCallsJson: null,
        toolCallId: tr.callId,
        seq: toolSeq++,
      }).catch(console.error);
    }

    setStreaming(false);
    streamingRef.current = false;
    abortRef.current = null;
    streamMsgIdRef.current = null;
  };

  // Truncate-and-resend helper. Shared by edit-and-resubmit (`fromIdx` is
  // the edited user message, send `newText`) and retry (`fromIdx` is the
  // last user message, send its existing content). Both delete the
  // from-message and everything after it (in memory + DB), then invoke
  // handleSend with the truncated list explicitly so the closure inside
  // handleSend doesn't need React state to have flushed.
  //
  // Gated by !streaming externally; this helper assumes the caller has
  // checked. Toasts on DB failure but otherwise stays silent.
  const truncateAndResend = async (fromIdx, newText) => {
    const msgs = chat.messages;
    if (fromIdx < 0 || fromIdx >= msgs.length) return;
    const anchor = msgs[fromIdx];
    if (!anchor?.id) return;
    const truncated = msgs.slice(0, fromIdx);
    // Optimistic UI: drop the from-message + tail immediately so the
    // user gets visual confirmation. If the DB delete fails below, we
    // surface a toast — the in-memory state will be re-synced on next
    // chat reload, so a transient mismatch is acceptable.
    setChat(c => ({ ...c, messages: truncated }));
    try {
      // persistTruncate no-ops for ephemeral chats (in-memory truncate
      // above is the only work needed there). For persisted chats it
      // calls the Rust command to delete the from-message and everything
      // after it.
      await persistTruncate(activeTab, anchor.id);
    } catch (e) {
      console.error('truncate failed:', e);
      window.ekToast?.({
        kind: 'error',
        title: 'Could not redo from this point',
        body: String(e),
      });
      return;
    }
    // Re-run send with the truncated list passed in explicitly. Don't
    // await — handleSend kicks off the stream, which we want to fire-
    // and-forget the same way the composer's send does. `isContinuation`
    // tells handleSend to skip its new-chat side effects (sidebar
    // history append + auto-title) even if the truncated list is empty:
    // the chat itself still exists, we just deleted its messages.
    handleSend(newText, { baseMessages: truncated, isContinuation: true });
  };

  // Edit-and-resubmit: called from chat.jsx's Message component when the
  // user edits a past user message and clicks Save. Truncates from that
  // message (deletes it + everything after) and re-runs the send flow
  // with the new text. No-op while a stream is in progress.
  const handleEditAndResubmit = (messageId, newText) => {
    if (streamingRef.current) return;
    const text = (newText || '').trim();
    if (!text) return;
    const idx = chat.messages.findIndex(m => m.id === messageId);
    if (idx < 0) return;
    if (chat.messages[idx].role !== 'user') return;
    truncateAndResend(idx, text);
  };

  // Retry: called from chat.jsx's Message component for the most-recent
  // assistant message. Finds the user turn that preceded it and re-runs
  // from there. No-op while a stream is in progress.
  const handleRetryAssistant = () => {
    if (streamingRef.current) return;
    const msgs = chat.messages;
    // Find the last assistant message that has any content (or a saved
    // partial). Walk backwards from the end so we always operate on the
    // most-recent turn; older assistant messages should be retried via
    // edit-and-resubmit on the user message that produced them.
    let asstIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') { asstIdx = i; break; }
    }
    if (asstIdx < 0) return;
    // The user message that drove this assistant turn is the most-recent
    // user role at index < asstIdx. In practice this is asstIdx - 1, but
    // we scan defensively in case a future change interleaves system rows.
    let userIdx = -1;
    for (let i = asstIdx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { userIdx = i; break; }
    }
    if (userIdx < 0) return;
    const userText = msgs[userIdx].content || '';
    truncateAndResend(userIdx, userText);
  };

  // ── Multi-model parallel send pipeline (Phase 3) ─────────────────────
  //
  // streamModelToMessage: stream one model's response into one assistant
  // message row. Pure-ish — reads/writes only the per-stream Map slots
  // (keyed by asstId) and invokes the onChunk callback for content
  // updates. No tool-call support; the tool loop is deliberately
  // single-model only (its permission-modal interleave doesn't map to
  // N-way fan-out, and compare-mode v1 is a one-shot pick-a-winner
  // experience).
  //
  // Returns { ok, content, tokensIn, tokensOut, elapsedMs }. ok=false
  // means the fetch errored before any content arrived (Ollama not
  // running, model missing, etc) — the caller treats this as "this
  // column failed" without aborting the other columns.
  const streamModelToMessage = async ({ asstId, model, messages, onChunk }) => {
    const startMs = Date.now();
    // Phase B.2: per-column controllers map now stores the requestId
    // (asstId, which is already unique per column) rather than an
    // AbortController. handleStopMultiModel translates a stop into a
    // Rust-side cancel via invoke('ollama_chat_stream_cancel').
    multiStreamControllersRef.current.set(asstId, asstId);
    multiStreamAccumRef.current.set(asstId, '');

    let accumulated = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let ok = false;

    try {
      const Channel = getChannel();
      const channel = new Channel();
      channel.onmessage = (obj) => {
        if (!obj) return;
        if (obj.message?.content) {
          accumulated += obj.message.content;
          multiStreamAccumRef.current.set(asstId, accumulated);
          onChunk?.(asstId, accumulated);
        }
        if (obj.done) {
          // tokensIn is the prompt-eval count of the latest /api/chat
          // response. Compare-mode currently issues one fetch per
          // column (no tool loop), so this is final by definition.
          tokensIn = obj.prompt_eval_count ?? tokensIn;
          tokensOut += obj.eval_count ?? 0;
        }
      };

      // Snappy compare columns too — force thinking off for reasoning
      // models (helper gates it; `think` on a non-thinking model is a 400).
      const body = applyThinkPref({ model, messages, stream: true }, modelThinkingMap[model]);
      await invoke('ollama_chat_stream', {
        requestId: asstId,
        body,
        onChunk: channel,
      });
      ok = true;
    } catch (e) {
      // Rust returns Err on Ollama unreachable / non-2xx / network
      // failure. We treat any error here as "this column failed" so
      // sibling columns finish independently. Matches the pre-B.2
      // semantics where !resp.ok also returned ok:false without
      // aborting the rest.
      console.error(`streamModelToMessage error for ${model}:`, e);
    } finally {
      // Always clear the controller slot so the Map doesn't leak across
      // sends. The accum slot stays — handleSendMultiModel's finalize
      // step reads it as the last-known content for the persist step
      // (matters when a mid-stream cancel truncated content).
      multiStreamControllersRef.current.delete(asstId);
    }

    return {
      ok,
      content: accumulated,
      tokensIn,
      tokensOut,
      elapsedMs: Date.now() - startMs,
    };
  };

  // handleSendMultiModel: fan-out send for compare-mode tabs. Called by
  // CompareChatPane's Composer (Phase 4 wiring). Builds one user message,
  // appends N empty assistant stubs (one per model), then fires N parallel
  // streamModelToMessage calls via Promise.allSettled so one model erroring
  // doesn't kill the others.
  //
  // All N assistant rows share a `variantGroupId` and start with
  // `isPicked: null`. Phase 4's "Keep this" interaction flips one of them
  // to is_picked=1 and the siblings to 0, then the chat transitions to
  // `tabType='single-from-multi'`.
  const handleSendMultiModel = async (text) => {
    const tab = tabs.find(t => t.id === activeTab);
    const models = Array.isArray(tab?.models) ? tab.models : null;
    if (!models || models.length < 2) {
      console.error('handleSendMultiModel: tab has no model list', tab);
      return;
    }
    const trimmed = (text || '').trim();
    if (!trimmed) return;

    const baseMessages = chat.messages || [];
    const isNewChat = baseMessages.length === 0;
    // Auto-title: avoid clobbering both the literal 'New chat' default
    // AND our compare-mode 'New comparison chat' so the first send still
    // names the chat after the user's prompt.
    const hasCustomTitle =
      chat.title &&
      chat.title !== 'New chat' &&
      chat.title !== 'New comparison chat';
    const title = isNewChat && !hasCustomTitle
      ? (trimmed.slice(0, 40) || 'New comparison chat')
      : chat.title;

    // Compare-mode v2: attached prompts are now included as a system
    // message at the start of the convo so every column receives the
    // same prompt context. Attachments (file context, memory) are still
    // deferred to a future iteration — they involve the Rust retrieval
    // pipeline and don't map cleanly to a one-shot N-way comparison.
    //
    // Phase 3 (Spaces): the Space's framing reaches the model via its
    // locked pinned prompts, which auto-attach to new chats and ride
    // through `attachedPrompts` like any other prompt. Every comparison
    // column sees the same prompts (including locked pins), so the
    // comparison stays "models" not "models × prompts".
    const priorMessages = baseMessages.map(m => ({ role: m.role, content: m.content }));
    const promptSystem = attachedPrompts.map(p => p.body).join('\n\n');
    const promptSystemMessages = promptSystem
      ? [{ role: 'system', content: promptSystem }]
      : [];
    const userMessage = { role: 'user', content: text };
    const convoMessages = [
      ...promptSystemMessages,
      ...priorMessages,
      userMessage,
    ];

    const userId = genId();
    const variantGroupId = genId();
    const asstIds = models.map(() => genId());
    const userSeq = priorMessages.length;
    const nowTs = Math.floor(Date.now() / 1000);

    // Resolve favorite color → chip background here so historical
    // chats keep their tint even if a prompt's favorite is later
    // cleared. Mirrors handleSend's userMsg construction.
    const userPromptChips = attachedPrompts.length
      ? attachedPrompts.map(p => {
          const fav = p.favorite ? FAVORITE_COLOR_MAP[p.favorite] : null;
          return { id: p.id, name: p.name, color: fav?.color || null };
        })
      : undefined;
    const userMsgUi = {
      id: userId,
      role: 'user',
      content: text,
      time: now(),
      prompts: userPromptChips,
    };
    const stubAssistants = models.map((m, i) => ({
      id: asstIds[i],
      role: 'assistant',
      model: m,
      time: now(),
      content: '',
      streaming: true,
      // Carried through the persisted row + back via db_load_messages
      // so Phase 4 can render variants under one user message and
      // keepVariant can re-persist with the original seq.
      variantGroupId,
      isPicked: null,
      seq: userSeq + 1,
    }));

    setStreaming(true);

    setChat(c => ({
      ...c,
      title,
      messages: [...c.messages, userMsgUi, ...stubAssistants],
    }));

    if (isNewChat) {
      setTabs(ts => ts.map(t => t.id === activeTab ? { ...t, title } : t));
      const ephemeral = isEphemeralChat(activeTab);
      if (!ephemeral) {
        const newItem = {
          id: activeTab, title, model: models[0], when: 'now',
          tabType: tab.tabType, models, spaceId: null,
        };
        setHistory(hs => {
          // Guard against double-add: confirmCompareModels' persist may
          // race with a parallel mount-time refresh.
          if (sidebarContainsChatId(hs, activeTab)) return hs;
          return prependChatToToday(hs, newItem);
        });
      }
    }
    // Persist chat row (idempotent vs. the one confirmCompareModels
    // created — INSERT … ON CONFLICT DO UPDATE in Rust preserves the
    // original created_at and the multi_models / tab_type fields).
    persistChat({
      id: activeTab,
      title,
      model: tab.model,
      createdAt: nowTs,
      updatedAt: nowTs,
      ...multiFieldsForChat(activeTab),
    }).catch(console.error);

    // Persist the user message + N empty assistant stubs up front so
    // the variant group exists in the DB before any stream completes.
    // This means a crash / quit mid-send still leaves the variant
    // structure on disk; the user can reopen the chat and the stubs
    // remain (Phase 4 will offer "Retry empty variants" affordance).
    persistMessage({
      id: userId, chatId: activeTab, role: 'user', content: text,
      model: null, time: userMsgUi.time,
      tokensIn: null, tokensOut: null, tokensMs: null,
      // Persist attached-prompt chips on the user row so re-opening
      // the chat re-renders them above the bubble. Matches handleSend.
      promptsJson: userPromptChips ? JSON.stringify(userPromptChips) : null,
      seq: userSeq,
    }).catch(console.error);
    stubAssistants.forEach((stub) => {
      persistMessage({
        id: stub.id, chatId: activeTab, role: 'assistant',
        content: '',
        model: stub.model, time: stub.time,
        tokensIn: null, tokensOut: null, tokensMs: null,
        promptsJson: null,
        seq: userSeq + 1,
        variantGroupId,
        isPicked: null,
      }).catch(console.error);
    });

    // Per-chunk UI update. Looks up the message by id (not last-index)
    // because in compare mode the "last" message changes per-column —
    // we want each chunk to land in its own row regardless of order.
    const onChunk = (id, accumulated) => {
      setChat(c => {
        const msgs = c.messages.map(m =>
          m.id === id ? { ...m, content: accumulated } : m,
        );
        return { ...c, messages: msgs };
      });
    };

    // Finalize a single column the moment ITS stream resolves. Earlier
    // shape was forEach-after-allSettled, which gated every column's
    // "done" transition (Keep button, tokens footer) on the slowest
    // stream. With per-stream finalize the UI matches Ollama's actual
    // parallelism — fast columns flip to "done" while slow ones keep
    // streaming. Reads the multiStreamAccumRef snapshot as a fallback
    // in case `value` is null (which only happens if the promise
    // rejected before streamModelToMessage's try/catch — streamModel-
    // ToMessage normally returns a structured shape on every path).
    const finalizeColumn = (asstId, model, value) => {
      const lastAccum = multiStreamAccumRef.current.get(asstId) || '';
      multiStreamAccumRef.current.delete(asstId);

      const finalContent = value?.content || lastAccum;
      const ok = value?.ok ?? false;
      const tokensIn = value?.tokensIn ?? 0;
      const tokensOut = value?.tokensOut ?? 0;
      const elapsedMs = value?.elapsedMs ?? 0;

      const errorHint = !ok && !finalContent
        ? `(error: model ${model} unavailable or fetch failed)`
        : null;
      const renderedContent = finalContent || errorHint || '';

      setChat(c => {
        const msgs = c.messages.map(m =>
          m.id === asstId ? {
            ...m,
            content: renderedContent,
            streaming: false,
            tokens: (tokensIn || tokensOut)
              ? { in: tokensIn, out: tokensOut, ms: elapsedMs }
              : undefined,
            incomplete: errorHint ? true : undefined,
          } : m,
        );
        return { ...c, messages: msgs };
      });

      persistMessage({
        id: asstId,
        chatId: activeTab,
        role: 'assistant',
        content: renderedContent,
        model,
        time: now(),
        tokensIn: tokensIn || null,
        tokensOut: tokensOut || null,
        tokensMs: elapsedMs || null,
        promptsJson: null,
        seq: userSeq + 1,
        variantGroupId,
        isPicked: null,
      }).catch(console.error);
    };

    // Fan out. Each stream's then() finalizes its own column as soon
    // as it resolves — no waiting on siblings. allSettled at the
    // bottom only gates the global streaming=false transition (Send/
    // Stop-all UI state); per-column readiness happens earlier.
    const streams = models.map((model, i) => {
      const asstId = asstIds[i];
      return streamModelToMessage({
        asstId,
        model,
        messages: convoMessages,
        onChunk,
      }).then(
        (value) => { finalizeColumn(asstId, model, value); return value; },
        (_err) => { finalizeColumn(asstId, model, null); return null; },
      );
    });
    await Promise.allSettled(streams);

    setStreaming(false);
  };

  // handleStopMultiModel: cancel in-flight compare-mode streams.
  //   • asstId given → cancel that one column only (the others keep
  //     streaming). The aborted column's content stays as whatever
  //     accumulated so far; handleSendMultiModel's finalize step will
  //     mark it `incomplete` if no content arrived at all.
  //   • asstId absent → "Stop all" — cancel every in-flight controller
  //     and flip streaming=false immediately, since the user has
  //     explicitly given up on the whole turn.
  const handleStopMultiModel = (asstId) => {
    // Phase B.2: per-column "controllers" are now request IDs that
    // the Rust streaming command registered against. Cancellation is
    // an IPC ping to ollama_chat_stream_cancel; the running task
    // notices the flag at its next chunk boundary and exits cleanly.
    const map = multiStreamControllersRef.current;
    if (asstId) {
      const reqId = map.get(asstId);
      if (reqId) {
        invoke('ollama_chat_stream_cancel', { requestId: reqId })
          .catch(() => {});
        map.delete(asstId);
      }
      return;
    }
    for (const [, reqId] of map) {
      invoke('ollama_chat_stream_cancel', { requestId: reqId })
        .catch(() => {});
    }
    map.clear();
    setStreaming(false);
  };

  // keepVariant: the user has clicked "Keep this" on one of the compare-mode
  // columns. Flip is_picked to 1 on the chosen row and 0 on its siblings,
  // transition the tab from 'multi-pending' to 'single-from-multi', and
  // re-route the active model to the kept one so any subsequent turn goes
  // through the single-model handleSend with the picked model.
  //
  // Persistence: every variant row gets re-upserted with its original seq
  // and content but the new is_picked value. db_load_messages on a later
  // session returns them all; render-site filtering (isPicked !== 0) hides
  // the unpicked siblings from ChatPane while leaving them available in
  // the DB for a future "▸ N alternatives" disclosure (Phase 5).
  const keepVariant = (asstId) => {
    const variant = chat.messages?.find(m => m.id === asstId);
    if (!variant || !variant.variantGroupId) {
      console.error('keepVariant: target variant not found or missing group', asstId);
      return;
    }
    const groupId = variant.variantGroupId;
    const pickedModel = variant.model;
    const nowTs = Math.floor(Date.now() / 1000);

    // Snapshot the sibling rows before any state change so we have a
    // stable view of what to persist below. After setChat the variants
    // are mutated (isPicked changes) but we want the original content +
    // tokens + seq preserved on each row.
    const siblings = chat.messages.filter(m => m.variantGroupId === groupId);

    // Update chat state: flip isPicked across the group, mark the chat
    // as single-from-multi so the next render routes to ChatPane.
    setChat(c => {
      const msgs = c.messages.map(m =>
        m.variantGroupId === groupId
          ? { ...m, isPicked: m.id === asstId ? 1 : 0 }
          : m,
      );
      return { ...c, messages: msgs, tabType: 'single-from-multi' };
    });

    // Update the tab: tabType transitions and model becomes the picked
    // one so the ChatPane header + future Composer sends use it.
    setTabs(ts => ts.map(t =>
      t.id === activeTab
        ? { ...t, tabType: 'single-from-multi', model: pickedModel }
        : t,
    ));
    setModelId(pickedModel);

    // Persist the chat row's new tabType. multi_models is preserved so
    // future "▸ N alternatives" rendering knows which models participated.
    persistChat({
      id: activeTab,
      title: chat.title,
      model: pickedModel,
      createdAt: nowTs,
      updatedAt: nowTs,
      tabType: 'single-from-multi',
      multiModels: Array.isArray(chat.models) ? JSON.stringify(chat.models) : null,
    }).catch(console.error);

    // Persist each variant's new is_picked. We re-send every field
    // because db_upsert_message's ON CONFLICT DO UPDATE writes the
    // full row — partial-update would clobber content / tokens with
    // null. seq is preserved from the in-memory shape (carried over
    // by handleSendMultiModel + openChatInTab).
    siblings.forEach((v) => {
      const isPicked = v.id === asstId ? 1 : 0;
      // Preserve incomplete/sources blob shape used by the rest of the
      // codebase. For variants that already had it (errored streams),
      // re-serialise so the marker survives the upsert.
      const sourcesBlob = (v.sources?.length || v.imagesSkipped || v.incomplete)
        ? JSON.stringify({
            items: v.sources || [],
            imagesSkipped: !!v.imagesSkipped,
            incomplete: !!v.incomplete,
          })
        : null;
      persistMessage({
        id: v.id,
        chatId: activeTab,
        role: 'assistant',
        content: v.content || '',
        model: v.model,
        time: v.time,
        tokensIn: v.tokens?.in ?? null,
        tokensOut: v.tokens?.out ?? null,
        tokensMs: v.tokens?.ms ?? null,
        promptsJson: null,
        sourcesJson: sourcesBlob,
        seq: v.seq,
        variantGroupId: groupId,
        isPicked,
      }).catch(console.error);
    });
  };

  const handleStop = () => {
    // Phase B.2: cancellation is now an IPC ping to the Rust
    // streaming command — the running task checks its cancel flag at
    // each chunk boundary and exits cleanly. The await in handleSend
    // resolves, the Stopped marker gets applied below as before.
    if (abortRef.current) {
      invoke('ollama_chat_stream_cancel', { requestId: abortRef.current })
        .catch(() => {});
    }
    abortRef.current = null;
    streamingRef.current = false;
    setStreaming(false);
    setChat(c => {
      const msgs = [...c.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        // Mark the message as incomplete so the chat UI renders a
        // "Stopped" marker. `incomplete` rides on the message object in
        // memory and through sources_json on disk (see stoppedBlob below).
        msgs[msgs.length - 1] = { ...last, streaming: false, incomplete: true };
        // Persist partial content
        if (last.id) {
          // Preserve citation sources on stopped messages so the Sources
          // footer still renders for partial responses. Matches the wrapper
          // shape used in the normal-completion path above, plus an
          // `incomplete: true` flag so the marker survives a chat reload.
          // We ALWAYS serialize the blob here (even with no sources or
          // images) because the incomplete flag is itself worth persisting.
          const stoppedBlob = JSON.stringify({
            items: last.sources || [],
            imagesSkipped: !!last.imagesSkipped,
            incomplete: true,
          });
          persistMessage({
            id: last.id, chatId: activeTab, role: 'assistant',
            content: streamAccumulatedRef.current || last.content,
            model: last.model, time: last.time,
            tokensIn: null, tokensOut: null, tokensMs: null,
            promptsJson: null,
            sourcesJson: stoppedBlob,
            seq: msgs.length - 1,
          }).catch(console.error);
        }
      }
      return { ...c, messages: msgs };
    });
  };

  // Rename a chat. Updates three pieces of in-memory state (chats, tabs,
  // sidebar history) and persists via db_upsert_chat — which after the
  // INSERT…ON CONFLICT fix is safe to call on existing chats without
  // wiping their message history. Whitespace-only titles are rejected.
  const renameChat = (id, newTitle) => {
    const title = (newTitle || '').trim();
    if (!title || !id) return;
    setChats(cs => (cs[id] ? { ...cs, [id]: { ...cs[id], title } } : cs));
    setTabs(ts => ts.map(t => (t.id === id ? { ...t, title } : t)));
    setHistory(hs =>
      mapItemsAcrossHistory(hs, (it) => (it.id === id ? { ...it, title } : it)),
    );
    // Use the current tab's model if available, else fall back to whatever
    // the chats state has, else the active model. created_at is ignored on
    // the UPDATE branch of the upsert — the original survives — so passing
    // current time is harmless.
    const tab = tabs.find(t => t.id === id);
    const model = tab?.model || chats[id]?.model || modelId || '';
    const nowTs = Math.floor(Date.now() / 1000);
    persistChat({ id, title, model, createdAt: nowTs, updatedAt: nowTs, ...multiFieldsForChat(id) }).catch(console.error);
  };

  const deleteChat = (id) => {
    // Skip the DB delete for ephemeral chats — there's no row to remove.
    // The in-memory cleanup below still runs so the tab + state vanish.
    if (!isEphemeralChat(id)) {
      invoke('db_delete_chat', { id }).catch(console.error);
    }
    setHistory(hs => removeChatFromHistory(hs, id));
    setTabs(ts => {
      const next = ts.filter(t => t.id !== id);
      if (id === activeTab && next.length) setActiveTab(next[0].id);
      return next;
    });
    setChats(cs => { const n = { ...cs }; delete n[id]; return n; });
    // Drop the deleted chat's slot from the per-chat attached-prompts
    // map. Without this, the map slowly grows by one dangling entry
    // every time the user deletes a chat that had a prompt attached.
    setAttachedPromptsByChat(m => { const n = { ...m }; delete n[id]; return n; });
  };

  // Bulk wipe of every persisted chat. Called from SettingsModal's
  // Danger zone after the user confirms. The flow:
  //   1. Abort any in-flight stream the same way handleStop does, so
  //      no late setChat calls can resurrect a chat-id we're about
  //      to delete. abortRef.abort() rejects the fetch immediately
  //      and the surrounding try/catch in handleSend unwinds.
  //   2. Run db_clear_all_chats — single DELETE FROM chats; FK cascade
  //      drops messages, attachments, attachment_files,
  //      attachment_chunks, and chat_files in one shot. Files on disk
  //      are untouched.
  //   3. Reset all in-memory chat state to a fresh single new tab.
  //      Mirrors the newTab() shape so the user lands in a working
  //      compose surface instead of a blank screen.
  //   4. Clear the ephemeral-chat id set — any private tabs we just
  //      wiped were never persisted, so dropping their ids is safe.
  // Errors are re-thrown so SettingsModal can surface them via toast.
  const clearAllChats = async () => {
    if (abortRef.current) {
      // Cancel any in-flight Rust streaming chat — same channel-based
      // path as handleStop (Phase B.2).
      invoke('ollama_chat_stream_cancel', { requestId: abortRef.current })
        .catch(() => {});
      abortRef.current = null;
    }
    streamingRef.current = false;
    setStreaming(false);
    await invoke('db_clear_all_chats');
    ephemeralChatIdsRef.current.clear();
    const freshId = genId();
    const freshModel = readPersistedComposerModel();
    setHistory(EMPTY_HISTORY);
    // Groups themselves survive a "clear chats" — db_clear_all_chats only
    // wipes the chats table. Reloading from disk keeps the in-memory list
    // in sync with reality (in particular, FK SET NULL on fresh installs
    // would have already detached every chat by the time we land here).
    setTabs([{ id: freshId, title: 'New chat', model: freshModel }]);
    setChats({ [freshId]: { id: freshId, title: 'New chat', messages: [], loaded: true } });
    setActiveTab(freshId);
    // Every chat we tracked is gone; map keys would all be dangling.
    // Reset to {} so the fresh chat starts with no attached prompts
    // (per-chat default = no entry → [] via the derived getter).
    setAttachedPromptsByChat({});
  };

  // ── Sidebar reload helper ─────────────────────────────────────────────
  //
  // Re-fetch chats + Spaces and rebuild the sidebar's date-section view.
  // Called by every Space-mutating handler (create / rename / recolor /
  // delete / move) after the Rust write returns. Cheap (one SELECT for
  // chats, one for spaces; both indexed) and keeps the sidebar exactly
  // in lockstep with the DB on the next tick.
  //
  // Concurrency note: every caller awaits the invoke before touching
  // setState. If two handlers fire in quick succession (e.g. create then
  // recolor before the first refresh returns), they serialise cleanly —
  // each is a fire-and-await sequence, and React batches the setState
  // pairs naturally.
  const reloadHistory = async () => {
    try {
      const [chatRows, spaceRows] = await Promise.all([
        invoke('db_load_chats'),
        invoke('space_list'),
      ]);
      setSpaces(spaceRows || []);
      const liveIds = new Set((spaceRows || []).map((s) => s.id));
      // Stale-filter guard: if the active Space was deleted in this
      // same reload (delete-Space dispatch), drop the filter so the
      // user lands back in "All chats" rather than viewing an empty
      // list.
      const safeActiveSpace = activeSpaceId && liveIds.has(activeSpaceId) ? activeSpaceId : null;
      if (safeActiveSpace !== activeSpaceId) setActiveSpaceId(safeActiveSpace);
      const filteredChats = safeActiveSpace
        ? (chatRows || []).filter((c) => c.spaceId === safeActiveSpace)
        : (chatRows || []);
      setHistory(bucketChatsByDate(filteredChats));
      // Re-index the locked-pin slugs alongside the sidebar refresh so
      // the Composer's "suppress ×" gate stays current after every Space
      // mutation. Don't await — the sidebar shouldn't block on per-Space
      // prompt fetches, and a brief stale window (locked chip detachable
      // for ~100ms after Settings save) is preferable to a flicker.
      refreshLockedSlugsForAllSpaces(spaceRows || []);
    } catch (e) {
      console.error('reloadHistory failed:', e);
    }
  };

  // Fan out to `space_prompts_list` for every Space and rebuild the
  // `lockedSlugsBySpace` map. Each lookup is independent; Promise.all
  // keeps wall-clock at max(t_i) instead of sum. Individual failures
  // collapse to an empty Set for that Space (the lock UI silently
  // degrades to "no chip is locked" rather than crashing the modal).
  const refreshLockedSlugsForAllSpaces = async (spaceRows) => {
    const list = spaceRows || [];
    if (list.length === 0) {
      setLockedSlugsBySpace({});
      return;
    }
    try {
      const entries = await Promise.all(
        list.map(async (s) => {
          try {
            const rows = await invoke('space_prompts_list', { spaceId: s.id });
            const locked = new Set(
              (rows || [])
                .filter((r) => r && r.locked)
                .map((r) => r.promptSlug)
                .filter(Boolean),
            );
            return [s.id, locked];
          } catch (e) {
            console.error(`space_prompts_list (${s.id}) failed:`, e);
            return [s.id, new Set()];
          }
        }),
      );
      const next = {};
      for (const [id, set] of entries) next[id] = set;
      setLockedSlugsBySpace(next);
    } catch (e) {
      console.error('refreshLockedSlugsForAllSpaces failed:', e);
    }
  };

  // ── Spaces handlers ────────────────────────────────────────────────────
  //
  // Same pattern as the groups handlers: dispatch the Rust write, then
  // refresh from the backend rather than splicing in-memory state. The
  // refresh is cheap (chats + groups + spaces, all indexed) and keeps
  // the sidebar in lockstep with the DB on the next tick.
  //
  // Activating a Space (`selectSpace`) is purely client-side — it sets
  // the filter id and lets the history reshape pick it up via the
  // useEffect below. No DB write.

  const createSpace = async (name, color) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return null;
    const id = genId();
    try {
      // `space_create` returns the full SpaceRow (per Phase 1) — return
      // it to the caller so flows that want to immediately open the
      // settings dialog (the "Create & configure…" button in
      // SpaceCreateModal) have the row in hand without a follow-up
      // space_get round-trip. The id is still accessible via .id for
      // callers that only need the id.
      const newSpace = await invoke('space_create', { id, name: trimmed, color: color || null });
      await reloadHistory();
      return newSpace;
    } catch (e) {
      console.error('space_create failed:', e);
      return null;
    }
  };

  const renameSpace = async (id, name) => {
    const trimmed = (name || '').trim();
    if (!id || !trimmed) return;
    // Read the current row so the update payload preserves color +
    // system_prompt + default_model + memory_path. `space_update`'s SET
    // clause covers every editable field; supplying only `name` would
    // wipe the others on conflict.
    const current = (spaces || []).find((s) => s.id === id);
    if (!current) return;
    try {
      await invoke('space_update', {
        space: { ...current, name: trimmed, updatedAt: Math.floor(Date.now() / 1000) },
      });
      await reloadHistory();
    } catch (e) {
      console.error('space_update (rename) failed:', e);
    }
  };

  const recolorSpace = async (id, color) => {
    if (!id) return;
    const current = (spaces || []).find((s) => s.id === id);
    if (!current) return;
    try {
      await invoke('space_update', {
        space: { ...current, color: color || null, updatedAt: Math.floor(Date.now() / 1000) },
      });
      await reloadHistory();
    } catch (e) {
      console.error('space_update (recolor) failed:', e);
    }
  };

  // Delete a Space. Chats are NOT deleted — the Rust `space_delete`
  // command unfiles them (sets space_id NULL) inside a transaction. The
  // sidebar refresh that follows will drop the Space row and surface the
  // unfiled chats back under "All chats".
  const deleteSpace = async (id) => {
    if (!id) return;
    try {
      await invoke('space_delete', { id });
      // If the deleted Space was active, fall back to All chats BEFORE
      // the reload — otherwise the in-flight reload would see the stale
      // activeSpaceId and filter to an empty set for one tick.
      if (id === activeSpaceId) setActiveSpaceId(null);
      await reloadHistory();
    } catch (e) {
      console.error('space_delete failed:', e);
    }
  };

  // Apply a full settings draft from SpaceSettingsModal. The draft
  // shape is documented in shell.jsx → SpaceSettingsModal; here we:
  //   1. Persist the row-level fields via `space_update`.
  //   2. Diff the desired pinned-prompt slugs against the current row
  //      set → fire `space_prompt_remove` for vanished slugs +
  //      `space_prompt_add` for new ones.
  //   3. Diff the desired pinned-attachment (kind, path) pairs against
  //      the current rows → same shape: remove vanished, add new.
  //   4. Reload everything so the sidebar / send pipeline see the new
  //      state without an extra refresh tick.
  //
  // Failures of any individual step are logged but don't abort the
  // sequence — same fail-soft pattern used elsewhere in this file
  // (`instantiateSpacePinnedAttachments`, the Space-pinned attachment
  // dispatcher). Stopping mid-flight would leave the user with a
  // half-applied draft and no easy recovery.
  const saveSpaceSettings = async (spaceId, draft) => {
    if (!spaceId || !draft) return;
    try {
      // 1. Row-level update — name, color, system_prompt, default_model,
      // memory_path. Refresh updatedAt so the row reflects the edit.
      const rowPayload = {
        ...draft.row,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      await invoke('space_update', { space: rowPayload });

      // 2. Prompt-pin diff. Current set is what's in the DB right now
      // — re-fetch to avoid drift if a parallel save happened. The
      // diff is by slug since slugs are unique per (space, prompt).
      const currentPromptRows = await invoke('space_prompts_list', { spaceId });
      // Build two parallel maps: slug → row id (for add/remove diff) and
      // slug → current locked flag (for the locked-state diff). Two
      // separate maps keep the diff loops simple.
      const currentPromptSlugs = new Map(
        (currentPromptRows || []).map((r) => [r.promptSlug, r.id]),
      );
      const currentLockedBySlug = new Map(
        (currentPromptRows || []).map((r) => [r.promptSlug, !!r.locked]),
      );
      const desiredPromptSlugs = new Set(draft.promptSlugs || []);
      const desiredLockedSlugs = new Set(draft.lockedSlugs || []);
      // Remove rows whose slug is no longer desired.
      for (const [slug, rowId] of currentPromptSlugs) {
        if (!desiredPromptSlugs.has(slug)) {
          try {
            await invoke('space_prompt_remove', { id: rowId });
          } catch (e) {
            console.error(`space_prompt_remove ${slug} failed:`, e);
          }
        }
      }
      // Add rows for slugs that are now desired but weren't pinned.
      // Inherit the desired locked state at INSERT time so we don't fire
      // a separate space_prompt_set_locked round-trip for fresh pins.
      for (const slug of desiredPromptSlugs) {
        if (!currentPromptSlugs.has(slug)) {
          try {
            await invoke('space_prompt_add', {
              id: genId(),
              spaceId,
              promptSlug: slug,
              locked: desiredLockedSlugs.has(slug),
            });
          } catch (e) {
            console.error(`space_prompt_add ${slug} failed:`, e);
          }
        }
      }
      // Toggle the locked flag on EXISTING pins whose lock state drifted.
      // Fresh pins (just inserted above) already carry the right value;
      // this loop only catches pins that were unchanged in the
      // pinned-set diff but whose lock state changed.
      for (const [slug, rowId] of currentPromptSlugs) {
        if (!desiredPromptSlugs.has(slug)) continue; // already removed
        const wasLocked = currentLockedBySlug.get(slug) === true;
        const isLocked = desiredLockedSlugs.has(slug);
        if (wasLocked !== isLocked) {
          try {
            await invoke('space_prompt_set_locked', { id: rowId, locked: isLocked });
          } catch (e) {
            console.error(`space_prompt_set_locked ${slug} failed:`, e);
          }
        }
      }

      // 3. Attachment-pin diff. Match key is (kind, path) — same shape
      // as the modal's de-dupe. Current id is preserved through the
      // diff so we know which rows to remove.
      const currentAttachRows = await invoke('space_attachments_list', { spaceId });
      const keyOf = (a) => `${a.kind}::${a.path}`;
      const currentByKey = new Map(
        (currentAttachRows || []).map((r) => [keyOf(r), r.id]),
      );
      const desiredKeys = new Set((draft.attachments || []).map(keyOf));
      for (const [key, rowId] of currentByKey) {
        if (!desiredKeys.has(key)) {
          try {
            await invoke('space_attachment_remove', { id: rowId });
          } catch (e) {
            console.error(`space_attachment_remove ${key} failed:`, e);
          }
        }
      }
      for (const a of draft.attachments || []) {
        if (!currentByKey.has(keyOf(a))) {
          try {
            await invoke('space_attachment_add', {
              id: genId(),
              spaceId,
              kind: a.kind,
              path: a.path,
            });
          } catch (e) {
            console.error(`space_attachment_add ${keyOf(a)} failed:`, e);
          }
        }
      }

      // 4. Reload sidebar + spaces so any change (rename, recolor,
      // default-model, etc.) is reflected immediately.
      await reloadHistory();
    } catch (e) {
      console.error('saveSpaceSettings failed:', e);
      window.ekToast?.({
        kind: 'error',
        title: 'Save Space failed',
        body: String(e),
      });
    }
  };

  // Move a chat into a Space, or unfile it (pass null for `spaceId`).
  // The single write path for chats.space_id from the UI side. Mirrors
  // moveChatToGroup exactly.
  const moveChatToSpace = async (chatId, spaceId) => {
    if (!chatId) return;
    try {
      await invoke('db_move_chat_to_space', {
        chatId,
        spaceId: spaceId || null,
      });
      await reloadHistory();
    } catch (e) {
      console.error('db_move_chat_to_space failed:', e);
    }
  };

  // Resolve the active Space row (or null) for the current activeSpaceId.
  // Memoised so each render boundary that needs the row (newTab, the
  // ChatPane badge, the system-prompt prepend) doesn't repeat the find.
  const activeSpace = useMemo(
    () => (activeSpaceId ? (spaces || []).find((s) => s.id === activeSpaceId) || null : null),
    [activeSpaceId, spaces],
  );

  // Build the "starting context" for a new chat created inside a Space:
  //   • preferredModel    — Space.defaultModel if set, else the global
  //                         composer-model preference.
  //   • spaceId           — the active Space's id (or null if no Space).
  //   • promptSlugs       — pinned prompt slugs from `space_prompts_list`.
  //   • pinnedAttachments — pinned files/folders from
  //                         `space_attachments_list`. Each entry is
  //                         { id, kind: 'file'|'folder', path }. The
  //                         actual instantiation (calling
  //                         attachment_add_files / _add_folder against
  //                         the new chat) is done asynchronously by
  //                         `instantiateSpacePinnedAttachments` AFTER
  //                         the chat is on-screen, so the user sees the
  //                         empty composer immediately while the chips
  //                         materialise behind the scenes.
  // Failures of either backend call are logged + ignored — the chat
  // still creates successfully, just without that piece of Space
  // inheritance.
  const resolveSpaceContextForNewChat = async () => {
    if (!activeSpace) {
      return {
        preferredModel: readPersistedComposerModel(),
        spaceId: null,
        promptSlugs: [],
        pinnedAttachments: [],
      };
    }
    const preferred = activeSpace.defaultModel || readPersistedComposerModel();
    let promptSlugs = [];
    let pinnedAttachments = [];
    // Run both list queries concurrently — they hit different SQLite
    // tables, no dependency, and the chat-creation path waits on max(t1,
    // t2) instead of t1 + t2.
    try {
      const [promptRows, attachRows] = await Promise.all([
        invoke('space_prompts_list', { spaceId: activeSpace.id }),
        invoke('space_attachments_list', { spaceId: activeSpace.id }),
      ]);
      promptSlugs = (promptRows || []).map((r) => r.promptSlug).filter(Boolean);
      pinnedAttachments = (attachRows || []).filter((a) => a && a.path);
    } catch (e) {
      console.error('space context fetch failed:', e);
    }
    return {
      preferredModel: preferred,
      spaceId: activeSpace.id,
      promptSlugs,
      pinnedAttachments,
    };
  };

  // Thin App-scope wrapper around the module-level
  // `instantiateSpacePinnedAttachments` helper (declared at the bottom
  // of this file so it's auto-hoisted to window for the test fixture).
  // The wrapper threads the toast surface + the post-completion
  // refreshAttachments call that the App owns.
  const instantiateSpaceAttachmentsForChat = (chatId, pinned) =>
    instantiateSpacePinnedAttachments(invoke, chatId, pinned, {
      onError: (e, kind, path) => {
        console.error(`Space-pinned attachment ${kind} failed${path ? ' (' + path + ')' : ''}:`, e);
        window.ekToast?.({
          kind: 'warn',
          title: kind === 'folder'
            ? 'Space folder failed to load'
            : 'Some Space attachments failed to load',
          body: path ? `${path}: ${String(e)}` : String(e),
        });
      },
      onComplete: () => refreshAttachments(chatId),
    });

  // Activate a Space (or fall back to All chats with null). The reload
  // can't happen via a useEffect on activeSpaceId because the active id
  // has already mounted on first render — `reloadHistory` itself
  // reads `activeSpaceId` from the closure, so we must set state and
  // then re-reload using the NEW id. We pass the target id explicitly
  // (rather than relying on closure) so the reload sees the fresh value.
  const selectSpace = async (id) => {
    const next = id || null;
    if (next === activeSpaceId) return;
    setActiveSpaceId(next);
    try {
      const [chatRows, spaceRows] = await Promise.all([
        invoke('db_load_chats'),
        invoke('space_list'),
      ]);
      setSpaces(spaceRows || []);
      const filteredChats = next
        ? (chatRows || []).filter((c) => c.spaceId === next)
        : (chatRows || []);
      setHistory(bucketChatsByDate(filteredChats));
    } catch (e) {
      console.error('selectSpace reload failed:', e);
    }
  };

  // Total persisted-chat count, used for the Danger-zone confirm copy
  // ("Delete N chats?"). history is the date-bucketed sidebar shape;
  // sum item counts across sections. Ephemeral chats aren't in history
  // so they're not counted — matches the user's mental model that
  // "history" is the persisted list they see in the sidebar.
  const totalChatCount =
    (history.dateSections || []).reduce((n, s) => n + (s.items?.length || 0), 0);

  const activeTabModelId = tabs.find(t => t.id === activeTab)?.model || modelId;
  const tabModel = MODELS_BY_ID[activeTabModelId] || { id: activeTabModelId, name: activeTabModelId, color: '#9bbf83' };

  const closeTab = (id) => {
    // Pre-compute the post-close tab list so the branch decision happens
    // OUTSIDE any setState reducer. Putting genId() inside a setTabs
    // reducer would double-fire under StrictMode and mint two fresh ids
    // for the same close action.
    const next = tabs.filter(t => t.id !== id);

    if (next.length === 0) {
      // Last tab closed — spawn a fresh empty chat so the user lands on
      // a working composer. Without this, the tab bar would go empty but
      // `chat = chats[activeTab] ?? ...` (see top of App) keeps resolving
      // to the just-closed chat's entry, so ChatPane keeps rendering its
      // stale title + messages. Mirrors newTab()'s shape inline so we
      // can also drop the closed ephemeral entry in the same setChats
      // call.
      const fresh = genId();
      setTabs([{ id: fresh, title: 'New chat', model: model.id }]);
      setChats(cs => {
        const upd = {
          ...cs,
          [fresh]: { id: fresh, title: 'New chat', messages: [], loaded: true },
        };
        if (isEphemeralChat(id)) delete upd[id];
        return upd;
      });
      setActiveTab(fresh);
      // Drop the closed chat's attached-prompts slot. Closing a tab
      // doesn't reopen the chat (it's just hidden), but the per-chat
      // attached set is a session-only convenience — on reopen we
      // re-hydrate from the last user message in openChatInTab. So
      // it's safe to drop now to keep the map bounded.
      setAttachedPromptsByChat(m => { const n = { ...m }; delete n[id]; return n; });
      return;
    }

    setTabs(next);
    if (id === activeTab) setActiveTab(next[0].id);
    // For ephemeral chats, also drop the in-memory entry — they have no
    // sidebar row and no DB row, so once the tab is closed there's no way
    // to bring them back. Holding them in `chats` would just be a leak.
    // Persisted chats stay in memory because the sidebar can reopen them
    // (load-on-demand is already wired in openChatInTab).
    if (isEphemeralChat(id)) {
      setChats(cs => { const n = { ...cs }; delete n[id]; return n; });
    }
    // Drop this chat's slot from the per-chat attached-prompts map.
    // Re-hydrated from the last user message on reopen (see
    // openChatInTab). Keeps the map size bounded by open-tab count.
    setAttachedPromptsByChat(m => { const n = { ...m }; delete n[id]; return n; });
  };

  const openChatInTab = async (c) => {
    // Multi-model tabs carry their tabType + models list through to the
    // tab/chat state. bucketChatsByDate parses multiModels from JSON
    // into an array on the sidebar item, so by the time we get here
    // `c.models` is already a string[] (or null/undefined for single-
    // mode chats).
    const tabType = c.tabType || null;
    const models = Array.isArray(c.models) ? c.models : null;
    // Carry the chat's Space membership through to the in-memory tab +
    // chat state. The sidebar item already has spaceId from
    // bucketChatsByDate (utils.js); ChatPane reads chat.spaceId off
    // chats[id] to render the Space badge, and `multiFieldsForChat`
    // reads tab.spaceId on the next persistChat so the column stays
    // round-trip-stable across renames + edits.
    const spaceId = c.spaceId || null;
    if (!tabs.find(t => t.id === c.id)) {
      const baseTab = { id: c.id, title: c.title, model: c.model || modelId };
      if (tabType) baseTab.tabType = tabType;
      if (models) baseTab.models = models;
      if (spaceId) baseTab.spaceId = spaceId;
      setTabs(ts => [...ts, baseTab]);
    }
    if (!chats[c.id]?.loaded) {
      const baseChat = { id: c.id, title: c.title, messages: [], loaded: false };
      if (tabType) baseChat.tabType = tabType;
      if (models) baseChat.models = models;
      if (spaceId) baseChat.spaceId = spaceId;
      setChats(cs => ({ ...cs, [c.id]: baseChat }));
      try {
        const rows = await invoke('db_load_messages', { chatId: c.id });
        // role='tool' rows hold raw JSON tool-result payloads — useful for
        // model context on continuation but noise in the chat UI. We skip
        // them at render time; the saved-file chips are reconstructed from
        // chat_files_list instead (see below). Persisted rows remain on
        // disk so a future re-send round trip still includes them.
        const messages = rows.filter(r => r.role !== 'tool').map(r => {
          // sources_json is a JSON object { items, imagesSkipped, incomplete? };
          // null when the message had no attachments at send time. tryParseJson
          // returns undefined on failure → the spreads below preserve
          // undefined-ness. `incomplete: true` is set by handleStop when the
          // user aborted mid-generation; surfaced on the message so the chat
          // UI shows a "Stopped" marker after reload.
          const blob = r.sourcesJson ? tryParseJson(r.sourcesJson, null) : null;
          return {
            id: r.id,
            role: r.role,
            content: r.content,
            model: r.model,
            time: r.time,
            tokens: (r.tokensIn || r.tokensOut) ? { in: r.tokensIn, out: r.tokensOut, ms: r.tokensMs } : undefined,
            prompts: r.promptsJson ? tryParseJson(r.promptsJson, undefined) : undefined,
            sources: blob?.items?.length ? blob.items : undefined,
            imagesSkipped: blob?.imagesSkipped || undefined,
            incomplete: blob?.incomplete || undefined,
            // Multi-model fields carried through from the row so
            // CompareChatPane can identify variants on reload and
            // keepVariant can re-persist with the original seq.
            seq: r.seq,
            variantGroupId: r.variantGroupId || undefined,
            isPicked: r.isPicked,
          };
        });

        // Attach saved-file chips to assistant messages by walking
        // chat_files rows. Failures here don't block the chat — chips
        // just won't show. message_id may be null on legacy rows; those
        // get dropped from the chip rendering.
        try {
          const files = await invoke('chat_files_list', { chatId: c.id });
          if (Array.isArray(files) && files.length) {
            const byMsg = new Map();
            for (const f of files) {
              if (!f.messageId) continue;
              const list = byMsg.get(f.messageId) || [];
              list.push({
                callId: f.id,
                relPath: f.relPath,
                bytes: f.bytes,
                version: f.version,
                // absPath isn't on chat_files — we resolve lazily via
                // chat_file_path when the user clicks Reveal/Open.
                fileId: f.id,
              });
              byMsg.set(f.messageId, list);
            }
            for (const m of messages) {
              const list = byMsg.get(m.id);
              if (list?.length) m.toolResults = list;
            }
          }
        } catch (_) { /* chips silently absent on failure */ }

        // Preserve multi-model + Space fields on the chat after messages
        // load. Without this, the loaded: true entry would wipe tabType /
        // models / spaceId that the placeholder set above, breaking
        // compare-mode restore AND erasing the Space badge until the
        // next reload.
        setChats(cs => {
          const next = { id: c.id, title: c.title, messages, loaded: true };
          if (tabType) next.tabType = tabType;
          if (models) next.models = models;
          if (spaceId) next.spaceId = spaceId;
          return { ...cs, [c.id]: next };
        });
        // Hydrate the composer's attached-prompts slot for this chat
        // from the LAST user message's prompts metadata. We don't store
        // the composer's attached set per-chat in the DB — instead we
        // derive it from the per-message promptsJson that's already
        // there. Means: reopening an old chat lands the Composer chip
        // strip on the same prompts the user had attached when they
        // last sent a message in this chat.
        //
        // The `m[c.id] !== undefined` guard preserves any pick made
        // BEFORE the message load resolved — e.g. the overlay handoff
        // and the watch-notes "Open notes" flow both set the slot
        // synchronously before openChatInTab finishes. Without the
        // guard, their explicit pick would be overwritten when the
        // async load arrives.
        setAttachedPromptsByChat(m => {
          if (m[c.id] !== undefined) return m;
          const lastUser = [...messages].reverse().find(x => x.role === 'user');
          const ids = lastUser?.prompts?.map(p => p.id) || [];
          return { ...m, [c.id]: ids };
        });
        // Load any attachments persisted for this chat. Side-loaded so the
        // chip row reappears as the user re-enters an older conversation
        // and can be augmented before the next send.
        refreshAttachments(c.id);
      } catch (e) {
        console.error('Failed to load messages:', e);
        setChats(cs => {
          const next = { id: c.id, title: c.title, messages: [], loaded: true };
          if (tabType) next.tabType = tabType;
          if (models) next.models = models;
          return { ...cs, [c.id]: next };
        });
      }
    }
    setActiveTab(c.id);
    const m = MODELS_BY_ID[c.model];
    if (m) setModelId(m.id);
  };

  // ── Overlay "Send to main" handoff ──────────────────────────────────────────
  // The overlay window already inserted the chat + messages into the DB;
  // we just need to update in-memory state (sidebar history + a fresh tab).
  // The listener is registered once at mount and routes through a ref so
  // the body always sees current closures of openChatInTab.
  const openChatInTabRef = useR(openChatInTab);
  useE(() => { openChatInTabRef.current = openChatInTab; });
  useE(() => {
    const eventApi = getEventApi();
    if (!eventApi) return;
    let unlisten = null;
    let cancelled = false;
    eventApi.listen('overlay:open_chat', (e) => {
      const payload = e.payload || {};
      const { id, title, model, promptId } = payload;
      if (!id) return;
      // Prepend to "Today" — same shape as a new chat born in the composer.
      setHistory(hs => {
        if (sidebarContainsChatId(hs, id)) return hs;
        return prependChatToToday(hs, {
          id, title, model, when: 'now', spaceId: null,
        });
      });
      openChatInTabRef.current?.({ id, title, model });
      // Carry the overlay's attached prompt into the new chat's slot
      // in the per-chat map. Setting it BEFORE openChatInTab finishes
      // is safe because the hydration block in openChatInTab only
      // writes when the entry is undefined — our explicit array wins.
      // If the prompt has since been deleted in the main window,
      // attachedPrompts silently filters it out via .filter(Boolean).
      if (promptId) {
        setAttachedPromptsByChat(m => ({ ...m, [id]: [promptId] }));
      }
    }).then(u => {
      // Window unmounted before the listener finished registering — unlisten now.
      if (cancelled) u();
      else unlisten = u;
    });
    return () => { cancelled = true; if (unlisten) unlisten(); };
  }, []);

  const newTab = async () => {
    const id = genId();
    // Resolve Space context (model preference, spaceId, pinned-prompt
    // slugs) BEFORE state writes so the chat materialises with the right
    // model already preselected — no flash of the global default before
    // the Space's choice takes over. resolveSpaceContextForNewChat
    // returns the global defaults when no Space is active, so this is
    // safe to call unconditionally.
    const ctx = await resolveSpaceContextForNewChat();
    const tabRow = { id, title: 'New chat', model: ctx.preferredModel };
    if (ctx.spaceId) tabRow.spaceId = ctx.spaceId;
    setTabs(ts => [...ts, tabRow]);
    setChats(cs => ({
      ...cs,
      [id]: {
        id,
        title: 'New chat',
        messages: [],
        loaded: true,
        ...(ctx.spaceId ? { spaceId: ctx.spaceId } : {}),
      },
    }));
    setActiveTab(id);
    setModelId(ctx.preferredModel);
    // Auto-attach the Space's pinned prompts. The prompts library is
    // already loaded into `prompts` state on mount; `attachedPromptsByChat`
    // is keyed by chat id and holds slugs (which equal prompt.id). If a
    // pinned slug no longer resolves to a live prompt (.md file deleted
    // from disk), the existing .filter(Boolean) downstream silently drops
    // it — same orphan tolerance as the spaces.rs / prompt_meta layer.
    if (ctx.promptSlugs.length) {
      setAttachedPromptsByChat(m => ({ ...m, [id]: ctx.promptSlugs }));
    }
    // Instantiate the Space's pinned attachments AFTER the chat is on
    // screen — no need to block the visible "+ New chat" flow on file
    // I/O. The fire-and-forget here is intentional; the helper handles
    // its own error toasts AND refreshes chatAttachments when done.
    if (ctx.pinnedAttachments.length) {
      instantiateSpaceAttachmentsForChat(id, ctx.pinnedAttachments).catch(console.error);
    }
  };

  // Private chat (Phase 4b): same as newTab, but registers the chat id
  // in the ephemeral ref so every persistence helper (persistChat,
  // persistMessage, persistTruncate) short-circuits. Tab gets ephemeral
  // metadata so the UI can render a lock indicator + distinct color.
  // The chat is NOT added to history (no sidebar entry); it lives only
  // in the tab strip until closed.
  const newPrivateTab = () => {
    const id = genId();
    ephemeralChatIdsRef.current.add(id);
    const preferred = readPersistedComposerModel();
    setTabs(ts => [...ts, { id, title: 'Private chat', model: preferred, ephemeral: true }]);
    setChats(cs => ({
      ...cs,
      [id]: { id, title: 'Private chat', messages: [], loaded: true, ephemeral: true },
    }));
    setActiveTab(id);
    setModelId(preferred);
  };

  // Compare-mode tab creation (Phase 2). Entry point is the sidebar's
  // "compare" icon button; that opens the CompareModelPickerModal, which
  // calls onConfirm with the chosen 2-3 model ids. We then mint a new
  // tab+chat with tabType='multi-pending' and persist the row so re-
  // opening from history hydrates back into compare mode.
  //
  // The tab's `model` field gets the first selected model as a sensible
  // fallback for any single-model code path that hasn't been taught
  // about multi-mode yet (e.g. token-count widgets that read the active
  // model). Once the user picks a winner in Phase 4, `model` gets
  // rewritten to the chosen one and `tabType` flips to 'single-from-
  // multi' — see Phase 4 plan.
  const newCompareTab = () => setCompareModalOpen(true);

  const confirmCompareModels = async (selected) => {
    setCompareModalOpen(false);
    if (!Array.isArray(selected) || selected.length < 2) return;
    const id = genId();
    const firstModel = selected[0];
    const nowTs = Math.floor(Date.now() / 1000);
    // Compare-mode chats inherit Space context the same way single-mode
    // ones do — spaceId on the chat row, pinned prompts auto-attached
    // for the first send, system_prompt prepended at send time. The
    // explicit list of models is the user's pick from the picker; the
    // Space's defaultModel is NOT auto-injected into `selected` because
    // the whole point of compare mode is the user choosing.
    const ctx = await resolveSpaceContextForNewChat();
    const tabRow = {
      id,
      title: 'New comparison chat',
      model: firstModel,
      tabType: 'multi-pending',
      models: selected,
    };
    if (ctx.spaceId) tabRow.spaceId = ctx.spaceId;
    setTabs(ts => [...ts, tabRow]);
    setChats(cs => ({
      ...cs,
      [id]: {
        id,
        title: 'New comparison chat',
        messages: [],
        loaded: true,
        tabType: 'multi-pending',
        models: selected,
        ...(ctx.spaceId ? { spaceId: ctx.spaceId } : {}),
      },
    }));
    setActiveTab(id);
    // Persist immediately so the chat survives an app relaunch even if
    // the user never sends a first message. multiModels is stored as a
    // JSON string (matches the Rust Option<String> column). spaceId
    // rides along so the chat materialises inside the right Space on
    // first load.
    persistChat({
      id,
      title: 'New comparison chat',
      model: firstModel,
      createdAt: nowTs,
      updatedAt: nowTs,
      tabType: 'multi-pending',
      multiModels: JSON.stringify(selected),
      spaceId: ctx.spaceId || null,
    }).catch(console.error);
    // Auto-attach the Space's pinned prompts. handleSendMultiModel
    // reads from attachedPromptsByChat too, so the first compare-mode
    // send gets the same pinned-prompts treatment as a single-mode chat.
    if (ctx.promptSlugs.length) {
      setAttachedPromptsByChat(m => ({ ...m, [id]: ctx.promptSlugs }));
    }
    // Pinned attachments — same fire-and-forget shape as newTab.
    // handleSendMultiModel currently doesn't consume attachments at
    // send time (compare mode defers RAG; see the comment block in
    // handleSendMultiModel about "attachments ... deferred to a future
    // iteration"), but instantiating them onto the chat row makes them
    // visible in the composer chip strip AND they'll be picked up by a
    // future iteration. No reason to suppress them just because the
    // current compare-send path doesn't consult them.
    if (ctx.pinnedAttachments.length) {
      instantiateSpaceAttachmentsForChat(id, ctx.pinnedAttachments).catch(console.error);
    }
  };

  // Screenshot pipeline (Phase 5). Called from the `screenshot:captured`
  // event listener (registered earlier with [] deps) via a ref-based
  // indirection so the listener always invokes the LATEST closure — direct
  // capture would freeze modelId / modelVisionMap to their mount-time
  // values. Updated on every render below.
  const screenshotIntoNewTab = async (path) => {
    if (!path) return;
    // Pick a vision-capable model. Three-step decision:
    //   1. If we already KNOW the active model has vision (cached true) —
    //      keep it.
    //   2. If we DON'T KNOW (cache miss — undefined, not false), probe
    //      synchronously so we don't false-alarm the user with "active
    //      model has no vision" when in reality we just haven't asked
    //      Ollama yet. The probe is a single /api/show call.
    //   3. Only after a confirmed false do we hunt for another vision
    //      model in the cache.
    let chosenModel = modelId;
    let switched = false;
    let activeHasVision = modelVisionMap[modelId];
    if (activeHasVision === undefined) {
      try {
        const caps = await invoke('model_capabilities', { model: modelId });
        activeHasVision = !!caps?.vision;
        // Cache the probe result for next time and so other code paths
        // (the composer's vision badge, etc.) reflect it immediately.
        setModelVisionMap((m) => ({ ...m, [modelId]: activeHasVision }));
      } catch (_) {
        // Probe failure (Ollama down, model not pulled) — treat as
        // unknown-false. The user will see the existing "model has no
        // vision capability" warning, which is the right signal.
        activeHasVision = false;
      }
    }
    if (!activeHasVision) {
      const visionEntry = Object.entries(modelVisionMap).find(([, v]) => v);
      if (visionEntry) {
        chosenModel = visionEntry[0];
        switched = true;
      }
    }

    const id = genId();
    // The new tab inherits chosenModel; the active model selector also
    // switches so the composer + status bar follow. We don't touch other
    // open tabs — their model is a historical fact about that chat.
    setTabs(ts => [...ts, { id, title: 'Screenshot', model: chosenModel }]);
    setChats(cs => ({
      ...cs,
      [id]: { id, title: 'Screenshot', messages: [], loaded: true },
    }));
    setActiveTab(id);
    if (switched) {
      setModelId(chosenModel);
      window.ekToast?.({
        kind: 'info',
        title: 'Switched to vision model',
        body: `Using ${chosenModel} to read the screenshot.`,
      });
    } else if (!activeHasVision) {
      // We have a confirmed-false vision capability for the active model
      // and no other known vision model in the cache. Warn so the user
      // understands why the screenshot won't be read.
      window.ekToast?.({
        kind: 'warn',
        title: 'Active model has no vision capability',
        body: `${modelId} can't read images. Pull a vision model (e.g., gemma3) for best results.`,
      });
    }

    // Attach the screenshot via the regular attachment pipeline. The
    // pipeline only stores the PATH — it doesn't copy the file. So the
    // PNG at this path needs to remain readable for the whole lifetime
    // of the chat (every send re-reads it). We DELIBERATELY do not
    // delete the temp file: macOS reclaims the system temp dir on
    // reboot, the file is tiny (a few KB to a few MB), and an earlier
    // cleanup would silently break the attachment on the user's first
    // send. The `screenshot_consumed` Rust command is kept around for a
    // future "copy then delete" implementation.
    try {
      const added = await invoke('attachment_add_files', {
        chatId: id,
        paths: [path],
      });
      setChatAttachments((m) => ({
        ...m,
        [id]: [...(m[id] || []), ...(added || [])],
      }));
    } catch (e) {
      console.error('attach screenshot failed:', e);
      window.ekToast?.({
        kind: 'error',
        title: 'Could not attach screenshot',
        body: String(e),
      });
    }
  };

  // Mirror the latest screenshotIntoNewTab into a ref so the listener
  // (bound once at mount with [] deps) always calls the freshest closure.
  // Without this indirection, modelId / modelVisionMap reads inside the
  // handler would be frozen to their mount-time values.
  const screenshotHandlerRef = useR(null);
  screenshotHandlerRef.current = screenshotIntoNewTab;

  // ── Chat with a watch's notes file ─────────────────────────────────────────
  // Reads the notes file via Rust, then opens a fresh chat tab whose system
  // context is the file's contents. We carry the notes as a "virtual" prompt
  // entry: same in-memory shape as a real library prompt, attached the same
  // way (handleSend converts attached prompts to a system message on the
  // first turn of a new chat), but flagged with `_virtual: true` so the
  // PromptLibrary can hide it from the user-visible list.
  //
  // No DB write — virtual prompts live only in `prompts` state for the
  // session; they vanish on reload, which is what we want (each chat-with-
  // notes click captures a fresh snapshot of the notes file at click time).
  const chatWithNotes = async (watch) => {
    let content = '';
    try {
      content = await invoke('watch_notes_read', { path: watch.notesPath });
    } catch (e) {
      window.ekToast?.({
        kind: 'error',
        title: "Couldn't read notes file",
        body: String(e),
      });
      return;
    }
    if (!content || !content.trim()) {
      window.ekToast?.({
        kind: 'warn',
        title: 'Notes file is empty',
        body: `${watch.notesPath}\n\nNothing has been processed yet — wait for the watch to summarise some files, then try again.`,
      });
      return;
    }

    // Synthesize the prompt body. The plain notes content is wrapped in a
    // brief explanatory frame so the model treats it as reference material
    // rather than instructions to follow.
    const virtualPrompt = {
      id: `notes-${watch.id}-${Date.now().toString(36)}`,
      name: `${watch.name} notes`,
      tags: ['watch'],
      favorite: null,
      body:
        `You have access to the following notes — accumulated summaries of files ` +
        `from the user's "${watch.name}" watch. Use them as reference material ` +
        `when answering questions. If asked something not covered by the notes, ` +
        `say so plainly.\n\n` +
        `=== NOTES START ===\n${content}\n=== NOTES END ===`,
      updated: 'now',
      _virtual: true,
    };

    // Open new chat tab + attach the virtual prompt + switch focus.
    const chatId = genId();
    const title = `Chat: ${watch.name}`;
    setPrompts(ps => [virtualPrompt, ...ps]);
    setTabs(ts => [...ts, { id: chatId, title, model: modelId }]);
    setChats(cs => ({
      ...cs,
      [chatId]: { id: chatId, title, messages: [], loaded: true },
    }));
    setAttachedPromptsByChat(m => ({ ...m, [chatId]: [virtualPrompt.id] }));
    setActiveTab(chatId);

    // Seed the composer with a starter question so the user has a sense of
    // what to ask. They can edit or replace before sending.
    setComposerSeedText(
      `What are the main themes across these ${watch.name} notes?`,
    );
    setComposerSeedKey(k => k + 1);
  };

  // Update an existing prompt. Two paths:
  //   • Favorite-only change → prompts_meta_set (SQLite write, no file touch).
  //   • Anything else → prompts_save (rewrites the .md file). Favorite is
  //     orthogonal to file content so we keep its persistence separate even
  //     when it's part of a larger patch.
  const updatePrompt = (id, patch) => {
    setPrompts(ps => ps.map(p => {
      if (p.id !== id) return p;
      const updated = { ...p, ...patch, updated: 'just now' };
      const favoriteChanged = 'favorite' in patch && patch.favorite !== p.favorite;
      const fileChanged = ['name', 'tags', 'body'].some(
        (k) => k in patch && patch[k] !== p[k],
      );
      if (favoriteChanged) {
        invoke('prompts_meta_set', {
          slug: id,
          favorite: updated.favorite ?? null,
        }).catch(console.error);
      }
      if (fileChanged) {
        invoke('prompts_save', {
          slug: id,
          name: updated.name,
          tags: updated.tags ?? [],
          body: updated.body ?? '',
        }).catch(console.error);
      }
      return updated;
    }));
  };

  // Create a new prompt. Optimistic UI: insert with a placeholder slug, then
  // swap to the slug Rust returns (it dedupes against existing files, so
  // `code-review` could come back as `code-review-2`). The placeholder is
  // distinguished from real slugs by the `pending-` prefix so subsequent
  // state lookups still resolve correctly until the save settles.
  const createPrompt = async (init = {}) => {
    const placeholder = 'pending-' + Math.random().toString(36).slice(2, 7);
    const p = {
      id: placeholder,
      name: init.name || 'New prompt',
      tags: init.tags || [],
      body: init.body || '',
      favorite: init.favorite ?? null,
      builtin: false,
      updated: 'just now',
    };
    setPrompts(ps => [p, ...ps]);
    setSelectedPromptId(placeholder);
    try {
      const slug = await invoke('prompts_save', {
        slug: '',
        name: p.name,
        tags: p.tags,
        body: p.body,
      });
      // Swap the placeholder for the real slug. Re-map selection too so the
      // UI doesn't lose its place after the save resolves.
      setPrompts(ps => ps.map(x => x.id === placeholder ? { ...x, id: slug } : x));
      setSelectedPromptId(curr => curr === placeholder ? slug : curr);
      if (p.favorite) {
        invoke('prompts_meta_set', { slug, favorite: p.favorite }).catch(console.error);
      }
      return slug;
    } catch (e) {
      console.error('prompts_save failed:', e);
      // Roll the placeholder out so a failed save doesn't leave a ghost row.
      setPrompts(ps => ps.filter(x => x.id !== placeholder));
      return null;
    }
  };

  // Delete a prompt by slug — works for both built-ins and user prompts.
  // We close any context menus the caller had open by removing the row from
  // state immediately, then fire-and-forget the backend delete.
  const deletePrompt = (id) => {
    if (!id || id.startsWith('pending-')) return;
    setPrompts(ps => ps.filter(p => p.id !== id));
    setSelectedPromptId(curr => curr === id ? null : curr);
    // Detach the deleted prompt from EVERY chat's attached set — not
    // just the active one. Without this sweep, an old chat with the
    // now-deleted prompt would re-render its chip from stale state
    // on next open (until the .filter(Boolean) in attachedPrompts
    // hides it anyway, but the underlying id would still be there).
    setAttachedPromptsByChat(m => {
      const out = {};
      for (const [k, v] of Object.entries(m)) {
        out[k] = (v || []).filter(x => x !== id);
      }
      return out;
    });
    invoke('prompts_delete', { slug: id }).catch(console.error);
  };
  const importPromptFromFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    const baseName = file.name.replace(/\.(md|markdown|txt)$/i, '');
    // First markdown H1 wins as name, if present
    const h1 = text.match(/^\s*#\s+(.+)$/m);
    const name = (h1 ? h1[1] : baseName).trim().slice(0, 60) || 'Imported';
    createPrompt({ name, body: text, tags: ['imported'] });
  };

  const [ollamaModalOpen, setOllamaModalOpen] = useS(true);
  const [modelWarming, setModelWarming] = useS(false);
  // In-app model download/delete modal — opened via
  // window.ekOpenModelManager() (registered in the effect near the
  // onboarding opener; see model-manager.jsx for the component).
  const [modelManagerOpen, setModelManagerOpen] = useS(false);
  const [watchModalOpen, setWatchModalOpen] = useS(false);
  // null = create mode; watch object = edit mode. Cleared after close so a
  // subsequent "+ Configure" click reliably lands in create mode.
  const [editingWatch, setEditingWatch] = useS(null);
  // Multi-model "compare" creation modal (Phase 2). When open, user picks
  // 2 or 3 models; confirmation creates a new tab with tabType='multi-
  // pending'. Closed state means the modal is not mounted at all (see
  // CompareModelPickerModal's early-return on !open).
  const [compareModalOpen, setCompareModalOpen] = useS(false);
  // First-launch onboarding tour (Phase 6). Opens automatically when the
  // app_settings flag is absent; closes on Skip / Get started, both of
  // which write the flag so the tour stays hidden across launches.
  // Exposed as window.ekOpenOnboarding so the Settings modal's
  // "Show tour again" button can re-open it without lifting that state.
  const [onboardingOpen, setOnboardingOpen] = useS(false);

  // Pre-warm a model: POST /api/generate with a tiny one-token prompt so
  // Ollama runs a complete forward pass — this is what actually pays the
  // first-inference costs (Metal/CUDA kernel compilation, KV cache
  // allocation, tokenizer/sampler init) that an empty-prompt load doesn't.
  // Without a real generation, /api/ps flips to "loaded" the moment weights
  // are resident, but the user's first Send still eats the cold-kernel
  // penalty. With num_predict:1 the cost is ~one decode step and the model
  // is genuinely warm when modelWarming flips off. keep_alive:'30m' beats
  // the 5min default so a momentarily idle user doesn't pay the warmup
  // tax again.
  const warmModel = async (id) => {
    setModelWarming(true);
    try {
      // Routed through the Rust `ollama_generate` command — same
      // payload as the previous direct fetch, just wrapped in
      // invoke(). Response body is discarded on both sides; we
      // only need the side effect of forcing the model into RAM.
      await invoke('ollama_generate', {
        body: {
          model: id,
          prompt: 'hi',
          stream: false,
          options: { num_predict: 1 },
          keep_alive: '30m',
        },
      });
    } catch (e) {
      // IPC / Ollama failures are surfaced by the StatusBar's own
      // polling — no need to bubble up here.
    } finally {
      setModelWarming(false);
    }
  };

  return (
    <>
      <OllamaGate
        // Defer the gate while the onboarding tour is open — both are
        // top-of-tree modals and the gate (zIndex 9999) would otherwise
        // bury the tour (9990) on a true first run. Order: tour → setup.
        open={ollamaModalOpen && !onboardingOpen}
        modelId={model.id}
        onReady={() => { setOllamaModalOpen(false); warmModel(model.id); }}
        onDismiss={() => setOllamaModalOpen(false)}
        onModelInstalled={(id) => {
          // Guided setup finished: make the freshly-pulled model the active
          // default (mirrors the composer's onModelChange), patch the
          // current tab so the composer reflects it, close, and warm it —
          // warming `id` (not the stale fallback modelId) so the first send
          // is hot. Without this the startup validation no-ops on a
          // zero-models launch and we'd warm a model that isn't installed.
          setModelId(id);
          persistComposerModel(id);
          setTabs(ts => ts.map(t => t.id === activeTab ? { ...t, model: id } : t));
          setOllamaModalOpen(false);
          warmModel(id);
        }}
      />
      {/* In-app model download/delete. Mounted unconditionally (early-
          returns on !open); in-flight pulls live in module scope inside
          model-manager.jsx so they survive this modal closing. */}
      <ModelManagerModal
        open={modelManagerOpen}
        onClose={() => setModelManagerOpen(false)}
        activeModel={model.id}
      />
      {/* Toast host mounts once and exposes window.ekToast for global use.
          Lives high in the tree so toasts overlay everything else. */}
      <ToastHost />
      {/* First-launch onboarding tour (Phase 6). State lives in App so the
          Settings modal can reopen it via window.ekOpenOnboarding. */}
      <OnboardingTour open={onboardingOpen} onClose={closeOnboarding} />
      {/* write_file permission modal — appears when a tool-using model
          first tries to save a file in a chat with no output_dir.
          onClose receives the resolution: a path string (Allow), "" (Block
          always), or null (Not now). handleSend awaits this via
          outputDirResolverRef. */}
      {outputDirReq && (
        <OutputDirModal
          chatId={outputDirReq.chatId}
          chatTitle={outputDirReq.chatTitle}
          suggested={outputDirReq.suggested}
          invoke={invoke}
          onClose={(dir) => {
            setOutputDirReq(null);
            const r = outputDirResolverRef.current;
            outputDirResolverRef.current = null;
            r?.(dir);
          }}
        />
      )}
      <SettingsModal
        tweaks={tweaks}
        setTweak={setTweak}
        onPromptsChanged={refreshPrompts}
        chatCount={totalChatCount}
        onClearAllChats={clearAllChats}
      />
      <WatchModal
        open={watchModalOpen}
        editing={editingWatch}
        onClose={() => {
          setWatchModalOpen(false);
          setEditingWatch(null);
        }}
        onCreated={() => {
          setWatchModalOpen(false);
          setEditingWatch(null);
          // Bump the panel's refresh key — picks up the new/edited row
          // without any direct coupling between modal and panel state.
          setWatchPanelRefreshKey((k) => k + 1);
        }}
        prompts={prompts}
        notifPermission={notifPermission}
        refreshNotifPermission={refreshNotifPermission}
      />
      <CompareModelPickerModal
        open={compareModalOpen}
        onClose={() => setCompareModalOpen(false)}
        onConfirm={confirmCompareModels}
      />

      <div style={{
        width: '100vw', height: '100vh',
        minWidth: 0, minHeight: 0,
        background: theme.bg0, color: theme.fg,
        display: 'flex', flexDirection: 'column',
        fontSize: 14 * tweaks.fontScale,
      }}>
        <TitleBar
          onToggleSidebar={() => setSidebarOpen(o => !o)}
          // Each tab button toggles the panel if it's already on that tab,
          // otherwise opens the panel and switches to that tab. Clicking
          // "the tab I'm not currently on" never closes the panel — just
          // swaps content, matching how browser/IDE tab bars behave.
          onTogglePrompts={() => {
            if (rightPanelOpen && rightPanelTab === 'prompts') {
              setRightPanelOpen(false);
            } else {
              setRightPanelOpen(true);
              setRightPanelTab('prompts');
            }
          }}
          onToggleWatch={() => {
            if (rightPanelOpen && rightPanelTab === 'watches') {
              setRightPanelOpen(false);
            } else {
              setRightPanelOpen(true);
              setRightPanelTab('watches');
            }
          }}
          onToggleFiles={() => {
            if (rightPanelOpen && rightPanelTab === 'files') {
              setRightPanelOpen(false);
            } else {
              setRightPanelOpen(true);
              setRightPanelTab('files');
            }
          }}
          onToggleTweaks={() => window.postMessage({type:'__activate_edit_mode'}, '*')}
          sidebarOpen={sidebarOpen}
          rightPanelOpen={rightPanelOpen}
          rightPanelTab={rightPanelTab}
          model={tabModel}
        />
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {sidebarOpen && (
            <>
              <Sidebar
                chats={history}
                activeId={activeTab}
                onPick={openChatInTab}
                onDelete={deleteChat}
                query={query}
                onQuery={setQuery}
                onNew={newTab}
                onNewPrivate={newPrivateTab}
                onNewCompare={newCompareTab}
                width={sidebarWidth}
                // ── Spaces (workspace bundles) ─────────────────────────
                // A Space bundles a system prompt, default model, optional
                // pinned attachments + prompts, and an optional Space-
                // scoped memory file. The sidebar surfaces them as the
                // top section with an "All chats" pseudo-row, and the
                // active Space filters the chat list below.
                spaces={spaces}
                activeSpaceId={activeSpaceId}
                onSelectSpace={selectSpace}
                onCreateSpace={createSpace}
                onRenameSpace={renameSpace}
                onRecolorSpace={recolorSpace}
                onDeleteSpace={deleteSpace}
                onMoveChatToSpace={moveChatToSpace}
                promptsLibrary={prompts}
                onEditSpaceSave={saveSpaceSettings}
                onRename={renameChat}
                // Full-text hits + click handler. The hit carries chatModel
                // so we don't have to look it up from history (which is
                // grouped/filtered and awkward to scan).
                messageHits={messageHits}
                onPickHit={(hit) =>
                  openChatInTab({ id: hit.chatId, title: hit.chatTitle, model: hit.chatModel })
                }
              />
              <Resizer onDrag={(dx) => {
                if (dx === 0) sidebarStartRef.current = sidebarWidth;
                setSidebarWidth(Math.max(160, Math.min(420, sidebarStartRef.current + dx)));
              }} />
            </>
          )}

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <TabBar
              tabs={tabs}
              activeId={activeTab}
              onSelect={setActiveTab}
              onClose={closeTab}
              onNew={newTab}
              // Derived map of tab.id → attachment count for the TabBar
              // indicator. Cheap to recompute on each render since the
              // list is per-tab and small; Object.entries keeps it
              // straightforward without a useMemo dance.
              attachmentCounts={Object.fromEntries(
                Object.entries(chatAttachments).map(([k, v]) => [k, (v || []).length]),
              )}
            />
            {staleAttachments.count > 0 && (
              <StaleEmbeddingsBanner
                count={staleAttachments.count}
                model={staleAttachments.currentModel}
                onReindex={onReindexAllStale}
                onDismiss={() => setStaleAttachments({ count: 0, currentModel: staleAttachments.currentModel })}
                busy={reindexingStale}
              />
            )}
            {chat.tabType === 'multi-pending' ? (
              // Compare-mode chats route to the panel UI. handleSendMultiModel
              // fans out the first message to every model in chat.models;
              // keepVariant transitions the tab to 'single-from-multi' and
              // re-routes future renders through the branch below.
              <CompareChatPane
                chat={chat}
                isStreaming={streaming}
                onSend={handleSendMultiModel}
                onStopAll={() => handleStopMultiModel()}
                onStopColumn={(asstId) => handleStopMultiModel(asstId)}
                onKeep={keepVariant}
                onCancel={() => closeTab(activeTab)}
                attachedPrompts={attachedPrompts}
                onDetachPrompt={detachPrompt}
              />
            ) : (
              <>
                <ChatPane
                  // Pre-process so picked variants carry their unpicked
                  // siblings as m.alternatives, then drop the unpicked
                  // rows from the rendered list. Single-mode chats have
                  // isPicked=null/undefined everywhere, so the pipeline
                  // is a no-op for them (no group → no alternatives).
                  //
                  // The unpicked rows stay in the DB and in chat.messages
                  // (we only filter at the render-site copy here), so a
                  // future feature that wants them — re-comparing, picking
                  // again, exporting variant history — can read from
                  // chat.messages directly.
                  chat={(() => {
                    const raw = chat.messages || [];
                    // Group unpicked siblings by variantGroupId. Keys
                    // are stable opaque ids generated at send time;
                    // O(N) build is fine since N is small.
                    const unpickedByGroup = new Map();
                    for (const m of raw) {
                      if (m.isPicked === 0 && m.variantGroupId) {
                        const list = unpickedByGroup.get(m.variantGroupId) || [];
                        list.push(m);
                        unpickedByGroup.set(m.variantGroupId, list);
                      }
                    }
                    const messages = raw
                      .filter(m => m.isPicked !== 0)
                      .map(m => {
                        if (m.isPicked === 1 && m.variantGroupId) {
                          const alts = unpickedByGroup.get(m.variantGroupId);
                          if (alts?.length) return { ...m, alternatives: alts };
                        }
                        return m;
                      });
                    return { ...chat, messages };
                  })()}
                  model={tabModel}
                  isStreaming={streaming}
                  onRename={renameChat}
                  // Propagate the sidebar search query so messages can highlight
                  // matches in-place. Empty/whitespace queries are handled inside
                  // ChatPane (regex becomes null, render is unchanged).
                  searchQuery={query}
                  // Edit + retry (Phase 3). Both go through truncateAndResend,
                  // gated by streaming inside the handlers themselves so the UI
                  // doesn't need to know.
                  onEditMessage={handleEditAndResubmit}
                  onRetryMessage={handleRetryAssistant}
                  // Resolved Space row for this chat (or null). Used by
                  // ChatPane to render the Space badge in the header.
                  // Resolved at the parent so ChatPane stays presentation-
                  // only and doesn't need the spaces array.
                  space={chat.spaceId ? (spaces || []).find(s => s.id === chat.spaceId) || null : null}
                />
                <Composer
                  model={tabModel}
                  onModelChange={(id) => {
                    setModelId(id);
                    setTabs(ts => ts.map(t => t.id === activeTab ? { ...t, model: id } : t));
                    // User explicitly picked a model — persist as the
                    // stable default for future new chats. This is the
                    // ONLY place we write to COMPOSER_MODEL_LS_KEY (no
                    // auto-persist on modelId change), so opening an
                    // old chat doesn't drift the default.
                    persistComposerModel(id);
                  }}
                  onSend={handleSend}
                  isStreaming={streaming}
                  onStop={handleStop}
                  attachedPrompts={attachedPrompts}
                  onDetachPrompt={detachPrompt}
                  // Locked-pin enforcement: for chats inside a Space,
                  // resolve the set of slugs flagged `locked=true` in
                  // `space_prompts`. The Composer hides the × on those
                  // chips so the user can't detach a Space-mandated
                  // prompt from one chat. Resolved at render time (not
                  // snapshotted into the chat) — unlocking later flows
                  // through to every open chat on the next render.
                  lockedPromptSlugs={
                    chat.spaceId
                      ? (lockedSlugsBySpace[chat.spaceId] || EMPTY_LOCKED_SET)
                      : EMPTY_LOCKED_SET
                  }
                  // Full library for the in-composer slash-command picker.
                  // Filter out _virtual prompts (watch-notes carriers) per
                  // the rule in CLAUDE.md — they're context blobs that
                  // shouldn't appear as user-selectable presets.
                  prompts={prompts.filter(p => !p._virtual)}
                  onPickPrompt={togglePromptAttach}
                  attachments={attachments}
                  onAttachFile={onAttachFile}
                  onAttachFolder={onAttachFolder}
                  onDetachAttachment={onDetachAttachment}
                  onReindexAttachment={onReindexAttachment}
                  modelHasVision={activeModelHasVision}
                  modelHasTools={activeModelHasTools}
                  seedText={composerSeedText}
                  seedKey={composerSeedKey}
                  // Hide attach buttons in private mode — see Composer notes.
                  ephemeral={!!chat.ephemeral}
                />
              </>
            )}
          </div>

          {rightPanelOpen && (
            <>
              <Resizer onDrag={(dx) => {
                if (dx === 0) rightPanelStartRef.current = rightPanelWidth;
                setRightPanelWidth(Math.max(280, Math.min(600, rightPanelStartRef.current - dx)));
              }} />
              {/* Tab bar is built once and passed as a prop to whichever  */}
              {/* tab's component is rendering — keeps the two tabs from   */}
              {/* having to re-implement the chrome each time.             */}
              {(() => {
                const tabHeader = (
                  <RightPanelTabs
                    tab={rightPanelTab}
                    onTab={setRightPanelTab}
                    onClose={() => setRightPanelOpen(false)}
                  />
                );
                if (rightPanelTab === 'prompts') {
                  return (
                    <PromptLibrary
                      tabHeader={tabHeader}
                      // Hide _virtual prompts — these are transient,
                      // session-only contexts (e.g. notes-from-a-watch)
                      // that get attached behind the scenes by features
                      // like "Chat with notes". They're real in the
                      // attached-prompts flow but shouldn't clutter the
                      // user-visible library.
                      prompts={prompts.filter((p) => !p._virtual)}
                      selectedId={selectedPromptId}
                      onSelect={setSelectedPromptId}
                      onUse={togglePromptAttach}
                      attachedIds={attachedPromptIds}
                      onUpdate={updatePrompt}
                      onCreate={createPrompt}
                      onDelete={deletePrompt}
                      onRefresh={refreshPrompts}
                      onImport={importPromptFromFile}
                      width={rightPanelWidth}
                    />
                  );
                }
                if (rightPanelTab === 'files') {
                  return (
                    <FilesPanel
                      tabHeader={tabHeader}
                      width={rightPanelWidth}
                      chatId={activeTab}
                      // Click a row → scroll the chat scroller to the
                      // message that produced this save. Message divs in
                      // chat.jsx carry id="ek-msg-{m.id}" so we can find
                      // them without prop-drilling refs through ChatPane.
                      onScrollToMessage={(messageId) => {
                        const el = document.getElementById(`ek-msg-${messageId}`);
                        if (el) {
                          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          // Brief amber pulse on the targeted message so the
                          // user notices where the scroll landed.
                          el.style.transition = 'background 0.6s ease';
                          const prev = el.style.background;
                          el.style.background = T.amber + '22';
                          setTimeout(() => { el.style.background = prev; }, 900);
                        }
                      }}
                    />
                  );
                }
                return (
                  <WatchPanel
                    tabHeader={tabHeader}
                    width={rightPanelWidth}
                    prompts={prompts}
                    onConfigure={() => {
                      setEditingWatch(null);
                      setWatchModalOpen(true);
                    }}
                    onEdit={(w) => {
                      setEditingWatch(w);
                      setWatchModalOpen(true);
                    }}
                    onChatWithNotes={chatWithNotes}
                    refreshKey={watchPanelRefreshKey}
                    focusFilter={watchFocusFilter}
                  />
                );
              })()}
            </>
          )}
        </div>

        {tweaks.showStatusBar && (
          <StatusBar
            model={tabModel}
            onOllamaClick={() => setOllamaModalOpen(true)}
            warming={modelWarming}
            // Flatten all chats' attachments and surface anything in
            // 'indexing'. Aggregated across the whole window so a long
            // folder index in chat A stays visible while the user works
            // in chat B.
            indexingAttachments={Object.values(chatAttachments)
              .flat()
              .filter((a) => a.status === 'indexing')}
          />
        )}
      </div>
    </>
  );
}

function now() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// Note: `instantiateSpacePinnedAttachments` (the pure dispatcher used by
// the App-scope wrapper `instantiateSpaceAttachmentsForChat` above) lives
// in ui/utils.js so it can be unit-tested with Node's built-in test
// runner. See ui/__tests__/utils.test.js for the contract tests.
//
// Only the main window renders <App />. The overlay window has its own
// mount inside overlay.jsx. In a non-Tauri context (pure-browser dev),
// __TAURI__ is absent and we default to the main app.
(() => {
  const winApi = getWindowApi();
  const label =
    (winApi?.getCurrentWindow?.() ?? winApi?.getCurrent?.())?.label ?? 'main';
  if (label === 'main') {
    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  }
})();
