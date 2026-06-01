// shell.jsx -- App chrome: TitleBar, Sidebar, ChatRow,
//   MessageHitRow, TabBar, Tab, RightPanelTabs, StatusBar.
// Depends on: tokens, atoms, icons, data (MODELS).

// ─── Title bar ──────────────────────────────────────────────
// Window is configured with titleBarStyle: "Overlay" + hiddenTitle: true —
// macOS draws native traffic lights overlaying our toolbar's top-left. We
// leave an ~88px gutter for them so the Sidebar button has breathing room.
const TRAFFIC_LIGHT_GUTTER = 88;

function TitleBar({
  onToggleSidebar,
  onTogglePrompts,
  onToggleTweaks,
  onToggleWatch,
  onToggleFiles,
  sidebarOpen,
  // The right panel is shared between the Prompts / Watches / Files tabs.
  // We get the open flag + the current tab so each button can render
  // an accurate "active" state.
  rightPanelOpen,
  rightPanelTab,
  model,
}) {
  // Drive dragging from JS instead of relying on data-tauri-drag-region:
  // the attribute-based path was firing inconsistently (likely an interaction
  // between withGlobalTauri injection timing and the cascade). Calling the
  // OS drag API directly removes every variable.
  const onTitleBarMouseDown = async (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, a, input, textarea, select")) return;
    const winApi = getWindowApi();
    const current =
      winApi?.getCurrentWindow?.() ??
      winApi?.getCurrent?.() ??
      winApi?.appWindow ??
      null;
    if (current?.startDragging) {
      try {
        await current.startDragging();
      } catch {}
    }
  };

  // Double-click on the title bar should zoom (matches native macOS behavior).
  const onTitleBarDoubleClick = async (e) => {
    if (e.target.closest("button, a, input, textarea, select")) return;
    const winApi = getWindowApi();
    const current =
      winApi?.getCurrentWindow?.() ??
      winApi?.getCurrent?.() ??
      winApi?.appWindow ??
      null;
    if (current?.toggleMaximize) {
      try {
        await current.toggleMaximize();
      } catch {}
    }
  };

  return (
    <div
      onMouseDown={onTitleBarMouseDown}
      onDoubleClick={onTitleBarDoubleClick}
      style={{
        height: 36,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: TRAFFIC_LIGHT_GUTTER,
        paddingRight: 6,
        borderBottom: `1px solid ${T.border}`,
        background: T.bg1,
      }}
    >
      <IconButton
        icon={I.Sidebar}
        onClick={onToggleSidebar}
        active={sidebarOpen}
        title={`Toggle history (${MOD_GLYPH}\\)`}
      >
        History
      </IconButton>
      <div style={{ flex: 1, alignSelf: "stretch" }} />
      <IconButton
        icon={I.Library}
        onClick={onTogglePrompts}
        active={rightPanelOpen && rightPanelTab === "prompts"}
        title="Prompt library"
      >
        Prompts
      </IconButton>
      <IconButton
        icon={I.Eye}
        onClick={onToggleWatch}
        active={rightPanelOpen && rightPanelTab === "watches"}
        title="Watches — folder→notes pipelines"
      >
        Watch
      </IconButton>
      <IconButton
        icon={I.File || I.Library}
        onClick={onToggleFiles}
        active={rightPanelOpen && rightPanelTab === "files"}
        title="Files saved by this chat"
      >
        Files
      </IconButton>
      <IconButton icon={I.Settings} onClick={onToggleTweaks} title="Settings">
        Settings
      </IconButton>
    </div>
  );
}

// ─── Sidebar ────────────────────────────────────────────────
//
// History layout (top → bottom):
//   • Search box
//   • New chat / private / compare buttons
//   • Groups (user-defined folders), with [+ New group] button below
//   • An "Ungrouped" drop-zone (only while a drag is in progress, and only
//     if at least one group exists — otherwise dragging a chat would have
//     nowhere to go)
//   • Date sections (Today / Yesterday / …) for ungrouped chats
//   • Message-content hits from full-text search (only when searching)
//
// `chats` is the new `{ groups, dateSections }` shape from
// `groupChatsForSidebar` in utils.js. Filtering by the search query is
// done across BOTH lists; empty groups stay visible (so a just-created
// folder doesn't disappear before the user files anything into it).
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
  // Group management. `groups` is the raw [{id, name}, ...] list — the
  // context menu needs every group, not just ones with items in view.
  groups = [],
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveChatToGroup,
  // Full-text-search hits (from messages_fts MATCH bm25). Empty when no
  // query is active. Owner: App in main.jsx, populated by a debounced
  // invoke to the `search_chats` Rust command.
  messageHits = [],
  onPickHit,
}) {
  // ── Search filter ──
  // Apply the query across BOTH groups and dateSections in one pass. Empty
  // groups are filtered out *while searching only* (showing an empty
  // group during a search would imply "no results" with extra noise).
  const filtered = useMemo(() => {
    if (!query.trim()) return chats;
    const q = query.toLowerCase();
    const matches = (c) => c.title.toLowerCase().includes(q);
    return {
      groups: (chats.groups || [])
        .map((g) => ({ ...g, items: g.items.filter(matches) }))
        .filter((g) => g.items.length),
      dateSections: (chats.dateSections || [])
        .map((s) => ({ ...s, items: s.items.filter(matches) }))
        .filter((s) => s.items.length),
    };
  }, [chats, query]);
  const searching = !!query.trim();
  const totalItems =
    (filtered.groups || []).reduce((n, g) => n + g.items.length, 0) +
    (filtered.dateSections || []).reduce((n, s) => n + s.items.length, 0);
  const anyResults = totalItems > 0 || messageHits.length > 0;

  // ── Collapsed-state per group (localStorage-backed) ──
  // Persist across launches so a user's collapsed Research folder stays
  // collapsed after a restart. Keyed by group id; missing key = expanded.
  // We inline the read/write (rather than calling usePersistedState) to
  // avoid the script-load-order trap: this file loads before main.jsx
  // where usePersistedState is defined.
  const COLLAPSE_LS_KEY = "ekorbia.groupCollapsed";
  const [collapsedGroups, setCollapsedGroups] = useState(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_LS_KEY);
      if (raw !== null) return JSON.parse(raw) || {};
    } catch {}
    return {};
  });
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_LS_KEY, JSON.stringify(collapsedGroups));
    } catch {}
  }, [collapsedGroups]);
  const toggleCollapse = (groupId) =>
    setCollapsedGroups((m) => ({ ...m, [groupId]: !m[groupId] }));

  // ── Right-click context menu state ──
  // Single instance at a time — opening a new menu closes any prior.
  // `chat` is the sidebar-item (with id, title, groupId, …); `x`/`y` come
  // from the right-click coords (viewport-relative for `position: fixed`).
  const [rowMenu, setRowMenu] = useState(null);

  // ── Group-name modal state ──
  // `mode` is 'create' or 'rename'. For rename, `group` carries the
  // existing row so the input pre-fills with its current name.
  const [nameModal, setNameModal] = useState(null);
  const openCreateGroupModal = () =>
    setNameModal({ mode: "create", initial: "" });
  const openRenameGroupModal = (group) =>
    setNameModal({ mode: "rename", group, initial: group.name });

  // ── Chat rename + chat delete modal states ──
  // window.prompt() / window.confirm() are blocked in Tauri's WKWebView
  // (return null silently), so all naming + confirming goes through
  // proper modals. `renameChatModal.chat` carries the chat row so the
  // input pre-fills with its current title; `confirmDeleteChat.chat`
  // carries the row so the body copy can name it.
  const [renameChatModal, setRenameChatModal] = useState(null);
  const [confirmDeleteChat, setConfirmDeleteChat] = useState(null);

  // ── Action handlers wired into the row context menu ──
  const handleMenuMove = (groupId) => {
    if (!rowMenu) return;
    const chatId = rowMenu.chat.id;
    setRowMenu(null);
    onMoveChatToGroup && onMoveChatToGroup(chatId, groupId);
  };
  const handleMenuNewGroup = () => {
    if (!rowMenu) return;
    const chatId = rowMenu.chat.id;
    setRowMenu(null);
    // Open the name modal; on save, create the group and move the chat
    // into it as a single user-perceived action.
    setNameModal({
      mode: "create",
      initial: "",
      andMoveChatId: chatId,
    });
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

  // ── Name-modal submit ──
  // Wraps create vs. rename in one place so the modal stays dumb. The
  // create-then-move case (from the "+ New group…" context-menu item)
  // chains the two ops in sequence.
  const handleNameModalSubmit = async (name) => {
    const m = nameModal;
    setNameModal(null);
    if (!m) return;
    if (m.mode === "create") {
      const newId = onCreateGroup ? await onCreateGroup(name) : null;
      if (newId && m.andMoveChatId && onMoveChatToGroup) {
        await onMoveChatToGroup(m.andMoveChatId, newId);
      }
    } else if (m.mode === "rename") {
      onRenameGroup && onRenameGroup(m.group.id, name);
    }
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

  return (
    <aside
      style={{
        width: width || 220,
        flexShrink: 0,
        background: T.bg1,
        borderRight: `1px solid ${T.border}`,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {/* Search box */}
      <div style={{ padding: 8, borderBottom: `1px solid ${T.border}` }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: T.bg2,
            borderRadius: 5,
            padding: "0 8px",
            height: 26,
            border: `1px solid ${T.border}`,
          }}
        >
          <I.Search size={11} style={{ color: T.fg3 }} />
          <input
            placeholder="Search chats…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              color: T.fg,
              fontFamily: T.mono,
              fontSize: 11,
              padding: 0,
            }}
          />
          <span
            style={{
              fontFamily: T.mono,
              fontSize: 9.5,
              color: T.fg3,
              letterSpacing: 0.5,
            }}
          >
            {MOD_GLYPH}K
          </span>
        </div>
      </div>

      {/* New chat + Private chat. The private button is a smaller affordance
          sharing the same row — discoverable but visually subordinate so it
          doesn't compete with the primary action. */}
      <div style={{ margin: 8, display: "flex", gap: 6 }}>
        <button
          onClick={onNew}
          style={{
            flex: 1,
            padding: "6px 10px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: T.bg2,
            border: `1px solid ${T.border}`,
            borderRadius: 5,
            color: T.fg,
            fontFamily: T.mono,
            fontSize: 11.5,
            cursor: "pointer",
          }}
        >
          <I.Plus size={11} />
          <span>New chat</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: T.fg3, fontSize: 10 }}>{MOD_GLYPH}N</span>
        </button>
        {onNewPrivate && (
          <button
            onClick={onNewPrivate}
            title="Private chat — not saved to disk"
            style={{
              padding: "6px 8px",
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: T.bg2,
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              color: T.fg2,
              fontFamily: T.mono,
              fontSize: 11.5,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = T.fg; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = T.fg2; }}
            aria-label="New private chat"
          >
            <I.Lock size={11} />
          </button>
        )}
        {onNewCompare && (
          <button
            onClick={onNewCompare}
            title="Compare 2–3 models on the same prompt"
            style={{
              padding: "6px 8px",
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: T.bg2,
              border: `1px solid ${T.border}`,
              borderRadius: 5,
              color: T.fg2,
              fontFamily: T.mono,
              fontSize: 11.5,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = T.fg; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = T.fg2; }}
            aria-label="New comparison chat"
            data-new-compare
          >
            <I.Columns size={11} />
          </button>
        )}
      </div>

      {/* History scroll */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          minHeight: 0,
          padding: "4px 0 12px",
        }}
      >
        {/* ── Groups (user-defined folders) ── */}
        {(filtered.groups || []).map((g) => (
          <GroupSection
            key={g.id}
            group={g}
            collapsed={!!collapsedGroups[g.id]}
            onToggle={() => toggleCollapse(g.id)}
            onRename={() => openRenameGroupModal(g)}
            onDelete={() => onDeleteGroup && onDeleteGroup(g.id)}
            onDropChat={(chatId) =>
              onMoveChatToGroup && onMoveChatToGroup(chatId, g.id)
            }
            renderChild={(c) => {
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
            }}
          />
        ))}

        {/* [+ New group] — always visible at the bottom of the groups
            stack so the affordance is discoverable on first launch even
            before any groups exist (matches default #3 in the plan). */}
        {!searching && onCreateGroup && (
          <button
            onClick={openCreateGroupModal}
            data-new-group
            style={{
              margin: "2px 8px 10px",
              padding: "5px 10px",
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              border: `1px dashed ${T.border}`,
              borderRadius: 4,
              color: T.fg3,
              fontFamily: T.mono,
              fontSize: 10.5,
              cursor: "pointer",
              width: "calc(100% - 16px)",
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
            <I.Plus size={9} />
            <span>New group</span>
          </button>
        )}

        {/* ── Date sections (ungrouped chats), wrapped in a permanent
            drop target ──
            This wrapper is ALWAYS rendered (even when there are no
            ungrouped chats), so the DOM doesn't shift mid-drag. That
            shift was the root cause of the "can't drag ungrouped → group"
            bug: WebKit cancels an in-flight drag when the source's
            preceding DOM is mutated, and a conditionally-rendered
            ungrouped-drop-zone above the source's date section triggered
            exactly that mutation on drag-start.
            Drops here move the chat to NULL group (unfile). */}
        <UngroupedSectionsDropTarget
          hasGroups={(chats.groups || []).length > 0}
          onDropChat={(chatId) =>
            onMoveChatToGroup && onMoveChatToGroup(chatId, null)
          }
        >
          {(filtered.dateSections || []).map((section) => (
            <div key={section.section} style={{ marginBottom: 6 }}>
              <div
                style={{
                  padding: "8px 14px 4px",
                  fontFamily: T.mono,
                  fontSize: 10,
                  fontWeight: 500,
                  color: T.fg3,
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                }}
              >
                {section.section}
              </div>
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
        </UngroupedSectionsDropTarget>
        {/* Message-content hits (full-text search). Only rendered while a */}
        {/* query is active. Sits below title-matched chats so the user can */}
        {/* see the high-confidence matches (titles) first, then dig into   */}
        {/* deeper content matches.                                         */}
        {searching && messageHits.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div
              style={{
                padding: "8px 14px 4px",
                fontFamily: T.mono,
                fontSize: 10,
                fontWeight: 500,
                color: T.fg3,
                textTransform: "uppercase",
                letterSpacing: 0.6,
              }}
            >
              Messages
            </div>
            {messageHits.map((hit) => (
              <MessageHitRow
                key={hit.msgId}
                hit={hit}
                onClick={() => onPickHit && onPickHit(hit)}
              />
            ))}
          </div>
        )}
        {/* Unified empty-state: only show when BOTH title hits and message */}
        {/* hits are empty AND the user is actually searching.              */}
        {searching && !anyResults && (
          <div
            style={{
              padding: "20px 14px",
              color: T.fg3,
              fontSize: 11,
              fontFamily: T.mono,
              textAlign: "center",
            }}
          >
            No chats match that search.
          </div>
        )}
        {/* No-chats-yet empty state: distinct from search-miss because it
            fires when the user has never created a chat (or has deleted
            them all). Shown only when not searching, so a typo-search on
            a fresh install still gets the search-miss copy above. */}
        {!searching && totalItems === 0 && (
          <div
            style={{
              padding: "24px 16px",
              color: T.fg3,
              fontFamily: T.sans,
              fontSize: 12,
              lineHeight: 1.6,
              textAlign: "center",
            }}
          >
            No conversations yet.
            <div style={{ marginTop: 6, fontSize: 11 }}>
              Hit{" "}
              <span style={{ fontFamily: T.mono, color: T.fg2 }}>{MOD_GLYPH}N</span>{" "}
              or click <span style={{ color: T.fg2 }}>New chat</span> above
              to start one. Saved chats land here.
            </div>
          </div>
        )}
      </div>

      {/* Right-click context menu — appears over everything (z-index 50).
          The fixed positioning is anchored at the click coords; the menu
          handles its own click-outside / Esc dismiss. */}
      {rowMenu && (
        <ChatContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          chat={rowMenu.chat}
          groups={groups}
          onOpen={handleMenuOpen}
          onRename={handleMenuRename}
          onDelete={handleMenuDelete}
          onMove={handleMenuMove}
          onNewGroup={handleMenuNewGroup}
          onClose={() => setRowMenu(null)}
        />
      )}

      {/* Group-name modal — shared for both "create new group" and
          "rename group". Mode-driven so the title + button copy change
          to match. */}
      {nameModal && (
        <NameModal
          title={nameModal.mode === "rename" ? "Rename group" : "New group"}
          confirmLabel={nameModal.mode === "rename" ? "Save" : "Create"}
          initial={nameModal.initial}
          placeholder="Group name"
          onCancel={() => setNameModal(null)}
          onSubmit={handleNameModalSubmit}
        />
      )}

      {/* Chat-rename modal — replaces the Tauri-blocked window.prompt(). */}
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

      {/* Delete-chat confirm — destructive action, requires explicit
          confirmation rather than firing on the bare menu click. */}
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
    </aside>
  );
}

// ─── GroupSection ───────────────────────────────────────────
//
// One collapsible folder header + its child chats. Drops a chat onto the
// header (or anywhere in the body) by listening for `text/x-ekorbia-chat-id`
// in the dataTransfer. Drop-target hover state highlights the header so
// the user can see what they're about to commit to.
//
// Children are rendered via the `renderChild` prop so the Sidebar stays
// the single source of truth for ChatRow wiring (onPick / onDelete /
// onContextMenu / drag handlers). Keeps GroupSection presentation-only.
function GroupSection({
  group,
  collapsed,
  onToggle,
  onRename,
  onDelete,
  onDropChat,
  renderChild,
}) {
  const [dropHover, setDropHover] = useState(false);
  const [headerHover, setHeaderHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef(null);

  // Drop-target plumbing. preventDefault on dragover is required for the
  // drop event to fire at all (HTML5 D&D quirk). We DON'T gate on the
  // dataTransfer.types list here — WebKit historically returned a
  // DOMStringList (no .includes()) and also hides custom MIME types from
  // `types` during dragover for security, so a check would false-negative
  // and the drop would never enable. We accept all drags at dragover time
  // and filter for our custom MIME at drop time instead, where the
  // dataTransfer is fully readable.
  const onDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!dropHover) setDropHover(true);
  };
  const onDragLeave = () => setDropHover(false);
  const onDrop = (e) => {
    setDropHover(false);
    const chatId = e.dataTransfer.getData("text/x-ekorbia-chat-id");
    if (chatId) {
      e.preventDefault();
      onDropChat && onDropChat(chatId);
    }
  };

  return (
    <div
      style={{ marginBottom: 4 }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Folder header — chevron + 📁 + name + (count) + overflow menu */}
      <div
        onMouseEnter={() => setHeaderHover(true)}
        onMouseLeave={() => setHeaderHover(false)}
        style={{
          margin: "0 6px",
          padding: "4px 8px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: dropHover
            ? `${T.amber}33`
            : headerHover
              ? T.bg2
              : "transparent",
          border: dropHover
            ? `1px solid ${T.amber}`
            : "1px solid transparent",
          borderRadius: 4,
          cursor: "pointer",
          fontFamily: T.mono,
          fontSize: 10.5,
          color: T.fg1,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          userSelect: "none",
        }}
        onClick={onToggle}
        data-group-header
        data-group-id={group.id}
      >
        <span style={{ fontSize: 9, color: T.fg2, width: 8, textAlign: "center" }}>
          {collapsed ? "▶" : "▼"}
        </span>
        <span style={{ color: T.fg2 }}>📁</span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {group.name}
        </span>
        <span style={{ color: T.fg3, fontSize: 10 }}>
          {group.items.length}
        </span>
        {/* Overflow menu (rename / delete). Hidden until hover so the
            row stays clean in the resting state. */}
        {headerHover && (
          <button
            ref={menuBtnRef}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            title="Group actions"
            style={{
              width: 14,
              height: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              background: "transparent",
              color: T.fg3,
              cursor: "pointer",
              padding: 0,
              fontSize: 12,
              lineHeight: 1,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = T.fg)}
            onMouseLeave={(e) => (e.currentTarget.style.color = T.fg3)}
          >
            ⋯
          </button>
        )}
      </div>

      {/* Overflow menu pop-out. Positioned absolutely below the button so
          it doesn't shift layout when it appears. */}
      {menuOpen && menuBtnRef.current && (
        <GroupOverflowMenu
          anchor={menuBtnRef.current}
          onRename={() => {
            setMenuOpen(false);
            onRename();
          }}
          onDelete={() => {
            setMenuOpen(false);
            onDelete();
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}

      {/* Folder body — children when expanded. When collapsed, the drop
          target still works (covers the header), so dropping a chat onto
          a collapsed folder files it without expanding. */}
      {!collapsed && (
        <div style={{ paddingTop: 2 }}>
          {group.items.length === 0 ? (
            <div
              style={{
                margin: "2px 14px 4px",
                padding: "4px 0",
                color: T.fg3,
                fontFamily: T.sans,
                fontSize: 11,
                fontStyle: "italic",
              }}
            >
              Empty — drag a chat here
            </div>
          ) : (
            group.items.map((c) => renderChild(c))
          )}
        </div>
      )}
    </div>
  );
}

// ─── GroupOverflowMenu ──────────────────────────────────────
// Small popover anchored under a group's "⋯" button. Two items: Rename
// and Delete. Dismisses via a transparent backdrop (catches outside
// clicks bulletproof) and via Esc.
//
// Backdrop pattern explanation: rather than attach a `mousedown` listener
// to document and check `e.target` containment (which races with React
// re-renders and has subtle ordering bugs vs. menu-item clicks), we
// render a full-viewport transparent div at one z-index below the menu.
// Any click that lands on the backdrop is by definition "outside the
// menu" — backdrop's onClick calls onClose. Clicks on menu items hit
// the menu (which is above the backdrop), so they fire normally and the
// item handler runs.
function GroupOverflowMenu({ anchor, onRename, onDelete, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Anchor positioning: read the button's rect each render so the menu
  // stays glued to it even if the sidebar scrolls.
  const rect = anchor.getBoundingClientRect();
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
        style={{
          position: "fixed",
          top: rect.bottom + 4,
          left: rect.left - 100,
          zIndex: 60,
          background: T.bg2,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 5,
          padding: 4,
          minWidth: 120,
          boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
        }}
      >
        <MenuItem onClick={onRename}>Rename group</MenuItem>
        <MenuItem onClick={onDelete} danger>
          Delete group
        </MenuItem>
      </div>
    </Fragment>
  );
}

// ─── UngroupedSectionsDropTarget ────────────────────────────
//
// Permanent wrapper around the date sections that acts as a drop target
// for "unfile" (move chat to NULL group). Always rendered — never
// conditionally based on drag state. This is load-bearing for drag
// correctness: HTML5 D&D cancels the in-flight drag whenever the
// source's preceding-DOM gets shifted, and an earlier version that
// only mounted a drop zone WHILE dragging triggered exactly that shift
// on drag-start from a date-section chat. The cure is to never mutate
// the DOM around the source on dragstart at all.
//
// Visual: invisible in the resting state (renders as a plain wrapper
// around the existing date sections). When a drag enters during which
// the user is filed-into-a-group → ungroup intent, the wrapper picks up
// a soft amber background to confirm the drop will land. When there
// are zero ungrouped chats but the user has groups and is dragging out
// of one, we surface a small "Drop here to ungroup" hint so the
// affordance is still discoverable.
function UngroupedSectionsDropTarget({ hasGroups, onDropChat, children }) {
  const [hover, setHover] = useState(false);
  // See GroupSection.onDragOver for why we don't gate on dataTransfer
  // types here — WebKit hides custom MIME type names during dragover.
  const onDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!hover) setHover(true);
  };
  const onDragLeave = () => setHover(false);
  const onDrop = (e) => {
    setHover(false);
    const chatId = e.dataTransfer.getData("text/x-ekorbia-chat-id");
    if (chatId) {
      e.preventDefault();
      onDropChat && onDropChat(chatId);
    }
  };
  // React.Children.count is the cheapest "are there any rendered date
  // sections?" check. When there are zero AND the user has groups, we
  // surface a thin hint so the drop affordance stays discoverable —
  // otherwise the wrapper would be completely empty (just whitespace).
  const dateSectionsCount = React.Children.count(children);
  const showEmptyHint = hasGroups && dateSectionsCount === 0;
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-ungrouped-dropzone
      style={{
        margin: "0 6px 8px",
        padding: "2px 0",
        background: hover ? `${T.amber}22` : "transparent",
        border: hover
          ? `1px dashed ${T.amber}`
          : "1px dashed transparent",
        borderRadius: 4,
        minHeight: 24,
        transition: "background-color 120ms",
      }}
    >
      {showEmptyHint && (
        <div
          style={{
            padding: "10px 8px",
            color: hover ? T.fg1 : T.fg3,
            fontFamily: T.mono,
            fontSize: 10.5,
            textAlign: "center",
          }}
        >
          Drop here to ungroup
        </div>
      )}
      {children}
    </div>
  );
}

// ─── ChatContextMenu ────────────────────────────────────────
// Fixed-position menu anchored at the right-click coordinates. Items:
// Open, Rename, divider, Move-to-group list (with current group marked,
// "(none)" entry to unfile, "+ New group…" to create), divider, Delete.
//
// Dismisses on click-outside, Esc, or any menu action. Clicks inside
// the menu must stopPropagation to avoid the document listener closing
// before the item handler runs.
function ChatContextMenu({
  x, y, chat, groups,
  onOpen, onRename, onDelete, onMove, onNewGroup, onClose,
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
          boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
          fontFamily: T.sans,
          fontSize: 12,
        }}
      >
      <MenuItem onClick={onOpen}>Open</MenuItem>
      <MenuItem onClick={onRename}>Rename…</MenuItem>
      <MenuDivider />
      <MenuLabel>Move to group</MenuLabel>
      <MenuItem
        onClick={() => onMove(null)}
        selected={!chat.groupId}
        indent
      >
        (none)
      </MenuItem>
      {(groups || []).map((g) => (
        <MenuItem
          key={g.id}
          onClick={() => onMove(g.id)}
          selected={chat.groupId === g.id}
          indent
        >
          {g.name}
        </MenuItem>
      ))}
      <MenuItem onClick={onNewGroup} indent>
        <span style={{ color: T.fg2 }}>+ New group…</span>
      </MenuItem>
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
function MenuItem({ children, onClick, selected, danger, indent }) {
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
      style={{
        padding: indent ? "4px 8px 4px 24px" : "4px 8px",
        borderRadius: 3,
        cursor: "pointer",
        color: danger
          ? hover
            ? T.red || "#d87e7e"
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
          background: T.bg1,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 8,
          fontFamily: T.sans,
          color: T.fg,
          boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
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
          background: T.bg1,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 8,
          fontFamily: T.sans,
          color: T.fg,
          boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
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
              background: danger ? (T.red || "#d87e7e") : T.amber,
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
            background: "rgba(212,138,80,0.25)",
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
        padding: "5px 8px",
        background: active ? T.bg4 : hover ? T.bg3 : "transparent",
        borderRadius: 4,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
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
      <ModelDot color={model?.color || T.fg3} size={6} glow={false} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
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
        <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.fg3 }}>
          {chat.when}
        </span>
      )}
    </div>
  );
}

// ─── Tab Bar ────────────────────────────────────────────────
function TabBar({ tabs, activeId, onSelect, onClose, onNew, attachmentCounts = {} }) {
  const scrollerRef = useRef(null);

  // Auto-scroll active tab into view
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const idx = tabs.findIndex((t) => t.id === activeId);
    if (idx < 0) return;
    const tabEl = el.children[idx];
    if (tabEl && tabEl.scrollIntoView) {
      const tabRect = tabEl.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      if (tabRect.left < elRect.left) {
        el.scrollLeft += tabRect.left - elRect.left - 8;
      } else if (tabRect.right > elRect.right) {
        el.scrollLeft += tabRect.right - elRect.right + 8;
      }
    }
  }, [activeId, tabs.length]);

  const navTab = (delta) => {
    const idx = tabs.findIndex((t) => t.id === activeId);
    if (idx < 0) return;
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    if (next) onSelect(next.id);
  };

  const arrowBtn = (icon, click, title) => (
    <button
      onClick={click}
      title={title}
      style={{
        width: 28,
        border: "none",
        background: "transparent",
        color: T.fg2,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRight: `1px solid ${T.border}`,
        flexShrink: 0,
      }}
    >
      {icon}
    </button>
  );

  return (
    <div
      style={{
        height: 32,
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        borderBottom: `1px solid ${T.border}`,
        background: T.bg1,
        overflow: "hidden",
      }}
    >
      {arrowBtn(<I.ChevronL size={13} />, () => navTab(-1), "Previous tab")}
      {arrowBtn(<I.ChevronR size={13} />, () => navTab(1), "Next tab")}
      <div
        ref={scrollerRef}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "stretch",
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none",
        }}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const model = MODELS_BY_ID[tab.model];
          return (
            <Tab
              key={tab.id}
              tab={tab}
              active={active}
              model={model}
              attachmentCount={attachmentCounts[tab.id] || 0}
              onSelect={() => onSelect(tab.id)}
              onClose={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            />
          );
        })}
      </div>
      <button
        onClick={onNew}
        title="New tab"
        style={{
          width: 32,
          border: "none",
          background: "transparent",
          color: T.fg2,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderLeft: `1px solid ${T.border}`,
          flexShrink: 0,
        }}
      >
        <I.Plus size={12} />
      </button>
    </div>
  );
}

function Tab({ tab, active, model, attachmentCount = 0, onSelect, onClose }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 10px 0 12px",
        maxWidth: 220,
        minWidth: 120,
        background: active ? T.bg0 : "transparent",
        borderRight: `1px solid ${T.border}`,
        cursor: "pointer",
      }}
    >
      {active && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            // Ephemeral tabs get a distinct accent on the active-tab
            // top bar (cool slate instead of amber) so the user can see
            // at a glance which tab is the private one.
            background: tab.ephemeral ? "#7aa6b8" : T.amber,
          }}
        />
      )}
      {tab.ephemeral ? (
        // Replace the model dot with a lock for private chats. Keeps the
        // tab the same width / layout while making the privacy state
        // visible without hovering. Tooltip lets you double-check.
        <span title="Private chat — not saved" style={{ display: "inline-flex", color: "#7aa6b8" }}>
          <I.Lock size={11} />
        </span>
      ) : (
        <ModelDot color={model?.color || T.fg3} size={6} glow={false} />
      )}
      <span
        style={{
          flex: 1,
          fontFamily: T.sans,
          fontSize: 11.5,
          color: active ? T.fg : T.fg2,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          fontStyle: tab.ephemeral ? "italic" : "normal",
        }}
      >
        {tab.title}
      </span>
      {attachmentCount > 0 && (
        // Small paperclip + count indicator next to the title — fades on
        // inactive tabs so it doesn't clutter, brightens on hover/active.
        // Useful when you've got context attached to a tab you're not
        // currently looking at.
        <span
          title={`${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            color: active || hover ? T.amber : T.fg3,
            fontFamily: T.mono,
            fontSize: 9.5,
            flexShrink: 0,
          }}
        >
          <I.Attach size={10} />
          {attachmentCount}
        </span>
      )}
      <button
        onClick={onClose}
        style={{
          width: 16,
          height: 16,
          border: "none",
          borderRadius: 3,
          background: hover ? T.bg3 : "transparent",
          color: T.fg2,
          cursor: "pointer",
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: hover || active ? 1 : 0,
        }}
      >
        <I.X size={9} />
      </button>
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
function StatusBar({ model, onOllamaClick, warming, indexingAttachments = [] }) {
  const [ollamaUp, setOllamaUp] = useState(false);
  const [pulled, setPulled] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const matchesModel = (n) =>
      n === model.id || n.startsWith(model.id.split(":")[0]);
    const check = async () => {
      try {
        const tagsResp = await fetch("http://localhost:11434/api/tags", {
          signal: AbortSignal.timeout(2000),
        });
        if (cancelled) return;
        if (!tagsResp.ok) {
          setOllamaUp(false);
          setPulled(false);
          setLoaded(false);
          return;
        }
        setOllamaUp(true);
        const tagsData = await tagsResp.json();
        setPulled((tagsData.models || []).some((m) => matchesModel(m.name)));

        // /api/ps is the only honest source for "loaded into memory".
        const psResp = await fetch("http://localhost:11434/api/ps", {
          signal: AbortSignal.timeout(2000),
        });
        if (cancelled) return;
        if (psResp.ok) {
          const psData = await psResp.json();
          setLoaded((psData.models || []).some((m) => matchesModel(m.name)));
        } else {
          setLoaded(false);
        }
      } catch {
        if (!cancelled) {
          setOllamaUp(false);
          setPulled(false);
          setLoaded(false);
        }
      }
    };
    check();
    // Poll fast while warming so the loaded transition shows up promptly;
    // otherwise the user could click Send before we've noticed the model is hot.
    const iv = setInterval(check, warming ? 1000 : 5000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [model.id, warming]);

  let dotColor, label, dim;
  if (!ollamaUp) {
    dotColor = T.fg3;
    label = "ollama not running";
    dim = true;
  } else if (!pulled) {
    dotColor = T.amber;
    label = `${model.name} not pulled`;
    dim = true;
  } else if (warming) {
    // `warming` MUST be checked before `loaded`: /api/ps flips to loaded
    // the moment weights are resident, but our warmup is still running a
    // real one-token generation to compile kernels and allocate the KV
    // cache. Showing "loaded" before warmup completes would mislead the
    // user into clicking Send and eating the cold-kernel penalty anyway.
    dotColor = T.amber;
    label = `${model.name} loading…`;
    dim = false;
  } else if (loaded) {
    dotColor = T.green;
    label = `${model.name} loaded`;
    dim = false;
  } else {
    dotColor = T.amber;
    label = `${model.name} cold`;
    dim = true;
  }

  return (
    <div
      style={{
        height: 28,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 14px",
        background: T.bg1,
        borderTop: `1px solid ${T.border}`,
        fontFamily: T.mono,
        fontSize: 12,
        color: T.fg2,
      }}
    >
      <span
        onClick={!ollamaUp ? onOllamaClick : undefined}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          cursor: ollamaUp ? "default" : "pointer",
        }}
      >
        <ModelDot color={dotColor} size={6} glow={false} />
        ollama
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          color: dim ? T.fg3 : T.fg2,
        }}
      >
        <I.Cpu size={10} /> {label}
      </span>
      {indexingAttachments.length > 0 && (
        // Aggregated indexing line across ALL chats. When one folder is
        // indexing we show its name + progress; with multiple, we collapse
        // to a count so the bar doesn't overflow on a slow run with several
        // queued. The animated dot mirrors the Composer chip's indicator.
        (() => {
          const first = indexingAttachments[0];
          const more = indexingAttachments.length - 1;
          const isFolder = first.kind === "folder";
          // Match the chip's label progression: "walking…" while the
          // walker is still enumerating, then "N/M" once embedding starts.
          const progress = isFolder
            ? (first.phase === "walking" || typeof first.progressTotal !== "number"
                ? " — walking…"
                : ` — ${first.fileCount ?? 0}/${first.progressTotal}`)
            : "";
          const label =
            indexingAttachments.length === 1
              ? `Indexing ${first.label}${progress}`
              : `Indexing ${first.label}${progress} (+${more} more)`;
          return (
            <span
              title={indexingAttachments.map((a) => a.label).join("\n")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                color: T.amber,
              }}
            >
              <span
                className="typing-dot"
                style={{ color: T.amber, fontSize: 9 }}
              >
                ●
              </span>
              {label}
            </span>
          );
        })()
      )}
    </div>
  );
}
