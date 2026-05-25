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
        title="Toggle history (⌘\\)"
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
function Sidebar({
  chats,
  activeId,
  onPick,
  onDelete,
  query,
  onQuery,
  onNew,
  onNewPrivate,
  onNewCompare,
  width,
  // Full-text-search hits (from messages_fts MATCH bm25). Empty when no
  // query is active. Owner: App in main.jsx, populated by a debounced
  // invoke to the `search_chats` Rust command.
  messageHits = [],
  onPickHit,
}) {
  const filtered = useMemo(() => {
    if (!query.trim()) return chats;
    const q = query.toLowerCase();
    return chats
      .map((s) => ({
        ...s,
        items: s.items.filter((c) => c.title.toLowerCase().includes(q)),
      }))
      .filter((s) => s.items.length);
  }, [chats, query]);
  const searching = !!query.trim();
  const anyResults =
    filtered.some((s) => s.items.length > 0) || messageHits.length > 0;

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
            ⌘K
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
          <span style={{ color: T.fg3, fontSize: 10 }}>⌘N</span>
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
        {filtered.map((section) => (
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
                  query={query}
                />
              );
            })}
          </div>
        ))}
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
        {!searching && filtered.every((s) => s.items.length === 0) && (
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
              <span style={{ fontFamily: T.mono, color: T.fg2 }}>⌘N</span>{" "}
              or click <span style={{ color: T.fg2 }}>New chat</span> above
              to start one. Saved chats land here.
            </div>
          </div>
        )}
      </div>
    </aside>
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

function ChatRow({ chat, model, active, onClick, onDelete, query }) {
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
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
