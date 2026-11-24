// shell.jsx -- App chrome: window-drag helpers, Sidebar (one workspace),
//   Space dialogs, ChatRow, MessageHitRow, RightPanelTabs, StatusLine, MoreMenu.
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

  // Lookup table for the per-chat sidebar dot: a chat in a coloured Space
  // wears that colour, which says more than the model's.
  const spaceColorById = useMemo(() => {
    const m = new Map();
    const resolve = window.spaceColorHex;
    for (const s of (spaces || [])) {
      if (s.color && resolve) m.set(s.id, resolve(s.color));
    }
    return m;
  }, [spaces]);
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

  // Space ambient tint — in a coloured workspace the rail wears a whisper
  // wash of that colour at the top, matching the chat pane's tinted glows.
  // Dark themes only, coloured Spaces only, else the flat bg1.
  const activeSpaceRow = activeSpaceId
    ? (spaces || []).find((s) => s.id === activeSpaceId) || null
    : null;
  const railTint = window.spaceAmbientTint
    ? window.spaceAmbientTint(activeSpaceRow, window.SPACE_COLORS, T.isLight)
    : null;
  const workspaceName = activeSpaceRow ? (activeSpaceRow.name || "Unnamed") : "General";
  const metaLine = activeSpaceRow
    ? (docsLabel || "No documents yet")
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
      data-space-tint={railTint || undefined}
      style={{
        width: width || 252,
        flexShrink: 0,
        background: railTint
          ? `radial-gradient(ellipse 130% 24% at 50% 0%, ${railTint}1a, transparent), ${T.bg1}`
          : T.bg1,
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
                  spaceColor={c.spaceId ? spaceColorById.get(c.spaceId) : undefined}
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
          onCancel={() => setEditSpaceModal(null)}
          onSave={async (draft) => {
            const s = editSpaceModal.space;
            setEditSpaceModal(null);
            if (onEditSpaceSave) await onEditSpaceSave(s.id, draft);
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
// Rename, Change color, Delete.
//
// Clamps to the viewport internally so a near-edge open doesn't render
// off-screen. Mirrors the dismissal pattern from ChatContextMenu: a
// transparent full-viewport backdrop at the layer below catches outside
// clicks; Esc dismisses via the keydown effect.
function SpaceOverflowMenu({ x, y, onEdit, onRename, onRecolor, onDelete, onClose }) {
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
        <MenuItem onClick={onRecolor}>Change color…</MenuItem>
        <MenuItem onClick={onDelete} danger>
          Delete workspace
        </MenuItem>
      </div>
    </Fragment>
  );
}

// ─── SpaceCreateModal ───────────────────────────────────────
//
// Modal for creating a new Space — name input + color palette grid.
// Distinct from NameModal because we need to capture both pieces in
// one user gesture; rename re-uses NameModal (color stays put).
//
// Color defaults to the first palette key so a user who just hits
// Enter still gets a sensibly-tinted Space. Selecting "no color" is
// also valid (the dot falls back to fg2 in the sidebar).
function SpaceCreateModal({ onCancel, onSubmit }) {
  const [name, setName] = useState("");
  const palette = window.SPACE_COLORS || {};
  const paletteKeys = Object.keys(palette);
  const [color, setColor] = useState(paletteKeys[0] || null);
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
          placeholder="Space name (e.g. Novel, Q4 plans)"
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
            marginTop: 16,
            marginBottom: 8,
            fontFamily: T.mono,
            fontSize: 10,
            color: T.fg2,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          Color
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
          }}
        >
          {paletteKeys.map((k) => {
            const selected = color === k;
            return (
              <button
                key={k}
                onClick={() => setColor(k)}
                title={k}
                data-color-swatch={k}
                aria-pressed={selected}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: palette[k],
                  border: selected
                    ? `2px solid ${T.fg}`
                    : `2px solid transparent`,
                  cursor: "pointer",
                  padding: 0,
                  outline: "none",
                  flexShrink: 0,
                }}
              />
            );
          })}
          {/* "No color" option — falls through to the muted fg2 in the
              sidebar dot. Useful for visually-noisy users who don't want
              tinting at all. */}
          <button
            onClick={() => setColor(null)}
            title="No color"
            data-color-swatch="none"
            aria-pressed={!color}
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: "transparent",
              border: !color
                ? `2px solid ${T.fg}`
                : `2px dashed ${T.border}`,
              cursor: "pointer",
              padding: 0,
              outline: "none",
              flexShrink: 0,
              color: T.fg3,
              fontFamily: T.mono,
              fontSize: 9,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ∅
          </button>
        </div>

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
            style={{
              padding: "7px 14px",
              background: "transparent",
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              color: T.fg2,
              fontFamily: T.sans,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => name.trim() && onSubmit(name.trim(), color, true)}
            disabled={!name.trim()}
            data-space-create-and-configure
            title="Create the Space and open its settings dialog so you can set system prompt, default model, memory file, pinned prompts, and pinned attachments"
            style={{
              padding: "7px 14px",
              background: "transparent",
              border: `1px solid ${name.trim() ? T.borderStrong : T.border}`,
              borderRadius: 5,
              color: name.trim() ? T.fg1 : T.fg3,
              fontFamily: T.sans,
              fontSize: 12,
              cursor: name.trim() ? "pointer" : "not-allowed",
            }}
          >
            Create &amp; configure…
          </button>
          <button
            onClick={() => name.trim() && onSubmit(name.trim(), color, false)}
            disabled={!name.trim()}
            data-space-create-confirm
            style={{
              padding: "7px 14px",
              background: name.trim() ? T.amber : T.bg3,
              border: `1px solid ${name.trim() ? T.amber : T.border}`,
              borderRadius: 5,
              color: name.trim() ? T.bg0 : T.fg3,
              fontFamily: T.sans,
              fontSize: 12,
              fontWeight: 600,
              cursor: name.trim() ? "pointer" : "not-allowed",
            }}
          >
            Create
          </button>
        </div>
      </div>
    </Fragment>
  );
}

// ─── SpaceColorPickerPopover ────────────────────────────────
//
// Small popover anchored next to a Space row, opened from the Change-
// color overflow item. Clicking a swatch immediately calls onPick + closes;
// clicking outside cancels (no Change button — there's nothing to confirm
// because the only state is the picked color).
function SpaceColorPickerPopover({ anchorRect, current, onPick, onClose }) {
  const palette = window.SPACE_COLORS || {};
  const paletteKeys = Object.keys(palette);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Anchor below the row's overflow button. If anchorRect isn't supplied
  // (defensive), center on the viewport.
  const rect = anchorRect || {
    bottom: window.innerHeight / 2,
    left: window.innerWidth / 2 - 100,
  };

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
          zIndex: 65,
          background: "transparent",
        }}
      />
      <div
        data-space-color-popover
        style={{
          position: "fixed",
          top: rect.bottom + 6,
          left: Math.max(8, rect.left - 60),
          background: T.bg1,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 6,
          padding: 10,
          zIndex: 66,
          boxShadow: T.shadowPop,
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          maxWidth: 180,
        }}
      >
        {paletteKeys.map((k) => {
          const selected = current === k;
          return (
            <button
              key={k}
              onClick={() => onPick(k)}
              title={k}
              data-color-swatch={k}
              aria-pressed={selected}
              style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: palette[k],
                border: selected
                  ? `2px solid ${T.fg}`
                  : `2px solid transparent`,
                cursor: "pointer",
                padding: 0,
                outline: "none",
                flexShrink: 0,
              }}
            />
          );
        })}
        <button
          onClick={() => onPick(null)}
          title="No color"
          data-color-swatch="none"
          aria-pressed={!current}
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: "transparent",
            border: !current
              ? `2px solid ${T.fg}`
              : `2px dashed ${T.border}`,
            cursor: "pointer",
            padding: 0,
            outline: "none",
            flexShrink: 0,
            color: T.fg3,
            fontFamily: T.mono,
            fontSize: 9,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ∅
        </button>
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
//   4. Pinned prompts (search + alphabetised list with lock toggle
//      per pinned row + "+ New prompt for this Space" affordance)
//   5. Pinned attachments (list with Add file / Add folder / Remove)
//
// Draft state lives in this component — Cancel reverts cleanly without
// touching the backend. Save calls the `onSave(draft)` callback once
// with everything the parent needs to diff + dispatch:
//   {
//     row: { ...space, name, color, defaultModel, memoryPath },
//     promptSlugs:   string[],          // desired final pin set
//     lockedSlugs:   string[],          // subset that's locked
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
function SpaceSettingsModal({ space, promptsLibrary = [], onCancel, onSave }) {
  // ── Draft state for the row-level fields ──
  // Color and slug are loaded from the live row; slug is read-only
  // (display only) because `space_update`'s SET clause excludes it
  // (the Phase 1 contract — memory file path on disk is keyed by slug).
  const [name, setName] = useState(space.name || "");
  const [color, setColor] = useState(space.color || null);
  const [defaultModel, setDefaultModel] = useState(space.defaultModel || "");
  const [memoryPath, setMemoryPath] = useState(space.memoryPath || "");
  // Search filter for the pinned-prompts picker. Empty string means
  // "show everything" — the picker still splits into Pinned + All.
  const [promptSearch, setPromptSearch] = useState("");
  // Subset of `promptSlugs` that's locked. Loaded from the
  // `space_prompts_list` rows' `locked` flag on mount; mutated when the
  // user toggles the lock icon on a pinned row. The parent uses this
  // alongside `promptSlugs` to diff against the live DB state on save
  // (add new pins with locked=true, fire space_prompt_set_locked on
  // existing pins whose lock state changed).
  const [lockedSlugs, setLockedSlugs] = useState(new Set());
  // "+ New prompt for this Space" inline form state. `null` when closed,
  // `{name, body}` when open. The form materialises a new prompt in the
  // user's library AND pins it (locked) on save.
  const [newPromptForm, setNewPromptForm] = useState(null);
  // Prompts created via the inline form during this modal session.
  // Merged with the live `promptsLibrary` prop for picker rendering so
  // they appear immediately — the parent's library refresh fires on
  // modal close and brings them in officially.
  const [newlyCreatedPrompts, setNewlyCreatedPrompts] = useState([]);
  // Saving-in-flight flag for the inline form — disables Save while the
  // backend round-trips so the user can't double-fire.
  const [newPromptSaving, setNewPromptSaving] = useState(false);

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
        // Bootstrap the locked-set from the rows' `locked` flag. Slugs
        // not in the set are unlocked; the diff in `saveSpaceSettings`
        // catches both "newly locked" and "newly unlocked" by reading
        // membership against this Set.
        const lockedFromRows = new Set(
          (prompts || []).filter((p) => p && p.locked).map((p) => p.promptSlug),
        );
        setLockedSlugs(lockedFromRows);
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

  // ── Memory file actions (leaf — talk directly to Tauri) ──
  const browseMemoryPath = async () => {
    const dialogApi = window.getDialogApi && window.getDialogApi();
    if (!dialogApi) return;
    try {
      const picked = await dialogApi.save({
        title: `Memory file for ${space.name || "Space"}`,
        // Suggest the canonical default — parent dir is created by
        // space_memory_open on first Edit. The user can override.
        defaultPath: `Ekorbia/Spaces/${space.slug}/memory.md`,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (picked) setMemoryPath(picked);
    } catch (e) {
      console.error("space memory browse failed:", e);
    }
  };
  const editMemory = async () => {
    const invoke = window.getInvoke && window.getInvoke();
    if (!invoke) return;
    // If no path is set yet, derive the canonical default so the user
    // can hit Edit on a fresh Space without going through Browse first.
    const path = memoryPath
      || `${space.slug ? "~/Documents/Ekorbia/Spaces/" + space.slug + "/memory.md" : ""}`;
    if (!path) return;
    try {
      await invoke("space_memory_open", { path, reveal: false });
      // If we just created the file via the canonical default, pin the
      // path so Save persists it on the row. Without this, hitting
      // Edit-then-Cancel would leave the row's memoryPath unset.
      if (!memoryPath) setMemoryPath(path);
    } catch (e) {
      console.error("space_memory_open failed:", e);
      window.ekToast?.({ kind: "error", title: "Open memory failed", body: String(e) });
    }
  };
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
  const clearMemory = () => setMemoryPath("");

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
  const handleSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return; // disabled below; defence in depth
    const draft = {
      row: {
        ...space,
        name: trimmedName,
        color: color || null,
        defaultModel: defaultModel.trim() || null,
        memoryPath: memoryPath.trim() || null,
      },
      promptSlugs,
      // Only include slugs that are ALSO in promptSlugs — a lock flag
      // on an unpinned slug is meaningless. Filter defensively in case
      // the user toggled lock-then-unpin without the lockedSlugs Set
      // catching up; the parent shouldn't have to think about it.
      lockedSlugs: promptSlugs.filter((s) => lockedSlugs.has(s)),
      attachments: attachments.map((a) => ({ kind: a.kind, path: a.path })),
    };
    onSave(draft);
  };

  const palette = window.SPACE_COLORS || {};
  const paletteKeys = Object.keys(palette);

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
          {/* ── 1. Name + Color ── */}
          <div>
            <SectionLabel>Name</SectionLabel>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Space name"
              data-space-settings-name
              style={modalInputStyle}
            />
            <div style={{ height: 12 }} />
            <SectionLabel>Color</SectionLabel>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {paletteKeys.map((k) => {
                const selected = color === k;
                return (
                  <button
                    key={k}
                    onClick={() => setColor(k)}
                    title={k}
                    data-color-swatch={k}
                    aria-pressed={selected}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      background: palette[k],
                      border: selected
                        ? `2px solid ${T.fg}`
                        : `2px solid transparent`,
                      cursor: "pointer",
                      padding: 0,
                      flexShrink: 0,
                    }}
                  />
                );
              })}
              <button
                onClick={() => setColor(null)}
                title="No color"
                data-color-swatch="none"
                aria-pressed={!color}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: "transparent",
                  border: !color
                    ? `2px solid ${T.fg}`
                    : `2px dashed ${T.border}`,
                  cursor: "pointer",
                  padding: 0,
                  flexShrink: 0,
                  color: T.fg3,
                  fontFamily: T.mono,
                  fontSize: 9,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                ∅
              </button>
            </div>
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
              Default model
              <SectionHint>
                Preselected for new chats in this Space. Pick "Inherit global default" to use your composer's default model instead.
              </SectionHint>
            </SectionLabel>
            <select
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              data-space-settings-default-model
              style={{
                ...modalInputStyle,
                fontFamily: T.mono,
                // The native select's appearance varies per platform —
                // leave it unstyled rather than fighting the OS dropdown.
                appearance: "auto",
                cursor: "pointer",
              }}
            >
              <option value="">Inherit global default</option>
              {/* If the saved defaultModel isn't in the installed list
                  (model was uninstalled OR Ollama is down), surface it
                  as a separate option marked "(not installed)" so the
                  value isn't silently lost on save. */}
              {defaultModel && !availableModels.includes(defaultModel) && (
                <option value={defaultModel} data-model-not-installed>
                  {defaultModel} (not installed)
                </option>
              )}
              {availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
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
                  fontSize: 11,
                  color: T.fg3,
                  lineHeight: 1.4,
                }}
              >
                No installed models found. Start Ollama and pull a model (e.g. <span style={{ fontFamily: T.mono, color: T.fg2 }}>ollama pull gemma4:latest</span>) to populate this list.
              </div>
            )}
          </div>

          {/* ── 3. Memory file ── */}
          <div>
            <SectionLabel>
              Memory file
              <SectionHint>
                Injected as a system message every send, after your global memory file.
              </SectionHint>
            </SectionLabel>
            <div
              data-space-settings-memory-path
              style={{
                padding: "6px 8px",
                background: T.bg2,
                border: `1px solid ${T.border}`,
                borderRadius: 4,
                fontFamily: T.mono,
                fontSize: 11,
                color: memoryPath ? T.fg1 : T.fg3,
                wordBreak: "break-all",
                minHeight: 24,
              }}
            >
              {memoryPath || "(no memory file set)"}
            </div>
            <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <SmallButton onClick={browseMemoryPath} data-space-memory-browse>
                Browse…
              </SmallButton>
              <SmallButton onClick={editMemory} data-space-memory-edit>
                Edit
              </SmallButton>
              <SmallButton
                onClick={revealMemory}
                disabled={!memoryPath}
                data-space-memory-reveal
              >
                Reveal
              </SmallButton>
              <SmallButton
                onClick={clearMemory}
                disabled={!memoryPath}
                danger
                data-space-memory-clear
              >
                Clear
              </SmallButton>
            </div>
          </div>

          {/* ── 4. Pinned prompts ──
              Search-and-section picker (Option A from the proposal):
                • Search input pinned at the top filters by name (case-
                  insensitive substring match).
                • Two stacked sections inside one scrollable area —
                  "Pinned" (current selection, alphabetical) then "All
                  prompts" (everything else, alphabetical).
                • Each row: checkbox + favourite color dot + prompt name.
                • Click anywhere on the row to toggle pinned state — the
                  row instantly reflows between the two sections.
                • Sections collapse to empty when they have no matches
                  for the current filter; if BOTH are empty the picker
                  shows a "no matches" message. */}
          <div>
            <SectionLabel>
              Pinned prompts
              <SectionHint>
                Auto-attached to every new chat in this Space. Click a row to toggle.
              </SectionHint>
            </SectionLabel>
            {!loaded ? (
              <div style={{ color: T.fg3, fontSize: 11, fontFamily: T.mono }}>
                loading…
              </div>
            ) : promptsLibrary.length === 0 && newlyCreatedPrompts.length === 0 ? (
              <div style={{ color: T.fg3, fontSize: 11, fontFamily: T.sans }}>
                No prompts in your library yet — add some in the Prompts panel, or use "+ New prompt for this Space" below.
              </div>
            ) : (
              (() => {
                // Compute pinned + unpinned splits once per render. Cheap
                // for libraries under a few hundred prompts (the loop is
                // single-pass) — useMemo would be over-optimisation since
                // the inputs (promptsLibrary identity, promptSlugs array,
                // promptSearch string) all change rarely.
                //
                // Merge `newlyCreatedPrompts` with the live library
                // (deduped by id) so prompts the user just created via
                // the inline form appear immediately, without waiting
                // for the parent's library refresh on modal close.
                const q = promptSearch.trim().toLowerCase();
                const matches = (p) =>
                  !q || (p.name || p.id).toLowerCase().includes(q);
                const sorter = (a, b) =>
                  (a.name || a.id).localeCompare(b.name || b.id);
                const pinnedSet = new Set(promptSlugs);
                const seen = new Set();
                const merged = [];
                for (const p of [...newlyCreatedPrompts, ...promptsLibrary]) {
                  if (!p || !p.id || seen.has(p.id)) continue;
                  seen.add(p.id);
                  merged.push(p);
                }
                const pinned = [];
                const unpinned = [];
                for (const p of merged) {
                  if (!matches(p)) continue;
                  if (pinnedSet.has(p.id)) pinned.push(p);
                  else unpinned.push(p);
                }
                pinned.sort(sorter);
                unpinned.sort(sorter);

                const renderRow = (p, isSelected) => {
                  const fav = p.favorite && window.FAVORITE_COLOR_MAP
                    ? window.FAVORITE_COLOR_MAP[p.favorite]
                    : null;
                  return (
                    <div
                      key={p.id}
                      onClick={() => togglePromptSlug(p.id)}
                      data-prompt-toggle={p.id}
                      data-selected={isSelected ? "true" : "false"}
                      role="checkbox"
                      aria-checked={isSelected}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === " " || e.key === "Enter") {
                          e.preventDefault();
                          togglePromptSlug(p.id);
                        }
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 10px",
                        cursor: "pointer",
                        background: isSelected ? `${T.amber}14` : "transparent",
                        borderLeft: isSelected
                          ? `2px solid ${T.amber}`
                          : "2px solid transparent",
                        fontFamily: T.sans,
                        fontSize: 12,
                        color: isSelected ? T.fg : T.fg1,
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = T.bg3;
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      {/* Checkbox indicator */}
                      <span
                        aria-hidden="true"
                        style={{
                          width: 14,
                          height: 14,
                          flexShrink: 0,
                          border: `1px solid ${isSelected ? T.amber : T.borderStrong}`,
                          background: isSelected ? T.amber : "transparent",
                          borderRadius: 3,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: T.bg0,
                          fontSize: 10,
                          fontWeight: 700,
                          lineHeight: 1,
                        }}
                      >
                        {isSelected ? "✓" : ""}
                      </span>
                      {/* Favourite color dot (only when the prompt has one
                          set). The dot uses the same colour the prompt
                          library uses for its favourites — keeps visual
                          continuity across screens. */}
                      {fav && (
                        <span
                          aria-hidden="true"
                          title={`Favourite: ${p.favorite}`}
                          style={{
                            width: 7,
                            height: 7,
                            flexShrink: 0,
                            borderRadius: "50%",
                            background: fav.color || fav,
                          }}
                        />
                      )}
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.name || p.id}
                      </span>
                      {/* Lock toggle — only meaningful for pinned rows.
                          A locked pin (filled amber lock) is always
                          attached to new chats in this Space AND its
                          composer chip's × is suppressed at render time.
                          Clicking the lock stops propagation so it
                          doesn't also fire the row's "toggle pinned"
                          handler. */}
                      {isSelected && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setLockedSlugs((cur) => {
                              const next = new Set(cur);
                              if (next.has(p.id)) next.delete(p.id);
                              else next.add(p.id);
                              return next;
                            });
                          }}
                          title={
                            lockedSlugs.has(p.id)
                              ? "Locked — always attached to chats in this Space. Click to unlock."
                              : "Click to lock — the prompt will always be attached, can't be detached per-chat."
                          }
                          data-prompt-lock-toggle={p.id}
                          data-locked={lockedSlugs.has(p.id) ? "true" : "false"}
                          style={{
                            background: "transparent",
                            border: "none",
                            padding: 2,
                            cursor: "pointer",
                            color: lockedSlugs.has(p.id) ? T.amber : T.fg3,
                            display: "flex",
                            alignItems: "center",
                            flexShrink: 0,
                          }}
                          onMouseEnter={(e) => {
                            if (!lockedSlugs.has(p.id))
                              e.currentTarget.style.color = T.fg1;
                          }}
                          onMouseLeave={(e) => {
                            if (!lockedSlugs.has(p.id))
                              e.currentTarget.style.color = T.fg3;
                          }}
                        >
                          <I.Lock size={11} />
                        </button>
                      )}
                    </div>
                  );
                };

                const sectionHeader = (label) => (
                  <div
                    data-prompt-section-header={label}
                    style={{
                      padding: "5px 10px 4px",
                      fontFamily: T.mono,
                      fontSize: 9.5,
                      letterSpacing: 0.4,
                      textTransform: "uppercase",
                      color: T.fg3,
                      background: T.bg3,
                      borderBottom: `1px solid ${T.border}`,
                      position: "sticky",
                      top: 0,
                      zIndex: 1,
                    }}
                  >
                    {label}
                  </div>
                );

                return (
                  <>
                    <input
                      type="text"
                      placeholder="Search prompts…"
                      value={promptSearch}
                      onChange={(e) => setPromptSearch(e.target.value)}
                      data-space-settings-prompts-search
                      style={{
                        ...modalInputStyle,
                        marginBottom: 6,
                        fontFamily: T.sans,
                      }}
                    />
                    <div
                      data-space-settings-prompts-list
                      style={{
                        maxHeight: 280,
                        overflowY: "auto",
                        border: `1px solid ${T.border}`,
                        borderRadius: 4,
                        background: T.bg2,
                      }}
                    >
                      {pinned.length > 0 && sectionHeader(`Pinned (${pinned.length})`)}
                      {pinned.map((p) => renderRow(p, true))}
                      {unpinned.length > 0 && sectionHeader(
                        pinned.length > 0 ? "All prompts" : `All prompts (${unpinned.length})`,
                      )}
                      {unpinned.map((p) => renderRow(p, false))}
                      {pinned.length === 0 && unpinned.length === 0 && (
                        <div
                          data-prompts-no-matches
                          style={{
                            padding: "14px 10px",
                            color: T.fg3,
                            fontSize: 11,
                            fontFamily: T.sans,
                            textAlign: "center",
                          }}
                        >
                          No prompts match "{promptSearch}".
                        </div>
                      )}
                    </div>
                  </>
                );
              })()
            )}

            {/* ── "+ New prompt for this Space" inline affordance ──
                Creates a new prompt in the user's library AND auto-pins
                it (locked) on this Space. Button → form: name + body,
                Save + Cancel. The new prompt also appears in the user's
                regular prompt library — it's not Space-private, just
                created from here for convenience. */}
            {!newPromptForm && (
              <button
                onClick={() => setNewPromptForm({
                  name: `${space.name} framing`,
                  body: "",
                })}
                data-space-new-prompt-open
                style={{
                  marginTop: 8,
                  padding: "5px 10px",
                  background: "transparent",
                  border: `1px dashed ${T.border}`,
                  borderRadius: 4,
                  color: T.fg3,
                  fontFamily: T.mono,
                  fontSize: 10.5,
                  cursor: "pointer",
                  width: "100%",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = T.fg1;
                  e.currentTarget.style.borderColor = T.borderStrong;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = T.fg3;
                  e.currentTarget.style.borderColor = T.border;
                }}
              >
                + New prompt for this Space
              </button>
            )}
            {newPromptForm && (
              <div
                data-space-new-prompt-form
                style={{
                  marginTop: 8,
                  padding: 10,
                  background: T.bg2,
                  border: `1px solid ${T.borderStrong}`,
                  borderRadius: 5,
                }}
              >
                <SectionLabel>Name</SectionLabel>
                <input
                  value={newPromptForm.name}
                  onChange={(e) =>
                    setNewPromptForm((cur) => ({ ...cur, name: e.target.value }))
                  }
                  placeholder="Prompt name"
                  data-space-new-prompt-name
                  style={{ ...modalInputStyle, marginBottom: 8 }}
                />
                <SectionLabel>Body</SectionLabel>
                <textarea
                  value={newPromptForm.body}
                  onChange={(e) =>
                    setNewPromptForm((cur) => ({ ...cur, body: e.target.value }))
                  }
                  placeholder="Prompt body — what the model should see as a system message."
                  data-space-new-prompt-body
                  rows={4}
                  style={{
                    ...modalInputStyle,
                    resize: "vertical",
                    minHeight: 80,
                  }}
                />
                <SectionHint>
                  Creates the prompt in your library and pins it (locked) on this Space.
                </SectionHint>
                <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end", gap: 6 }}>
                  <SmallButton
                    onClick={() => setNewPromptForm(null)}
                    data-space-new-prompt-cancel
                  >
                    Cancel
                  </SmallButton>
                  <SmallButton
                    onClick={async () => {
                      const trimmedName = (newPromptForm.name || "").trim();
                      const trimmedBody = (newPromptForm.body || "").trim();
                      if (!trimmedName || !trimmedBody || newPromptSaving) return;
                      const invoke = window.getInvoke && window.getInvoke();
                      if (!invoke) return;
                      setNewPromptSaving(true);
                      try {
                        // prompts_save derives the slug from the name on
                        // the Rust side, dedupes against the prompts dir,
                        // and returns the resulting prompt row. We use
                        // that row's id (= slug) for the pin so the
                        // settings save's pinned-prompts diff matches it
                        // against the library on disk.
                        const created = await invoke("prompts_save", {
                          // No id = create new (vs. update existing).
                          name: trimmedName,
                          body: trimmedBody,
                          tags: [],
                          favorite: null,
                        });
                        if (created && created.id) {
                          // Local optimistic merge — the picker render
                          // shows it immediately. Parent's library
                          // refresh on modal close brings it in
                          // canonically.
                          setNewlyCreatedPrompts((cur) => [created, ...cur]);
                          setPromptSlugs((cur) =>
                            cur.includes(created.id) ? cur : [...cur, created.id],
                          );
                          setLockedSlugs((cur) => {
                            const next = new Set(cur);
                            next.add(created.id);
                            return next;
                          });
                        }
                        setNewPromptForm(null);
                      } catch (e) {
                        console.error("prompts_save (Space inline) failed:", e);
                        window.ekToast?.({
                          kind: "error",
                          title: "Couldn't create prompt",
                          body: String(e),
                        });
                      } finally {
                        setNewPromptSaving(false);
                      }
                    }}
                    disabled={
                      newPromptSaving
                      || !(newPromptForm.name || "").trim()
                      || !(newPromptForm.body || "").trim()
                    }
                    data-space-new-prompt-save
                  >
                    {newPromptSaving ? "Saving…" : "Save & pin"}
                  </SmallButton>
                </div>
              </div>
            )}
          </div>

          {/* ── 5. Pinned attachments ── */}
          <div>
            <SectionLabel>
              Pinned attachments
              <SectionHint>
                Auto-attached to every new chat in this Space.
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
              <div style={{ color: T.fg3, fontSize: 11, fontFamily: T.mono }}>
                loading…
              </div>
            ) : attachments.length === 0 ? (
              <div style={{ color: T.fg3, fontSize: 11, fontFamily: T.sans }}>
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
                      borderRadius: 4,
                      marginBottom: 4,
                      fontFamily: T.mono,
                      fontSize: 11,
                    }}
                  >
                    <span style={{ color: T.fg3, fontSize: 9, textTransform: "uppercase" }}>
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
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: `1px solid ${T.border}`,
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            onClick={onCancel}
            data-space-settings-cancel
            style={{
              padding: "7px 14px",
              background: "transparent",
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              color: T.fg2,
              fontFamily: T.sans,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            data-space-settings-save
            style={{
              padding: "7px 14px",
              background: name.trim() ? T.amber : T.bg3,
              border: `1px solid ${name.trim() ? T.amber : T.border}`,
              borderRadius: 5,
              color: name.trim() ? T.bg0 : T.fg3,
              fontFamily: T.sans,
              fontSize: 12,
              fontWeight: 600,
              cursor: name.trim() ? "pointer" : "not-allowed",
            }}
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
    <div
      style={{
        fontFamily: T.mono,
        fontSize: 10,
        color: T.fg2,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function SectionHint({ children }) {
  return (
    <div
      style={{
        fontFamily: T.sans,
        fontSize: 11,
        color: T.fg3,
        textTransform: "none",
        letterSpacing: 0,
        marginTop: 2,
        fontWeight: 400,
      }}
    >
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
      style={{
        padding: "5px 10px",
        background: T.bg2,
        border: `1px solid ${T.border}`,
        borderRadius: 4,
        color: disabled ? T.fg3 : danger ? T.red : T.fg1,
        fontFamily: T.sans,
        fontSize: 11,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

const modalInputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 10px",
  background: T.bg2,
  border: `1px solid ${T.border}`,
  borderRadius: 4,
  color: T.fg,
  fontFamily: T.sans,
  fontSize: 12.5,
  outline: "none",
};


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
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: window.spaceColorHex
                    ? window.spaceColorHex(s.color)
                    : (s.color ? T[s.color] || T.fg2 : T.fg2),
                  marginRight: 8,
                  verticalAlign: "middle",
                }}
              />
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
        fontFamily: T.mono,
        fontSize: 9.5,
        textTransform: "uppercase",
        letterSpacing: 0.5,
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
            borderRadius: 5,
            color: T.fg,
            fontFamily: T.mono,
            fontSize: 12,
            marginBottom: 12,
          }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{
              padding: "5px 12px",
              background: "transparent",
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              color: T.fg2,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!trimmed}
            style={{
              padding: "5px 14px",
              background: trimmed ? T.amber : T.bg3,
              border: "none",
              borderRadius: 5,
              color: trimmed ? T.bg0 : T.fg3,
              cursor: trimmed ? "pointer" : "not-allowed",
              fontSize: 12,
              fontWeight: 600,
            }}
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
            style={{
              padding: "5px 12px",
              background: "transparent",
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              color: T.fg2,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {cancelLabel || "Cancel"}
          </button>
          <button
            ref={btnRef}
            onClick={onConfirm}
            data-confirm-button
            style={{
              padding: "5px 14px",
              background: danger ? T.red : T.amber,
              boxShadow: `0 5px 16px -6px ${danger ? T.red : T.amber}66, inset 0 1px 0 rgba(255,255,255,0.25)`,
              border: "none",
              borderRadius: 5,
              color: T.bg0,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
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
          fontFamily: T.mono,
          fontSize: 10,
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
  spaceColor,
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
          color={spaceColor || model?.color || T.fg3}
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
                  fontFamily: T.mono,
                  fontSize: 10,
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

// ─── Right-panel tab switcher ───────────────────────────────
// Header that sits at the top of the right panel and switches between
// the Prompts view and the Watches view. Rendered inside each tab's
// component (passed in as `tabHeader` prop) so the panel never has to
// know what tab it's currently showing — the tab's own component does.
function RightPanelTabs({ tab, onTab, onClose }) {
  const TabButton = ({ id, label }) => {
    const active = tab === id;
    return (
      <button
        onClick={() => onTab(id)}
        style={{
          flex: 1,
          height: "100%",
          background: active ? T.bg2 : "transparent",
          // Bottom border doubles as the "you are here" indicator. The
          // 2px solid amber on the active tab visually replaces the
          // panel's own bottom border line for that one tab cell.
          border: "none",
          borderBottom: active
            ? `2px solid ${T.amber}`
            : "2px solid transparent",
          color: active ? T.fg : T.fg2,
          fontFamily: T.mono,
          fontSize: 11,
          fontWeight: active ? 600 : 500,
          letterSpacing: 0.4,
          textTransform: "capitalize",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.color = T.fg1;
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.color = T.fg2;
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      style={{
        height: 36,
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        gap: 0,
        borderBottom: `1px solid ${T.border}`,
      }}
    >
      <TabButton id="prompts" label="Prompts" />
      <TabButton id="watches" label="Watches" />
      <TabButton id="files" label="Files" />
      <button
        onClick={onClose}
        title="Close panel"
        style={{
          width: 32,
          background: "transparent",
          border: "none",
          borderBottom: "2px solid transparent",
          color: T.fg3,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = T.fg)}
        onMouseLeave={(e) => (e.currentTarget.style.color = T.fg3)}
      >
        <I.X size={12} />
      </button>
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
function StatusLine({ model, backendKind, onProblemClick, warming, indexingAttachments = [] }) {
  const [baseUrl, setBaseUrl] = useState(null);
  const [up, setUp] = useState(true);
  const [present, setPresent] = useState(true);
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
        setPresent(!modelId || ((data && data.models) || []).some((m) => matches(m.name)));
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

  const privacy = privacyStatus(backendKind, baseUrl);
  const indexing = indexingAttachments.length;
  let kind = privacy.kind; // 'local' | 'server'
  let text = privacy.text;
  let color = privacy.kind === "local" ? T.green : T.blue;
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
    text = `${modelName} is not installed`;
  } else if (indexing > 0) {
    kind = "indexing";
    color = T.amber;
    text = indexing === 1 ? "Reading 1 attachment…" : `Reading ${indexing} attachments…`;
  }
  const clickable = kind === "problem" && !!onProblemClick;
  return (
    <button
      type="button"
      data-status-line
      data-status-kind={kind}
      onClick={clickable ? onProblemClick : undefined}
      title={clickable ? "Open setup" : text}
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
      <I.Shield size={14} style={{ color }} />
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
function MoreMenu({ onSettings, onPanel }) {
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
          <MenuItem onClick={run(() => onPanel && onPanel("prompts"))} data-more-panel="prompts">Prompt library</MenuItem>
          <MenuItem onClick={run(() => onPanel && onPanel("watches"))} data-more-panel="watches">Watches</MenuItem>
          <MenuItem onClick={run(() => onPanel && onPanel("files"))} data-more-panel="files">Saved files</MenuItem>
        </div>
      )}
    </div>
  );
}
