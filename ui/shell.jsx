// shell.jsx -- App chrome: window-drag helpers, Sidebar (one workspace),
//   Space dialogs, ChatRow, MessageHitRow, StatusLine, MoreMenu.
// Depends on: tokens, atoms, icons, data (MODELS), utils.

// ─── Window chrome ──────────────────────────────────────────
// The window is configured with titleBarStyle: "Overlay" + hiddenTitle:
// true, so macOS draws its traffic lights over our top-left corner and
// there is no native title bar to drag. Whatever sits at the top of the
// window (the Home bar, the workspace sidebar's head, the strip above the
// conversation) spreads WINDOW_DRAG onto itself and leaves
// TRAFFIC_LIGHT_GUTTER clear where the lights sit.
'use strict';
const TRAFFIC_LIGHT_GUTTER = 88;
// Height of the strip the traffic lights live in.
const WINDOW_TOP_STRIP = 36;

function ekCurrentWindow() {
  const winApi = getWindowApi();
  return (
    winApi?.getCurrentWindow?.() ??
    winApi?.getCurrent?.() ??
    winApi?.appWindow ??
    null
  );
}

// Controls inside a drag area keep their own clicks.
const WINDOW_DRAG_EXEMPT = "button, a, input, textarea, select, [role='menu'], [data-no-drag]";

// Drive dragging from JS instead of relying on data-tauri-drag-region:
// the attribute-based path fired inconsistently (likely an interaction
// between withGlobalTauri injection timing and the cascade). Calling the
// OS drag API directly removes every variable.
async function ekWindowDragMouseDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest(WINDOW_DRAG_EXEMPT)) return;
  const current = ekCurrentWindow();
  if (current?.startDragging) {
    try {
      await current.startDragging();
    } catch {}
  }
}

// Double-click zooms the window, as a native macOS title bar does.
async function ekWindowDragDoubleClick(e) {
  if (e.target.closest(WINDOW_DRAG_EXEMPT)) return;
  const current = ekCurrentWindow();
  if (current?.toggleMaximize) {
    try {
      await current.toggleMaximize();
    } catch {}
  }
}

const WINDOW_DRAG = {
  onMouseDown: ekWindowDragMouseDown,
  onDoubleClick: ekWindowDragDoubleClick,
};

// ─── Sidebar ────────────────────────────────────────────────
// The left rail of the workspace window. It shows ONE workspace: a way
// back to Home, the workspace's name, the New chat control, a search box
// scoped to this workspace, and its chats.
//
// Switching workspaces is Home's job (home.jsx), so nothing here lists
// them. A workspace is a Space; "General" (activeSpaceId null) is every
// chat that has no Space.
//
// The chat list arrives pre-filtered to this workspace (main.jsx). Above
// the saved chats sit `openTabs`: open chats the saved list cannot show —
// private chats, which are never saved, and the unsent chat in front (see
// unsavedTabsForWorkspace in utils.js).
function Sidebar({
  chats,
  activeId,
  onPick,
  onDelete,
  onRename,
  query,
  onQuery,
  onNew,
  onNewPrivate,
  onNewCompare,
  width,
  // Back to the workspaces screen.
  onHome,
  // `spaces` is the raw [{id, name, slug, color, …}] list from
  // `space_list`; `activeSpaceId` is the workspace on show (null = General).
  spaces = [],
  activeSpaceId = null,
  onMoveChatToSpace,
  // The workspace settings dialog needs the live prompts library so the
  // user can pick which prompts to pin. main.jsx owns the fetch.
  promptsLibrary = [],
  onEditSpaceSave,
  // Where this workspace's documents live, e.g. "Matters/Hartwell"
  // (workspaceDocsLabel in utils.js). Empty when nothing is pinned.
  docsLabel = "",
  // The model this workspace's chats use, by its plain name ("Balanced").
  modelName = "",
  // For the settings dialog's model list: (id) → plain name, and the app
  // default's name.
  nameOfModel,
  appDefaultName = "",
  // { documents, capped } for this workspace's pinned documents, counted
  // by Rust; null until known or when nothing is pinned.
  documentCount = null,
  // Delete this workspace (its chats move to General). Called after the
  // user confirms; the caller then goes back to Home.
  onDeleteSpace,
  // Unsaved open chats to list above the saved ones: [{id, title,
  // ephemeral}]. onPickOpen(id) brings one to the front; onCloseOpen(id)
  // ends a private chat.
  openTabs = [],
  onPickOpen,
  onCloseOpen,
  // Full-text-search hits (from messages_fts MATCH bm25), already limited
  // to this workspace's chats by main.jsx. Empty when no query is active.
  messageHits = [],
  onPickHit,
  // The status line and settings menu, built once by main.jsx so Home and
  // this rail show the same thing.
  footer = null,
}) {
  // ── Search filter ──
  // Apply the query to the date-section items. Empty sections are
  // filtered out — showing an empty "Today" header during a search would
  // imply "no results in Today" rather than the cleaner unified empty
  // state below.
  const filtered = useMemo(() => {
    if (!query.trim()) return chats;
    const q = query.toLowerCase();
    const matches = (c) => c.title.toLowerCase().includes(q);
    return {
      dateSections: (chats.dateSections || [])
        .map((s) => ({ ...s, items: s.items.filter(matches) }))
        .filter((s) => s.items.length),
    };
  }, [chats, query]);

  const searching = !!query.trim();
  const totalItems = (filtered.dateSections || []).reduce(
    (n, s) => n + s.items.length,
    0,
  );
  const anyResults = totalItems > 0 || messageHits.length > 0;

  // ── Right-click context menu state ──
  // Single instance at a time — opening a new menu closes any prior.
  const [rowMenu, setRowMenu] = useState(null);

  // ── Chat rename + chat delete modal states ──
  // window.prompt() / window.confirm() are blocked in Tauri's WKWebView
  // (return null silently), so all naming + confirming goes through
  // proper modals.
  const [renameChatModal, setRenameChatModal] = useState(null);
  const [confirmDeleteChat, setConfirmDeleteChat] = useState(null);
  // `editSpaceModal.space` is the workspace being edited; the dialog owns
  // its own draft state so cancel reverts cleanly.
  const [editSpaceModal, setEditSpaceModal] = useState(null);
  const [confirmDeleteSpace, setConfirmDeleteSpace] = useState(null);

  // ── The New chat menu (the arrow beside the button) ──
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuRef = useRef(null);
  useEffect(() => {
    if (!newMenuOpen) return undefined;
    const onDown = (e) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target)) setNewMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setNewMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [newMenuOpen]);
  const fromNewMenu = (fn) => () => { setNewMenuOpen(false); fn && fn(); };

  // ── Action handlers wired into the row context menu ──
  const handleMenuMoveToSpace = (spaceId) => {
    if (!rowMenu) return;
    const chatId = rowMenu.chat.id;
    setRowMenu(null);
    onMoveChatToSpace && onMoveChatToSpace(chatId, spaceId);
  };
  const handleMenuRename = () => {
    if (!rowMenu) return;
    const chat = rowMenu.chat;
    setRowMenu(null);
    setRenameChatModal({ chat });
  };
  const handleMenuDelete = () => {
    if (!rowMenu) return;
    const chat = rowMenu.chat;
    setRowMenu(null);
    setConfirmDeleteChat({ chat });
  };
  const handleMenuOpen = () => {
    if (!rowMenu) return;
    const chat = rowMenu.chat;
    setRowMenu(null);
    onPick(chat);
  };

  const handleRenameChatSubmit = (newTitle) => {
    const m = renameChatModal;
    setRenameChatModal(null);
    if (!m) return;
    if (newTitle && newTitle !== m.chat.title) {
      onRename && onRename(m.chat.id, newTitle);
    }
  };

  const handleConfirmDeleteChat = () => {
    const m = confirmDeleteChat;
    setConfirmDeleteChat(null);
    if (!m) return;
    onDelete(m.chat.id);
  };

  const activeSpaceRow = activeSpaceId
    ? (spaces || []).find((s) => s.id === activeSpaceId) || null
    : null;
  const workspaceName = activeSpaceRow ? (activeSpaceRow.name || "Unnamed") : "General";
  const countLabel = documentCount && documentCount.documents > 0
    ? (documentCount.capped
        ? `${documentCount.documents}+ documents`
        : documentsLabel(documentCount.documents))
    : "";
  const metaLine = activeSpaceRow
    ? [countLabel || docsLabel || "No documents yet", modelName].filter(Boolean).join(" · ")
    : "Chats that belong to no workspace";

  const sectionLabelStyle = {
    padding: "10px 16px 4px",
    fontFamily: T.sans,
    fontSize: 11.5,
    fontWeight: 600,
    color: T.fg2,
  };

  return (
    <aside
      data-sidebar
      style={{
        width: width || 252,
        flexShrink: 0,
        background: T.bg1,
        borderRight: `1px solid ${T.border}`,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        fontFamily: T.sans,
      }}
    >
      {/* Head: the strip the traffic lights sit in, the way back to Home,
          and the workspace's name. The whole head drags the window. */}
      <div {...WINDOW_DRAG} data-sidebar-head style={{ padding: "0 12px", flexShrink: 0 }}>
        <div style={{ height: WINDOW_TOP_STRIP }} />
        {onHome && (
          <button
            type="button"
            data-back-home
            onClick={onHome}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              padding: "2px 6px 2px 2px",
              marginLeft: 2,
              border: "none",
              borderRadius: 5,
              background: "transparent",
              color: T.fg2,
              fontFamily: T.sans,
              fontSize: 12.5,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = T.fg; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = T.fg2; }}
          >
            <I.ChevronL size={12} />
            <span>Workspaces</span>
          </button>
        )}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 6px 0" }}>
          <div
            data-workspace-name
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 15,
              fontWeight: 600,
              lineHeight: 1.3,
              color: T.fg,
              overflowWrap: "anywhere",
            }}
          >
            {workspaceName}
          </div>
          {activeSpaceRow && (
            <button
              type="button"
              data-workspace-settings
              aria-label="Workspace settings"
              title="Workspace settings"
              onClick={() => setEditSpaceModal({ space: activeSpaceRow })}
              style={{
                width: 24,
                height: 24,
                marginTop: -2,
                display: "grid",
                placeItems: "center",
                border: "none",
                borderRadius: 6,
                background: "transparent",
                color: T.fg2,
                cursor: "pointer",
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = T.fg; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = T.fg2; }}
            >
              <I.Settings size={14} />
            </button>
          )}
        </div>
        <div
          data-workspace-meta
          style={{
            padding: "1px 6px 0",
            fontSize: 12,
            color: T.fg2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {metaLine}
        </div>
      </div>

      {/* New chat, with the two other kinds of chat behind the arrow. A
          private chat is never saved and inherits nothing from the
          workspace it is started in; a comparison asks two or three models
          the same question. */}
      <div ref={newMenuRef} style={{ margin: "12px 12px 8px", display: "flex", gap: 6, position: "relative" }}>
        <button
          type="button"
          data-new-chat
          onClick={onNew}
          style={{
            flex: 1,
            height: 34,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            background: T.bg0,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            color: T.fg,
            fontFamily: T.sans,
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          <I.Plus size={12} />
          <span>New chat</span>
        </button>
        <button
          type="button"
          data-new-chat-more
          aria-label="Other kinds of chat"
          aria-haspopup="menu"
          aria-expanded={newMenuOpen}
          onClick={() => setNewMenuOpen((o) => !o)}
          style={{
            width: 34,
            height: 34,
            display: "grid",
            placeItems: "center",
            background: newMenuOpen ? T.bg3 : T.bg0,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            color: T.fg1,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <I.Chevron size={12} />
        </button>
        {newMenuOpen && (
          <div
            role="menu"
            data-new-chat-menu
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              minWidth: 236,
              padding: 4,
              background: T.bg2,
              border: `1px solid ${T.border}`,
              borderRadius: 8,
              boxShadow: T.shadowPop,
              zIndex: 60,
              fontSize: 13,
            }}
          >
            <MenuItem onClick={fromNewMenu(onNew)} data-menu-new-chat>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <I.Chat size={13} />
                <span style={{ flex: 1 }}>New chat</span>
                <span style={{ color: T.fg3, fontSize: 11.5 }}>{MOD_GLYPH}N</span>
              </span>
            </MenuItem>
            {onNewPrivate && (
              <MenuItem onClick={fromNewMenu(onNewPrivate)} data-menu-new-private aria-label="New private chat">
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <I.Lock size={13} />
                  <span style={{ flex: 1 }}>New private chat</span>
                  <span style={{ color: T.fg3, fontSize: 11.5 }}>Not saved</span>
                </span>
              </MenuItem>
            )}
            {onNewCompare && <MenuDivider />}
            {onNewCompare && (
              <MenuItem onClick={fromNewMenu(onNewCompare)} data-new-compare aria-label="New comparison chat">
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <I.Columns size={13} />
                  <span style={{ flex: 1 }}>Compare models…</span>
                </span>
              </MenuItem>
            )}
          </div>
        )}
      </div>

      {/* Search, scoped to this workspace */}
      <div style={{ padding: "0 12px 8px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            background: T.bg0,
            borderRadius: 8,
            padding: "0 10px",
            height: 32,
            border: `1px solid ${T.border}`,
          }}
        >
          <I.Search size={13} style={{ color: T.fg3 }} />
          <input
            data-sidebar-search
            placeholder="Search this workspace"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              background: "transparent",
              color: T.fg,
              fontFamily: T.sans,
              fontSize: 13,
              padding: 0,
            }}
          />
        </div>
      </div>

      {/* Chats */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          minHeight: 0,
          padding: "0 0 12px",
        }}
      >
        {/* Open chats the saved list cannot show. */}
        {!searching && openTabs.length > 0 && (
          <div data-open-chats style={{ padding: "2px 8px 0" }}>
            {openTabs.map((t) => {
              const active = t.id === activeId;
              return (
                <div
                  key={t.id}
                  data-open-chat-id={t.id}
                  data-open-chat-private={t.ephemeral ? "" : undefined}
                  data-active={active ? "true" : undefined}
                  onClick={() => onPickOpen && onPickOpen(t.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    height: 30,
                    padding: "0 8px",
                    borderRadius: 7,
                    background: active ? T.bg3 : "transparent",
                    color: active ? T.fg : T.fg1,
                    fontSize: 13,
                    fontWeight: active ? 500 : 400,
                    cursor: "pointer",
                  }}
                >
                  {t.ephemeral
                    ? <I.Lock size={12} style={{ color: T.purple }} />
                    : <I.Chat size={12} style={{ color: T.fg2 }} />}
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.title || (t.ephemeral ? "Private chat" : "New chat")}
                  </span>
                  {t.ephemeral && onCloseOpen && (
                    <button
                      type="button"
                      data-end-private
                      aria-label="End this private chat"
                      title="End this private chat. It is not saved."
                      onClick={(e) => { e.stopPropagation(); onCloseOpen(t.id); }}
                      style={{
                        width: 20,
                        height: 20,
                        display: "grid",
                        placeItems: "center",
                        border: "none",
                        borderRadius: 5,
                        background: "transparent",
                        color: T.fg2,
                        cursor: "pointer",
                      }}
                    >
                      <I.X size={10} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Date sections ──
            Today / Yesterday / Last 7 days / Last 30 days / Older. */}
        {(filtered.dateSections || []).map((section) => (
          <div key={section.section} style={{ marginBottom: 4 }}>
            <div style={sectionLabelStyle}>{section.section}</div>
            {section.items.map((c) => {
              const active = c.id === activeId;
              const model = MODELS_BY_ID[c.model];
              return (
                <ChatRow
                  key={c.id}
                  chat={c}
                  model={model}
                  active={active}
                  onClick={() => onPick(c)}
                  onDelete={() => onDelete(c.id)}
                  onContextMenu={(e) =>
                    setRowMenu({ x: e.clientX, y: e.clientY, chat: c })
                  }
                  query={query}
                />
              );
            })}
          </div>
        ))}
        {/* Message-content hits (full-text search). Only rendered while a
            query is active, below the title matches. */}
        {searching && messageHits.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={sectionLabelStyle}>Messages</div>
            {messageHits.map((hit) => (
              <MessageHitRow
                key={hit.msgId}
                hit={hit}
                onClick={() => onPickHit && onPickHit(hit)}
              />
            ))}
          </div>
        )}
        {searching && !anyResults && (
          <div
            style={{
              padding: "20px 16px",
              color: T.fg2,
              fontSize: 12.5,
              textAlign: "center",
            }}
          >
            Nothing in this workspace matches.
          </div>
        )}
        {/* Nothing saved here yet. Distinct from a search miss. */}
        {!searching && totalItems === 0 && (
          <div
            data-sidebar-empty
            style={{
              padding: "20px 16px",
              color: T.fg2,
              fontSize: 12.5,
              lineHeight: 1.55,
              textAlign: "center",
            }}
          >
            No chats here yet. A chat is saved when you send its first message.
          </div>
        )}
      </div>

      {footer && (
        <div
          data-sidebar-foot
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px 8px 16px",
            borderTop: `1px solid ${T.border}`,
            flexShrink: 0,
          }}
        >
          {footer}
        </div>
      )}

      {/* Right-click context menu — appears over everything (z-index 50). */}
      {rowMenu && (
        <ChatContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          chat={rowMenu.chat}
          spaces={spaces}
          onOpen={handleMenuOpen}
          onRename={handleMenuRename}
          onDelete={handleMenuDelete}
          onMoveToSpace={handleMenuMoveToSpace}
          onClose={() => setRowMenu(null)}
        />
      )}

      {renameChatModal && (
        <NameModal
          title="Rename chat"
          confirmLabel="Save"
          initial={renameChatModal.chat.title}
          placeholder="Chat title"
          onCancel={() => setRenameChatModal(null)}
          onSubmit={handleRenameChatSubmit}
        />
      )}

      {confirmDeleteChat && (
        <ConfirmModal
          title="Delete chat?"
          body={
            <span>
              <strong>{confirmDeleteChat.chat.title || "This chat"}</strong>{" "}
              and its messages will be permanently removed. This can't be
              undone.
            </span>
          }
          cancelLabel="Cancel"
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDeleteChat(null)}
          onConfirm={handleConfirmDeleteChat}
        />
      )}

      {editSpaceModal && (
        <SpaceSettingsModal
          space={editSpaceModal.space}
          promptsLibrary={promptsLibrary}
          nameOfModel={nameOfModel}
          appDefaultName={appDefaultName}
          documentCount={documentCount}
          onDelete={onDeleteSpace ? () => {
            const s = editSpaceModal.space;
            setEditSpaceModal(null);
            setConfirmDeleteSpace({ space: s });
          } : undefined}
          onCancel={() => setEditSpaceModal(null)}
          onSave={async (draft) => {
            const s = editSpaceModal.space;
            setEditSpaceModal(null);
            if (onEditSpaceSave) await onEditSpaceSave(s.id, draft);
          }}
        />
      )}
      {confirmDeleteSpace && (
        <ConfirmModal
          title="Delete workspace?"
          body={
            <span>
              The workspace{" "}
              <strong>{confirmDeleteSpace.space.name || "Unnamed"}</strong>{" "}
              will be removed. Its chats are kept and move to{" "}
              <strong>General</strong>. This can't be undone.
            </span>
          }
          cancelLabel="Cancel"
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDeleteSpace(null)}
          onConfirm={() => {
            const sp = confirmDeleteSpace.space;
            setConfirmDeleteSpace(null);
            onDeleteSpace && onDeleteSpace(sp.id);
          }}
        />
      )}
    </aside>
  );
}

// ─── SpaceOverflowMenu ──────────────────────────────────────
// Small popover anchored at user-supplied (x, y) coordinates — fed by
// either the ⋯ button (which passes its rect's bottom-left offset by
// -130 so the right edges roughly align) or a right-click on the row
// (which passes the cursor coords directly). Four items: Edit settings,
// Rename, Delete.
//
// Clamps to the viewport internally so a near-edge open doesn't render
// off-screen. Mirrors the dismissal pattern from ChatContextMenu: a
// transparent full-viewport backdrop at the layer below catches outside
// clicks; Esc dismisses via the keydown effect.
function SpaceOverflowMenu({ x, y, onEdit, onRename, onDelete, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Approximate natural dimensions of the 4-item menu (minWidth + padding
  // + 4 rows). Clamp so a click within ~150px of the right edge or
  // ~120px of the bottom edge still renders fully on screen.
  const menuW = 160;
  const menuH = 130;
  const clampedX = Math.max(8, Math.min(x, window.innerWidth - menuW - 8));
  const clampedY = Math.max(8, Math.min(y, window.innerHeight - menuH - 8));

  return (
    <Fragment>
      <div
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 55,
          background: "transparent",
        }}
      />
      <div
        data-space-overflow-menu
        style={{
          position: "fixed",
          top: clampedY,
          left: clampedX,
          zIndex: 60,
          background: T.bg2,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 5,
          padding: 4,
          minWidth: 140,
          boxShadow: T.shadowPop,
        }}
      >
        <MenuItem onClick={onEdit}>Edit settings…</MenuItem>
        <MenuItem onClick={onRename}>Rename workspace</MenuItem>
        <MenuItem onClick={onDelete} danger>
          Delete workspace
        </MenuItem>
      </div>
    </Fragment>
  );
}

// ─── SpaceCreateModal ───────────────────────────────────────
//
// Modal for creating a new workspace — a name, and a choice between
// creating it and creating it then opening its settings. A workspace has
// no colour any more; `onSubmit` still takes one (always null) because the
// row has the column.
function SpaceCreateModal({ onCancel, onSubmit }) {
  const [name, setName] = useState("");
  const color = null;
  const inputRef = useRef(null);

  // Autofocus the name input on mount + Esc dismiss / Enter submit.
  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
      // Enter defaults to the primary action ("Create" — quick path).
      // To use "Create & configure…" the user must click that button.
      if (e.key === "Enter" && name.trim()) onSubmit(name.trim(), color, false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [name, color, onCancel, onSubmit]);

  return (
    <Fragment>
      {/* Backdrop — catches outside clicks AND dims the chrome behind. */}
      <div
        onClick={onCancel}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
          zIndex: 70,
        }}
      />
      <div
        role="dialog"
        aria-label="Create workspace"
        data-space-create-modal
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%,-50%)",
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 8,
          padding: 20,
          width: 380,
          zIndex: 71,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
        }}
      >
        <div
          style={{
            fontFamily: T.sans,
            fontSize: 14,
            fontWeight: 600,
            color: T.fg,
            marginBottom: 14,
          }}
        >
          New workspace
        </div>

        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workspace name"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 10px",
            background: T.bg2,
            border: `1px solid ${T.border}`,
            borderRadius: 5,
            color: T.fg,
            fontFamily: T.sans,
            fontSize: 13,
            outline: "none",
          }}
        />


        <div
          style={{
            marginTop: 20,
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            onClick={onCancel}
            style={ekBtn("secondary")}
          >
            Cancel
          </button>
          <button
            onClick={() => name.trim() && onSubmit(name.trim(), color, true)}
            disabled={!name.trim()}
            data-space-create-and-configure
            title="Create the workspace and open its settings: model, notes, templates and documents"
            style={ekBtn("secondary", { disabled: !name.trim() })}
          >
            Create &amp; configure…
          </button>
          <button
            onClick={() => name.trim() && onSubmit(name.trim(), color, false)}
            disabled={!name.trim()}
            data-space-create-confirm
            style={ekBtn("primary", { disabled: !name.trim() })}
          >
            Create
          </button>
        </div>
      </div>
    </Fragment>
  );
}

// ─── SpaceSettingsModal ─────────────────────────────────────
//
// Full Space-editing dialog. Five sections, stacked vertically inside a
// tall modal:
//   1. Name + Color (palette swatches)
//   2. Default model (dropdown — model id preselected for new chats in
//      this Space; empty = inherit the global default)
//   3. Memory file (path display + Browse / Edit / Reveal / Clear)
//   4. Always use these templates (chips + Add; every one is both
//      pre-selected in new chats and locked there)
//   5. Pinned attachments (list with Add file / Add folder / Remove)
//
// Draft state lives in this component — Cancel reverts cleanly without
// touching the backend. Save calls the `onSave(draft)` callback once
// with everything the parent needs to diff + dispatch:
//   {
//     row: { ...space, name, color, defaultModel, memoryPath },
//     promptSlugs:   string[],          // desired final pin set
//     lockedSlugs:   string[],          // the same list: all are locked
//     attachments:   [{ kind, path }],  // desired final pin set
//   }
//
// The earlier `systemPrompt` row field was dropped in favour of locked
// pinned prompts — see CLAUDE.md / db.rs for the data-model story.
//
// Pinned-prompt + pinned-attachment data is fetched lazily on mount via
// the same `space_prompts_list` / `space_attachments_list` commands the
// instantiate-on-new-chat helper uses (Phase 4). The modal renders a
// loading skeleton while those resolve so the user doesn't see flicker.
//
// Memory file actions (Browse / Edit / Reveal) talk to the backend
// directly via `space_memory_open` / `getDialogApi`. These are leaf
// actions that don't need to round-trip through the parent.
// `nameOfModel(id)` gives a model's plain name ("Balanced — Gemma 4 12B")
// and `appDefaultName` the app default's, so the model list reads the way
// Settings → Models does. Both optional: without them ids are shown.
//
// `documentCount` ({ documents, capped } or null) is how many documents the
// saved pins hold, counted by Rust. `onDelete` puts a "Delete workspace…"
// button in the footer; the host asks for confirmation.
function SpaceSettingsModal({ space, promptsLibrary = [], onCancel, onSave, nameOfModel, appDefaultName = "", documentCount = null, onDelete }) {
  // ── Draft state for the row-level fields ──
  // Color and slug are loaded from the live row; slug is read-only
  // (display only) because `space_update`'s SET clause excludes it
  // (the Phase 1 contract — memory file path on disk is keyed by slug).
  const [name, setName] = useState(space.name || "");
  const [color, setColor] = useState(space.color || null);
  const [defaultModel, setDefaultModel] = useState(space.defaultModel || "");
  const [memoryPath, setMemoryPath] = useState(space.memoryPath || "");
  // Notes: the text of the Space's memory file, edited here in place. Read
  // once when the dialog opens; written by Rust on Save, and only if it
  // was touched, so opening and saving the dialog never rewrites the file.
  const [notes, setNotes] = useState("");
  const [notesLoaded, setNotesLoaded] = useState(!space.memoryPath);
  const [notesDirty, setNotesDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const invoke = getInvoke();
    if (!invoke || !space.memoryPath) {
      setNotesLoaded(true);
      return undefined;
    }
    let alive = true;
    invoke("space_memory_read", { path: space.memoryPath })
      .then((text) => { if (alive) setNotes(typeof text === "string" ? text : ""); })
      .catch((e) => console.error("space_memory_read failed:", e))
      .finally(() => { if (alive) setNotesLoaded(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open
  }, []);
  // "Always use these templates": whether the list of templates that can
  // still be added is showing.
  const [addTemplateOpen, setAddTemplateOpen] = useState(false);

  // ── Pinned prompts + attachments (loaded lazily) ──
  // We fetch on mount so the user opens the modal and immediately sees
  // the current pin set. `loaded` gates the render between "skeleton"
  // and "real fields" so the user doesn't briefly see an empty list
  // and think nothing's pinned.
  const [promptSlugs, setPromptSlugs] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [loaded, setLoaded] = useState(false);
  // Installed Ollama models for the default-model picker. Empty until
  // the on-mount fetch resolves; the picker degrades gracefully when
  // the list is empty (still shows "Inherit global default" + the
  // currently-saved value if any).
  const [availableModels, setAvailableModels] = useState([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const invoke = window.getInvoke && window.getInvoke();
      if (!invoke) {
        // Headless / test fixture without a Tauri mock — render as
        // "loaded with empty lists" so the modal stays interactive.
        setLoaded(true);
        return;
      }
      try {
        const [prompts, attaches, tags] = await Promise.all([
          invoke("space_prompts_list", { spaceId: space.id }),
          invoke("space_attachments_list", { spaceId: space.id }),
          // llm_list_models can throw on IPC failure (Ollama down) — wrap
          // separately so it doesn't take down the prompt/attachment
          // loads with it. Treats absence as "no models available."
          invoke("llm_list_models").catch(() => null),
        ]);
        if (cancelled) return;
        const slugList = (prompts || []).map((p) => p.promptSlug).filter(Boolean);
        setPromptSlugs(slugList);
        // Every template listed here is "always on". (An older version
        // also allowed one that was merely pre-selected and could be
        // removed in a chat; saving this dialog makes those always on.)
        setAttachments(
          (attaches || []).map((a) => ({ id: a.id, kind: a.kind, path: a.path })),
        );
        // Sort alphabetically — matches the other model pickers in the
        // app (composer, overlay, compare-mode picker) for muscle-memory
        // consistency.
        const models = ((tags && tags.models) || [])
          .map((m) => m && m.name)
          .filter(Boolean);
        models.sort((a, b) => a.localeCompare(b));
        setAvailableModels(models);
      } catch (e) {
        console.error("space modal fetch failed:", e);
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [space.id]);

  // ── Esc dismisses ──
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // ── Notes file (leaf — talks directly to Tauri) ──
  const revealMemory = async () => {
    const invoke = window.getInvoke && window.getInvoke();
    if (!invoke || !memoryPath) return;
    try {
      await invoke("space_memory_open", { path: memoryPath, reveal: true });
    } catch (e) {
      console.error("space_memory_open(reveal) failed:", e);
      window.ekToast?.({ kind: "error", title: "Reveal failed", body: String(e) });
    }
  };

  // ── Pinned attachment actions ──
  const addPinnedFile = async () => {
    const dialogApi = window.getDialogApi && window.getDialogApi();
    if (!dialogApi) return;
    try {
      const picked = await dialogApi.open({
        multiple: true,
        filters: [
          {
            name: "Documents & images",
            extensions: ["txt", "md", "markdown", "pdf", "png", "jpg", "jpeg", "webp"],
          },
        ],
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      // De-dupe against current draft so the same file isn't pinned
      // twice. Match on (kind, path) since Spaces pin a kind+path pair.
      setAttachments((cur) => {
        const seen = new Set(cur.map((a) => `${a.kind}::${a.path}`));
        const fresh = paths
          .filter((p) => !seen.has(`file::${p}`))
          .map((p) => ({ id: null, kind: "file", path: p }));
        return [...cur, ...fresh];
      });
    } catch (e) {
      console.error("space pin file dialog failed:", e);
    }
  };
  const addPinnedFolder = async () => {
    const dialogApi = window.getDialogApi && window.getDialogApi();
    if (!dialogApi) return;
    try {
      const picked = await dialogApi.open({ directory: true, multiple: false });
      if (!picked) return;
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      setAttachments((cur) => {
        if (cur.some((a) => a.kind === "folder" && a.path === path)) return cur;
        return [...cur, { id: null, kind: "folder", path }];
      });
    } catch (e) {
      console.error("space pin folder dialog failed:", e);
    }
  };
  const removeAttachment = (idx) =>
    setAttachments((cur) => cur.filter((_, i) => i !== idx));

  // ── Pinned prompt actions ──
  const togglePromptSlug = (slug) =>
    setPromptSlugs((cur) =>
      cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug],
    );

  // ── Save ──
  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || saving) return; // disabled below; defence in depth
    // Notes first: Rust writes the file (creating the Space's own notes
    // file the first time) and answers with where it is, which is then
    // stored on the Space. Nothing to write when the notes were never
    // touched, or were left empty with no file to empty.
    let notesPath = memoryPath.trim();
    if (notesDirty && (notesPath || notes.trim())) {
      const invoke = getInvoke();
      setSaving(true);
      try {
        const written = await invoke("space_memory_write", {
          path: notesPath,
          slug: space.slug || "",
          contents: notes,
        });
        if (written) notesPath = written;
      } catch (e) {
        setSaving(false);
        console.error("space_memory_write failed:", e);
        window.ekToast?.({ kind: "error", title: "Could not save the notes", body: String(e) });
        return;
      }
      setSaving(false);
    }
    const draft = {
      row: {
        ...space,
        name: trimmedName,
        color: color || null,
        defaultModel: defaultModel.trim() || null,
        memoryPath: notesPath || null,
      },
      promptSlugs,
      // Always on = in every chat here and not removable in a chat.
      lockedSlugs: promptSlugs.slice(),
      attachments: attachments.map((a) => ({ kind: a.kind, path: a.path })),
    };
    onSave(draft);
  };

  return (
    <Fragment>
      <div
        onClick={onCancel}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
          zIndex: 70,
        }}
      />
      <div
        role="dialog"
        aria-label={`Edit Space ${space.name}`}
        data-space-settings-modal
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%,-50%)",
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 8,
          width: 560,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          zIndex: 71,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
        }}
      >
        <div
          style={{
            padding: "16px 20px 12px",
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          <div
            style={{
              fontFamily: T.sans,
              fontSize: 14,
              fontWeight: 600,
              color: T.fg,
            }}
          >
            Workspace settings — {space.name}
          </div>
          <div
            style={{
              marginTop: 4,
              fontFamily: T.sans,
              fontSize: 11.5,
              color: T.fg3,
              lineHeight: 1.4,
            }}
          >
            Everything below is optional — a workspace with just a name works fine as a folder.
          </div>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          {/* ── 1. Name ── (a workspace has no colour any more; one set
              before this stays on the row and is simply not shown here) */}
          <div>
            <SectionLabel>Name</SectionLabel>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Workspace name"
              data-space-settings-name
              style={modalInputStyle()}
            />
          </div>

          {/* ── 2. Default model ──
              Native <select> populated from `llm_list_models` (installed
              local models). Falls back gracefully when Ollama is down
              or the fetch failed — the dropdown still renders with
              "Inherit global default" + the currently-saved value (if
              any) marked "(not installed)" so a stale pick isn't
              silently dropped on save. */}
          <div>
            <SectionLabel>
              Model
              <SectionHint>
                The model this workspace's chats use. "App default" follows Settings → Models.
              </SectionHint>
            </SectionLabel>
            <select
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              data-space-settings-default-model
              style={{
                ...modalInputStyle(),
                fontFamily: T.sans,
                // The native select's appearance varies per platform —
                // leave it unstyled rather than fighting the OS dropdown.
                appearance: "auto",
                cursor: "pointer",
              }}
            >
              <option value="">{appDefaultName ? `App default (${appDefaultName})` : "App default"}</option>
              {/* If the saved defaultModel isn't in the installed list
                  (model was uninstalled OR Ollama is down), surface it
                  as a separate option marked "(not installed)" so the
                  value isn't silently lost on save. */}
              {defaultModel && !availableModels.includes(defaultModel) && (
                <option value={defaultModel} data-model-not-installed>
                  {nameOfModel ? nameOfModel(defaultModel) : defaultModel} (not installed)
                </option>
              )}
              {/* The model that reads documents for search is not one a
                  chat can use. */}
              {availableModels.filter((m) => !/embed/i.test(m)).map((m) => (
                <option key={m} value={m}>
                  {nameOfModel ? nameOfModel(m) : m}
                </option>
              ))}
            </select>
            {/* If the list came back empty AND no value is saved, surface
                a small hint pointing the user at how to populate it. The
                empty-AND-something-saved case is already handled by the
                "(not installed)" option above. */}
            {loaded && availableModels.length === 0 && !defaultModel && (
              <div
                style={{
                  marginTop: 6,
                  fontFamily: T.sans,
                  fontSize: 12,
                  color: T.fg3,
                  lineHeight: 1.4,
                }}
              >
                No installed models found. Start Ollama and pull a model (e.g. <span style={{ fontFamily: T.sans, color: T.fg2 }}>ollama pull gemma4:latest</span>) to populate this list.
              </div>
            )}
          </div>

          {/* ── 3. Notes ──
              What every chat in this workspace should know. Kept as a
              Markdown file (the Space's memory file), edited here in place
              and saved with the rest of the dialog. */}
          <div>
            <SectionLabel>
              Notes for this workspace
              <SectionHint>
                Standing facts every chat here should know. They are added to each question.
              </SectionHint>
            </SectionLabel>
            <textarea
              data-space-settings-notes
              value={notes}
              onChange={(e) => { setNotes(e.target.value); setNotesDirty(true); }}
              disabled={!notesLoaded}
              placeholder={notesLoaded
                ? "For example: We act for the buyer. Use British spelling. Cite clause numbers."
                : "Loading…"}
              rows={4}
              style={{
                ...modalInputStyle(),
                fontFamily: T.sans,
                lineHeight: 1.5,
                minHeight: 76,
                resize: "vertical",
              }}
            />
            {memoryPath && (
              <div
                data-space-settings-memory-path
                style={{
                  marginTop: 6,
                  fontFamily: T.sans,
                  fontSize: 12,
                  color: T.fg3,
                  wordBreak: "break-all",
                }}
              >
                Kept in {memoryPath}.{" "}
                <button
                  type="button"
                  onClick={revealMemory}
                  data-space-memory-reveal
                  style={{
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    cursor: "pointer",
                    color: T.fg1,
                    fontFamily: T.sans,
                    fontSize: 12,
                    textDecoration: "underline",
                  }}
                >
                  Show in Finder
                </button>
              </div>
            )}
          </div>

          {/* ── 4. Always use these templates ──
              Templates that are on in every chat in this workspace (a
              house style, say). In a chat their chips show a lock and
              cannot be removed. Templates themselves are written in
              Settings → Templates. */}
          <div data-space-settings-templates>
            <SectionLabel>
              Always use these templates
              <SectionHint>
                On in every chat in this workspace, such as a house style.
                They cannot be turned off inside a chat.
              </SectionHint>
            </SectionLabel>
            {!loaded ? (
              <div style={ekHint()}>Loading…</div>
            ) : (() => {
              const library = sortTemplates(promptsLibrary);
              const byId = new Map(library.map((p) => [p.id, p]));
              const remaining = library.filter((p) => !promptSlugs.includes(p.id));
              return (
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, position: "relative" }}>
                  {promptSlugs.map((slug) => {
                    const t = byId.get(slug);
                    return (
                      <span
                        key={slug}
                        data-space-template={slug}
                        title={t ? t.description || undefined : "This template's file is no longer in the folder"}
                        style={{ ...ekChip("plain"), height: 28, gap: 6, padding: "0 8px 0 10px", opacity: t ? 1 : 0.6 }}
                      >
                        <I.Lock size={11} />
                        <span style={{ color: T.fg }}>{t ? t.name : slug}</span>
                        <button
                          type="button"
                          data-space-template-remove={slug}
                          aria-label={`Stop always using ${t ? t.name : slug}`}
                          onClick={() => togglePromptSlug(slug)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            color: T.fg2,
                          }}
                        >
                          <I.X size={10} />
                        </button>
                      </span>
                    );
                  })}
                  <button
                    type="button"
                    data-space-template-add
                    aria-haspopup="menu"
                    aria-expanded={addTemplateOpen}
                    disabled={remaining.length === 0}
                    onClick={() => setAddTemplateOpen((o) => !o)}
                    style={ekBtn("secondary", { small: true, disabled: remaining.length === 0 })}
                  >
                    <I.Plus size={11} />
                    Add
                  </button>
                  {library.length === 0 && (
                    <span style={ekHint()}>No templates yet. Write one in Settings → Templates.</span>
                  )}
                  {addTemplateOpen && remaining.length > 0 && (
                    <div
                      role="menu"
                      data-space-template-options
                      // The dialog scrolls: bring the list into view when it
                      // opens near the foot.
                      ref={(el) => { if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); }}
                      style={{
                        position: "absolute",
                        left: 0,
                        top: "calc(100% + 6px)",
                        zIndex: 5,
                        minWidth: 260,
                        maxWidth: 380,
                        maxHeight: 220,
                        overflowY: "auto",
                        padding: 5,
                        background: T.isLight ? T.bg0 : T.bg2,
                        border: `1px solid ${T.borderStrong}`,
                        borderRadius: 10,
                        boxShadow: T.shadowPop,
                        fontFamily: T.sans,
                        fontSize: 13,
                      }}
                    >
                      {remaining.map((p) => (
                        <MenuItem
                          key={p.id}
                          data-space-template-option={p.id}
                          title={p.description || undefined}
                          onClick={() => {
                            togglePromptSlug(p.id);
                            setAddTemplateOpen(false);
                          }}
                        >
                          {p.name}
                        </MenuItem>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* ── 5. Pinned attachments ── */}
          <div>
            <SectionLabel>
              Documents
              <SectionHint>
                Every new chat in this workspace can read these.
              </SectionHint>
            </SectionLabel>
            <div style={{ marginBottom: 8, display: "flex", gap: 6 }}>
              <SmallButton onClick={addPinnedFile} data-space-pin-file>
                Add file…
              </SmallButton>
              <SmallButton onClick={addPinnedFolder} data-space-pin-folder>
                Add folder…
              </SmallButton>
            </div>
            {!loaded ? (
              <div style={{ color: T.fg3, fontSize: 12.5, fontFamily: T.sans }}>
                loading…
              </div>
            ) : attachments.length === 0 ? (
              <div style={{ color: T.fg3, fontSize: 12, fontFamily: T.sans }}>
                Nothing pinned yet.
              </div>
            ) : (
              <div data-space-settings-attachments-list>
                {attachments.map((a, idx) => (
                  <div
                    key={idx}
                    data-space-attachment-row
                    data-attachment-kind={a.kind}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "5px 8px",
                      background: T.bg2,
                      border: `1px solid ${T.border}`,
                      borderRadius: 8,
                      marginBottom: 4,
                      fontFamily: T.sans,
                      fontSize: 12.5,
                    }}
                  >
                    <span style={{ color: T.fg3, fontSize: 12, }}>
                      {a.kind}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        color: T.fg1,
                        wordBreak: "break-all",
                      }}
                    >
                      {a.path}
                    </span>
                    <button
                      onClick={() => removeAttachment(idx)}
                      title="Remove pin"
                      data-attachment-remove={idx}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: T.fg3,
                        cursor: "pointer",
                        padding: 4,
                      }}
                    >
                      <I.X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {documentCount && documentCount.documents > 0 && (
              <div
                data-space-settings-doc-count
                style={{ marginTop: 8, fontFamily: T.sans, fontSize: 11.5, color: T.fg2 }}
              >
                {documentCount.capped
                  ? `More than ${documentCount.documents} documents found.`
                  : `${documentsLabel(documentCount.documents)} found.`}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              data-space-settings-delete
              style={{
                padding: "7px 2px",
                background: "transparent",
                border: "none",
                color: T.red,
                fontFamily: T.sans,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Delete workspace…
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button
            onClick={onCancel}
            data-space-settings-cancel
            style={ekBtn("secondary")}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            data-space-settings-save
            style={ekBtn("primary", { disabled: !name.trim() || saving })}
          >
            Save
          </button>
        </div>
      </div>
    </Fragment>
  );
}

// Small section-label component used throughout SpaceSettingsModal.
// Local to this file so the modal's styling stays self-contained.
function SectionLabel({ children }) {
  return (
    <div style={ekHeading({ marginBottom: 5 })}>
      {children}
    </div>
  );
}

function SectionHint({ children }) {
  return (
    <div style={ekHint({ fontWeight: 400, marginTop: 2 })}>
      {children}
    </div>
  );
}

function SmallButton({ children, onClick, disabled, danger, ...rest }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      {...rest}
      style={ekBtn(danger ? "danger" : "secondary", { small: true, disabled })}
    >
      {children}
    </button>
  );
}

// A function, not a constant: it reads `T` when called, so the fields
// follow the theme in force. As a module-level object it was built once,
// from the dark defaults, and every dialog field stayed dark in a light
// theme.
function modalInputStyle() {
  return ekField();
}


// ─── ChatContextMenu ────────────────────────────────────────
// Fixed-position menu anchored at the right-click coordinates. Items:
// Open, Rename, divider, Move-to-Space list (rendered only when at
// least one Space exists; "(none)" entry to unfile), divider, Delete.
//
// Dismisses on click-outside, Esc, or any menu action. Clicks inside
// the menu must stopPropagation to avoid the document listener closing
// before the item handler runs.
function ChatContextMenu({
  x, y, chat, spaces = [],
  onOpen, onRename, onDelete, onMoveToSpace, onClose,
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Clamp the menu within the viewport so a right-click near the right/
  // bottom edge doesn't render off-screen. 200px is the wider-than-most
  // estimate of the menu's natural width.
  const menuW = 200;
  const menuH = 220;
  const clampedX = Math.min(x, window.innerWidth - menuW - 8);
  const clampedY = Math.min(y, window.innerHeight - menuH - 8);

  // Backdrop pattern: a transparent full-viewport div at z-index 49 catches
  // any click that isn't on a menu item; its onClick closes the menu. The
  // menu itself sits at z-index 50 so item clicks land on the menu (not
  // the backdrop) and fire normally. Bulletproof vs. the older
  // document.addEventListener('mousedown') approach, which raced with
  // React re-renders and could close the menu before the item's click
  // event fired.
  return (
    <Fragment>
      <div
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 49,
          background: "transparent",
        }}
      />
      <div
        role="menu"
        data-chat-context-menu
        style={{
          position: "fixed",
          top: clampedY,
          left: clampedX,
          zIndex: 50,
          background: T.bg2,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 5,
          padding: 4,
          minWidth: menuW,
          maxHeight: "70vh",
          overflowY: "auto",
          boxShadow: T.shadowPop,
          fontFamily: T.sans,
          fontSize: 12,
        }}
      >
      <MenuItem onClick={onOpen}>Open</MenuItem>
      <MenuItem onClick={onRename}>Rename…</MenuItem>
      {/* Move to Space submenu — only shown when a Space mover is wired
          AND there's at least one Space to move into (avoids a dead
          submenu on a fresh install before any Spaces exist). The "(none)"
          row always appears alongside Spaces so a user filed into a
          Space can unfile via the menu without dragging. */}
      {onMoveToSpace && spaces.length > 0 && (
        <Fragment>
          <MenuDivider />
          <MenuLabel>Move to workspace</MenuLabel>
          <MenuItem
            onClick={() => onMoveToSpace(null)}
            selected={!chat.spaceId}
            indent
            data-move-to-space="none"
          >
            General
          </MenuItem>
          {spaces.map((s) => (
            <MenuItem
              key={s.id}
              onClick={() => onMoveToSpace(s.id)}
              selected={chat.spaceId === s.id}
              indent
              data-move-to-space={s.id}
            >
              {s.name}
            </MenuItem>
          ))}
        </Fragment>
      )}
      <MenuDivider />
      <MenuItem onClick={onDelete} danger>
        Delete chat
      </MenuItem>
      </div>
    </Fragment>
  );
}

// Generic single menu item — used by both the row context menu and the
// group overflow menu. `selected` marks the current state with a leading
// checkmark glyph; `danger` colours destructive actions red on hover.
function MenuItem({ children, onClick, selected, danger, indent, ...rest }) {
  // ...rest forwards any extra HTML attributes (especially `data-*` for
  // Playwright selectors) to the underlying div. Without it, callers can
  // pass `data-move-to-space="s1"` and the prop just vanishes in the
  // component boundary — the test then can't find a stable hook for
  // clicking the specific item. Forwarding is safe here: MenuItem
  // doesn't accept any other unknown props in production code, and
  // React skips unknown attrs that aren't `data-*`/`aria-*` on the DOM.
  const [hover, setHover] = useState(false);
  return (
    <div
      role="menuitem"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        onClick && onClick();
      }}
      {...rest}
      style={{
        padding: indent ? "4px 8px 4px 24px" : "4px 8px",
        borderRadius: 3,
        cursor: "pointer",
        color: danger
          ? hover
            ? T.red
            : T.fg1
          : hover
            ? T.fg
            : T.fg1,
        background: hover ? T.bg3 : "transparent",
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {selected ? (
        <span style={{ width: 12, color: T.amber, fontSize: 11 }}>✓</span>
      ) : indent ? (
        <span style={{ width: 12 }} />
      ) : null}
      <span style={{ flex: 1 }}>{children}</span>
    </div>
  );
}

function MenuDivider() {
  return (
    <div
      style={{
        height: 1,
        margin: "4px 0",
        background: T.border,
      }}
    />
  );
}

function MenuLabel({ children }) {
  return (
    <div
      style={{
        padding: "4px 8px 2px",
        color: T.fg3,
        fontFamily: T.sans,
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}

// ─── NameModal ──────────────────────────────────────────────
// Shared single-input modal for naming things — used here for:
//   • Create group  (title="New group",   confirm="Create")
//   • Rename group  (title="Rename group", confirm="Save")
//   • Rename chat   (title="Rename chat",  confirm="Save")
//
// window.prompt() is the obvious alternative, BUT Tauri's WKWebView
// disables it (returns null silently). This modal is the substitute.
//
// Submits on Enter; cancels on Esc. Pre-fills with `initial` and selects
// the text so the user can type-to-replace. Trims input and refuses
// empty submissions (button greyed; Enter is a no-op).
function NameModal({
  title,
  confirmLabel,
  initial,
  placeholder,
  onCancel,
  onSubmit,
}) {
  const [name, setName] = useState(initial || "");
  const inputRef = useRef(null);
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);
  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed) return;
    onSubmit(trimmed);
  };
  return (
    <div
      role="dialog"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 320,
          padding: 16,
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 8,
          fontFamily: T.sans,
          color: T.fg,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
          {title}
        </div>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") onCancel();
          }}
          placeholder={placeholder || ""}
          spellCheck={false}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "6px 8px",
            background: T.bg2,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            color: T.fg,
            fontFamily: T.sans,
            fontSize: 13,
            marginBottom: 12,
          }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={ekBtn("secondary")}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!trimmed}
            style={ekBtn("primary", { disabled: !trimmed })}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ConfirmModal ───────────────────────────────────────────
// Generic confirm dialog. Title + body + Cancel/Confirm buttons.
// `danger` styles the confirm button red. Used by the chat-row context
// menu's "Delete chat" so an accidental click can't wipe a conversation.
//
// Esc cancels; Enter confirms. The confirm button auto-focuses so the
// user can hit Enter to follow through quickly — but the default action
// (button focus, Enter) is intentionally on the *confirm* side, not on
// a destructive default-click while the user is mid-keystroke elsewhere.
function ConfirmModal({
  title,
  body,
  cancelLabel,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}) {
  const btnRef = useRef(null);
  useEffect(() => {
    if (btnRef.current) btnRef.current.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);
  return (
    <div
      role="dialog"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 360,
          padding: 18,
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 8,
          fontFamily: T.sans,
          color: T.fg,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          {title}
        </div>
        <div
          style={{
            fontSize: 12,
            color: T.fg1,
            lineHeight: 1.5,
            marginBottom: 16,
          }}
        >
          {body}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={ekBtn("secondary")}
          >
            {cancelLabel || "Cancel"}
          </button>
          <button
            ref={btnRef}
            onClick={onConfirm}
            data-confirm-button
            style={danger ? { ...ekBtn("primary"), background: T.red, border: `1px solid ${T.red}`, color: "#fff" } : ekBtn("primary")}
          >
            {confirmLabel || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

// One row in the "Messages" section of the sidebar. Renders the parent
// chat's title (small mono header) and the matched snippet with FTS5
// U+0001 (start) / U+0002 (end) sentinels parsed into <mark> elements.
// Splitting on sentinels rather than HTML-injecting keeps assistant-
// streamed content safe from any XSS surprises.
function MessageHitRow({ hit, onClick }) {
  const [hover, setHover] = useState(false);
  // Snippet parser: even-indexed parts are literal text, odd-indexed are
  // the highlighted matches. The regex literal below contains the actual
  // U+0001 and U+0002 control bytes — they appear invisible in most
  // editors and diff tools. Verify with `od -c` if a change to this line
  // appears to drop them. Robust to "no marker" snippets (returns the
  // whole string as a single literal part) and to multiple matches.
  const parts = useMemo(() => {
    const s = hit.snippet || "";
    return s.split(/(.*?)/s);
  }, [hit.snippet]);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        margin: "0 6px 2px",
        padding: "6px 8px",
        background: hover ? T.bg3 : "transparent",
        borderRadius: 4,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 3,
      }}
      title={hit.chatTitle}
    >
      <div
        style={{
          fontFamily: T.sans,
          fontSize: 12,
          color: T.fg2,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <span style={{ color: T.fg3 }}>{hit.role === "user" ? "you" : "ai"}</span>
        <span style={{ color: T.fg3 }}>·</span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {hit.chatTitle}
        </span>
      </div>
      <div
        style={{
          fontFamily: T.sans,
          fontSize: 11.5,
          color: T.fg1,
          lineHeight: 1.4,
          // Clamp to 3 lines so a long snippet doesn't push other hits off
          // screen. The ellipsis comes from FTS5's snippet() function for
          // truncated context; this clamp handles the visual overflow case.
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {parts.map((part, i) =>
          i % 2 === 1 ? (
            <mark
              key={i}
              style={{
                background: T.amber + "40",
                color: T.fg,
                padding: 0,
                borderRadius: 2,
              }}
            >
              {part}
            </mark>
          ) : (
            <Fragment key={i}>{part}</Fragment>
          ),
        )}
      </div>
    </div>
  );
}

function ChatRow({
  chat,
  model,
  // Resolved Space color for this chat (passed pre-computed from the
  // Sidebar so we don't re-scan the spaces array per row). Undefined
  // when the chat isn't in a Space, or is in a Space with no color
  // set. When defined, it wins over the model color — most users have
  // a stack of installed Ollama models that aren't in MODELS_BY_ID and
  // would otherwise render as a meaningless muted gray dot; the Space
  // color is far more informative at a glance ("oh this chat is in
  // Novel").
  active,
  onClick,
  onDelete,
  onContextMenu,
  onDragStart,
  onDragEnd,
  query,
}) {
  const [hover, setHover] = useState(false);
  const highlight = (text) => {
    if (!query.trim()) return text;
    const re = new RegExp(
      `(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
    return text.split(re).map((p, i) =>
      re.test(p) ? (
        <mark
          key={i}
          style={{
            background: T.amber + "40",
            color: T.amber,
            padding: 0,
          }}
        >
          {p}
        </mark>
      ) : (
        <Fragment key={i}>{p}</Fragment>
      ),
    );
  };
  // Drag source. We use a custom MIME type so unrelated drops (text, files
  // dragged in from Finder, prompts in a future feature) don't accidentally
  // match the GroupSection drop handler.
  const handleDragStart = (e) => {
    e.dataTransfer.setData("text/x-ekorbia-chat-id", chat.id);
    e.dataTransfer.effectAllowed = "move";
    onDragStart && onDragStart(chat.id);
  };
  const handleDragEnd = () => {
    onDragEnd && onDragEnd(chat.id);
  };
  return (
    <div
      onClick={onClick}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        onContextMenu(e);
      }}
      draggable={true}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-chat-row
      data-chat-id={chat.id}
      style={{
        margin: "0 6px",
        padding: "7px 9px",
        background: active ? T.bg4 : hover ? T.bg3 : "transparent",
        border: `1px solid ${hover && !active ? T.border : "transparent"}`,
        borderRadius: 8,
        cursor: "pointer",
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        position: "relative",
      }}
    >
      {chat.pinned && (
        <I.Pin
          size={9}
          style={{ color: T.amber, position: "absolute", left: -2, top: 7 }}
        />
      )}
      <span style={{ marginTop: 3, flexShrink: 0 }}>
        <ModelDot
          color={model?.color || T.fg3}
          size={6}
          glow={false}
        />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Row 1: title + relative time — the time swaps for the delete ×
            on hover/active. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: T.sans,
              fontSize: 12,
              color: active ? T.fg : T.fg1,
              fontWeight: active ? 500 : 400,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            {(chat.tabType === "multi-pending" ||
              chat.tabType === "single-from-multi") && (
              <I.Columns
                size={10}
                style={{ color: T.amber, flexShrink: 0 }}
                title={`Comparison chat (${chat.models?.length || 0} models)`}
                data-compare-badge
              />
            )}
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {highlight(chat.title)}
            </span>
          </div>
          {hover || active ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              style={{
                flexShrink: 0,
                width: 16,
                height: 16,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "none",
                border: "none",
                cursor: "pointer",
                color: T.fg3,
                borderRadius: 3,
                padding: 0,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = T.fg)}
              onMouseLeave={(e) => (e.currentTarget.style.color = T.fg3)}
            >
              <I.X size={10} />
            </button>
          ) : (
            chat.when && (
              <span
                style={{
                  flexShrink: 0,
                  fontFamily: T.sans,
                  fontSize: 12,
                  color: T.fg3,
                }}
              >
                {chat.when}
              </span>
            )
          )}
        </div>
        {/* Row 2: one-line message preview (Bear-style). Absent on a fresh
            or attachment-only chat with no non-empty message yet. */}
        {chat.preview && (
          <div
            style={{
              fontFamily: T.sans,
              fontSize: 11,
              color: T.fg2,
              marginTop: 2,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {chat.preview}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Status line ────────────────────────────────────────────
// One line that states the privacy position, shown on Home and at the
// foot of the workspace sidebar. It replaces the old status bar and keeps
// the two things that bar was needed for: a backend that cannot answer
// (the line turns into a warning that opens the setup gate) and folders
// still being indexed.
//
// The privacy text comes from privacyStatus (utils.js): a local backend
// keeps chats on this Mac; a custom server on another machine is named.
function StatusLine({ model, backendKind, onProblemClick, warming, indexingAttachments = [], locked = false, onPrivacyClick }) {
  const [baseUrl, setBaseUrl] = useState(null);
  const [up, setUp] = useState(true);
  const [present, setPresent] = useState(true);
  // Whether any model that can answer is installed (the one that only
  // searches documents does not count). False on a first run until the
  // download finishes: the line then says so instead of naming a model.
  const [anyModel, setAnyModel] = useState(true);
  const invoke = getInvoke();
  const modelId = (model && model.id) || "";
  const modelName = (model && (model.name || model.id)) || "The model";

  useEffect(() => {
    if (!invoke) return;
    invoke("llm_backend_config_get")
      .then((c) => setBaseUrl((c && c.baseUrl) || null))
      .catch(() => {});
  }, [backendKind]);

  useEffect(() => {
    if (!invoke) return undefined;
    let cancelled = false;
    const matches = (n) => !!modelId && (n === modelId || n.startsWith(modelId.split(":")[0]));
    const check = async () => {
      try {
        const data = await invoke("llm_list_models");
        if (cancelled) return;
        setUp(true);
        const names = ((data && data.models) || []).map((m) => (m && m.name) || "");
        setPresent(!modelId || names.some(matches));
        setAnyModel(names.some((n) => n && !/embed/i.test(n)));
      } catch {
        if (!cancelled) setUp(false);
      }
    };
    check();
    const iv = setInterval(check, warming ? 1000 : 5000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [modelId, warming, backendKind]);

  const privacy = privacyStatus(backendKind, baseUrl, locked);
  const indexing = indexingAttachments.length;
  let kind = privacy.kind; // 'local' | 'server' | 'locked'
  let text = privacy.text;
  let color = privacy.kind === "local" ? T.green : privacy.kind === "locked" ? T.fg : T.blue;
  if (!up) {
    kind = "problem";
    color = T.amber;
    text = backendKind === "engine"
      ? "The engine is not responding"
      : backendKind === "openai"
        ? "The server is not responding"
        : "Ollama is not running";
  } else if (!present) {
    kind = "problem";
    color = T.amber;
    text = anyModel ? `${modelName} is not installed` : "No model is installed yet";
  } else if (indexing > 0) {
    kind = "indexing";
    color = T.amber;
    text = indexing === 1 ? "Reading 1 attachment…" : `Reading ${indexing} attachments…`;
  }
  // A problem opens setup; the privacy position opens the record behind it
  // (Settings → Privacy), so the claim can be checked.
  const toSetup = kind === "problem" && !!onProblemClick;
  const toPrivacy = !toSetup && kind !== "indexing" && !!onPrivacyClick;
  const clickable = toSetup || toPrivacy;
  return (
    <button
      type="button"
      data-status-line
      data-status-kind={kind}
      onClick={toSetup ? onProblemClick : toPrivacy ? onPrivacyClick : undefined}
      title={toSetup ? "Open setup" : toPrivacy ? "See what Ekorbia has connected to" : text}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        minWidth: 0,
        padding: 0,
        border: "none",
        background: "transparent",
        color: T.fg2,
        fontFamily: T.sans,
        fontSize: 12,
        cursor: clickable ? "pointer" : "default",
        textAlign: "left",
      }}
    >
      {kind === "locked" ? <I.Lock size={14} style={{ color }} /> : <I.Shield size={14} style={{ color }} />}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {text}
      </span>
    </button>
  );
}

// ─── More menu ──────────────────────────────────────────────
// The control beside the status line. Settings is its lasting job. The
// three panel entries are a stop-gap: the title-bar buttons that opened
// the Prompts, Watches and Files panels are gone, and those panels move
// into Settings (Templates, Watches) or go away (Files) in later steps of
// the redesign. Until then this is how they are reached.
function MoreMenu({ onSettings, onTemplates, onWatches }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const run = (fn) => () => { setOpen(false); fn && fn(); };
  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        data-more-menu-button
        aria-label="Settings and more"
        title="Settings and more"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 28,
          height: 28,
          display: "grid",
          placeItems: "center",
          border: "none",
          borderRadius: 7,
          background: open ? T.bg3 : "transparent",
          color: T.fg1,
          cursor: "pointer",
        }}
      >
        <I.Settings size={15} />
      </button>
      {open && (
        <div
          role="menu"
          data-more-menu
          style={{
            position: "absolute",
            right: 0,
            bottom: "calc(100% + 6px)",
            minWidth: 190,
            padding: 4,
            background: T.bg2,
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            boxShadow: T.shadowPop,
            zIndex: 60,
          }}
        >
          <MenuItem onClick={run(onSettings)} data-more-settings>Settings…</MenuItem>
          <MenuDivider />
          <MenuItem onClick={run(onTemplates)} data-more-templates>Templates…</MenuItem>
          <MenuItem onClick={run(onWatches)} data-more-watches>Watches…</MenuItem>
        </div>
      )}
    </div>
  );
}
