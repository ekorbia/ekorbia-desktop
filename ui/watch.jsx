// watch.jsx — Watches: a folder Ekorbia keeps an eye on, summarising each
// new file into a notes file with a template the person chooses.
//
//   WatchPanel     the list in Settings → Watches, with each watch's activity
//   WatchModal     the form to add or edit one
//   RecipePickerModal / RecipeGallery   the two starting points
//
// Only folders are watched. Feeds and web pages were removed (Nov 2026); a
// watch of one left by an older version is counted in a note at the foot of
// the list, where it can be removed.
//
// Depends on: tokens (T, ek* styles), atoms, icons, overlays (ConfirmDialog),
// utils (relativeTime, buildTodayDigest, recipeToFormDefaults, sortTemplates).

'use strict';

function WatchField({ label, value, onChange, placeholder, onBrowse, browseLabel = "Choose…", testId }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={ekHeading()}>{label}</span>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
          data-watch-field={testId}
          style={ekField({ flex: 1, minWidth: 0, width: "auto" })}
        />
        {onBrowse && (
          <button onClick={onBrowse} type="button" style={ekBtn("secondary")}>
            {browseLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Starting points ────────────────────────────────────────────────────────
// Picking one opens the form filled in (for Downloads: the folder, a notes
// file, and "skip files already there"); "Another folder" opens it blank.
// `promptSlug` names a starter template by its file name; if it has been
// deleted the watch falls back to the built-in summary.
const WATCH_RECIPES = [
  {
    id: "downloads",
    title: "Summarise new downloads",
    blurb: "Summarise PDFs, text and Markdown files as they land in your Downloads folder.",
    kind: "folder",
    promptSlug: "summarise-a-document",
    useDownloadsDir: true,
    skipExisting: true,
    notesFileName: "downloads-summaries.md",
    name: "Downloads",
  },
  {
    id: "custom",
    title: "Another folder",
    blurb: "Summarise new files in any folder you choose.",
    custom: true,
  },
];

function RecipeGallery({ onPick }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
      {WATCH_RECIPES.map((r) => (
        <button
          key={r.id}
          data-recipe={r.id}
          onClick={() => onPick(r)}
          style={{
            textAlign: "left",
            background: T.isLight ? T.bg0 : T.bg2,
            border: `1px solid ${T.border}`,
            borderRadius: 10,
            padding: "10px 12px",
            cursor: "pointer",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = T.borderStrong)}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = T.border)}
        >
          <span style={{ display: "inline-flex", color: T.fg2, marginBottom: 2 }}>
            <I.Folder size={15} />
          </span>
          <span style={ekHeading()}>{r.title}</span>
          <span style={ekHint()}>{r.blurb}</span>
        </button>
      ))}
    </div>
  );
}

function RecipePickerModal({ open, onClose, onPick }) {
  // Capture phase, and stopped, so Escape closes this and not the Settings
  // dialog underneath it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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
        aria-label="Add a watch"
        data-recipe-picker
        style={{
          width: 480, maxWidth: "90vw", background: panelGrad(),
          border: `1px solid ${T.borderStrong}`, borderRadius: 12,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`, padding: "14px 16px 16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 600, color: T.fg, flex: 1 }}>
            Add a watch
          </div>
          <button onClick={() => onClose?.()} aria-label="Close" style={ekBtn("quiet", { small: true })}>
            <I.X size={13} />
          </button>
        </div>
        <RecipeGallery onPick={onPick} />
      </div>
    </div>
  );
}

// One summarised file: status dot, file name, when, then the summary —
// clipped to three lines until clicked.
function WatchEventRow({ e, expanded, onToggle }) {
  const fname = (e.filePath || "").split("/").pop();
  const statusColor = e.status === "done" ? T.green : e.status === "error" ? T.red : T.amber;
  const isProcessing = e.status === "processing";
  return (
    <div
      data-watch-event
      style={{
        margin: "0 10px 8px 30px",
        padding: "10px 12px",
        background: T.isLight ? T.bg1 : T.bg2,
        border: `1px solid ${T.border}`,
        borderRadius: 8,
      }}
    >
      <div
        onClick={onToggle}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
        title={expanded ? "Show less" : "Show the whole summary"}
      >
        <span
          className={isProcessing ? "watch-pulse-dot" : undefined}
          style={{ width: 7, height: 7, borderRadius: 99, background: statusColor, flexShrink: 0 }}
        />
        <span
          style={{
            fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.fg,
            flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {fname}
        </span>
        <span className={isProcessing ? "watch-pulse-text" : undefined} style={ekHint({ flexShrink: 0 })}>
          {isProcessing ? "Summarising…" : relativeTime(e.createdAt, { verbose: true })}
        </span>
        <span
          style={{
            display: "inline-flex", color: T.fg3, flexShrink: 0,
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 120ms ease",
          }}
        >
          <I.ChevronR size={11} />
        </span>
      </div>
      {e.summary && (
        <div
          onClick={onToggle}
          style={{
            fontFamily: T.sans, fontSize: 12.5, color: T.fg1, lineHeight: 1.55,
            whiteSpace: "pre-wrap", marginTop: 6, cursor: "pointer",
            display: expanded ? "block" : "-webkit-box",
            WebkitLineClamp: expanded ? "unset" : 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {e.summary}
        </div>
      )}
      {e.error && (
        <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.red, marginTop: 6, whiteSpace: "pre-wrap" }}>
          {e.error}
        </div>
      )}
    </div>
  );
}

// The last two folders of a path: enough to recognise it in a narrow row.
function watchFolderLabel(path) {
  return (path || "").split("/").filter(Boolean).slice(-2).join("/");
}

//   prompts            the templates (to name the one a watch uses)
//   nameOfModel(id)    → plain name of a model
//   onConfigure        "+ Add a watch"
//   onPickRecipe(r)    a starting point chosen from the empty list
//   onEdit(w)          the pencil on a row
//   onChatWithNotes(w) open a chat about a watch's notes file
//   onChatAboutToday(text)  open a chat about today's summaries
//   refreshKey         bumped by the caller after a watch is saved
//   focusFilter        { watchId, key }: open that watch's section (set when
//                      a notification brought the person here)
function WatchPanel({
  prompts,
  nameOfModel,
  onConfigure,
  onEdit,
  onChatWithNotes,
  onPickRecipe,
  onChatAboutToday,
  refreshKey = 0,
  focusFilter,
}) {
  const [allWatches, setWatches] = useState([]);
  const watches = allWatches.filter((w) => (w.kind || "folder") === "folder");
  const retired = allWatches.filter((w) => (w.kind || "folder") !== "folder");
  // 'All' = the latest 100 summaries; 'Today' = the last 24 hours.
  const [todayMode, setTodayMode] = useState(false);
  const [events, setEvents] = useState([]);
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const invoke = getInvoke();

  const flip = (setter) => (id) =>
    setter((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleCollapsed = flip(setCollapsedIds);
  const toggleExpanded = flip(setExpandedIds);

  const reload = async () => {
    if (!invoke) return;
    try {
      const since = todayMode ? Math.floor(Date.now() / 1000) - 86400 : null;
      const [ws, es] = await Promise.all([
        invoke("watch_list"),
        invoke("watch_events_list", { watchId: null, limit: todayMode ? 500 : 100, since }),
      ]);
      setWatches(ws || []);
      setEvents(es || []);
    } catch (e) {
      console.error("Failed to load watches:", e);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, todayMode]);

  // A notification brought the person here: make sure that watch is open.
  useEffect(() => {
    if (!focusFilter || !focusFilter.key || !focusFilter.watchId) return;
    setCollapsedIds((curr) => {
      if (!curr.has(focusFilter.watchId)) return curr;
      const next = new Set(curr);
      next.delete(focusFilter.watchId);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFilter?.key]);

  // Rust emits this after every file it summarises. `cancelled` covers both
  // an unmount before the listener is installed and a reload still in
  // flight at unmount.
  useEffect(() => {
    const eventApi = getEventApi();
    if (!eventApi) return;
    let unlisten = null;
    let cancelled = false;
    eventApi
      .listen("watch:event_changed", () => {
        if (!cancelled) reload();
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (w) => {
    try {
      await invoke("watch_set_enabled", { id: w.id, enabled: !w.enabled });
      await reload();
    } catch (e) {
      console.error(e);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      await invoke("watch_run_once");
      window.ekToast?.({
        kind: "info",
        title: "Folders checked",
        body: "Anything new appears in the list. A watch set to skip the files already in its folder only summarises files added since.",
      });
    } catch (e) {
      window.ekToast?.({ kind: "error", title: "Could not check the folders", body: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (id) => {
    const n = nameOfModel ? nameOfModel(id) : id;
    return n && typeof n === "object" ? n.name : n;
  };
  const noneOn = watches.filter((w) => w.enabled).length === 0;
  const iconBtn = { background: "transparent", border: "none", color: T.fg2, cursor: "pointer", padding: 4, display: "flex", borderRadius: 6 };

  return (
    <div
      data-watch-panel
      style={{
        display: "flex",
        flexDirection: "column",
        border: `1px solid ${T.border}`,
        borderRadius: 10,
        background: T.isLight ? T.bg0 : T.bg1,
        overflow: "hidden",
      }}
    >
      {/* ── All / Today, and the actions ── */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 10px", borderBottom: `1px solid ${T.border}`,
        }}
      >
        <div
          role="group"
          aria-label="Which summaries to show"
          style={{ display: "flex", border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}
        >
          {[["all", "All"], ["today", "Today"]].map(([mode, label]) => {
            const active = todayMode === (mode === "today");
            return (
              <button
                key={mode}
                data-watch-scope={mode}
                aria-pressed={active}
                onClick={() => setTodayMode(mode === "today")}
                style={{
                  height: 24, padding: "0 10px", border: "none",
                  background: active ? T.bg3 : "transparent",
                  color: active ? T.fg : T.fg2,
                  fontFamily: T.sans, fontSize: 12, fontWeight: active ? 600 : 400, cursor: "pointer",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <span style={{ flex: 1 }} />
        {todayMode && events.some((e) => e.status === "done" && e.summary) && (
          <button
            onClick={() => onChatAboutToday?.(buildTodayDigest(events, watches).text)}
            title="Open a chat about today's summaries"
            style={ekBtn("secondary", { small: true })}
          >
            Chat about today
          </button>
        )}
        <button
          onClick={runNow}
          disabled={busy || noneOn}
          title="Check the watched folders now"
          style={ekBtn("secondary", { small: true, disabled: busy || noneOn })}
        >
          {busy ? "Checking…" : "Check now"}
        </button>
        <button data-watch-add onClick={onConfigure} style={ekBtn("secondary", { small: true })}>
          + Add a watch
        </button>
      </div>

      {watches.length === 0 ? (
        <div data-watch-empty style={{ padding: 14 }}>
          <div style={ekHint({ marginBottom: 10 })}>No folders are watched yet. Pick a starting point:</div>
          <RecipeGallery onPick={(r) => onPickRecipe?.(r)} />
        </div>
      ) : (
        <div style={{ padding: "6px 0 4px" }}>
          {watches.map((w) => {
            const collapsed = collapsedIds.has(w.id);
            const wEvents = events.filter((e) => e.watchId === w.id);
            const template = w.promptId ? (prompts || []).find((p) => p.id === w.promptId) : null;
            return (
              <div key={w.id} data-watch-row={w.id} style={{ marginBottom: 2 }}>
                <div
                  onClick={() => toggleCollapsed(w.id)}
                  title={collapsed ? "Show what this watch has summarised" : "Hide what this watch has summarised"}
                  style={{ padding: "8px 10px 8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-flex", color: T.fg3, flexShrink: 0,
                      transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
                      transition: "transform 120ms ease",
                    }}
                  >
                    <I.ChevronR size={11} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      data-watch-name
                      style={{
                        fontFamily: T.sans, fontSize: 13, fontWeight: 600,
                        color: w.enabled ? T.fg : T.fg2,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}
                    >
                      {w.name}
                    </div>
                    <div
                      data-watch-detail
                      title={w.folderPath || ""}
                      style={ekHint({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}
                    >
                      {[
                        watchFolderLabel(w.folderPath),
                        template ? template.name : "Built-in summary",
                        w.model ? nameOf(w.model) : null,
                        w.notify ? "Notifies" : null,
                      ].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  {/* Row controls: stopped, so they do not fold the section. */}
                  <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    <button onClick={() => onChatWithNotes && onChatWithNotes(w)} title="Chat about this watch's notes" aria-label="Chat about this watch's notes" style={iconBtn}>
                      <I.Chat size={13} />
                    </button>
                    <button onClick={() => onEdit && onEdit(w)} title="Edit" aria-label={`Edit ${w.name}`} data-watch-edit style={iconBtn}>
                      <I.Edit size={13} />
                    </button>
                    <button onClick={() => setDeleteConfirm(w)} title="Delete" aria-label={`Delete ${w.name}`} data-watch-delete style={iconBtn}>
                      <I.Trash size={13} />
                    </button>
                    <EkToggle value={!!w.enabled} onChange={() => toggle(w)} label={`${w.name}: on`} testId={`watch-on-${w.id}`} />
                  </span>
                </div>
                {!collapsed &&
                  (wEvents.length === 0 ? (
                    <div style={ekHint({ margin: "0 10px 8px 30px" })}>
                      {todayMode ? "Nothing today." : "Nothing summarised yet."}
                    </div>
                  ) : (
                    wEvents.map((e) => (
                      <WatchEventRow key={e.id} e={e} expanded={expandedIds.has(e.id)} onToggle={() => toggleExpanded(e.id)} />
                    ))
                  ))}
              </div>
            );
          })}
        </div>
      )}

      {retired.length > 0 && (
        <div
          data-watch-retired
          style={{
            ...ekHint(),
            display: "flex", alignItems: "center", gap: 10,
            padding: "10px 12px", borderTop: `1px solid ${T.border}`,
          }}
        >
          <span style={{ flex: 1 }}>
            {retired.length === 1
              ? "1 watch of a feed or web page, set up in an earlier version, is no longer run."
              : `${retired.length} watches of feeds or web pages, set up in an earlier version, are no longer run.`}
          </span>
          <button
            data-watch-retired-remove
            onClick={async () => {
              if (!invoke) return;
              for (const w of retired) {
                try {
                  await invoke("watch_delete", { id: w.id });
                } catch (e) {
                  console.error("watch_delete failed:", e);
                }
              }
              reload();
            }}
            style={ekBtn("secondary", { small: true })}
          >
            Remove {retired.length === 1 ? "it" : "them"}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteConfirm}
        title="Delete this watch?"
        body={
          deleteConfirm && (
            <>
              <b>{deleteConfirm.name}</b> and the list of what it has summarised will be removed.
              <br />
              <span style={ekHint()}>The notes file is left where it is.</span>
            </>
          )
        }
        confirmText="Delete watch"
        cancelText="Cancel"
        busy={deleteBusy}
        onConfirm={async () => {
          if (!deleteConfirm) return;
          const w = deleteConfirm;
          setDeleteBusy(true);
          try {
            await invoke("watch_delete", { id: w.id });
            await reload();
          } catch (e) {
            console.error(e);
          } finally {
            setDeleteBusy(false);
            setDeleteConfirm(null);
          }
        }}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
}

// How often a watched folder is checked. A closed list, so nobody sets a
// one-second check by accident. Seconds, as `interval_secs` stores them.
const WATCH_INTERVALS = [
  { secs: 30, label: "30 seconds" },
  { secs: 60, label: "1 minute" },
  { secs: 300, label: "5 minutes" },
  { secs: 900, label: "15 minutes" },
];

function watchBlankForm(model) {
  return {
    name: "",
    folderPath: "",
    intervalSecs: 30,
    notesPath: "",
    model: model || "",
    promptId: null,
    notify: false,
    // Unix seconds; files older than this are skipped. null = every file.
    ignoreBefore: null,
  };
}

// ─── The form (add + edit) ──────────────────────────────────────────────────
// Both end in `watch_create`, which updates the row when the id exists.
//   editing     the watch to edit, or null for a new one
//   template    a WATCH_RECIPES entry to fill a new watch from, or null
//   defaultModel  the model a new watch starts with (the app default)
//   nameOfModel(id)  → plain name of a model
//   prompts     the templates
//   notifPermission / refreshNotifPermission   macOS notification permission
function WatchModal({
  open,
  onClose,
  onCreated,
  prompts,
  editing,
  template = null,
  defaultModel = "",
  nameOfModel,
  notifPermission = "granted",
  refreshNotifPermission = async () => {},
}) {
  const [form, setForm] = useState(() => watchBlankForm(defaultModel));
  const [busy, setBusy] = useState(false);
  const [busyRun, setBusyRun] = useState(false);
  const [permBusy, setPermBusy] = useState(false);
  const [models, setModels] = useState([]);
  const invoke = getInvoke();
  const dialogApi = getDialogApi();

  const pickFolder = async () => {
    if (!dialogApi) return;
    try {
      const selected = await dialogApi.open({
        directory: true,
        multiple: false,
        title: "Choose the folder to watch",
        defaultPath: form.folderPath || undefined,
      });
      if (selected) setForm((f) => ({ ...f, folderPath: selected }));
    } catch (e) {
      console.error("Folder picker failed:", e);
    }
  };

  const pickNotesFile = async () => {
    if (!dialogApi) return;
    try {
      // The file need not exist yet; Rust creates it on the first summary.
      const selected = await dialogApi.save({
        title: "Choose the notes file",
        defaultPath: form.notesPath || undefined,
        filters: [
          { name: "Markdown", extensions: ["md", "markdown"] },
          { name: "Text", extensions: ["txt"] },
        ],
      });
      if (selected) setForm((f) => ({ ...f, notesPath: selected }));
    } catch (e) {
      console.error("File picker failed:", e);
    }
  };

  // Each time the form opens: fill it from the watch being edited, or from
  // the starting point, or blank. Without this a cancelled form would show
  // its old values next time.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        name: editing.name || "",
        folderPath: editing.folderPath || "",
        intervalSecs: editing.intervalSecs || 30,
        notesPath: editing.notesPath || "",
        model: editing.model || defaultModel,
        promptId: editing.promptId || null,
        notify: !!editing.notify,
        ignoreBefore: editing.ignoreBefore ?? null,
      });
      return;
    }
    setForm(watchBlankForm(defaultModel));
    if (template && !template.custom) {
      // The folders are resolved by Rust; the form shows blank for the
      // moment that takes.
      let gone = false;
      (async () => {
        let paths = {};
        try {
          if (invoke) paths = await invoke("watch_default_paths");
        } catch (_) {
          /* blank paths: the person picks them */
        }
        const d = recipeToFormDefaults(template, paths, Math.floor(Date.now() / 1000));
        if (d && !gone) setForm({ ...watchBlankForm(defaultModel), ...d });
      })();
      return () => {
        gone = true;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, template]);

  // The installed models, for the list. The model that reads documents for
  // search cannot write a summary, so it is left out.
  useEffect(() => {
    if (!open || !invoke) return;
    let gone = false;
    invoke("llm_list_models")
      .then((r) => {
        if (gone) return;
        const names = ((r && r.models) || []).map((m) => m && m.name).filter(Boolean);
        names.sort((a, b) => a.localeCompare(b));
        setModels(names.filter((m) => !/embed/i.test(m)));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Escape closes the form and not the Settings dialog underneath it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const valid = !!form.name.trim() && !!form.notesPath.trim() && !!form.folderPath.trim();

  const requestNotificationPermission = async () => {
    const notifApi = getNotificationApi();
    if (!notifApi?.requestPermission) return;
    setPermBusy(true);
    try {
      const result = await notifApi.requestPermission();
      await refreshNotifPermission();
      if (result !== "granted") {
        window.ekToast?.({
          kind: "warn",
          title: "Notifications are off for Ekorbia",
          body: "Turn them on in System Settings → Notifications → Ekorbia.",
        });
      }
    } catch (e) {
      window.ekToast?.({ kind: "error", title: "Could not ask for permission", body: String(e) });
    } finally {
      setPermBusy(false);
    }
  };

  // `runAfter` also starts the watch at once. The run is not awaited: it
  // can take minutes, and its progress shows in the list.
  const saveWatch = async (runAfter = false) => {
    if (!valid || !invoke) return;
    const id = editing?.id || `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    if (runAfter) setBusyRun(true);
    else setBusy(true);
    try {
      await invoke("watch_create", {
        watch: {
          id,
          name: form.name.trim(),
          folderPath: form.folderPath.trim(),
          notesPath: form.notesPath.trim(),
          model: (form.model || "").trim() || defaultModel,
          promptId: form.promptId || null,
          // `enabled` is written on save, so echo it when editing or a
          // paused watch would start again.
          enabled: editing ? !!editing.enabled : true,
          createdAt: editing?.createdAt || Math.floor(Date.now() / 1000),
          kind: "folder",
          sourceUrl: null,
          intervalSecs: form.intervalSecs || 30,
          lastPolledAt: editing?.lastPolledAt || 0,
          urlSelector: null,
          urlDiffMode: null,
          notify: !!form.notify,
          ignoreBefore: form.ignoreBefore ?? null,
        },
      });
      if (runAfter) {
        invoke("watch_run_one", { id }).catch((e) => {
          window.ekToast?.({ kind: "error", title: "The watch could not run", body: String(e) });
        });
      }
      if (onCreated) onCreated();
    } catch (e) {
      window.ekToast?.({ kind: "error", title: "Could not save the watch", body: String(e) });
    } finally {
      setBusy(false);
      setBusyRun(false);
    }
  };

  if (!open) return null;

  const nameOf = (id) => {
    const n = nameOfModel ? nameOfModel(id) : id;
    return n && typeof n === "object" ? n.name : n;
  };
  const templates = sortTemplates((prompts || []).filter((p) => !p._virtual));
  const selectStyle = ekField({ appearance: "auto", cursor: "pointer" });
  const checkRow = { display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 9998,
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "Edit watch" : "New watch"}
        data-watch-form
        style={{
          width: 480, maxWidth: "92vw", maxHeight: "86vh",
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 12,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          overflow: "hidden",
          display: "flex", flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 16px", borderBottom: `1px solid ${T.border}`, flexShrink: 0,
          }}
        >
          <span style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 600, color: T.fg }}>
            {editing ? "Edit watch" : "New watch"}
          </span>
          <button onClick={onClose} aria-label="Close" style={ekBtn("quiet", { small: true })}>
            <I.X size={13} />
          </button>
        </div>

        <div style={{ padding: "14px 16px 16px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
          <WatchField
            label="Name"
            testId="name"
            value={form.name}
            onChange={(v) => setForm({ ...form, name: v })}
            placeholder="Downloads"
          />

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <WatchField
              label="Folder to watch"
              testId="folder"
              value={form.folderPath}
              onChange={(v) => setForm({ ...form, folderPath: v })}
              placeholder="/Users/you/Downloads"
              onBrowse={pickFolder}
            />
            <label style={checkRow}>
              <input
                type="checkbox"
                data-watch-skip-existing
                checked={form.ignoreBefore != null}
                onChange={(e) =>
                  setForm({ ...form, ignoreBefore: e.target.checked ? Math.floor(Date.now() / 1000) : null })
                }
                style={{ marginTop: 3 }}
              />
              <span style={ekHint()}>
                <span style={{ color: T.fg }}>Skip files already in the folder.</span> Only files added from now on
                are summarised.
              </span>
            </label>
          </div>

          <WatchField
            label="Notes file"
            testId="notes"
            value={form.notesPath}
            onChange={(v) => setForm({ ...form, notesPath: v })}
            placeholder="/Users/you/Documents/Ekorbia/Watches/summaries.md"
            onBrowse={pickNotesFile}
          />

          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={ekHeading()}>Template</span>
              <select
                data-watch-template
                aria-label="Template"
                value={form.promptId || ""}
                onChange={(e) => setForm({ ...form, promptId: e.target.value || null })}
                style={selectStyle}
              >
                <option value="">Built-in summary</option>
                {form.promptId && !templates.some((p) => p.id === form.promptId) && (
                  <option value={form.promptId}>{form.promptId} (deleted)</option>
                )}
                {templates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={ekHeading()}>Model</span>
              <select
                data-watch-model
                aria-label="Model"
                value={form.model || ""}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                style={selectStyle}
              >
                {form.model && !models.includes(form.model) && (
                  <option value={form.model}>
                    {nameOf(form.model)}
                    {models.length > 0 ? " (not installed)" : ""}
                  </option>
                )}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {nameOf(m)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={ekHeading()}>Check the folder every</span>
            <select
              data-watch-interval
              aria-label="Check the folder every"
              value={form.intervalSecs}
              onChange={(e) => setForm({ ...form, intervalSecs: parseInt(e.target.value, 10) })}
              style={{ ...selectStyle, width: 180 }}
            >
              {WATCH_INTERVALS.map((opt) => (
                <option key={opt.secs} value={opt.secs}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <label style={{ ...checkRow, alignItems: "center" }}>
            <input
              type="checkbox"
              data-watch-notify
              checked={!!form.notify}
              onChange={(e) => setForm({ ...form, notify: e.target.checked })}
            />
            <span style={ekLabel()}>Notify me when a file is summarised</span>
          </label>

          {form.notify && notifPermission && notifPermission !== "granted" && (
            <div
              data-watch-notify-permission
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 10px",
                background: T.isLight ? T.bg1 : T.bg2,
                border: `1px solid ${T.border}`,
                borderRadius: 8,
              }}
            >
              <span style={ekHint({ flex: 1 })}>
                macOS has not yet allowed Ekorbia to show notifications. It will ask once.
              </span>
              <button
                onClick={requestNotificationPermission}
                disabled={permBusy}
                style={ekBtn("secondary", { small: true, disabled: permBusy })}
              >
                {permBusy ? "Asking…" : "Allow notifications"}
              </button>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
            <span style={{ flex: 1 }} />
            <button onClick={onClose} style={ekBtn("secondary")}>
              Cancel
            </button>
            <button
              data-watch-save-run
              onClick={() => saveWatch(true)}
              disabled={busy || busyRun || !valid}
              title={editing ? "Save, and check the folder now" : "Create the watch, and check the folder now"}
              style={ekBtn("secondary", { disabled: !valid || busy || busyRun })}
            >
              {busyRun ? "Starting…" : editing ? "Save and run" : "Create and run"}
            </button>
            <button
              data-watch-save
              onClick={() => saveWatch(false)}
              disabled={busy || busyRun || !valid}
              style={ekBtn("primary", { disabled: !valid || busy || busyRun })}
            >
              {editing ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
