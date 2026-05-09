// watch.jsx -- Watch feature UI:
//   WatchField (form-field wrapper), WatchPanel (list + Run-now + events),
//   WatchModal (create/edit, all three kinds), interval defaults.
// Depends on: tokens, atoms, icons.

function WatchField({
  label,
  value,
  onChange,
  placeholder,
  onBrowse,
  browseLabel = "Browse",
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontFamily: T.mono,
          fontSize: 10,
          color: T.fg3,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1,
            minWidth: 0,
            background: T.bg2,
            border: `1px solid ${T.border}`,
            borderRadius: 5,
            padding: "6px 9px",
            color: T.fg,
            fontFamily: T.mono,
            fontSize: 12,
            outline: "none",
          }}
        />
        {onBrowse && (
          <button
            onClick={onBrowse}
            type="button"
            style={{
              background: T.bg3,
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              padding: "0 11px",
              color: T.fg1,
              fontFamily: T.mono,
              fontSize: 11,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {browseLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Watch Panel (sidebar) ──────────────────────────────────────────────────
// Ambient background work. The user configures folder→notes pipelines via
// WatchModal (form-only); this panel is the read/monitor side:
//   • Compact list of configured watches across the top — click to filter
//     the activity feed below to just that watch
//   • Live activity feed with full (untruncated) summaries the user can
//     scan inline without opening the notes file
//   • "Open notes" per watch to launch the on-disk notes file in the
//     system default app via tauri-plugin-shell
//
// Subscribes to the `watch:event_changed` Tauri event so the activity feed
// updates the moment Rust finishes processing a file.
function WatchPanel({
  tabHeader,
  width,
  prompts,
  onConfigure,
  // Invoked when the user clicks the edit pencil on a watch row — main.jsx
  // opens the WatchModal pre-filled with this watch's data.
  onEdit,
  // Invoked when the user clicks the chat icon on a watch row — main.jsx
  // reads the notes file and opens a new chat with the contents as context.
  onChatWithNotes,
  refreshKey = 0,
  // `{ watchId, key }` — bumped when an OS notification fired recently
  // and the user just focused the app. We apply it as the activity-feed
  // filter so they land on the relevant watch. `key` (not `watchId`) is
  // the dependency so repeated notifications for the same watch still
  // re-apply the filter if the user manually cleared it between hints.
  focusFilter,
}) {
  const [watches, setWatches] = useState([]);
  const [events, setEvents] = useState([]);
  // null = show all; otherwise filter to just this watch's events
  const [selectedWatchId, setSelectedWatchId] = useState(null);
  // Activity rows are click-to-expand. We track which ones are open in a
  // Set so multiple can be open simultaneously.
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  // ── Delete-confirm dialog ──────────────────────────────────────────
  // Mirrors the prompt-delete and chat-clear flows so the destructive
  // action gets the same styled affordance instead of the OS confirm()
  // (which on macOS doesn't make it obvious which app is asking).
  // `deleteConfirm` is null or the watch object pending confirmation.
  // `deleteBusy` covers the watch_delete round-trip so the button can
  // disable while the DB write is in flight.
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const invoke = getInvoke();

  const reload = async () => {
    if (!invoke) return;
    try {
      const [ws, es] = await Promise.all([
        invoke("watch_list"),
        // Bump the limit vs the old modal (25→100) since the panel has
        // more vertical room for activity history.
        invoke("watch_events_list", { watchId: null, limit: 100 }),
      ]);
      setWatches(ws || []);
      setEvents(es || []);
    } catch (e) {
      console.error("Failed to load watches:", e);
    }
  };

  // Reload on mount and whenever the parent bumps refreshKey (which happens
  // after WatchModal creates a new watch, so the panel sees it appear).
  useEffect(() => {
    reload();
  }, [refreshKey]);

  // Notification click-through: parent bumps focusFilter.key (key 0 is
  // the initial state — ignore that) when the user just clicked an OS
  // notification. Apply the filter to the activity feed so they land on
  // the firing watch's events. The user can clear by clicking the
  // selected watch row again.
  useEffect(() => {
    if (!focusFilter || !focusFilter.key) return;
    if (focusFilter.watchId) setSelectedWatchId(focusFilter.watchId);
  }, [focusFilter?.key]);

  // Live updates: Rust emits this event after every file it processes.
  // `cancelled` gates BOTH the listen() promise (handles "unmounted before
  // the listener was even installed") AND each fired event (handles
  // "unmounted while a reload was in flight" — reload() awaits a Tauri
  // round-trip, and a stale completion would call setWatches/setEvents on
  // an unmounted component → React warning + a small leak).
  useEffect(() => {
    const eventApi = getEventApi();
    if (!eventApi) return;
    let unlisten = null;
    let cancelled = false;
    eventApi
      .listen("watch:event_changed", () => {
        if (cancelled) return;
        reload();
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const toggle = async (w) => {
    try {
      await invoke("watch_set_enabled", { id: w.id, enabled: !w.enabled });
      await reload();
    } catch (e) {
      console.error(e);
    }
  };

  // Open the styled confirm dialog. The actual delete runs in the
  // ConfirmDialog's onConfirm (below) so we can show busy state and
  // dismiss the dialog cleanly without racing the reload.
  const remove = (w) => {
    setDeleteConfirm(w);
  };

  const runNow = async () => {
    setBusy(true);
    try {
      await invoke("watch_run_once");
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const toggleExpanded = (id) => {
    setExpandedIds((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // "Nm ago" labels for the activity feed. Shares relativeTime() with
  // FilesPanel + Sidebar (via utils.js) so a 5-min-old event reads the
  // same way everywhere in the app.
  const fmtTime = (ts) => relativeTime(ts, { verbose: true });

  const visibleEvents = selectedWatchId
    ? events.filter((e) => e.watchId === selectedWatchId)
    : events;

  return (
    <aside
      style={{
        width: width || 380,
        flexShrink: 0,
        background: T.bg1,
        borderLeft: `1px solid ${T.border}`,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {tabHeader}

      {/* ── Sub-header: count + actions ── */}
      <div
        style={{
          height: 32,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 8px 0 14px",
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>
          {visibleEvents.length} event{visibleEvents.length === 1 ? "" : "s"}
          {selectedWatchId && (
            <span style={{ color: T.amber, marginLeft: 6 }}>· filtered</span>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={runNow}
          disabled={busy || watches.filter((w) => w.enabled).length === 0}
          title="Scan watched folders now (skips the 30s wait)"
          style={{
            background: "transparent",
            border: `1px solid ${T.border}`,
            borderRadius: 4,
            padding: "2px 8px",
            color: T.fg1,
            fontFamily: T.mono,
            fontSize: 10.5,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.5 : 1,
          }}
        >
          Run now
        </button>
        <button
          onClick={onConfigure}
          title="Configure a new watch"
          style={{
            background: T.bg3,
            border: `1px solid ${T.border}`,
            borderRadius: 4,
            padding: "2px 8px",
            color: T.fg,
            fontFamily: T.mono,
            fontSize: 10.5,
            cursor: "pointer",
          }}
        >
          + Configure
        </button>
      </div>

      {/* ── Configured watches (compact list) ── */}
      {watches.length === 0 ? (
        <div
          style={{
            padding: "14px 14px",
            fontFamily: T.mono,
            fontSize: 11,
            color: T.fg3,
            fontStyle: "italic",
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          No watches yet. Click{" "}
          <span style={{ color: T.fg2 }}>+ Configure</span> to add one.
        </div>
      ) : (
        <div
          style={{
            flexShrink: 0,
            maxHeight: 200,
            overflowY: "auto",
            padding: "4px 0",
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          {watches.map((w) => {
            const isSelected = selectedWatchId === w.id;
            const linkedPrompt = w.promptId
              ? prompts?.find((p) => p.id === w.promptId)
              : null;
            const fav = linkedPrompt?.favorite
              ? FAVORITE_COLOR_MAP[linkedPrompt.favorite]
              : null;
            const favColor = fav?.color || null;
            return (
              <div
                key={w.id}
                onClick={() => setSelectedWatchId(isSelected ? null : w.id)}
                title={
                  isSelected
                    ? "Click to clear filter"
                    : "Click to filter activity to this watch"
                }
                style={{
                  margin: "0 6px 2px",
                  padding: "6px 8px",
                  background: isSelected ? T.bg4 : "transparent",
                  borderRadius: 5,
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = T.bg3;
                }}
                onMouseLeave={(e) => {
                  if (!isSelected)
                    e.currentTarget.style.background = "transparent";
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 99,
                      background: w.enabled ? T.green : T.fg3,
                      boxShadow: w.enabled ? `0 0 4px ${T.green}88` : "none",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: T.sans,
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: w.enabled ? T.fg : T.fg2,
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {w.name}
                  </span>
                  {/* Row controls — stopPropagation so they don't toggle */}
                  {/* the filter when clicked.                              */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onChatWithNotes) onChatWithNotes(w);
                    }}
                    title="Chat with the notes from this watch"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: T.fg3,
                      cursor: "pointer",
                      padding: 2,
                      display: "flex",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = T.amber)}
                    onMouseLeave={(e) => (e.currentTarget.style.color = T.fg3)}
                  >
                    <I.Chat size={12} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(w);
                    }}
                    title={w.enabled ? "Pause" : "Resume"}
                    style={{
                      background: w.enabled ? T.amber : "transparent",
                      color: w.enabled ? T.bg0 : T.fg2,
                      border: `1px solid ${w.enabled ? T.amber : T.border}`,
                      borderRadius: 3,
                      padding: "1px 6px",
                      fontFamily: T.mono,
                      fontSize: 9,
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    {w.enabled ? "on" : "off"}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onEdit) onEdit(w);
                    }}
                    title="Edit"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: T.fg3,
                      cursor: "pointer",
                      padding: 2,
                      display: "flex",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = T.amber)}
                    onMouseLeave={(e) => (e.currentTarget.style.color = T.fg3)}
                  >
                    <I.Edit size={11} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(w);
                    }}
                    title="Delete"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: T.fg3,
                      cursor: "pointer",
                      padding: 2,
                      display: "flex",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.color = T.red)
                    }
                    onMouseLeave={(e) => (e.currentTarget.style.color = T.fg3)}
                  >
                    <I.Trash size={11} />
                  </button>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    paddingLeft: 12,
                    flexWrap: "wrap",
                  }}
                >
                  {/* Kind glyph + source label — folder path (last 2 dirs) */}
                  {/* or feed URL (host + path, sans scheme). Truncates so a */}
                  {/* long source doesn't push the row controls off-screen. */}
                  <span
                    title={
                      w.kind === "rss"
                        ? `Feed: ${w.sourceUrl || ""}`
                        : w.kind === "url"
                        ? `URL: ${w.sourceUrl || ""}`
                        : `Folder: ${w.folderPath || ""}`
                    }
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      fontFamily: T.mono,
                      fontSize: 9.5,
                      color: T.fg3,
                      maxWidth: 200,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ fontSize: 10 }}>
                      {w.kind === "rss"
                        ? "📡"
                        : w.kind === "url"
                        ? "🌐"
                        : "📁"}
                    </span>
                    {w.kind === "folder"
                      ? (w.folderPath || "")
                          .split("/")
                          .filter(Boolean)
                          .slice(-2)
                          .join("/")
                      : (w.sourceUrl || "").replace(/^https?:\/\//, "")}
                  </span>
                  <span
                    style={{
                      fontFamily: T.mono,
                      fontSize: 9.5,
                      color: T.fg3,
                    }}
                  >
                    {w.model}
                  </span>
                  {linkedPrompt && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        fontFamily: T.mono,
                        fontSize: 9,
                        color: favColor || T.fg3,
                        padding: "1px 4px",
                        background: favColor ? favColor + "1f" : T.bg3,
                        border: `1px solid ${favColor ? favColor + "44" : T.border}`,
                        borderRadius: 3,
                      }}
                    >
                      {favColor && (
                        <span
                          style={{
                            width: 4,
                            height: 4,
                            borderRadius: 99,
                            background: favColor,
                          }}
                        />
                      )}
                      {linkedPrompt.name}
                    </span>
                  )}
                  {/* Bell glyph signals OS notifications are enabled for */}
                  {/* this watch. Hides when notify is false to keep the  */}
                  {/* row compact for the common (silent) case.           */}
                  {w.notify && (
                    <span
                      title="OS notifications enabled"
                      style={{
                        display: "inline-flex",
                        color: T.amber,
                        opacity: 0.9,
                      }}
                    >
                      <I.Bell size={10} />
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Activity feed ── */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "6px 0 10px",
        }}
      >
        {visibleEvents.length === 0 && (
          <div
            style={{
              padding: "16px 14px",
              fontFamily: T.mono,
              fontSize: 11,
              color: T.fg3,
              fontStyle: "italic",
              textAlign: "center",
            }}
          >
            {watches.length === 0
              ? "Configure a watch to start summarising."
              : selectedWatchId
                ? "Nothing processed yet for this watch."
                : "Nothing processed yet."}
          </div>
        )}
        {visibleEvents.map((e) => {
          const fname = e.filePath.split("/").pop();
          const expanded = expandedIds.has(e.id);
          const statusColor =
            e.status === "done"
              ? T.green
              : e.status === "error"
                ? T.red
                : T.amber;
          const w = watches.find((x) => x.id === e.watchId);
          const isProcessing = e.status === "processing";
          // Headline shown on row 1. For folder watches the file's
          // basename is meaningful; for rss/url the dedup key written to
          // file_path is typically a GUID or canonical URL hash that
          // reads as gibberish ("ebb03519e293…"). Prefer the first
          // non-empty line of the AI summary there — for a well-formed
          // summary that's effectively the article title, and it works
          // retroactively for events already stored without a schema
          // change. Falls back to "(fetching…)" while in-flight, then
          // to fname as a last resort so the row is never blank.
          const isFeedKind = w?.kind === "rss" || w?.kind === "url";
          const summaryHeadline = e.summary
            ? (e.summary.split("\n").find((s) => s.trim()) || "").trim()
            : "";
          const headline = isFeedKind
            ? (summaryHeadline ||
                (isProcessing ? "(fetching…)" : fname))
            : fname;
          return (
            <div
              key={e.id}
              style={{
                margin: "0 8px 8px",
                // Roomier padding gives the row enough breathing space that
                // the summary preview reads as a paragraph instead of a chip.
                padding: "12px 14px",
                background: T.bg2,
                // In-flight rows get a tinted border so they're easy to
                // spot at a glance even when the row is collapsed.
                border: `1px solid ${isProcessing ? T.amber + "55" : T.border}`,
                borderRadius: 7,
              }}
            >
              {/* Row 1: status + filename + watch name (if not filtered) + time */}
              <div
                onClick={() => toggleExpanded(e.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: "pointer",
                }}
                title={expanded ? "Collapse" : "Expand to read full summary"}
              >
                <span
                  // .watch-pulse-dot adds a 1.4s scale+opacity animation
                  // (see index.html). Static dot for done/error states so
                  // the eye is drawn only to rows that are actively moving.
                  className={isProcessing ? "watch-pulse-dot" : undefined}
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 99,
                    background: statusColor,
                    boxShadow: `0 0 4px ${statusColor}88`,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontFamily: T.sans,
                    fontSize: 13.5,
                    color: T.fg,
                    fontWeight: 500,
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  // For feed-kind rows the headline is the summary's
                  // first line; tooltip still surfaces the dedup key
                  // (GUID / URL) so the user can correlate with the
                  // source if they need to.
                  title={isFeedKind ? fname : undefined}
                >
                  {headline}
                </span>
                {!selectedWatchId && w && (
                  <span
                    style={{
                      fontFamily: T.mono,
                      fontSize: 9.5,
                      color: T.fg3,
                    }}
                  >
                    {w.name}
                  </span>
                )}
                {isProcessing ? (
                  <span
                    className="watch-pulse-text"
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: T.amber,
                      letterSpacing: 0.3,
                      textTransform: "uppercase",
                    }}
                  >
                    processing…
                  </span>
                ) : (
                  <span
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: T.fg3,
                    }}
                  >
                    {fmtTime(e.createdAt)}
                  </span>
                )}
                {/* Expand affordance — without this, the row reads as a */}
                {/* static card and users miss that there's more to see. */}
                {/* Quiet color so it doesn't compete with the status    */}
                {/* dot. Rotates 90° on expand instead of swapping icons */}
                {/* to keep the layout stable.                            */}
                <span
                  style={{
                    display: "inline-flex",
                    color: T.fg3,
                    transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 120ms ease",
                    flexShrink: 0,
                  }}
                >
                  <I.ChevronR size={11} />
                </span>
              </div>
              {/* Row 2: summary (preview or full) */}
              {e.summary && (
                <div
                  onClick={() => toggleExpanded(e.id)}
                  style={{
                    fontFamily: T.sans,
                    fontSize: 12.5,
                    color: T.fg1,
                    lineHeight: 1.55,
                    whiteSpace: "pre-wrap",
                    marginTop: 8,
                    cursor: "pointer",
                    // When collapsed, clip to 3 lines so the row stays
                    // scannable but shows enough preview to make sense of
                    // each summary without expanding. Expanded shows all.
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
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 11,
                    color: T.red,
                    marginTop: 8,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {e.error}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Delete-confirm dialog ──────────────────────────────────── */}
      {/* Styled to match the prompt-delete and Settings → clear-all   */}
      {/* flows. Body mentions both the kind+source and the activity   */}
      {/* log loss so the user knows exactly what's about to disappear.*/}
      <ConfirmDialog
        open={!!deleteConfirm}
        title="Delete watch?"
        body={
          deleteConfirm && (
            <>
              Delete the watch <b>"{deleteConfirm.name}"</b>
              {deleteConfirm.kind === "folder"
                ? " and its activity log?"
                : deleteConfirm.kind === "rss"
                  ? " (RSS feed) and its activity log?"
                  : " (URL) and its activity log?"}
              <br />
              <span style={{ fontSize: 11, color: T.fg3 }}>
                The notes file on disk is left untouched.
              </span>
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
            if (selectedWatchId === w.id) setSelectedWatchId(null);
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
    </aside>
  );
}

// ─── Watch Modal (create + edit) ────────────────────────────────────────────
// Form-only modal triggered from WatchPanel — either by the "+ Configure"
// button (create mode: `editing` prop is null/undefined) or by the pencil
// icon on a row (edit mode: `editing` prop is the watch object to pre-fill).
// Both paths terminate in `watch_create`, which is upsert-by-id on the Rust
// side; the panel reloads via the refreshKey bump in main.jsx once
// onCreated fires. `last_content` and `last_polled_at` are deliberately
// untouched by the upsert so editing a URL watch doesn't wipe the diff
// baseline.
// Per-kind sensible defaults for the poll cadence. Mirrors the Rust-side
// `default_interval_for_kind` so the UI defaults match what would be
// chosen server-side if the form sent 0. Switching kinds in the picker
// resets the interval to the new kind's default (but the user can still
// override before saving).
// defaultIntervalForKind lives in `ui/utils.js` so it's unit-testable
// under node:test. It's on `window` before this file loads.

// Discrete cadence choices per kind. We expose presets instead of a
// free-text number field so users don't accidentally configure a 1-second
// poll. Each option's value is in seconds — matches `interval_secs`.
//
// RSS and URL share the same option set — both are HTTP-fetched
// network sources where the cadence trade-offs (server politeness vs
// freshness) are the same shape. Folder is local IO with much more
// permissive minimums.
const FEED_INTERVAL_OPTIONS = [
  { secs: 300, label: "5 minutes" },
  { secs: 600, label: "10 minutes" },
  { secs: 1800, label: "30 minutes" },
  { secs: 3600, label: "1 hour" },
  { secs: 21600, label: "6 hours" },
  { secs: 43200, label: "12 hours" },
  { secs: 86400, label: "24 hours" },
];
const INTERVAL_OPTIONS = {
  folder: [
    { secs: 30, label: "30 seconds" },
    { secs: 60, label: "1 minute" },
    { secs: 300, label: "5 minutes" },
    { secs: 900, label: "15 minutes" },
  ],
  rss: FEED_INTERVAL_OPTIONS,
  url: FEED_INTERVAL_OPTIONS,
};

function WatchModal({
  open,
  onClose,
  onCreated,
  prompts,
  editing,
  // Tri-state: 'granted' / 'default' / null (still checking). When notify
  // is toggled on and this isn't 'granted', we show an inline explainer
  // strip with a "Request permission" button instead of letting the OS
  // prompt fire mysteriously on the first watch event. Defaults to
  // 'granted' for callers that don't pass these props (older usages).
  notifPermission = 'granted',
  // Called after the user clicks "Request permission" so main.jsx can
  // re-read the plugin state. WatchModal awaits the OS dialog, then
  // invokes this to refresh the prop.
  refreshNotifPermission = async () => {},
}) {
  const [form, setForm] = useState({
    name: "",
    kind: "folder",
    folderPath: "",
    sourceUrl: "",
    urlSelector: "",
    urlDiffMode: "snapshot",
    intervalSecs: 30,
    notesPath: "",
    model: "gemma4:latest",
    promptId: null,
    notify: false,
  });
  const [busy, setBusy] = useState(false);
  // Separate busy flag for the "and run" variant so the two buttons can
  // show independent spinner states (the save-only button stays clickable
  // while a save+run round-trip is in progress, and vice versa — though
  // in practice we disable both during either op for clarity).
  const [busyRun, setBusyRun] = useState(false);
  // "Advanced" disclosure for URL-kind options (CSS selector, eventually
  // diff mode in Phase 3). Hidden by default to keep the modal compact
  // for the common case.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Inline prompt-picker visibility. Kept at component scope (not inside
  // a sub-component) so re-renders triggered by typing in the search
  // input don't unmount the picker.
  const [promptPickerOpen, setPromptPickerOpen] = useState(false);
  const [promptSearch, setPromptSearch] = useState("");
  // Test-button state for RSS feed URLs. `result` is shown inline beneath
  // the URL input as either a green OK or red error message — keeps the
  // diagnostic right next to what they're testing.
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, msg } | null

  const invoke = getInvoke();
  const dialogApi = getDialogApi();

  // ── Native pickers ─────────────────────────────────────────────────────────
  // tauri-plugin-dialog exposes open()/save() that hit the OS file dialogs.
  // We seed defaultPath with the user's HOME if known so they land in a
  // useful directory; on macOS that means the picker opens in their home
  // instead of "/".
  const pickFolder = async () => {
    if (!dialogApi) return;
    try {
      const selected = await dialogApi.open({
        directory: true,
        multiple: false,
        title: "Choose folder to watch",
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
      // `save` returns a path the file *should* live at; the file doesn't
      // need to exist yet (Rust's append_to_notes creates it on first
      // write). filters bias the suggested extension toward Markdown.
      const selected = await dialogApi.save({
        title: "Choose notes file",
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

  const resetForm = () =>
    setForm({
      name: "",
      kind: "folder",
      folderPath: "",
      sourceUrl: "",
      urlSelector: "",
      urlDiffMode: "snapshot",
      intervalSecs: defaultIntervalForKind("folder"),
      notesPath: "",
      model: "gemma4:latest",
      promptId: null,
      notify: false,
    });

  // Each time the modal opens, either pre-fill from the watch being edited
  // (edit mode) or reset to defaults (create mode). Without this, a previous
  // cancel/abandon would bleed into the next session.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        name: editing.name || "",
        kind: editing.kind || "folder",
        folderPath: editing.folderPath || "",
        sourceUrl: editing.sourceUrl || "",
        urlSelector: editing.urlSelector || "",
        urlDiffMode: editing.urlDiffMode || "snapshot",
        intervalSecs:
          editing.intervalSecs ||
          defaultIntervalForKind(editing.kind || "folder"),
        notesPath: editing.notesPath || "",
        model: editing.model || "gemma4:latest",
        promptId: editing.promptId || null,
        notify: !!editing.notify,
      });
      // Open Advanced automatically if the watch has URL-specific tweaks
      // set — otherwise an existing CSS selector / diff-mode setting would
      // be hidden and the user might think their config was lost.
      const hasUrlTweaks =
        editing.kind === "url" &&
        (!!editing.urlSelector ||
          (editing.urlDiffMode && editing.urlDiffMode !== "snapshot"));
      setAdvancedOpen(!!hasUrlTweaks);
    } else {
      resetForm();
      setAdvancedOpen(false);
    }
    setPromptPickerOpen(false);
    setPromptSearch("");
    setTestResult(null);
  }, [open, editing]);

  // Validate the source field per kind: folder kinds need a folderPath,
  // RSS/URL need a sourceUrl. Notes file and name are always required.
  // Returns true if the Create button should be enabled.
  const isFormValid = () => {
    if (!form.name.trim() || !form.notesPath.trim()) return false;
    if (form.kind === "folder") return !!form.folderPath.trim();
    if (form.kind === "rss" || form.kind === "url") return !!form.sourceUrl.trim();
    return false;
  };

  const runTest = async () => {
    if (!invoke || !form.sourceUrl.trim()) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      const msg = await invoke("watch_test_source", {
        kind: form.kind,
        sourceUrl: form.sourceUrl.trim(),
      });
      setTestResult({ ok: true, msg });
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTestBusy(false);
    }
  };

  // Local busy state for the "Request permission" button only. We don't
  // share the form's `busy` because the permission dialog is independent
  // of saving — the user might click Request, get the OS prompt, decide,
  // then continue editing the form before saving.
  const [permBusy, setPermBusy] = useState(false);

  const requestNotificationPermission = async () => {
    const notifApi = getNotificationApi();
    if (!notifApi?.requestPermission) return;
    setPermBusy(true);
    try {
      const result = await notifApi.requestPermission();
      // Refresh the parent-held permission state so the strip re-renders
      // with the new value (which closes the strip if 'granted').
      await refreshNotifPermission();
      if (result !== 'granted') {
        window.ekToast?.({
          kind: 'warn',
          title: 'Notifications denied',
          body: 'Re-enable in System Settings → Notifications → Ekorbia.',
        });
      }
    } catch (e) {
      window.ekToast?.({
        kind: 'error',
        title: 'Permission request failed',
        body: String(e),
      });
    } finally {
      setPermBusy(false);
    }
  };

  // `runAfter=true` immediately fires `watch_run_one` after the create
  // succeeds — powers the "Create and run" / "Save and run" button. The
  // run is fire-and-forget (we don't await): the user sees the activity
  // feed light up live via the `watch:event_changed` subscription, and
  // the modal closes immediately so they're not blocked behind a poten-
  // tially-minutes-long LLM call.
  const saveWatch = async (runAfter = false) => {
    if (!isFormValid()) return;
    // Edit mode reuses the existing id (so the upsert lands as UPDATE);
    // create mode mints a fresh one.
    const id =
      editing?.id ||
      `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    if (runAfter) setBusyRun(true);
    else setBusy(true);
    try {
      await invoke("watch_create", {
        watch: {
          id,
          name: form.name.trim(),
          // Folder kinds keep folderPath; other kinds send "" so the NOT
          // NULL column stays happy and the Rust side reads source_url.
          folderPath: form.kind === "folder" ? form.folderPath.trim() : "",
          notesPath: form.notesPath.trim(),
          model: form.model.trim() || "gemma4:latest",
          promptId: form.promptId || null,
          // `enabled` is in the upsert SET clause on the Rust side, so we
          // must echo the current value when editing — otherwise saving a
          // paused watch would silently un-pause it.
          enabled: editing ? !!editing.enabled : true,
          // `created_at` is NOT in the SET clause, so the DB ignores this
          // on update — but still send the original value when editing for
          // tidiness (no spurious changed-row reads).
          createdAt: editing?.createdAt || Math.floor(Date.now() / 1000),
          kind: form.kind,
          sourceUrl: form.kind === "folder" ? null : (form.sourceUrl.trim() || null),
          intervalSecs: form.intervalSecs || defaultIntervalForKind(form.kind),
          lastPolledAt: editing?.lastPolledAt || 0,
          // URL kind only: optional CSS selector. Sending null for other
          // kinds (and for blank input) so the Rust normaliser turns it
          // into a real NULL in DB rather than an empty string.
          urlSelector:
            form.kind === "url"
              ? (form.urlSelector.trim() || null)
              : null,
          // URL kind only: 'snapshot' or 'diff'. Null for non-URL kinds so
          // the column stays cleanly inapplicable on folder/RSS rows.
          urlDiffMode: form.kind === "url" ? form.urlDiffMode : null,
          // v1 notifications: per-watch opt-in for OS notifications.
          // Rust requests permission lazily on first fire if needed.
          notify: !!form.notify,
        },
      });
      // Fire-and-forget the immediate run — don't await. The Rust side
      // returns once the cycle completes (which can be minutes); doing
      // it inline would block the modal close. The activity feed
      // subscribes to `watch:event_changed` and shows progress live.
      // Errors from the run itself surface as 'error' rows in the feed.
      if (runAfter) {
        invoke("watch_run_one", { id }).catch((e) => {
          window.ekToast?.({
            kind: 'error',
            title: 'Watch run failed',
            body: String(e),
          });
        });
      }
      // onCreated bumps the WatchPanel's refreshKey so the new/edited row
      // appears with current values, and (typically) closes this modal.
      if (onCreated) onCreated();
    } catch (e) {
      window.ekToast?.({
        kind: 'error',
        title: editing ? 'Watch save failed' : 'Watch create failed',
        body: String(e),
      });
    } finally {
      // Always clear both — the modal closes on success but stays open
      // on error, and a stale spinner would be confusing either way.
      setBusy(false);
      setBusyRun(false);
    }
  };

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxHeight: "82vh",
          background: T.bg1,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 12,
          boxShadow: "0 30px 70px rgba(0,0,0,0.55)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
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
            flexShrink: 0,
          }}
        >
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
          >
            <I.Eye size={14} style={{ color: T.fg2 }} />
            <span
              style={{
                fontFamily: T.sans,
                fontSize: 14,
                fontWeight: 600,
                color: T.fg,
              }}
            >
              {editing ? "Edit watch" : "New watch"}
            </span>
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: T.fg3,
              padding: 4,
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
            }}
          >
            <I.X size={14} />
          </button>
        </div>

        {/* Body — scrollable */}
        <div
          style={{
            padding: "14px 16px 16px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <WatchField
            label="Name"
            value={form.name}
            onChange={(v) => setForm({ ...form, name: v })}
            placeholder="e.g. Downloads inbox"
          />

          {/* ── Kind picker ──────────────────────────────────────────── */}
          {/* Three-way segmented control — Folder / RSS feed / URL.    */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 10,
                color: T.fg3,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              Kind
            </span>
            <div
              style={{
                display: "inline-flex",
                border: `1px solid ${T.border}`,
                borderRadius: 5,
                overflow: "hidden",
                width: "fit-content",
              }}
            >
              {[
                { id: "folder", label: "Folder" },
                { id: "rss", label: "RSS feed" },
                { id: "url", label: "URL" },
              ].map((k, i) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => {
                    // Switching kind resets cadence + source fields so we
                    // don't leak a stale folder path into an RSS create.
                    setForm((f) => ({
                      ...f,
                      kind: k.id,
                      intervalSecs: defaultIntervalForKind(k.id),
                    }));
                    setTestResult(null);
                  }}
                  style={{
                    background: form.kind === k.id ? T.amber : T.bg3,
                    color: form.kind === k.id ? T.bg0 : T.fg1,
                    border: "none",
                    borderLeft: i === 0 ? "none" : `1px solid ${T.border}`,
                    padding: "6px 14px",
                    fontFamily: T.mono,
                    fontSize: 11,
                    fontWeight: form.kind === k.id ? 600 : 400,
                    cursor: "pointer",
                  }}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Source field (varies by kind) ────────────────────────── */}
          {form.kind === "folder" && (
            <WatchField
              label="Watch folder"
              value={form.folderPath}
              onChange={(v) => setForm({ ...form, folderPath: v })}
              placeholder="/Users/you/Downloads"
              onBrowse={pickFolder}
              browseLabel="Choose…"
            />
          )}
          {form.kind === "rss" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <WatchField
                label="Feed URL"
                value={form.sourceUrl}
                onChange={(v) => {
                  setForm({ ...form, sourceUrl: v });
                  // Clear stale test result on any edit so the green/red
                  // line doesn't lie about a URL that changed since.
                  if (testResult) setTestResult(null);
                }}
                placeholder="https://example.com/feed.xml"
                onBrowse={runTest}
                browseLabel={testBusy ? "Testing…" : "Test"}
              />
              {testResult && (
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 10.5,
                    color: testResult.ok ? (T.green) : T.red,
                    lineHeight: 1.4,
                    wordBreak: "break-word",
                  }}
                >
                  {testResult.msg}
                </div>
              )}
            </div>
          )}
          {form.kind === "url" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <WatchField
                label="URL"
                value={form.sourceUrl}
                onChange={(v) => {
                  setForm({ ...form, sourceUrl: v });
                  if (testResult) setTestResult(null);
                }}
                placeholder="https://example.com/blog/post"
                onBrowse={runTest}
                browseLabel={testBusy ? "Testing…" : "Test"}
              />
              {testResult && (
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 10.5,
                    color: testResult.ok ? (T.green) : T.red,
                    lineHeight: 1.4,
                    wordBreak: "break-word",
                  }}
                >
                  {testResult.msg}
                </div>
              )}
              {/* Hint about what URL watching does — different mental */}
              {/* model than RSS so a one-liner saves on confusion.    */}
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  color: T.fg3,
                  lineHeight: 1.5,
                }}
              >
                Ekorbia fetches this page on each poll and summarises it
                only when the visible text changes since the last fetch.
              </div>

              {/* ── Advanced (CSS selector) ──────────────────────────── */}
              <button
                type="button"
                onClick={() => setAdvancedOpen((o) => !o)}
                style={{
                  background: "none",
                  border: "none",
                  padding: "2px 0",
                  marginTop: 2,
                  color: T.fg3,
                  fontFamily: T.mono,
                  fontSize: 10,
                  cursor: "pointer",
                  textAlign: "left",
                  width: "fit-content",
                  textDecoration: "underline",
                }}
              >
                {advancedOpen ? "Hide advanced" : "Advanced…"}
              </button>
              {advancedOpen && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    background: T.bg2,
                    border: `1px solid ${T.border}`,
                    borderRadius: 5,
                    padding: "8px 10px",
                  }}
                >
                  {/* ── Mode toggle ────────────────────────────────────── */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span
                      style={{
                        fontFamily: T.mono,
                        fontSize: 10,
                        color: T.fg3,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      What to summarise
                    </span>
                    <div
                      style={{
                        display: "inline-flex",
                        border: `1px solid ${T.border}`,
                        borderRadius: 5,
                        overflow: "hidden",
                        width: "fit-content",
                      }}
                    >
                      {[
                        {
                          id: "snapshot",
                          label: "Snapshot",
                          desc: "Whole page on each change",
                        },
                        {
                          id: "diff",
                          label: "Diff only",
                          desc: "Only the added/changed lines",
                        },
                      ].map((m, i) => (
                        <button
                          key={m.id}
                          type="button"
                          title={m.desc}
                          onClick={() => setForm({ ...form, urlDiffMode: m.id })}
                          style={{
                            background:
                              form.urlDiffMode === m.id ? T.amber : T.bg3,
                            color:
                              form.urlDiffMode === m.id ? T.bg0 : T.fg1,
                            border: "none",
                            borderLeft:
                              i === 0 ? "none" : `1px solid ${T.border}`,
                            padding: "5px 12px",
                            fontFamily: T.mono,
                            fontSize: 10.5,
                            fontWeight: form.urlDiffMode === m.id ? 600 : 400,
                            cursor: "pointer",
                          }}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 10,
                        color: T.fg3,
                        lineHeight: 1.5,
                      }}
                    >
                      {form.urlDiffMode === "diff"
                        ? "Sends a unified line diff of what changed since the last poll. The first fetch always sends the whole page so you get a baseline."
                        : "Sends the whole current page each time it changes."}
                    </div>
                  </div>

                  {/* ── CSS selector ──────────────────────────────────── */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <WatchField
                      label="CSS selector (optional)"
                      value={form.urlSelector}
                      onChange={(v) => setForm({ ...form, urlSelector: v })}
                      placeholder="article, main, .post-content"
                    />
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 10,
                        color: T.fg3,
                        lineHeight: 1.5,
                      }}
                    >
                      Narrow the watched region. Leave blank to use the whole
                      page. If the selector matches nothing on a given poll,
                      the full page is used as a fallback.
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Poll cadence ─────────────────────────────────────────── */}
          {/* Select from kind-appropriate presets. Discrete values keep */}
          {/* users from accidentally setting a 1-second poll on a feed. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 10,
                color: T.fg3,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              Poll every
            </span>
            <select
              value={form.intervalSecs}
              onChange={(e) =>
                setForm({ ...form, intervalSecs: parseInt(e.target.value, 10) })
              }
              style={{
                background: T.bg2,
                border: `1px solid ${T.border}`,
                borderRadius: 5,
                padding: "6px 9px",
                color: T.fg,
                fontFamily: T.mono,
                fontSize: 12,
                outline: "none",
                cursor: "pointer",
                width: "fit-content",
                minWidth: 160,
              }}
            >
              {(INTERVAL_OPTIONS[form.kind] || INTERVAL_OPTIONS.folder).map(
                (opt) => (
                  <option key={opt.secs} value={opt.secs}>
                    {opt.label}
                  </option>
                ),
              )}
            </select>
          </div>

          <WatchField
            label="Notes file"
            value={form.notesPath}
            onChange={(v) => setForm({ ...form, notesPath: v })}
            placeholder="/Users/you/Documents/inbox-summaries.md"
            onBrowse={pickNotesFile}
            browseLabel="Choose…"
          />

          {/* ── Notifications toggle ─────────────────────────────────── */}
          {/* Per-watch opt-in for OS notifications. Off by default —    */}
          {/* a chatty folder watch fires every few seconds and would    */}
          {/* drown the user otherwise. When toggled on and OS perm is   */}
          {/* not yet granted, an explainer strip appears below with a   */}
          {/* "Request permission" button — so the user understands the  */}
          {/* OS prompt before it fires.                                  */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              userSelect: "none",
              padding: "2px 0",
            }}
          >
            <input
              type="checkbox"
              checked={!!form.notify}
              onChange={(e) =>
                setForm({ ...form, notify: e.target.checked })
              }
              style={{ cursor: "pointer" }}
            />
            <span
              style={{
                fontFamily: T.sans,
                fontSize: 12,
                color: T.fg1,
              }}
            >
              Notify on events
            </span>
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 10,
                color: T.fg3,
                fontStyle: "italic",
              }}
            >
              — coalesced per poll; errors dedup until recovery
            </span>
          </label>

          {/* Inline permission explainer. Renders only when notify is on   */}
          {/* and OS permission isn't granted yet. The button surfaces the  */}
          {/* OS prompt; the parent's refresh callback re-reads state when  */}
          {/* the user responds, which closes the strip on grant.           */}
          {form.notify && notifPermission && notifPermission !== 'granted' && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: "10px 12px",
                marginLeft: 22,
                background: T.bg2,
                border: `1px solid ${T.amber}55`,
                borderLeft: `3px solid ${T.amber}`,
                borderRadius: 4,
              }}
            >
              <div
                style={{
                  fontFamily: T.sans,
                  fontSize: 11.5,
                  color: T.fg1,
                  lineHeight: 1.5,
                }}
              >
                <strong style={{ color: T.fg, fontWeight: 600 }}>
                  Notifications need permission.
                </strong>{" "}
                Ekorbia uses the OS notification system (Notification Center
                on macOS, Action Center on Windows). When this watch fires,
                you'll see a banner with the watch name and a short
                AI-generated summary. Clicking the banner brings the app
                forward and filters the activity feed to this watch.
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  onClick={requestNotificationPermission}
                  disabled={permBusy}
                  style={{
                    background: T.amber,
                    color: T.bg0,
                    border: "none",
                    borderRadius: 4,
                    padding: "4px 10px",
                    fontFamily: T.mono,
                    fontSize: 10.5,
                    fontWeight: 600,
                    cursor: permBusy ? "default" : "pointer",
                    opacity: permBusy ? 0.6 : 1,
                  }}
                >
                  {permBusy ? "Requesting…" : "Request permission"}
                </button>
                <span
                  style={{
                    fontFamily: T.mono,
                    fontSize: 10,
                    color: T.fg3,
                    fontStyle: "italic",
                  }}
                >
                  The OS will show its standard prompt.
                </span>
              </div>
            </div>
          )}

          <WatchField
            label="Model"
            value={form.model}
            onChange={(v) => setForm({ ...form, model: v })}
            placeholder="gemma4:latest"
          />

          {/* ── Prompt picker ──────────────────────────────────────── */}
          {/* Links this watch to a prompt in the library. Rust loads */}
          {/* the body at process time and uses it as the system      */}
          {/* message. Default = built-in summary instruction.        */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 10,
                color: T.fg3,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              Summarisation prompt
            </span>
            <button
              type="button"
              onClick={() => setPromptPickerOpen((o) => !o)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: T.bg3,
                border: `1px solid ${promptPickerOpen ? T.borderStrong : T.border}`,
                borderRadius: 5,
                padding: "6px 10px",
                color: T.fg,
                fontFamily: T.mono,
                fontSize: 12,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              {(() => {
                const sel = form.promptId
                  ? prompts.find((p) => p.id === form.promptId)
                  : null;
                const fav =
                  sel && sel.favorite
                    ? FAVORITE_COLOR_MAP[sel.favorite]
                    : null;
                const favColor = fav?.color || null;
                return (
                  <>
                    {favColor && (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 99,
                          background: favColor,
                          boxShadow: `0 0 4px ${favColor}88`,
                        }}
                      />
                    )}
                    <span style={{ flex: 1, color: sel ? T.fg : T.fg2 }}>
                      {sel ? sel.name : "(default summary instruction)"}
                    </span>
                    <span style={{ fontSize: 9, color: T.fg3 }}>▾</span>
                  </>
                );
              })()}
            </button>
            {promptPickerOpen && (
              <div
                style={{
                  marginTop: 4,
                  background: T.bg2,
                  border: `1px solid ${T.border}`,
                  borderRadius: 6,
                  overflow: "hidden",
                }}
              >
                <div style={{ padding: "6px 8px 4px" }}>
                  <input
                    autoFocus
                    placeholder="Search prompts…"
                    value={promptSearch}
                    onChange={(e) => setPromptSearch(e.target.value)}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      background: T.bg3,
                      border: `1px solid ${T.border}`,
                      borderRadius: 4,
                      color: T.fg,
                      fontFamily: T.mono,
                      fontSize: 11,
                      padding: "4px 8px",
                      outline: "none",
                    }}
                  />
                </div>
                <div
                  style={{
                    maxHeight: 220,
                    overflowY: "auto",
                    padding: "2px 0 6px",
                  }}
                >
                  {/* "None" option — explicit way to clear and use   */}
                  {/* the built-in default summary instruction.        */}
                  <button
                    type="button"
                    onClick={() => {
                      setForm((f) => ({ ...f, promptId: null }));
                      setPromptPickerOpen(false);
                      setPromptSearch("");
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      width: "calc(100% - 12px)",
                      margin: "0 6px 1px",
                      padding: "6px 10px",
                      background: !form.promptId ? T.bg4 : "transparent",
                      border: "none",
                      borderRadius: 4,
                      cursor: "pointer",
                      color: !form.promptId ? T.fg : T.fg1,
                      fontFamily: T.sans,
                      fontSize: 12.5,
                      textAlign: "left",
                      fontStyle: "italic",
                    }}
                  >
                    <span style={{ width: 6, height: 6 }} />
                    <span style={{ flex: 1 }}>
                      (default summary instruction)
                    </span>
                    {!form.promptId && (
                      <span style={{ color: T.amber }}>✓</span>
                    )}
                  </button>
                  {prompts
                    // A→Z sort by display name. `.slice()` first so we
                    // don't mutate the prop. Mirrors the overlay's prompt
                    // list so both pickers feel consistent.
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .filter((p) => {
                      const q = promptSearch.trim().toLowerCase();
                      if (!q) return true;
                      return (
                        p.name.toLowerCase().includes(q) ||
                        (p.body || "").toLowerCase().includes(q) ||
                        (p.tags || []).some((t) => t.toLowerCase().includes(q))
                      );
                    })
                    .map((p) => {
                      const sel = p.id === form.promptId;
                      const fav = p.favorite
                        ? FAVORITE_COLOR_MAP[p.favorite]
                        : null;
                      const favColor = fav?.color || null;
                      return (
                        <button
                          type="button"
                          key={p.id}
                          onClick={() => {
                            // Toggle: re-selecting current clears it
                            setForm((f) => ({
                              ...f,
                              promptId: sel ? null : p.id,
                            }));
                            setPromptPickerOpen(false);
                            setPromptSearch("");
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            width: "calc(100% - 12px)",
                            margin: "0 6px 1px",
                            padding: "6px 10px",
                            background: sel ? T.bg4 : "transparent",
                            border: "none",
                            borderRadius: 4,
                            cursor: "pointer",
                            color: sel ? T.fg : T.fg1,
                            fontFamily: T.sans,
                            fontSize: 12.5,
                            textAlign: "left",
                          }}
                        >
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 99,
                              background: favColor || "transparent",
                              flexShrink: 0,
                              boxShadow: favColor
                                ? `0 0 4px ${favColor}88`
                                : "none",
                            }}
                          />
                          <span
                            style={{
                              flex: 1,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {p.name}
                          </span>
                          {sel && <span style={{ color: T.amber }}>✓</span>}
                        </button>
                      );
                    })}
                  {prompts.length === 0 && (
                    <div
                      style={{
                        padding: "10px 14px",
                        color: T.fg3,
                        fontFamily: T.sans,
                        fontSize: 11.5,
                        lineHeight: 1.55,
                      }}
                    >
                      No prompts in the library yet.
                      <div style={{ marginTop: 4, color: T.fg3, fontSize: 11 }}>
                        Add some from the Prompts tab — they'll appear here.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <button
              onClick={() => saveWatch(false)}
              disabled={busy || busyRun || !isFormValid()}
              style={{
                background: isFormValid() && !busy && !busyRun ? T.amber : T.bg3,
                color: isFormValid() && !busy && !busyRun ? T.bg0 : T.fg3,
                border: "none",
                borderRadius: 5,
                padding: "5px 12px",
                fontFamily: T.mono,
                fontSize: 11,
                fontWeight: 600,
                cursor:
                  busy || busyRun || !isFormValid() ? "default" : "pointer",
              }}
            >
              {editing ? "Save changes" : "Create"}
            </button>
            {/* "And run" variant — same upsert, then fire-and-forget    */}
            {/* watch_run_one so the user gets immediate feedback. The   */}
            {/* button is styled as a subtler secondary action (bordered */}
            {/* rather than filled) since the bare Create is the safer   */}
            {/* default; users who *want* to run can pick this one.      */}
            <button
              onClick={() => saveWatch(true)}
              disabled={busy || busyRun || !isFormValid()}
              title={
                editing
                  ? "Save changes and run this watch immediately"
                  : "Create this watch and run it immediately"
              }
              style={{
                background: "transparent",
                color:
                  isFormValid() && !busy && !busyRun ? T.amber : T.fg3,
                border: `1px solid ${
                  isFormValid() && !busy && !busyRun
                    ? T.amber
                    : T.border
                }`,
                borderRadius: 5,
                padding: "5px 12px",
                fontFamily: T.mono,
                fontSize: 11,
                fontWeight: 600,
                cursor:
                  busy || busyRun || !isFormValid() ? "default" : "pointer",
              }}
            >
              {busyRun
                ? "Running…"
                : editing
                  ? "Save and run"
                  : "Create and run"}
            </button>
            <button
              onClick={onClose}
              style={{
                background: "transparent",
                color: T.fg2,
                border: `1px solid ${T.border}`,
                borderRadius: 5,
                padding: "5px 12px",
                fontFamily: T.mono,
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
