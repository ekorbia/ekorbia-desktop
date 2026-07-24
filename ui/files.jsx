// files.jsx — FilesPanel for the right-panel "Files" tab.
//
// Scope (May 2026 v1):
//   - Header: output dir + Change… / Block / Reset; file count
//   - Flat list grouped by rel_path, newest-write-wins for the head row
//   - Per-row Reveal / Open buttons; click row → scroll chat to source message
//   - Refresh on chat switch + the `chat:files_changed` Rust event
//
// Deferred (worth doing later if the panel pays off):
//   - Tree view, expandable per-file version chain, diffs between versions,
//     live preview, external-editor shell-out, rejected-write history.
//
// The panel is intentionally read-mostly. The only state-mutating affordance
// is the Change… / Block buttons in the header (which already have full
// permission-flow semantics via chat_set_output_dir).

// "Nm ago" / "Nh ago" / etc. — relativeTime in verbose mode lives in
// utils.js (unit-testable, shared with WatchPanel). The wrapper here
// keeps the empty-savedAt → "" short-circuit so absent timestamps don't
// render as "just now" (which would lie to the user).
'use strict';
function ekFilesAgeLabel(savedAt) {
  if (!savedAt) return '';
  return relativeTime(savedAt, { verbose: true });
}

function ekFilesByteLabel(bytes) {
  if (bytes == null) return '';
  // Space before the unit so "76 B" doesn't read as "768" at a glance.
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Collapse the chat_files_list result (multiple rows per rel_path = version
// history) into one row per rel_path with the latest version metadata at
// the head + a `versions` array of every save. Sorted by most-recent-save
// across the whole list so frequently-edited files float to the top.
// ekFilesGroupByPath lives in `ui/utils.js` so it's unit-testable
// under node:test. It's on `window` before this file loads.

function FilesPanel({ tabHeader, width, chatId, onScrollToMessage }) {
  const invoke = getInvoke();
  const [files, setFiles] = useState([]);
  const [outputDir, setOutputDir] = useState(null);
  // Bumping this re-runs the load effect without juggling promises. Useful
  // both for the `chat:files_changed` event and post-Change… refreshes.
  const [reloadKey, setReloadKey] = useState(0);

  // Reload on chat switch + reloadKey bump. Output dir + file list go
  // together so the header and body stay in sync.
  useEffect(() => {
    if (!chatId || !invoke) {
      setFiles([]); setOutputDir(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [list, dir] = await Promise.all([
          invoke('chat_files_list', { chatId }),
          invoke('chat_output_dir', { chatId }),
        ]);
        if (cancelled) return;
        setFiles(Array.isArray(list) ? list : []);
        setOutputDir(typeof dir === 'string' ? dir : null);
      } catch (e) {
        if (!cancelled) { setFiles([]); setOutputDir(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [chatId, reloadKey]);

  // chat:files_changed listener — only refreshes when the event is for the
  // active chat. Otherwise switching chats while another save is in flight
  // would refresh the WRONG chat's panel.
  useEffect(() => {
    const eventApi = getEventApi();
    if (!eventApi || !chatId) return;
    let unlisten = null;
    eventApi
      .listen('chat:files_changed', (e) => {
        if (e?.payload?.chatId === chatId) {
          setReloadKey((k) => k + 1);
        }
      })
      .then((u) => { unlisten = u; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, [chatId]);

  const grouped = useMemo(() => ekFilesGroupByPath(files), [files]);

  const pickFolder = async () => {
    const dialogApi = getDialogApi();
    if (!dialogApi || !chatId) return;
    try {
      const picked = await dialogApi.open({
        directory: true,
        multiple: false,
        defaultPath: outputDir || undefined,
      });
      if (typeof picked === 'string' && picked) {
        await invoke('chat_set_output_dir', { chatId, dir: picked });
        setReloadKey((k) => k + 1);
      }
    } catch (_) { /* cancelled */ }
  };

  const block = async () => {
    if (!chatId) return;
    try {
      await invoke('chat_set_output_dir', { chatId, dir: '' });
      setReloadKey((k) => k + 1);
      window.ekToast?.({
        kind: 'info',
        title: 'File saves blocked',
        body: 'The model can no longer save files to this chat. Use Change… to re-enable.',
      });
    } catch (e) {
      window.ekToast?.({ kind: 'error', title: 'Block failed', body: String(e) });
    }
  };

  // Reveal / Open go through native Tauri commands (chat_file_reveal,
  // chat_file_open, chat_output_dir_reveal) instead of tauri-plugin-shell.
  // The shell plugin's `open` API has a default scope regex that rejects
  // bare filesystem paths ("Scoped command argument at position 0 was
  // found, but failed regex validation ^((mailto:\w+)|(tel:\w+)|...") —
  // the Rust commands spawn the platform opener directly (macOS `open`,
  // `open -R`; xdg-open on Linux; explorer on Windows) so we sidestep that.
  const revealFolder = async () => {
    if (!chatId) return;
    try {
      await invoke('chat_output_dir_reveal', { chatId });
    } catch (e) {
      console.error('chat_output_dir_reveal failed:', e);
      window.ekToast?.({
        kind: 'warn',
        title: 'Could not reveal folder',
        body: String(e),
      });
    }
  };

  const reveal = async (row, action) => {
    try {
      const cmd = action === 'reveal' ? 'chat_file_reveal' : 'chat_file_open';
      await invoke(cmd, { fileId: row.head.id });
    } catch (e) {
      console.error(`${action} failed for fileId=${row.head.id}:`, e);
      window.ekToast?.({
        kind: 'warn',
        title: `Could not ${action}`,
        body: String(e),
      });
    }
  };

  // Drop a deleted file's entry (all versions) from the list. Only offered on
  // rows the model marked `missing` — clears the chat_files rows, never disk.
  const removeFromList = async (row) => {
    if (!chatId) return;
    try {
      await invoke('chat_file_remove', { fileId: row.head.id });
      setReloadKey((k) => k + 1);
    } catch (e) {
      window.ekToast?.({ kind: 'error', title: 'Remove failed', body: String(e) });
    }
  };

  // ── Header strip ─────────────────────────────────────────────────────
  // Three states for outputDir:
  //   null              → never picked. Show "Not set" + Choose folder...
  //   "" (empty string) → user blocked. Show "Blocked" + Unblock (= Change)
  //   "/abs/path"       → normal. Show the path + Reveal/Change/Block.
  const dirState =
    outputDir == null ? 'unset'
      : outputDir === '' ? 'blocked'
        : 'set';

  const header = (
    <div
      style={{
        padding: '8px 12px',
        borderBottom: `1px solid ${T.border}`,
        background: T.bg1,
        fontFamily: T.mono,
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ color: T.fg2 }}>Output:</span>
        <span
          title={outputDir || ''}
          style={{
            flex: 1,
            color: dirState === 'set' ? T.fg : T.fg3,
            fontStyle: dirState === 'set' ? 'normal' : 'italic',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: dirState === 'set' ? 'rtl' : 'ltr', // show tail of path
            textAlign: 'left',
          }}
        >
          {dirState === 'set' && outputDir}
          {dirState === 'unset' && 'Not set'}
          {dirState === 'blocked' && 'Blocked'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={pickFolder}
          style={{
            padding: '2px 8px',
            background: T.bg2,
            border: `1px solid ${T.border}`,
            borderRadius: 4,
            color: T.fg1,
            cursor: 'pointer',
            fontFamily: T.mono,
            fontSize: 10,
          }}
        >Change…</button>
        {dirState === 'set' && (
          <button
            onClick={revealFolder}
            style={{
              padding: '2px 8px',
              background: T.bg2,
              border: `1px solid ${T.border}`,
              borderRadius: 4,
              color: T.fg1,
              cursor: 'pointer',
              fontFamily: T.mono,
              fontSize: 10,
            }}
          >Reveal</button>
        )}
        {dirState !== 'blocked' && (
          <button
            onClick={block}
            title="Block file saves on this chat"
            style={{
              padding: '2px 8px',
              background: T.bg2,
              border: `1px solid ${T.border}`,
              borderRadius: 4,
              color: T.fg2,
              cursor: 'pointer',
              fontFamily: T.mono,
              fontSize: 10,
            }}
          >Block</button>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: T.fg3, fontSize: 10, alignSelf: 'center' }}>
          {grouped.length === 0
            ? 'no files'
            : `${grouped.length} file${grouped.length === 1 ? '' : 's'}`}
        </span>
      </div>
    </div>
  );

  return (
    <div
      style={{
        width,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: T.bg1,
        borderLeft: `1px solid ${T.border}`,
        minWidth: 280,
      }}
    >
      {tabHeader}
      {header}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {grouped.length === 0 ? (
          <div
            style={{
              padding: '24px 16px',
              color: T.fg3,
              fontFamily: T.sans,
              fontSize: 12,
              lineHeight: 1.6,
              textAlign: 'center',
            }}
          >
            No files saved yet.
            <div style={{ marginTop: 8, fontSize: 11, color: T.fg3 }}>
              Each chat keeps its own saved files and output folder, so
              switching chats shows a different set.
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: T.fg3 }}>
              Tool-using models can write files here; for other models, fenced
              code blocks in assistant messages show a Save button.
            </div>
          </div>
        ) : (
          grouped.map((g) => {
            const r = g.head;
            return (
              <div
                key={g.relPath}
                onClick={() => {
                  if (r.messageId && onScrollToMessage) onScrollToMessage(r.messageId);
                }}
                style={{
                  padding: '8px 12px',
                  borderBottom: `1px solid ${T.border}`,
                  cursor: r.messageId ? 'pointer' : 'default',
                  fontFamily: T.mono,
                  fontSize: 11,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = T.bg2)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {/* Line 1: filename + size/age + actions */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      color: T.fg,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {g.relPath}
                  </div>
                  <div
                    style={{
                      flexShrink: 0,
                      color: T.fg3,
                      fontSize: 10,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.missing ? (
                      <span
                        title="This file was deleted outside Ekorbia"
                        style={{ color: T.amber }}
                      >deleted from disk</span>
                    ) : (
                      <>
                        <span>{ekFilesByteLabel(r.bytes)}</span>
                        {g.versions.length > 1 && (
                          <span title={`${g.versions.length} versions saved`}>
                            v{r.version}
                          </span>
                        )}
                        {r.source === 'manual' && (
                          <span title="Saved via the Save button on a fenced code block">
                            manual
                          </span>
                        )}
                        <span>{ekFilesAgeLabel(r.savedAt)}</span>
                      </>
                    )}
                  </div>
                  {r.missing ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeFromList(g); }}
                      title="Remove this deleted file from the list"
                      style={{
                        flexShrink: 0,
                        background: 'none',
                        border: 'none',
                        color: T.fg2,
                        cursor: 'pointer',
                        fontFamily: T.mono,
                        fontSize: 10,
                        padding: '2px 4px',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = T.red)}
                      onMouseLeave={(e) => (e.currentTarget.style.color = T.fg2)}
                    >Remove</button>
                  ) : (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); reveal(g, 'reveal'); }}
                        title="Reveal in Finder"
                        style={{
                          flexShrink: 0,
                          background: 'none',
                          border: 'none',
                          color: T.fg2,
                          cursor: 'pointer',
                          fontFamily: T.mono,
                          fontSize: 10,
                          padding: '2px 4px',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = T.fg)}
                        onMouseLeave={(e) => (e.currentTarget.style.color = T.fg2)}
                      >Reveal</button>
                      <button
                        onClick={(e) => { e.stopPropagation(); reveal(g, 'open'); }}
                        title="Open file"
                        style={{
                          flexShrink: 0,
                          background: 'none',
                          border: 'none',
                          color: T.fg2,
                          cursor: 'pointer',
                          fontFamily: T.mono,
                          fontSize: 10,
                          padding: '2px 4px',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = T.fg)}
                        onMouseLeave={(e) => (e.currentTarget.style.color = T.fg2)}
                      >Open</button>
                    </>
                  )}
                </div>
                {/* Two-line content preview below the header line */}
                {r.preview && (
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10.5,
                      color: T.fg2,
                      marginTop: 4,
                      lineHeight: 1.4,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      wordBreak: 'break-word',
                    }}
                  >
                    {r.preview}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
