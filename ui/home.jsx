// home.jsx — the Home screen: what the app opens on.
//
//   a row to ask a quick question   → a new chat in General
//   the workspaces, one card each   → opens that workspace
//   the most recent chats           → opens that chat in its workspace
//
// A workspace is a Space under a plainer name (see ui/shell.jsx for the
// workspace window's sidebar). "General" is every chat that has no Space;
// it has a card of its own and is spelled `null` as a workspace id.
//
// Presentation only: every figure arrives through props (main.jsx owns the
// chat rows, the Spaces and their pinned documents) and every action goes
// back out through a callback. The Space dialogs (create, rename, colour,
// delete, settings) are the same components the sidebar used to host.
//
// Depends on: tokens, atoms (BrandMark), icons, shell (WINDOW_DRAG, the
// Space dialogs, MenuItem, MessageHitRow), utils, voice (VoiceMicButton).
'use strict';

// How many recent chats Home lists.
const HOME_RECENT_LIMIT = 4;

// "today" / "yesterday" / a short date, from unix seconds. Coarser than
// relativeTime on purpose: a card says when you last worked there, not how
// many minutes ago.
function homeWhenLabel(unixSecs) {
  if (!unixSecs) return "";
  const d = new Date(unixSecs * 1000);
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function HomeScreen({
  spaces = [],
  // Every saved chat row (db_load_chats), all workspaces together.
  chatRows = [],
  // { [spaceId]: [{ kind: 'file' | 'folder', path }] } — pinned documents.
  pinsBySpace = {},
  // The app-wide model id, so a card can say when a workspace uses another.
  defaultModelId = "",
  // (id) → the model's plain name, for that tag. Omitted, the id is shown.
  modelName,
  // For the settings dialog's model list (see SpaceSettingsModal).
  nameOfModel,
  appDefaultName = "",
  // { [spaceId]: { documents, capped } } — pinned documents, counted by Rust.
  docCounts = {},
  query = "",
  onQuery,
  messageHits = [],
  onPickHit,
  onOpenSpace,
  onOpenChat,
  // (text) → start a chat in General with this question.
  onAsk,
  askDisabled = false,
  onCreateSpace,
  onRenameSpace,
  onDeleteSpace,
  onEditSpaceSave,
  promptsLibrary = [],
  // The status line and settings menu, built once by main.jsx.
  footer = null,
}) {
  const [ask, setAsk] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [menu, setMenu] = useState(null); // { space, x, y }
  const [renameModal, setRenameModal] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [editModal, setEditModal] = useState(null);

  const summaries = useMemo(() => workspaceSummaries(chatRows), [chatRows]);
  const recent = useMemo(() => recentChatItems(chatRows, HOME_RECENT_LIMIT), [chatRows]);
  const spaceNameById = useMemo(() => {
    const m = new Map();
    for (const s of spaces || []) m.set(s.id, s.name || "Unnamed");
    return m;
  }, [spaces]);

  const submitAsk = () => {
    const text = ask.trim();
    if (!text || askDisabled) return;
    setAsk("");
    onAsk && onAsk(text);
  };

  // ── Search results (replace the cards while a query is active) ──
  const q = query.trim().toLowerCase();
  const searching = !!q;
  const spaceMatches = searching
    ? (spaces || []).filter((s) => (s.name || "").toLowerCase().includes(q))
    : [];
  const chatMatches = searching
    ? recentChatItems(chatRows).filter((c) => (c.title || "").toLowerCase().includes(q)).slice(0, 30)
    : [];
  const anyResults = spaceMatches.length + chatMatches.length + messageHits.length > 0;

  const ground = T.isLight ? T.bg1 : T.bg0;
  const surface = T.isLight ? T.bg0 : T.bg1;
  const sectionLabel = {
    fontSize: 12,
    fontWeight: 600,
    color: T.fg2,
    margin: "4px 0 -6px",
  };
  const listBox = {
    background: surface,
    border: `1px solid ${T.border}`,
    borderRadius: 14,
    padding: "6px 8px",
  };

  const chatRow = (c) => (
    <div
      key={c.id}
      role="button"
      tabIndex={0}
      data-home-chat-id={c.id}
      onClick={() => onOpenChat && onOpenChat(c)}
      onKeyDown={(e) => { if (e.key === "Enter") setTimeout(() => onOpenChat && onOpenChat(c), 0); }}
      className="ek-home-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 34,
        padding: "0 8px",
        borderRadius: 7,
        cursor: "pointer",
        color: T.fg,
        fontSize: 13,
      }}
    >
      {c.tabType ? <I.Columns size={13} style={{ color: T.fg2 }} /> : <I.Chat size={13} style={{ color: T.fg2 }} />}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {c.title || "New chat"}
      </span>
      <span
        data-home-chat-workspace
        style={{ width: 210, flexShrink: 0, color: T.fg2, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {c.spaceId ? (spaceNameById.get(c.spaceId) || "General") : "General"}
      </span>
      <span style={{ width: 64, flexShrink: 0, textAlign: "right", color: T.fg3, fontSize: 11.5 }}>
        {c.when}
      </span>
    </div>
  );

  const card = (space) => {
    const general = !space;
    const id = general ? null : space.id;
    const sum = summaries[id || ""] || { chats: 0, lastActive: 0 };
    const docs = general ? "" : workspaceDocsLabel(pinsBySpace[id]);
    const otherModel = !general && space.defaultModel && space.defaultModel !== defaultModelId
      ? space.defaultModel
      : "";
    return (
      <div
        key={id || "general"}
        role="button"
        tabIndex={0}
        data-workspace-card
        data-space-id={id || undefined}
        data-general={general ? "" : undefined}
        className="ek-home-card"
        onClick={() => onOpenSpace && onOpenSpace(id)}
        // Deferred a tick, like the quick question: opening replaces Home
        // while this card's own key event is still being dispatched.
        onKeyDown={(e) => { if (e.key === "Enter") setTimeout(() => onOpenSpace && onOpenSpace(id), 0); }}
        onContextMenu={(e) => {
          if (general) return;
          e.preventDefault();
          setMenu({ space, x: e.clientX, y: e.clientY });
        }}
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: 3,
          minWidth: 0,
          padding: "18px 20px 14px",
          background: general ? "transparent" : surface,
          border: `1px ${general ? "dashed" : "solid"} ${T.border}`,
          borderRadius: 14,
          boxShadow: general || !T.isLight ? "none" : "0 1px 2px rgba(0,0,0,0.04)",
          cursor: "pointer",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span
            data-workspace-card-name
            style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: T.fg, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {general ? "General" : (space.name || "Unnamed")}
          </span>
          {otherModel && (
            <span
              data-workspace-card-model
              title="This workspace uses its own model"
              style={{ flexShrink: 0, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, fontWeight: 500, color: T.amber, background: T.amber + "1f", borderRadius: 999, padding: "2px 8px" }}
            >
              {modelName ? modelName(otherModel) : otherModel}
            </span>
          )}
          {!general && (
            <button
              type="button"
              data-workspace-card-more
              aria-label="Workspace actions"
              title="Workspace actions"
              className="ek-home-card-more"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ space, x: r.left, y: r.bottom + 4 });
              }}
              style={{ width: 24, height: 24, margin: "-4px -6px -4px 0", display: "grid", placeItems: "center", border: "none", borderRadius: 6, background: "transparent", color: T.fg2, cursor: "pointer", flexShrink: 0 }}
            >
              <I.MoreHoriz size={14} />
            </button>
          )}
        </div>
        <div
          data-workspace-card-docs
          style={{ display: "flex", alignItems: "center", gap: 5, minHeight: 18, color: T.fg2, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {general
            ? "Chats that belong to no workspace"
            : docs
              ? <><I.Folder size={12} /><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{docs}</span></>
              : "No documents yet"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16, paddingTop: 11, borderTop: `1px solid ${T.border}`, fontSize: 12, color: T.fg1 }}>
          {!general && docCounts[id] && docCounts[id].documents > 0 && (
            <span data-workspace-card-doc-count>
              {docCounts[id].capped
                ? `${docCounts[id].documents}+ documents`
                : documentsLabel(docCounts[id].documents)}
            </span>
          )}
          <span data-workspace-card-chats>{sum.chats === 1 ? "1 chat" : `${sum.chats} chats`}</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: T.fg3 }}>{homeWhenLabel(sum.lastActive)}</span>
        </div>
      </div>
    );
  };

  return (
    <div
      data-home
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: ground,
        fontFamily: T.sans,
      }}
    >
      {/* Bar: drags the window; the traffic lights sit in its left gutter. */}
      <div
        {...WINDOW_DRAG}
        data-home-bar
        style={{
          height: 52,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 14,
          paddingLeft: TRAFFIC_LIGHT_GUTTER,
          paddingRight: 18,
          background: surface,
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 600, color: T.fg }}>
          <BrandMark size={20} />
          <span>Ekorbia</span>
        </div>
        <span style={{ flex: 1 }} />
        <div
          style={{ width: 400, maxWidth: "46%", height: 32, display: "flex", alignItems: "center", gap: 8, padding: "0 10px", background: ground, border: `1px solid ${T.border}`, borderRadius: 8 }}
        >
          <I.Search size={13} style={{ color: T.fg3 }} />
          <input
            data-home-search
            placeholder="Search workspaces and chats"
            value={query}
            onChange={(e) => onQuery && onQuery(e.target.value)}
            style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", color: T.fg, fontFamily: T.sans, fontSize: 13, padding: 0 }}
          />
        </div>
        <span style={{ flex: 1 }} />
        {/* Keeps the search box centred against the brand on the left. */}
        <span style={{ width: 82, flexShrink: 0 }} />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ maxWidth: 1088, margin: "0 auto", padding: "26px 56px 28px", display: "flex", flexDirection: "column", gap: 20 }}>
          {/* A quick question: one row, straight into a new chat in General.
              Deliberately not a <form>: Enter in a form "clicks" its first
              button, which here is the dictation button. */}
          <div
            data-home-ask
            style={{ height: 50, display: "flex", alignItems: "center", gap: 8, padding: "0 9px 0 20px", background: surface, border: `1px solid ${T.border}`, borderRadius: 25, boxShadow: T.isLight ? "0 2px 10px rgba(0,0,0,0.05)" : "none" }}
          >
            <input
              data-home-ask-input
              placeholder="Ask a quick question"
              aria-label="Ask a quick question"
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => {
                // Enter asks. Not while an input method is composing text.
                // Deferred by a tick: asking replaces Home with the
                // workspace window, and taking this input out of the page
                // while its own key event is still being dispatched stalls
                // WebKit's input handling (seen under the test driver).
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  setTimeout(submitAsk, 0);
                }
              }}
              style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", color: T.fg, fontFamily: T.sans, fontSize: 14.5, padding: 0 }}
            />
            <span style={{ flexShrink: 0, color: T.fg2, fontSize: 12, marginRight: 4 }}>
              Opens a new chat in General
            </span>
            {typeof IS_MAC !== "undefined" && IS_MAC && typeof VoiceMicButton === "function" && (
              <VoiceMicButton
                disabled={askDisabled}
                onInsert={(t) => { if (t) setAsk((cur) => (cur ? cur.replace(/\s*$/, " ") : "") + t); }}
              />
            )}
            <button
              type="button"
              onClick={submitAsk}
              data-home-ask-send
              aria-label="Ask"
              title={askDisabled ? "A reply is still arriving" : "Ask"}
              disabled={!ask.trim() || askDisabled}
              style={{ width: 32, height: 32, display: "grid", placeItems: "center", border: "none", borderRadius: "50%", background: ask.trim() && !askDisabled ? T.fg : T.bg3, color: ask.trim() && !askDisabled ? ground : T.fg3, cursor: ask.trim() && !askDisabled ? "pointer" : "default", flexShrink: 0 }}
            >
              <I.ArrowUp size={14} />
            </button>
          </div>

          {searching ? (
            <div data-home-results style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {spaceMatches.length > 0 && (
                <>
                  <div style={sectionLabel}>Workspaces</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 18 }}>
                    {spaceMatches.map((s) => card(s))}
                  </div>
                </>
              )}
              {chatMatches.length > 0 && (
                <>
                  <div style={sectionLabel}>Chats</div>
                  <div style={listBox}>{chatMatches.map(chatRow)}</div>
                </>
              )}
              {messageHits.length > 0 && (
                <>
                  <div style={sectionLabel}>Messages</div>
                  <div style={{ ...listBox, padding: "6px 0" }}>
                    {messageHits.map((hit) => (
                      <MessageHitRow key={hit.msgId} hit={hit} onClick={() => onPickHit && onPickHit(hit)} />
                    ))}
                  </div>
                </>
              )}
              {!anyResults && (
                <div data-home-no-results style={{ padding: "28px 0", textAlign: "center", color: T.fg2, fontSize: 13 }}>
                  Nothing matches that search.
                </div>
              )}
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                <span style={{ fontSize: 26, fontWeight: 600, letterSpacing: -0.3, color: T.fg }}>Workspaces</span>
                <span data-workspace-count style={{ color: T.fg2, fontSize: 13 }}>{(spaces || []).length}</span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  data-new-workspace
                  onClick={() => setCreateOpen(true)}
                  style={{ alignSelf: "center", height: 30, display: "flex", alignItems: "center", gap: 6, padding: "0 12px", border: `1px solid ${T.fg}`, borderRadius: 8, background: T.fg, color: ground, fontFamily: T.sans, fontSize: 13, fontWeight: 500, cursor: "pointer" }}
                >
                  <I.Plus size={12} />
                  <span>New workspace</span>
                </button>
              </div>
              <div
                data-workspace-grid
                style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 18 }}
              >
                {(spaces || []).map((s) => card(s))}
                {card(null)}
              </div>
              {recent.length > 0 && (
                <>
                  <div style={sectionLabel}>Recent chats</div>
                  <div data-home-recent style={listBox}>{recent.map(chatRow)}</div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {footer && (
        <div
          data-home-foot
          style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "8px 18px 10px 56px" }}
        >
          {footer}
        </div>
      )}

      {/* ── Space dialogs ── */}
      {menu && (
        <SpaceOverflowMenu
          x={menu.x}
          y={menu.y}
          onEdit={() => { const s = menu.space; setMenu(null); setEditModal({ space: s }); }}
          onRename={() => { const s = menu.space; setMenu(null); setRenameModal({ space: s }); }}
          onDelete={() => { const s = menu.space; setMenu(null); setConfirmDelete({ space: s }); }}
          onClose={() => setMenu(null)}
        />
      )}
      {createOpen && (
        <SpaceCreateModal
          onCancel={() => setCreateOpen(false)}
          onSubmit={async (name, color, andConfigure) => {
            setCreateOpen(false);
            if (!onCreateSpace) return;
            const created = await onCreateSpace(name, color);
            if (!created) return;
            // `created` is the new Space row when wired through main.jsx;
            // a test fixture may return just an id string.
            const newSpace = typeof created === "object" ? created : null;
            const newId = newSpace ? newSpace.id : created;
            // "Create & configure…" stays on Home with the settings dialog
            // open; a plain Create opens the new workspace.
            if (andConfigure && newSpace) setEditModal({ space: newSpace });
            else if (newId && onOpenSpace) onOpenSpace(newId);
          }}
        />
      )}
      {renameModal && (
        <NameModal
          title="Rename workspace"
          confirmLabel="Save"
          initial={renameModal.space.name}
          placeholder="Workspace name"
          onCancel={() => setRenameModal(null)}
          onSubmit={(name) => {
            const s = renameModal.space;
            setRenameModal(null);
            if (name && name !== s.name) onRenameSpace && onRenameSpace(s.id, name);
          }}
        />
      )}
      {editModal && (
        <SpaceSettingsModal
          space={editModal.space}
          promptsLibrary={promptsLibrary}
          nameOfModel={nameOfModel}
          appDefaultName={appDefaultName}
          documentCount={docCounts[editModal.space.id] || null}
          onDelete={() => { const sp = editModal.space; setEditModal(null); setConfirmDelete({ space: sp }); }}
          onCancel={() => setEditModal(null)}
          onSave={async (draft) => {
            const s = editModal.space;
            setEditModal(null);
            if (onEditSpaceSave) await onEditSpaceSave(s.id, draft);
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmModal
          title="Delete workspace?"
          body={
            <span>
              The workspace{" "}
              <strong>{confirmDelete.space.name || "Unnamed"}</strong>{" "}
              will be removed. Its chats are kept and move to{" "}
              <strong>General</strong>. This can't be undone.
            </span>
          }
          cancelLabel="Cancel"
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const s = confirmDelete.space;
            setConfirmDelete(null);
            onDeleteSpace && onDeleteSpace(s.id);
          }}
        />
      )}
    </div>
  );
}
