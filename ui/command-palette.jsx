'use strict';
// ── Command palette (⌘K) ───────────────────────────────────────────────────
//
// One fuzzy-searchable launcher over app actions, Spaces, themes, and
// recent chats. Opened by ⌘K (App-level keydown, next to the ⌘\ sidebar
// toggle); closed by Esc, backdrop click, or running a command.
//
// Contract is DATA-ONLY for testability: `commands` is an array of
//   { id, label, section, hint?, keywords? }
// and execution goes through `onRun(id)` — App owns the id → handler map
// (buildPaletteCommands in main.jsx) and closes the palette in onRun.
// Nothing here invokes, navigates, or mutates app state directly.
//
// Filtering: paletteFuzzyScore (ui/utils.js — node-tested). Empty query
// keeps the authored section order with section headers; a non-empty
// query flattens to one best-first list (headers off), the standard
// palette idiom.
//
// Keyboard: ↑/↓ move (wrapping), Enter runs the highlighted row, Esc
// closes. The list is mouse-friendly too — hover highlights, click runs.

function CommandPalette({ open, onClose, commands, onRun }) {
  const [query, setQuery] = React.useState("");
  const [sel, setSel] = React.useState(0);
  const inputRef = React.useRef(null);
  const listRef = React.useRef(null);

  // Fresh query + selection every open; focus the input once the panel
  // is actually in the DOM (this render hasn't committed yet inside the
  // effect body, hence the rAF).
  React.useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Score + filter. Keywords extend the haystack so "incognito" can hit
  // "New private chat" without cluttering the visible label.
  const items = React.useMemo(() => {
    const list = Array.isArray(commands) ? commands : [];
    const q = (query || "").trim();
    const scored = [];
    for (const c of list) {
      if (!c || !c.id || !c.label) continue;
      const hay = c.keywords ? `${c.label} ${c.keywords}` : c.label;
      const s = paletteFuzzyScore(q, hay);
      if (s < 0) continue;
      scored.push({ c, s });
    }
    // Stable sort: equal scores keep authored order (Array.prototype.sort
    // is stable per spec since ES2019 / Safari 14+).
    if (q) scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.c);
  }, [commands, query]);

  // Clamp the highlight when the result set changes under it.
  React.useEffect(() => {
    setSel(0);
  }, [query]);
  const selSafe = Math.min(sel, Math.max(0, items.length - 1));

  // Keep the highlighted row visible while arrowing through a long list.
  React.useEffect(() => {
    listRef.current
      ?.querySelector('[data-palette-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selSafe, items]);

  if (!open) return null;

  const run = (c) => {
    if (!c) return;
    onRun && onRun(c.id);
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose && onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length) setSel((s) => (s + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) setSel((s) => (s - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(items[selSafe]);
    }
  };

  const flat = !!(query || "").trim();

  return (
    <div
      data-command-palette
      onMouseDown={(e) => {
        // Backdrop click closes; clicks inside the panel don't bubble
        // here because the panel stops propagation below.
        if (e.target === e.currentTarget) onClose && onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9997,
        background: "rgba(0,0,0,0.42)",
        // Sit above the chat but below Settings (9998) and its confirm
        // modal (9999) — ⌘K under an open Settings would be odd anyway;
        // App's guard effect closes the palette when gates open.
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          left: "50%",
          top: "14%",
          transform: "translateX(-50%)",
          width: "min(620px, 92vw)",
          background: T.bg1,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 14,
          boxShadow: T.shadowPop,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <input
          ref={inputRef}
          data-palette-input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a command or search…"
          spellCheck={false}
          style={{
            padding: "14px 16px",
            fontSize: 14.5,
            fontFamily: T.sans,
            background: "transparent",
            border: "none",
            outline: "none",
            borderBottom: `1px solid ${T.border}`,
            color: T.fg,
            width: "100%",
          }}
        />
        <div
          ref={listRef}
          style={{
            maxHeight: "48vh",
            overflowY: "auto",
            padding: 6,
          }}
        >
          {items.length === 0 && (
            <div
              style={{
                padding: "16px 12px",
                fontFamily: T.mono,
                fontSize: 11.5,
                color: T.fg3,
                fontStyle: "italic",
              }}
            >
              No matches.
            </div>
          )}
          {items.map((c, i) => {
            const selected = i === selSafe;
            // Section header whenever the section changes — only in the
            // browse (empty-query) view, where authored grouping holds.
            const header =
              !flat && (i === 0 || items[i - 1].section !== c.section)
                ? c.section
                : null;
            return (
              <React.Fragment key={c.id}>
                {header && (
                  <div
                    style={{
                      padding: "9px 12px 3px",
                      fontFamily: T.mono,
                      fontSize: 9.5,
                      letterSpacing: 1.2,
                      textTransform: "uppercase",
                      color: T.fg3,
                    }}
                  >
                    {header}
                  </div>
                )}
                <div
                  data-palette-item={c.id}
                  data-palette-selected={selected ? "true" : "false"}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(c)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "8px 12px",
                    borderRadius: 8,
                    cursor: "pointer",
                    fontSize: 13.5,
                    fontFamily: T.sans,
                    color: selected ? T.fg : T.fg1,
                    background: selected ? T.bg3 : "transparent",
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.label}
                  </span>
                  {c.hint && (
                    <span
                      style={{
                        flexShrink: 0,
                        maxWidth: "45%",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontFamily: T.mono,
                        fontSize: 10.5,
                        color: T.fg3,
                      }}
                    >
                      {c.hint}
                    </span>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div
          style={{
            padding: "7px 14px",
            borderTop: `1px solid ${T.border}`,
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 0.4,
            color: T.fg3,
            display: "flex",
            gap: 14,
          }}
        >
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
