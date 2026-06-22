// chat.jsx -- ChatPane, message rendering helpers, SourcesFooter,
//   Message, StreamingIndicator, Composer.
// Depends on: tokens, atoms, icons, data (FAVORITE_COLORS),
//             overlays.jsx (ModelPicker, modelColor).

// ─── Fenced-block parser (heuristic file-save fallback) ─────
//
// For models that don't actually use the write_file tool (or for users who
// just want to save snippets out of any chat), we scan assistant messages
// for ```lang ... ``` blocks and offer Save buttons via window.ekSaveModelFile.
//
// The pure helpers (parseFencedBlocks, inferFilename, uniquifyFilename) +
// their lookup tables (LANG_DEFAULT_NAME, FILENAME_HINT_PATTERNS) live in
// `ui/utils.js` so they can be unit-tested under node:test. They're on
// `window` by the time this file's components render, so the bare-name
// references below resolve normally.

// Single row inside the chat-header export dropdown. Defined at module
// scope (not inside ChatPane) so its identity is stable across renders —
// per CLAUDE.md, components-inside-render-functions cause focus loss /
// re-mount churn. Trivial styling so the menu reads as a quiet OS list.
function ExportMenuItem({ label, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "6px 10px",
        background: hover ? T.bg3 : "transparent",
        border: "none",
        borderRadius: 4,
        color: T.fg,
        fontFamily: T.sans,
        fontSize: 12.5,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

// ─── Chat Pane ──────────────────────────────────────────────
function ChatPane({ chat, model, onSendDemo, onRename, isStreaming, searchQuery, onEditMessage, onRetryMessage, space }) {
  const scrollerRef = useRef(null);
  const lastContent = chat.messages[chat.messages.length - 1]?.content;
  useEffect(() => {
    if (scrollerRef.current)
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [chat.messages.length, isStreaming, lastContent]);

  // ── Export menu state (Phase 1b) ──────────────────────────────────────────
  // Kebab button at the right of the chat title opens a small dropdown
  // with "Export as Markdown" / "Export as JSON". The dropdown closes on:
  //   • Selecting an item
  //   • Clicking outside the menu
  //   • Pressing Escape
  // We track the open state locally; nothing needs to persist across
  // chat switches (the dropdown is transient).
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef(null);
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDocClick = (e) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setExportMenuOpen(false);
      }
    };
    const onKey = (e) => { if (e.key === 'Escape') setExportMenuOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [exportMenuOpen]);

  // Build a sensible default filename from the chat title — lowercased,
  // non-word chars to hyphens, trimmed. Empty title → "chat". The dialog
  // plugin appends the right extension based on the active filter when the
  // user doesn't type one, but we still suggest the full name so the
  // typical "press Save" path produces a tidy result.
  const slugifyTitle = (title) => {
    const slug = String(title || '')
      .toLowerCase()
      .replace(/[^\w]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return slug || 'chat';
  };

  const handleExport = async (format) => {
    setExportMenuOpen(false);
    const dialogApi = getDialogApi();
    const tauriInvoke = getInvoke();
    if (!dialogApi || !tauriInvoke) {
      window.ekToast?.({
        kind: 'error',
        title: 'Export failed',
        body: 'Tauri APIs not available.',
      });
      return;
    }
    const slug = slugifyTitle(chat.title);
    const ext = format === 'json' ? 'json' : 'md';
    const defaultPath = `${slug}.${ext}`;
    let path;
    try {
      path = await dialogApi.save({
        title: `Export chat as ${format === 'json' ? 'JSON' : 'Markdown'}`,
        defaultPath,
        filters: format === 'json'
          ? [{ name: 'JSON', extensions: ['json'] }]
          : [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      });
    } catch (e) {
      console.error('Save dialog failed:', e);
      return;
    }
    if (!path) return; // user cancelled — no toast, that's not an error
    try {
      await tauriInvoke('chat_export_to_path', {
        chatId: chat.id,
        format,
        path,
      });
      window.ekToast?.({
        kind: 'success',
        title: 'Chat exported',
        body: path,
      });
    } catch (e) {
      console.error('Export failed:', e);
      window.ekToast?.({
        kind: 'error',
        title: 'Export failed',
        body: String(e),
      });
    }
  };

  // ── Inline title editing ──────────────────────────────────────────────────
  // The H1 below swaps to an <input> on click; Enter or blur commits, Escape
  // cancels. Draft state is local so typing doesn't churn parent state on
  // every keystroke. The reset effect re-syncs the draft when chat.title
  // changes externally (e.g. handleSend auto-titling from the first user
  // message), so an in-flight edit isn't silently overwritten on Enter.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(chat.title);
  const titleInputRef = useRef(null);
  // Shared hover state for the title + pencil group so they brighten
  // together — the icon is the static affordance ("this is editable")
  // and the bg tint is the dynamic hint ("click here to start").
  const [titleHover, setTitleHover] = useState(false);
  useEffect(() => {
    if (!editingTitle) setTitleDraft(chat.title);
  }, [chat.title, editingTitle]);
  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  const commitTitle = () => {
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!next) {
      setTitleDraft(chat.title);
      return;
    }
    if (next !== chat.title && onRename) onRename(chat.id, next);
  };
  const cancelTitle = () => {
    setTitleDraft(chat.title);
    setEditingTitle(false);
  };

  // Compile the sidebar search query into a highlight regex once per query
  // change. Memoized so every Message in a long chat shares the same regex
  // instance — without this, each render would rebuild it and pessimise
  // matchAll loops. Returns null when the query is empty, which signals the
  // Message component to skip the highlight pass and render raw text.
  const highlightRegex = useMemo(
    () => buildHighlightRegex((searchQuery || "").trim()),
    [searchQuery],
  );

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: T.bg0,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "14px 16px 6px",
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 4,
          }}
        >
          {/* Space badge — small color dot + name, renders only when the
              chat lives inside a Space. Reads as "this chat is part of
              {space} workspace" alongside the title. Resolved at the
              parent (main.jsx) so ChatPane stays presentation-only and
              the spaces array doesn't need to plumb through here. */}
          {space && (
            <div
              data-chat-space-badge
              data-space-id={space.id}
              title={`Space: ${space.name}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "2px 8px 2px 6px",
                background: T.bg2,
                border: `1px solid ${T.border}`,
                borderRadius: 999,
                fontFamily: T.mono,
                fontSize: 10.5,
                color: T.fg1,
                flexShrink: 0,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: window.spaceColorHex
                    ? window.spaceColorHex(space.color)
                    : space.color
                      ? T[space.color] || T.fg2
                      : T.fg2,
                  flexShrink: 0,
                }}
              />
              {space.name}
            </div>
          )}
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTitle();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelTitle();
                }
              }}
              onBlur={commitTitle}
              maxLength={120}
              // Style mirrors the H1 it replaces so the swap is invisible
              // except for the focus ring + caret. Padding/border kept tiny
              // so the row height doesn't shift.
              style={{
                margin: 0,
                padding: "1px 4px",
                fontFamily: T.sans,
                fontSize: 15,
                fontWeight: 600,
                color: T.fg,
                letterSpacing: -0.1,
                background: T.bg2,
                border: `1px solid ${T.borderStrong}`,
                borderRadius: 4,
                outline: "none",
                minWidth: 200,
              }}
            />
          ) : (
            // H1 + pencil are wrapped in a flex group so they share a
            // hover state — clicking either opens the editor. The pencil
            // is the static "this is editable" affordance (visible at
            // rest); the bg tint is the dynamic "click here" hint
            // (visible on hover). Together they replace the old
            // hidden-tooltip-only affordance with something discoverable.
            <div
              onClick={() => onRename && setEditingTitle(true)}
              onMouseEnter={() => onRename && setTitleHover(true)}
              onMouseLeave={() => setTitleHover(false)}
              title={onRename ? "Click to rename" : undefined}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "1px 4px",
                borderRadius: 4,
                cursor: onRename ? "text" : "default",
                background: onRename && titleHover ? T.bg2 : "transparent",
                transition: "background 0.12s",
              }}
            >
              <h1
                style={{
                  margin: 0,
                  padding: 0,
                  fontFamily: T.sans,
                  fontSize: 15,
                  fontWeight: 600,
                  color: T.fg,
                  letterSpacing: -0.1,
                }}
              >
                {chat.title}
              </h1>
              {onRename && (
                <I.Edit
                  size={11}
                  style={{
                    color: titleHover ? T.fg1 : T.fg3,
                    transition: "color 0.12s",
                    flexShrink: 0,
                  }}
                />
              )}
            </div>
          )}
          {/* Spacer pushes the export menu to the far right of the header. */}
          <div style={{ flex: 1 }} />
          {/* Export menu — kebab button + transient dropdown. Hidden when
              the chat has no messages (nothing to export) and for ephemeral
              chats (their content never reached the DB; export reads from
              there). The user can still copy individual replies via the
              code-block copy buttons. */}
          {chat.messages && chat.messages.length > 0 && !chat.ephemeral && (
            <div ref={exportMenuRef} style={{ position: "relative" }}>
              <button
                onClick={() => setExportMenuOpen((v) => !v)}
                title="Export chat"
                aria-label="Export chat"
                aria-expanded={exportMenuOpen}
                style={{
                  width: 26,
                  height: 24,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: exportMenuOpen ? T.bg2 : "transparent",
                  border: "none",
                  borderRadius: 4,
                  color: T.fg2,
                  cursor: "pointer",
                  padding: 0,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = T.bg2;
                  e.currentTarget.style.color = T.fg;
                }}
                onMouseLeave={(e) => {
                  if (!exportMenuOpen) {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = T.fg2;
                  }
                }}
              >
                <I.MoreHoriz size={14} />
              </button>
              {exportMenuOpen && (
                // Dropdown positioned below the kebab, right-aligned so it
                // doesn't overflow the chat pane on narrow widths. Stays
                // above message content via z-index.
                <div
                  role="menu"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    right: 0,
                    minWidth: 180,
                    background: T.bg2,
                    border: `1px solid ${T.border}`,
                    borderRadius: 6,
                    boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
                    padding: 4,
                    zIndex: 10,
                  }}
                >
                  <ExportMenuItem
                    label="Export as Markdown"
                    onClick={() => handleExport('markdown')}
                  />
                  <ExportMenuItem
                    label="Export as JSON"
                    onClick={() => handleExport('json')}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Private-chat banner (Phase 4b). Slim, persistent, runs under the
          header for the lifetime of the tab so the user always knows the
          chat won't be saved. Cool slate accent matches the lock icon
          on the tab + sidebar button. */}
      {chat.ephemeral && (
        <div
          style={{
            padding: "6px 16px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "rgba(122, 166, 184, 0.08)",
            borderBottom: `1px solid rgba(122, 166, 184, 0.25)`,
            fontFamily: T.mono,
            fontSize: 10.5,
            color: "#9fb9c5",
          }}
        >
          <I.Lock size={11} />
          <span>
            Private chat — nothing here is saved. Close this tab and it's
            gone. Attachments and chat export are disabled in private mode.
          </span>
        </div>
      )}
      {/* Messages */}
      <div
        ref={scrollerRef}
        style={{
          flex: 1,
          overflowY: "auto",
          minHeight: 0,
          padding: "20px 0",
        }}
      >
        <div style={{ maxWidth: "100%", margin: "0", padding: "0 16px" }}>
          {/* Empty-chat hint: surfaces only when there are no messages
              yet, so newly-opened chats (including the welcome tab) feel
              less like a blank-page-staring-back-at-you. We deliberately
              keep this understated — a small centered card, not a
              full-page splash — so it disappears the moment the user
              starts typing without ever needing to be dismissed. */}
          {chat.messages.length === 0 && !isStreaming && (
            <div
              style={{
                margin: "60px auto",
                maxWidth: 460,
                padding: "20px 24px",
                textAlign: "center",
                color: T.fg3,
                fontFamily: T.sans,
                fontSize: 13,
                lineHeight: 1.7,
              }}
            >
              <div
                style={{
                  color: T.fg,
                  fontSize: 16,
                  fontWeight: 500,
                  marginBottom: 8,
                }}
              >
                Start a conversation.
              </div>
              <div style={{ marginBottom: 14 }}>
                Type below to chat with{" "}
                <span style={{ color: T.fg2, fontFamily: T.mono, fontSize: 12 }}>
                  {model?.name || model?.id || "the selected model"}
                </span>
                .
              </div>
              <div
                style={{
                  display: "grid",
                  gap: 6,
                  fontSize: 11.5,
                  color: T.fg3,
                  textAlign: "left",
                  fontFamily: T.mono,
                  background: T.bg1,
                  border: `1px solid ${T.border}`,
                  borderRadius: 6,
                  padding: "10px 14px",
                }}
              >
                {/* Quick-query hint: macOS + Windows only — the overlay
                    isn't wired up on Linux yet (Phase L2). */}
                {!IS_LINUX && (
                  <div>
                    <span style={{ color: T.amber }}>
                      {formatHotkey("Super+Shift+Space")}
                    </span>{" "}
                    <span style={{ color: T.fg2 }}>— quick-query overlay from anywhere</span>
                  </div>
                )}
                <div>
                  <span style={{ color: T.amber }}>Paperclip</span>{" "}
                  <span style={{ color: T.fg2 }}>— attach files or a folder for context</span>
                </div>
                <div>
                  <span style={{ color: T.amber }}>Prompts panel</span>{" "}
                  <span style={{ color: T.fg2 }}>— pin a saved system prompt to this chat</span>
                </div>
              </div>
            </div>
          )}
          {chat.messages.map((m, i) => {
            // isLastAssistant gates the Retry button — only the last
            // assistant message gets a Retry chip, because retrying an
            // older one would also have to truncate everything after it,
            // which is the edit-and-resubmit flow on the prior user
            // turn instead.
            const isLastAssistant =
              m.role === 'assistant' && i === chat.messages.length - 1;
            return (
              <Message
                key={i}
                m={m}
                highlightRegex={highlightRegex}
                chatId={chat.id}
                isStreaming={isStreaming}
                onEditMessage={onEditMessage}
                onRetryMessage={isLastAssistant ? onRetryMessage : null}
              />
            );
          })}
          {isStreaming &&
            chat.messages[chat.messages.length - 1]?.role !== "assistant" && (
              <StreamingIndicator />
            )}
        </div>
      </div>
    </div>
  );
}

// Build a RegExp that mirrors the Rust-side FTS sanitisation: strip
// non-alphanumeric characters, split into tokens, match each as a prefix
// (so "lock" matches "locked"). Returns null if no usable tokens remain —
// callers should short-circuit to plain text rendering in that case.
//
// The regex is anchored on word characters (\w+) rather than on each token
// individually so we can capture whole words that START WITH any of the
// tokens. That preserves natural word boundaries: searching "code" tints
// "code" and "coder" but not the "code" inside "decoder". Matches FTS5's
// "*" prefix-search semantics, which is what produced the hit in the
// first place — keeps the in-chat highlights consistent with the sidebar.
function buildHighlightRegex(query) {
  if (!query) return null;
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  // Escape any regex metachars (defensive — tokens are alphanumeric after
  // the strip, but if the predicate changes upstream this stays safe).
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b(?:tok1|tok2)\w* — match a word that begins with one of the tokens.
  const alt = tokens.map(escape).join("|");
  return new RegExp(`\\b(?:${alt})\\w*`, "gi");
}

// Render text with optional highlight markup. When `regex` is null, returns
// the raw string (cheapest path — React renders strings directly). Otherwise
// splits the text by regex matches and wraps each match in <mark>. We use
// matchAll to get capture indices so the surrounding literal slices can be
// emitted verbatim — no double-tokenisation, preserves whitespace exactly.
function renderHighlighted(text, regex) {
  if (!regex || !text) return text;
  const parts = [];
  let lastIdx = 0;
  let key = 0;
  for (const match of text.matchAll(regex)) {
    if (match.index > lastIdx) {
      parts.push(
        <Fragment key={`l${key++}`}>{text.slice(lastIdx, match.index)}</Fragment>,
      );
    }
    parts.push(
      <mark
        key={`m${key++}`}
        style={{ background: T.amber + "40", color: T.fg, padding: 0, borderRadius: 2 }}
      >
        {match[0]}
      </mark>,
    );
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(<Fragment key={`l${key++}`}>{text.slice(lastIdx)}</Fragment>);
  }
  return parts.length ? parts : text;
}

// Compose highlight rendering with citation-marker styling. When `sources`
// is non-empty, [N] tokens in the text that match a valid citation index
// are wrapped in a small amber chip — gives the user a visual cue that the
// model is citing one of the attached files. When the regex is non-null,
// highlight matches are also wrapped (in a separate pass on each text
// segment between citations).
//
// Run order matters: split on citations first (cheap, unambiguous), then
// apply the highlight regex to the LITERAL TEXT segments. A citation chip
// never contains highlightable content (we don't want `[1]` to be lit up
// when the user searches for "1").
function renderMessageContent(text, regex, sources) {
  if (!text) return text;
  if (!sources || sources.length === 0) return renderHighlighted(text, regex);
  const validIndices = new Set(sources.map((s) => s.citationIndex));
  const citePattern = /\[(\d+)\]/g;
  const parts = [];
  let lastIdx = 0;
  let key = 0;
  for (const match of text.matchAll(citePattern)) {
    const idx = parseInt(match[1], 10);
    if (!validIndices.has(idx)) continue; // [42] when only 3 sources — leave verbatim
    if (match.index > lastIdx) {
      parts.push(
        <Fragment key={`l${key++}`}>
          {renderHighlighted(text.slice(lastIdx, match.index), regex)}
        </Fragment>,
      );
    }
    parts.push(
      <sup
        key={`c${key++}`}
        title={sources.find((s) => s.citationIndex === idx)?.path || ""}
        style={{
          display: "inline-block",
          padding: "0 4px",
          margin: "0 1px",
          borderRadius: 4,
          background: T.amber + "22",
          color: T.amber,
          fontFamily: T.mono,
          fontSize: 9,
          fontWeight: 700,
          verticalAlign: "super",
          lineHeight: 1.3,
        }}
      >
        {idx}
      </sup>,
    );
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(
      <Fragment key={`l${key++}`}>
        {renderHighlighted(text.slice(lastIdx), regex)}
      </Fragment>,
    );
  }
  return parts.length ? parts : renderHighlighted(text, regex);
}

// Sources footer for assistant messages that drew on attachments. Each chip
// is clickable and opens the source path in Finder via the shell plugin.
// The footer always renders when there are sources, even if the model
// didn't emit any [N] markers — gives the user provenance regardless of how
// well the model cooperated with the citation prompt.
//
// For attachments with retrieved chunks, clicking expands the chip into a
// list of the actual files that contributed — for folders, this surfaces
// which sub-files matched; for large single files, just the relevance
// score. Each row in the expanded list is independently clickable.
function SourcesFooter({ sources, imagesSkipped }) {
  if ((!sources || sources.length === 0) && !imagesSkipped) return null;
  const tauriInvoke = getInvoke();
  const [expanded, setExpanded] = useState({});
  // Native opener via Tauri, NOT `tauri-plugin-shell.open`. The shell
  // plugin's default capability scope only allows mailto/tel/http URLs
  // and silently rejects bare filesystem paths (see CLAUDE.md gotcha
  // and files/commands.rs for the same pattern on chat_files).
  //
  // Two routes:
  //   • An attachment chip itself → attachment_reveal(attachmentId, reveal=true)
  //     resolves the path from the DB so a fabricated id can't reveal an
  //     arbitrary location.
  //   • A folder attachment's sub-file hit → attachment_hit_open(
  //     attachmentId, subPath, reveal=true) re-validates the sub-path
  //     via sandbox::resolve_within (rejects `..`, absolute, NUL,
  //     symlink-escapes).
  const revealAttachment = async (attachmentId) => {
    if (!tauriInvoke || !attachmentId) return;
    try {
      await tauriInvoke('attachment_reveal', { attachmentId, reveal: true });
    } catch (e) {
      console.error('attachment_reveal failed:', e);
      window.ekToast?.({
        kind: 'warn',
        title: 'Could not reveal source',
        body: String(e),
      });
    }
  };
  const revealHit = async (attachmentId, subPath) => {
    if (!tauriInvoke || !attachmentId || !subPath) return;
    try {
      await tauriInvoke('attachment_hit_open', {
        attachmentId,
        subPath,
        reveal: true,
      });
    } catch (e) {
      console.error('attachment_hit_open failed:', e);
      window.ekToast?.({
        kind: 'warn',
        title: 'Could not open file',
        body: String(e),
      });
    }
  };
  return (
    <div
      style={{
        marginTop: 6,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        <span
          style={{
            fontFamily: T.mono,
            fontSize: 10,
            color: T.fg3,
            marginRight: 4,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          Sources
        </span>
        {(sources || []).map((s) => {
          const isFolder = s.kind === "folder";
          const hasHits = (s.hits?.length || 0) > 0;
          const isExpanded = !!expanded[s.id];
          const isExpandable = isFolder || hasHits;
          // Folder chips primarily expand to show sub-files; single-file
          // chips open the file directly. Shift-click reveals the path
          // regardless — handy for "where is this on disk".
          const onChipClick = (e) => {
            if (e.shiftKey) {
              revealAttachment(s.id);
              return;
            }
            if (isExpandable) {
              setExpanded((m) => ({ ...m, [s.id]: !m[s.id] }));
            } else {
              revealAttachment(s.id);
            }
          };
          const hitsLabel = hasHits
            ? ` · ${s.hits.length} match${s.hits.length === 1 ? "" : "es"}`
            : "";
          return (
            <div key={s.id} style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
              <button
                onClick={onChipClick}
                title={
                  isExpandable
                    ? `Click to ${isExpanded ? "collapse" : "expand"} · Shift-click to reveal\n${s.path}`
                    : `Click to open · Shift-click to reveal\n${s.path}`
                }
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "2px 8px",
                  borderRadius: 99,
                  background: T.bg2,
                  border: `1px solid ${T.border}`,
                  color: T.fg1,
                  cursor: "pointer",
                  fontFamily: T.mono,
                  fontSize: 10,
                  maxWidth: 260,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = T.amber)}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = T.border)}
              >
                <span style={{ color: T.amber, fontWeight: 700 }}>[{s.citationIndex}]</span>
                <span>{s.label}</span>
                {isFolder && <span style={{ color: T.fg3 }}>·</span>}
                {isFolder && <span style={{ color: T.fg3 }}>folder</span>}
                <span style={{ color: T.fg3 }}>{hitsLabel}</span>
                {isExpandable && (
                  <span style={{ color: T.fg3 }}>{isExpanded ? "▾" : "▸"}</span>
                )}
              </button>
              {isExpanded && hasHits && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    marginLeft: 12,
                    paddingLeft: 8,
                    borderLeft: `1px dashed ${T.border}`,
                  }}
                >
                  {s.hits.map((h, i) => {
                    // For folder hits, h.path is the sub-file (absolute).
                    // Strip the parent path to get a short relative label
                    // for display AND to pass as sub_path to the native
                    // opener — the Rust side re-validates it against the
                    // attachment root via sandbox::resolve_within.
                    const rel = isFolder && h.path.startsWith(s.path)
                      ? h.path.slice(s.path.length).replace(/^[\\/]/, "")
                      : h.path.split(/[\\/]/).slice(-1)[0];
                    // Single-file attachments don't have a meaningful
                    // sub-path; just reveal the attachment itself.
                    const onHitClick = isFolder
                      ? () => revealHit(s.id, rel)
                      : () => revealAttachment(s.id);
                    return (
                      <button
                        key={`${s.id}-${i}`}
                        onClick={onHitClick}
                        title={`Click to open\n${h.path}\nrelevance ${h.score.toFixed(2)} · chars ${h.charStart}-${h.charEnd}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "2px 6px",
                          background: "transparent",
                          border: "none",
                          color: T.fg2,
                          cursor: "pointer",
                          fontFamily: T.mono,
                          fontSize: 10,
                          textAlign: "left",
                          maxWidth: 360,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = T.fg)}
                        onMouseLeave={(e) => (e.currentTarget.style.color = T.fg2)}
                      >
                        <span style={{ color: T.fg3 }}>↳</span>
                        <span>{rel}</span>
                        <span style={{ color: T.fg3 }}>·</span>
                        <span style={{ color: T.amber }}>{h.score.toFixed(2)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {imagesSkipped && (
          <span
            title="Switch to a vision-capable model to use the attached images"
            style={{
              fontFamily: T.mono,
              fontSize: 10,
              color: T.fg3,
              padding: "2px 6px",
              borderRadius: 4,
              background: T.bg2,
              border: `1px dashed ${T.border}`,
            }}
          >
            images skipped (model has no vision)
          </span>
        )}
      </div>
    </div>
  );
}

// File-saved chip strip on assistant messages. m.toolResults is populated by
// handleSend at live-write time and re-hydrated by openChatInTab from
// chat_files_list on reload. Each entry: { relPath, bytes, version, absPath?,
// fileId? }. Clicking "Reveal" opens the parent folder in Finder; "Open"
// hands the file to the OS default app. Reveal/Open both resolve absPath
// lazily via chat_file_path when only fileId is present (i.e. on reload).
function ToolResultsStrip({ results }) {
  if (!results?.length) return null;
  const tauriInvoke = getInvoke();
  // Use native Tauri commands instead of tauri-plugin-shell — the shell
  // plugin's `open` API rejects bare filesystem paths via its default
  // scope regex. chat_file_reveal / chat_file_open spawn the platform
  // opener directly. Falls back to no-op when neither absPath nor fileId
  // is present (shouldn't happen for live or reloaded saves).
  const reveal = async (chip, action) => {
    if (!tauriInvoke) return;
    if (!chip.fileId) {
      window.ekToast?.({
        kind: 'warn',
        title: 'No file id on this chip',
        body: 'Cannot reveal / open without a chat_files row.',
      });
      return;
    }
    try {
      const cmd = action === 'reveal' ? 'chat_file_reveal' : 'chat_file_open';
      await tauriInvoke(cmd, { fileId: chip.fileId });
    } catch (e) {
      console.error(`${action} failed for fileId=${chip.fileId}:`, e);
      window.ekToast?.({
        kind: 'warn',
        title: `Could not ${action}`,
        body: String(e),
      });
    }
  };
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        marginBottom: 8,
      }}
    >
      {results.map((r) => (
        <div
          key={r.callId || r.fileId || r.relPath}
          title={`${r.relPath} · ${r.bytes ?? '?'} bytes · v${r.version ?? 1}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 8px',
            borderRadius: 6,
            background: T.green + '15',
            border: `1px solid ${T.green}33`,
            fontFamily: T.mono,
            fontSize: 11,
            color: T.fg1,
          }}
        >
          <span style={{ color: T.green, fontSize: 10 }}>●</span>
          <span style={{ color: T.fg }}>{r.relPath}</span>
          {r.version > 1 && (
            <span style={{ color: T.fg3, fontSize: 9 }}>v{r.version}</span>
          )}
          <button
            onClick={() => reveal(r, 'reveal')}
            title="Reveal in Finder"
            style={{
              background: 'none',
              border: 'none',
              color: T.fg2,
              cursor: 'pointer',
              padding: 0,
              fontSize: 10,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = T.fg)}
            onMouseLeave={(e) => (e.currentTarget.style.color = T.fg2)}
          >Reveal</button>
          <button
            onClick={() => reveal(r, 'open')}
            title="Open file"
            style={{
              background: 'none',
              border: 'none',
              color: T.fg2,
              cursor: 'pointer',
              padding: 0,
              fontSize: 10,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = T.fg)}
            onMouseLeave={(e) => (e.currentTarget.style.color = T.fg2)}
          >Open</button>
        </div>
      ))}
    </div>
  );
}

// Heuristic-fallback Save strip for assistant messages that contain
// fenced code blocks the model didn't already save via the write_file
// tool. Each chip = one inferred file the user can save with one click.
// Falls back to a renamable input on the chip if they want to override.
// Hidden when:
//   - the message already has toolResults (tool-use path covered it)
//   - the message has no fenced blocks
//   - the message is still streaming (parsing mid-stream gives flicker)
function HeuristicSaveStrip({ messageId, chatId, content, streaming }) {
  const blocks = useMemo(
    () => (streaming ? [] : parseFencedBlocks(content)),
    [content, streaming]
  );
  const [saved, setSaved] = useState({}); // filename → true after save
  if (!blocks.length) return null;

  const save = async (block) => {
    if (!window.ekSaveModelFile) return;
    try {
      const r = await window.ekSaveModelFile({
        chatId,
        messageId,
        path: block.filename,
        contents: block.content,
      });
      if (r?.ok) setSaved((s) => ({ ...s, [block.filename]: true }));
    } catch (e) {
      // ekSaveModelFile handles its own toasts; nothing else to do here.
    }
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
      {blocks.map((b) => {
        const isSaved = !!saved[b.filename];
        return (
          <button
            key={`${b.ordinal}-${b.filename}`}
            onClick={() => save(b)}
            disabled={isSaved}
            title={
              isSaved
                ? `Saved · ${b.filename}`
                : `Save as ${b.filename} (${b.content.length} chars)`
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              background: isSaved ? T.green + '15' : T.bg2,
              border: `1px dashed ${isSaved ? T.green + '55' : T.border}`,
              borderRadius: 6,
              color: isSaved ? T.fg2 : T.fg1,
              fontFamily: T.mono,
              fontSize: 11,
              cursor: isSaved ? 'default' : 'pointer',
              opacity: isSaved ? 0.7 : 1,
            }}
            onMouseEnter={(e) => {
              if (!isSaved) e.currentTarget.style.borderColor = T.borderStrong;
            }}
            onMouseLeave={(e) => {
              if (!isSaved) e.currentTarget.style.borderColor = T.border;
            }}
          >
            <span style={{ color: isSaved ? T.green : T.amber, fontSize: 10 }}>
              {isSaved ? '✓' : '↓'}
            </span>
            <span style={{ color: T.fg }}>{b.filename}</span>
            {b.language && (
              <span style={{ color: T.fg3, fontSize: 9 }}>{b.language}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Hover-revealed action chip used by the Message component for Edit /
// Retry affordances. Defined at module scope (not inside Message) per
// CLAUDE.md's component-identity gotcha — nesting it inside Message would
// give it a new identity on every render and any focus / animation state
// would reset on each keystroke.
function MessageActionButton({ icon, label, title, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 8px',
        background: hover ? T.bg2 : 'transparent',
        border: `1px solid ${hover ? T.border : 'transparent'}`,
        borderRadius: 5,
        color: hover ? T.fg : T.fg3,
        fontFamily: T.mono,
        fontSize: 10.5,
        cursor: 'pointer',
        transition: 'color 0.12s, background 0.12s, border-color 0.12s',
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Message({ m, highlightRegex, chatId, isStreaming, onEditMessage, onRetryMessage }) {
  const isUser = m.role === "user";
  // Alternatives disclosure (Phase 5 polish). When this picked variant
  // (is_picked=1) was kept from a compare-mode comparison, m.alternatives
  // carries the unpicked siblings. Local state collapses/expands the
  // panel. The panel is read-only — there's no "re-pick" affordance in
  // v1; users who want to switch start a new compare chat.
  const [altsOpen, setAltsOpen] = useState(false);
  const hasAlternatives = !isUser && m.alternatives?.length > 0;
  // Heuristic strip only renders when the tool-use path hasn't already
  // claimed this message. Models that DID call write_file get green chips
  // via ToolResultsStrip and shouldn't also be nagged with dashed Save
  // buttons for the same files.
  const showHeuristic =
    !isUser && !m.streaming && !(m.toolResults?.length) && !!chatId;

  // ── Edit-and-resubmit (Phase 3) ─────────────────────────────────────────
  // Pencil icon on hover for user messages opens an inline textarea seeded
  // with the message content. Save (or ⌘/Ctrl+Enter) calls onEditMessage,
  // which in main.jsx truncates the chat from this point and re-runs the
  // send flow. Cancel (or Escape) reverts. Disabled while a stream is in
  // progress so the user can't accidentally fork mid-token.
  const [hover, setHover] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(m.content || '');
  const editTextareaRef = useRef(null);
  useEffect(() => {
    if (isEditing && editTextareaRef.current) {
      const t = editTextareaRef.current;
      t.focus();
      // Place cursor at the end so the user can keep typing without
      // having to click + extend selection.
      const len = t.value.length;
      t.setSelectionRange(len, len);
    }
  }, [isEditing]);
  const startEdit = () => {
    if (isStreaming) return;
    setDraft(m.content || '');
    setIsEditing(true);
  };
  const cancelEdit = () => {
    setIsEditing(false);
    setDraft(m.content || '');
  };
  const commitEdit = () => {
    const text = (draft || '').trim();
    setIsEditing(false);
    if (!text) return;
    if (text === m.content) return; // unchanged — leave the chat as is
    if (onEditMessage && m.id) onEditMessage(m.id, text);
  };
  const onEditKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commitEdit();
    }
  };

  // Show-hovered icons: pencil for user messages, refresh for the last
  // assistant message (parent passes onRetryMessage only when this is the
  // case). Suppressed while streaming OR editing OR while the message has
  // no id (transient/pending). The action row reserves space even when
  // dimmed so message heights don't jump on hover.
  const canEdit = isUser && !!onEditMessage && !!m.id && !isStreaming && !isEditing;
  const canRetry = !isUser && !!onRetryMessage && !!m.id && !isStreaming && !m.streaming;
  const showActions = canEdit || canRetry;

  return (
    // id is used by FilesPanel's onScrollToMessage to scroll-into-view the
    // message that produced a saved file. Stable across re-renders since
    // m.id is the persisted message id.
    <div
      id={m.id ? `ek-msg-${m.id}` : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ marginBottom: 16, position: 'relative' }}
    >
      {!isUser && m.toolResults?.length > 0 && (
        <ToolResultsStrip results={m.toolResults} />
      )}
      {showHeuristic && (
        <HeuristicSaveStrip
          messageId={m.id}
          chatId={chatId}
          content={m.content}
          streaming={m.streaming}
        />
      )}
      {isUser && m.prompts?.length > 0 && (
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}
        >
          {/* p.color was resolved from the prompt's favorite at send time
              (main.jsx). It can be null when the prompt had no favorite; we
              fall back to a neutral chip in that case. */}
          {m.prompts.map((p) => (
            <span
              key={p.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 8px",
                borderRadius: 99,
                background: p.color ? p.color + "22" : T.bg2,
                border: `1px solid ${p.color ? p.color + "55" : T.border}`,
                fontFamily: T.mono,
                fontSize: 10.5,
                color: p.color || T.fg1,
                letterSpacing: 0.2,
              }}
            >
              <span>{p.name}</span>
            </span>
          ))}
        </div>
      )}
      {isEditing ? (
        // Edit mode: textarea replaces the bubble, Save / Cancel below.
        // The textarea sizing matches the user-message bubble visually so
        // the swap doesn't reflow the conversation. We auto-grow via the
        // ref + a tiny rows-from-newlines heuristic so multi-line edits
        // don't get truncated to a single row.
        <div>
          <textarea
            ref={editTextareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onEditKey}
            rows={Math.max(2, Math.min(20, (draft.match(/\n/g) || []).length + 2))}
            style={{
              width: '100%',
              padding: '10px 14px',
              borderRadius: 10,
              background: T.bg2,
              border: `1px solid ${T.borderStrong || T.border}`,
              fontFamily: T.sans,
              fontSize: 14,
              lineHeight: 1.65,
              color: T.fg,
              resize: 'vertical',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <div
            style={{
              display: 'flex',
              gap: 6,
              marginTop: 6,
              alignItems: 'center',
              fontSize: 11,
              color: T.fg3,
              fontFamily: T.mono,
            }}
          >
            <button
              onClick={commitEdit}
              style={{
                padding: '4px 12px',
                background: T.amber,
                color: T.bg0,
                border: 'none',
                borderRadius: 5,
                fontFamily: T.mono,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Save &amp; Resend
            </button>
            <button
              onClick={cancelEdit}
              style={{
                padding: '4px 12px',
                background: 'transparent',
                color: T.fg2,
                border: `1px solid ${T.border}`,
                borderRadius: 5,
                fontFamily: T.mono,
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <span style={{ flex: 1 }} />
            <span style={{ opacity: 0.7 }}>{MOD_GLYPH}{ENTER_GLYPH} to save · Esc to cancel</span>
          </div>
        </div>
      ) : (
        <div
          className={!isUser && m.streaming ? 'ek-stream-border' : undefined}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            background: isUser ? T.bg2 : "transparent",
            border: isUser ? `1px solid ${T.border}` : "none",
            fontFamily: T.sans,
            fontSize: 14,
            lineHeight: 1.65,
            color: T.fg,
            // User messages keep the original pre-wrap behaviour so newlines
            // in what the user typed render literally. Assistant messages
            // now route through MarkdownMessage, which sets its own
            // whiteSpace normal on the rendered HTML root (so prose flows
            // and only <pre> preserves whitespace).
            whiteSpace: isUser ? "pre-wrap" : undefined,
            textWrap: "pretty",
          }}
        >
          {isUser ? (
            renderMessageContent(m.content, highlightRegex, null)
          ) : (
            <MarkdownMessage
              content={m.content}
              highlightRegex={highlightRegex}
              sources={m.sources}
              streaming={m.streaming}
            />
          )}
          {m.streaming && (
            <span className="stream-cursor" style={{ color: T.amber }} />
          )}
          {!isUser && m.incomplete && !m.streaming && (
            // "Stopped" marker for assistant messages where the user clicked
            // Stop mid-generation. Italic + muted so it doesn't compete with
            // the message content; the small horizontal rule above gives a
            // clean break from the truncated text. Persisted via
            // sources_json.incomplete so the marker survives a chat reload.
            <div
              style={{
                marginTop: 8,
                paddingTop: 6,
                borderTop: `1px dashed ${T.border}`,
                fontFamily: T.mono,
                fontSize: 10.5,
                color: T.fg3,
                fontStyle: "italic",
                letterSpacing: 0.3,
              }}
            >
              — Stopped.
            </div>
          )}
        </div>
      )}
      {/* Model + tokens footer for assistant messages. Always visible
          (not hover-gated) so scrolling back through a chat where the
          user switched models mid-conversation makes the attribution
          obvious. Hidden while the message is still streaming — the
          ek-stream-border + stream-cursor already indicate live state,
          and tokens aren't known until the `done` chunk arrives. User
          messages get no footer (no model produced them). */}
      {!isUser && !m.streaming && (m.model || m.tokens) && (
        <div
          style={{
            marginTop: 4,
            paddingLeft: 14,
            fontFamily: T.mono,
            fontSize: 10,
            color: T.fg3,
            letterSpacing: 0.3,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
          data-message-footer
        >
          {m.model && (
            <span data-message-model title={`Generated by ${m.model}`}>
              {m.model}
            </span>
          )}
          {m.tokens && (m.tokens.in || m.tokens.out) ? (
            <span style={{ color: T.fg3 }} data-message-tokens>
              {m.tokens.in || 0}/{m.tokens.out || 0} tok
              {m.tokens.ms
                ? ` · ${(m.tokens.ms / 1000).toFixed(1)}s`
                : ""}
            </span>
          ) : null}
        </div>
      )}
      {/* Alternatives disclosure (compare-mode → single-from-multi). The
          unpicked siblings rendered as read-only cards under the kept
          message. Collapsed by default so it doesn't bloat a long chat
          you've scrolled past; clicking expands inline. */}
      {hasAlternatives && (
        <div
          data-alternatives
          style={{
            marginTop: 6,
            paddingLeft: 14,
            fontFamily: T.mono,
            fontSize: 11,
            color: T.fg3,
          }}
        >
          <button
            data-alternatives-toggle
            onClick={() => setAltsOpen((v) => !v)}
            aria-expanded={altsOpen}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              color: T.fg2,
              fontFamily: T.mono,
              fontSize: 11,
              cursor: "pointer",
              letterSpacing: 0.2,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = T.fg)}
            onMouseLeave={(e) => (e.currentTarget.style.color = T.fg2)}
          >
            {altsOpen ? "▾" : "▸"} {m.alternatives.length} alternative
            {m.alternatives.length === 1 ? "" : "s"}
            <span style={{ color: T.fg3 }}>
              {" — "}
              {m.alternatives.map((a) => a.model || "unknown").join(", ")}
            </span>
          </button>
          {altsOpen && (
            <div
              data-alternatives-panel
              style={{
                marginTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {m.alternatives.map((alt) => (
                <div
                  key={alt.id}
                  data-alternative
                  data-alt-model={alt.model}
                  style={{
                    border: `1px solid ${T.border}`,
                    borderRadius: 6,
                    padding: "8px 12px",
                    background: T.bg1,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: T.fg3,
                      textTransform: "uppercase",
                      letterSpacing: 0.6,
                      marginBottom: 6,
                    }}
                  >
                    <span style={{ color: T.fg2 }}>{alt.model || "unknown"}</span>
                    {alt.tokens && (alt.tokens.in || alt.tokens.out) ? (
                      <span>
                        · {alt.tokens.in || 0}/{alt.tokens.out || 0} tok
                      </span>
                    ) : null}
                  </div>
                  {alt.content ? (
                    <div
                      style={{
                        fontFamily: T.sans,
                        fontSize: 13,
                        color: T.fg1,
                        lineHeight: 1.55,
                      }}
                    >
                      <MarkdownMessage
                        content={alt.content}
                        streaming={false}
                      />
                    </div>
                  ) : (
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 11,
                        color: T.fg3,
                        fontStyle: "italic",
                      }}
                    >
                      (no response captured)
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Hover-revealed actions: pencil for user messages, refresh for the
          last assistant message. Positioned absolute to the message row so
          it doesn't take up layout space. Opacity transitions on hover so
          static reading isn't cluttered. */}
      {showActions && (
        <div
          style={{
            display: 'flex',
            gap: 4,
            marginTop: 4,
            opacity: hover ? 1 : 0,
            transition: 'opacity 0.12s',
            pointerEvents: hover ? 'auto' : 'none',
          }}
        >
          {canEdit && (
            <MessageActionButton
              icon={<I.Edit size={11} />}
              label="Edit"
              title="Edit message and re-run from here"
              onClick={startEdit}
            />
          )}
          {canRetry && (
            <MessageActionButton
              icon={<I.Refresh size={11} />}
              label="Retry"
              title="Re-run the previous message"
              onClick={onRetryMessage}
            />
          )}
        </div>
      )}
      {!isUser && (m.sources?.length > 0 || m.imagesSkipped) && (
        <SourcesFooter sources={m.sources} imagesSkipped={m.imagesSkipped} />
      )}
    </div>
  );
}

// Three-dot typing indicator shown while waiting for the first streamed
// assistant token. Used to take a `model` prop for per-model tinting; the
// prop was never wired through, so the indicator is just amber. Add it
// back only when the surrounding ChatPane plumbing is ready to consume it.
function StreamingIndicator() {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ color: T.amber, fontFamily: T.mono, fontSize: 14 }}>
        <span className="typing-dot">●</span>
        <span className="typing-dot">●</span>
        <span className="typing-dot">●</span>
      </div>
    </div>
  );
}

// ─── Prompt slash-command picker ────────────────────────────
//
// Floating popover rendered above the Composer card. Lists prompts
// (filtered + sorted A→Z by the caller) and highlights one row.
// Purely presentational — all state lives in Composer; this component
// just renders + emits onPick/onHighlight.
//
// Hoisted to module scope per the "Component identity in modals" rule
// in CLAUDE.md: defining a component inside the parent's render causes
// React to remount it on every keystroke, which would blow away the
// highlight and any focus state.
//
// Positioning: absolute, bottom: 100% relative to the parent container
// the caller positions it inside (Composer's outermost composer-card
// div, which has position: relative). Caller controls width via that
// container. The data-prompt-picker attribute is used by Composer's
// click-outside listener to know "this click was for me, don't close."
function PromptSlashPicker({
  open,
  prompts,
  highlighted,
  onHighlight,
  onPick,
  emptyMessage,
}) {
  // Track each row's DOM node so we can scroll the highlighted one
  // into view when keyboard nav moves past the visible area. Map keyed
  // by row index. Callback refs clean up automatically: React calls
  // each ref with `null` on unmount/reorder, so removed rows drop out.
  //
  // Hooks must run unconditionally (rules-of-hooks), so they're hoisted
  // ABOVE the `if (!open)` early return.
  const rowRefs = useRef(new Map());
  useEffect(() => {
    if (!open) return;
    const el = rowRefs.current.get(highlighted);
    // block: 'nearest' keeps scrolling minimal — only moves when the
    // row is actually outside the visible area, no jumpy re-centering
    // on every arrow press.
    el?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  if (!open) return null;
  return (
    <div
      data-prompt-picker
      style={{
        position: "absolute",
        bottom: "100%",
        left: 0,
        right: 0,
        marginBottom: 6,
        background: T.bg2,
        border: `1px solid ${T.borderStrong}`,
        borderRadius: 6,
        boxShadow: "0 8px 22px rgba(0,0,0,0.4)",
        maxHeight: 260,
        overflowY: "auto",
        zIndex: 30,
      }}
    >
      {prompts.length === 0 && (
        <div
          style={{
            padding: "14px 16px",
            fontFamily: T.mono,
            fontSize: 11,
            color: T.fg3,
            textAlign: "center",
          }}
        >
          {emptyMessage || "No prompts."}
        </div>
      )}
      {prompts.map((p, i) => {
        const sel = i === highlighted;
        const fav = p.favorite ? FAVORITE_COLOR_MAP[p.favorite] : null;
        return (
          <button
            key={p.id}
            // Callback ref → Map by row index. The useEffect above
            // reads this Map to scroll the highlighted row into view
            // on keyboard nav. Setting null on unmount keeps the Map
            // free of stale references.
            ref={(el) => {
              if (el) rowRefs.current.set(i, el);
              else rowRefs.current.delete(i);
            }}
            // mousedown (not click) so we fire BEFORE the document
            // mousedown listener in Composer would interpret it as a
            // click-outside. The textarea's blur is also debounced
            // by the picker's stopPropagation chain.
            onMouseDown={(e) => {
              e.preventDefault(); // keep textarea focus
              onPick(p);
            }}
            onMouseEnter={() => onHighlight(i)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "6px 12px",
              background: sel ? T.bg4 : "transparent",
              border: "none",
              cursor: "pointer",
              color: sel ? T.fg : T.fg1,
              textAlign: "left",
              fontFamily: T.sans,
              fontSize: 12.5,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 99,
                background: fav?.color || "transparent",
                flexShrink: 0,
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
          </button>
        );
      })}
    </div>
  );
}

// ─── Composer ───────────────────────────────────────────────
function Composer({
  model,
  onModelChange,
  onSend,
  isStreaming,
  onStop,
  // Prompt slash-command picker:
  //   prompts          — the full library (filtered for _virtual upstream)
  //                      that the slash picker chooses from
  //   onPickPrompt(p)  — called when the user picks one; parent should
  //                      attach it (e.g. via togglePromptAttach)
  //   attachedPrompts  — already-attached prompts; the picker hides them
  //                      since picking an already-attached one would be
  //                      a no-op (toggle would detach, which is not
  //                      what "pick from the picker" implies)
  //   onDetachPrompt   — × button on each chip
  //   lockedPromptSlugs — Set<slug> of prompts the parent has flagged as
  //                      Space-locked. For chips whose `p.id` (== slug)
  //                      is in this set, the × button is suppressed and
  //                      a small lock glyph replaces it so the user
  //                      knows the chip is enforced by the Space, not
  //                      by them. Detaching it is disabled at this
  //                      layer; unlock via the Space settings modal.
  prompts = [],
  onPickPrompt,
  attachedPrompts = [],
  onDetachPrompt,
  lockedPromptSlugs = new Set(),
  // File + folder attachments (separate from prompts):
  //   attachments       — array of { id, kind ('text'|'image'|'folder'), label, path, bytes, status, ... }
  //   onAttachFile      — opens the OS file picker via the dialog plugin
  //   onAttachFolder    — opens the OS folder picker (directory: true)
  //   onDetachAttachment — removes a single attachment by id
  //   onReindexAttachment — re-runs the embedding pipeline (retry on error)
  //   modelHasVision    — gates the small "vision" badge on image chips so
  //                       the user knows the model will actually look at it
  //   modelHasTools     — drives the "TOOL" chip next to the model selector;
  //                       also signals that write_file tool calls will be
  //                       wired into this chat's outbound /api/chat requests
  attachments = [],
  onAttachFile,
  onAttachFolder,
  onDetachAttachment,
  onReindexAttachment,
  modelHasVision = false,
  modelHasTools = false,
  // Ephemeral (private) chats disable attachments because the attachments
  // table FK-references chats, and we never write the chats row for
  // private chats. Hiding the buttons keeps the UI honest (no clicking
  // and getting an FK-violation toast). The private-mode banner above the
  // composer explains the constraint.
  ephemeral = false,
  // seedText + seedKey: pre-fill the composer from outside (e.g. the
  // "Chat with notes" button in WatchPanel). seedKey is a counter — the
  // useEffect below seeds only when it changes, so React doesn't trample
  // the user's typing on every re-render. The pair is intentionally
  // detached from the rest of the composer state to keep Composer
  // uncontrolled in the common case.
  seedText,
  seedKey,
}) {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const taRef = useRef(null);

  // ── Prompt slash-command picker state ───────────────────────────────────
  // `slashPos` is the index of the `/` that opened the picker. Used to
  //   (a) derive the live query as the text between the `/` and the next
  //       whitespace (or end of text), and
  //   (b) strip `/query` from the textarea when the user picks or cancels.
  // The picker can be triggered two ways — typing `/` at a valid position
  // (line start or after whitespace), or clicking the library button (we
  // synthesise the `/` insertion in that case so the same code path
  // handles both). slashPos is always set when promptPickerOpen is true.
  const [promptPickerOpen, setPromptPickerOpen] = useState(false);
  const [slashPos, setSlashPos] = useState(0);
  const [pickerHighlight, setPickerHighlight] = useState(0);

  // Live query: text from after the `/` up to the next whitespace.
  // Re-derived on every render — cheap, and avoids a state sync bug
  // where the query lags one keystroke behind the text.
  const slashQuery = promptPickerOpen
    ? (text.slice(slashPos + 1).match(/^\S*/) || [""])[0]
    : "";

  // Filtered + sorted prompts for the picker. Hides already-attached
  // ones (picking them would be a no-op toggle) and sorts A→Z to match
  // the rest of the prompt UI (PromptLibrary default, overlay picker).
  const attachedPromptIds = attachedPrompts.map((p) => p.id);
  const pickerPrompts = useMemo(() => {
    const q = slashQuery.toLowerCase();
    return prompts
      .filter((p) => !attachedPromptIds.includes(p.id))
      .filter(
        (p) => q === "" || p.name.toLowerCase().includes(q),
      )
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    // attachedPromptIds is derived from attachedPrompts; depend on that
    // instead so identity is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompts, attachedPrompts, slashQuery]);

  // Keep the highlight in range — if filtering shrinks the list below
  // the current highlight, snap to the last row.
  useEffect(() => {
    if (pickerHighlight >= pickerPrompts.length && pickerPrompts.length > 0) {
      setPickerHighlight(pickerPrompts.length - 1);
    }
    if (pickerPrompts.length === 0 && pickerHighlight !== 0) {
      setPickerHighlight(0);
    }
  }, [pickerPrompts.length, pickerHighlight]);

  // Validate the picker's slashPos against the textarea's value. Lives
  // in onChange below (NOT in a useEffect) to avoid a state-batching
  // race: the onKeyDown that opens the picker sets `slashPos` +
  // `promptPickerOpen` in one event, but the textarea's onChange that
  // inserts the `/` into `text` fires in a separate event. Between
  // those two events, React re-renders with picker=open AND text="" —
  // a useEffect on `text` would see text[slashPos] === undefined and
  // wrongly close the picker before the slash even lands.
  const validatePickerAgainstText = (newText) => {
    if (!promptPickerOpen) return;
    if (newText[slashPos] !== "/") setPromptPickerOpen(false);
  };

  // ── Picker helpers ──────────────────────────────────────────────────────

  // Strip the `/query` substring from the textarea (used by both pick
  // and cancel paths). Caller is responsible for setting picker state
  // and refocusing the textarea.
  const stripSlashFromText = () => {
    setText((t) => {
      const before = t.slice(0, slashPos);
      const after = t.slice(slashPos + 1 + slashQuery.length);
      return before + after;
    });
  };

  // Attach the highlighted prompt (or the one passed in), strip the
  // `/query` text, close the picker, and refocus the textarea so the
  // user can continue typing their message right after.
  const pickPrompt = (p) => {
    if (!p || !onPickPrompt) {
      setPromptPickerOpen(false);
      return;
    }
    stripSlashFromText();
    setPromptPickerOpen(false);
    onPickPrompt(p);
    // Refocus + restore caret to where the `/` used to be (so the user
    // can keep typing in place).
    setTimeout(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(slashPos, slashPos);
    }, 0);
  };

  // Cancel the picker (Esc or click-outside on the cancel path). Removes
  // the `/query` so the user isn't left with a stray slash in their
  // message. Click-outside has a separate path that closes WITHOUT
  // stripping (since the user clicked away — they may want to leave
  // the slash in place as literal text).
  const cancelPicker = () => {
    stripSlashFromText();
    setPromptPickerOpen(false);
    setTimeout(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(slashPos, slashPos);
    }, 0);
  };

  // Click-outside the picker → close without modifying text. Watches
  // document mousedown; if the click target isn't inside a
  // [data-prompt-picker] or the textarea itself, close. Mirrors the
  // close-on-outside-click pattern PromptLibrary uses for its sort
  // menu.
  useEffect(() => {
    if (!promptPickerOpen) return;
    const onDoc = (e) => {
      if (e.target.closest("[data-prompt-picker]")) return;
      if (e.target === taRef.current) return;
      setPromptPickerOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [promptPickerOpen]);

  // Button-trigger for the picker (clicking the Library icon). Inserts
  // a `/` at the textarea's current caret position — synthesising the
  // same input the user would have made by typing `/` — so the rest
  // of the slash-picker logic doesn't need a separate code path.
  // If the caret isn't at a slash-valid position (start of text or
  // after whitespace), we prepend a space to make it valid.
  const triggerSlashPickerFromButton = () => {
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? text.length;
    const charBefore = caret > 0 ? text[caret - 1] : "";
    const needsSpace = caret > 0 && !/\s/.test(charBefore);
    const insert = needsSpace ? " /" : "/";
    const newText = text.slice(0, caret) + insert + text.slice(caret);
    const newSlashPos = needsSpace ? caret + 1 : caret;
    setText(newText);
    setSlashPos(newSlashPos);
    setPromptPickerOpen(true);
    setPickerHighlight(0);
    setTimeout(() => {
      const t2 = taRef.current;
      if (!t2) return;
      t2.focus();
      // Caret goes just past the inserted `/` so subsequent keystrokes
      // become the slash-query.
      const after = newSlashPos + 1;
      t2.setSelectionRange(after, after);
    }, 0);
  };

  // Seed on demand. Don't depend on seedText itself — if the parent
  // recomputes the same string, we'd needlessly stomp on user edits.
  useEffect(() => {
    if (typeof seedKey === "number" && seedKey > 0) {
      setText(seedText || "");
      setTimeout(() => taRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const handleSend = () => {
    if (!text.trim() || isStreaming) return;
    onSend(text);
    setText("");
  };
  const onKey = (e) => {
    // ── Slash-picker navigation has priority over other key handling ──
    // When the picker is open, ↑/↓ move the highlight, Enter/Tab attach
    // the highlighted prompt, Esc cancels (strips the /query). We don't
    // shift focus to the picker — the textarea stays focused, picker is
    // purely visual. Mirrors Slack/Discord's slash-command flow.
    if (promptPickerOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPickerHighlight((i) =>
          pickerPrompts.length ? (i + 1) % pickerPrompts.length : 0,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPickerHighlight((i) =>
          pickerPrompts.length
            ? (i - 1 + pickerPrompts.length) % pickerPrompts.length
            : 0,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (pickerPrompts.length) {
          pickPrompt(pickerPrompts[pickerHighlight] || pickerPrompts[0]);
        } else {
          // Empty list — Enter shouldn't fall through to send a message
          // either; just close the picker. This matches the user's
          // mental model ("I was trying to use the picker, not send").
          setPromptPickerOpen(false);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancelPicker();
        return;
      }
      // Other keys (typing, backspace) fall through to the textarea
      // so the query keeps updating live. The useEffect on text below
      // will close the picker if the user deletes the `/`.
    }

    // ── Slash-trigger detection ───────────────────────────────────────
    // Open the picker when the user types `/` at the start of the text
    // or immediately after whitespace. Anything else (mid-word, after a
    // letter) is treated as literal `/` — important so URLs ("http://")
    // and code snippets don't accidentally trigger the picker.
    if (e.key === "/" && !promptPickerOpen) {
      const ta = e.target;
      const caret = ta.selectionStart ?? text.length;
      const charBefore = caret > 0 ? text[caret - 1] : "";
      const valid = caret === 0 || /\s/.test(charBefore);
      if (valid) {
        // Don't preventDefault — let the textarea insert the `/`. We
        // set slashPos to the position the `/` will occupy after the
        // native input. Use the post-keystroke text indirectly:
        // currentText.slice(0, caret) + '/' + currentText.slice(caret).
        // The useEffect on text validates this assumption.
        setSlashPos(caret);
        setPromptPickerOpen(true);
        setPickerHighlight(0);
      }
      // Don't return — let the textarea process the keystroke normally.
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const placeholder = attachedPrompts.length
    ? `Continue with ${attachedPrompts.length} prompt${attachedPrompts.length > 1 ? "s" : ""} attached…`
    : `Send a message  —  ${MOD_GLYPH}${ENTER_GLYPH} to send, / for prompts`;

  return (
    <div
      style={{
        flexShrink: 0,
        padding: 4,
        borderTop: `1px solid ${T.border}`,
        background: T.bg0,
      }}
    >
      <div style={{ maxWidth: "100%", margin: "0" }}>
        <div
          style={{
            background: T.bg1,
            border: `1px solid ${T.borderStrong}`,
            borderRadius: 8,
            padding: 8,
            boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
            // position: relative anchors the absolutely-positioned
            // PromptSlashPicker below — its bottom: 100% rises from
            // the top edge of this card.
            position: "relative",
          }}
        >
          <PromptSlashPicker
            open={promptPickerOpen}
            prompts={pickerPrompts}
            highlighted={pickerHighlight}
            onHighlight={setPickerHighlight}
            onPick={pickPrompt}
            emptyMessage={
              prompts.length === 0
                ? "No prompts in library. Create one in the Prompts panel."
                : attachedPrompts.length >= prompts.length
                  ? "All prompts attached."
                  : "No matches."
            }
          />
          {(attachedPrompts.length > 0 || attachments.length > 0) && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginBottom: 8,
              }}
            >
              {/* File attachment chips. Image chips show a "vision" hint
                  when the active model can see them; otherwise they render
                  with a muted icon and a tooltip explaining the model is
                  text-only. */}
              {attachments.map((a) => {
                const isImage = a.kind === "image";
                const isFolder = a.kind === "folder";
                // Type badge text: extension for files, "DIR" for folders,
                // "IMG"-equivalent for images. Kept short so the chip
                // stays compact when many are attached.
                const fileType = isFolder
                  ? "DIR"
                  : isImage
                    ? (a.label.split(".").pop() || "img").toUpperCase()
                    : (a.label.split(".").pop() || "txt").toUpperCase();
                const visionActive = isImage && modelHasVision;
                const status = a.status || "ready";
                // Status drives both border tinting and the leading dot.
                // 'indexing' is amber-spinning, 'error' is red, 'ready' is
                // the default neutral border.
                const statusBorder =
                  status === "error"
                    ? T.red
                    : status === "indexing"
                      ? T.amber
                      : T.border;
                // Build the progress suffix on folder chips. The chip cycles
                // through three indexing labels:
                //   walking…  — the walker is enumerating files (no total yet)
                //   42/387    — embedding with known total
                //   87 files  — ready, persisted file_count
                // The walking state covers both the explicit 'walking' phase
                // event AND the gap before any progress event arrives (e.g.
                // when reopening a chat with a mid-flight indexing run).
                const progressText = isFolder
                  ? (status === "indexing" && (a.phase === "walking" || typeof a.progressTotal !== "number")
                      ? "walking…"
                      : status === "indexing"
                        ? `${a.fileCount ?? 0}/${a.progressTotal}`
                        : a.fileCount > 0
                          ? `${a.fileCount} file${a.fileCount === 1 ? "" : "s"}`
                          : "")
                  : "";
                const tooltipBase = isImage && !modelHasVision
                  ? `${a.path}\n\nCurrent model has no vision capability — this image won't be analysed. Switch to a vision-capable model (e.g. gemma4, llava) to use it.`
                  : isFolder
                    ? `${a.path}\n\nFolder attachment (indexed for retrieval). Click ↻ to re-index.`
                    : a.path;
                const tooltip =
                  status === "error"
                    ? `${tooltipBase}\n\nIndexing failed: ${a.error || "unknown"}\nClick ↻ to retry.`
                    : status === "indexing"
                      ? `${tooltipBase}\n\nIndexing — chunks will be searchable once this finishes.`
                      : tooltipBase;
                return (
                  <span
                    key={a.id}
                    title={tooltip}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "2px 6px 2px 6px",
                      background: T.bg2,
                      border: `1px solid ${statusBorder}`,
                      borderRadius: 4,
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: T.fg1,
                      opacity: isImage && !modelHasVision ? 0.7 : 1,
                    }}
                  >
                    <span
                      style={{
                        display: "inline-block",
                        padding: "1px 4px",
                        borderRadius: 2,
                        background: isFolder
                          ? T.amber + "22"
                          : isImage
                            ? T.amber + "33"
                            : T.bg3,
                        color: isFolder || isImage ? T.amber : T.fg2,
                        fontSize: 9,
                        fontWeight: 600,
                        letterSpacing: 0.3,
                      }}
                    >
                      {fileType}
                    </span>
                    <span style={{ color: T.fg, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.label}
                    </span>
                    {progressText && (
                      <span
                        style={{
                          color: status === "indexing" ? T.amber : T.fg3,
                          fontSize: 9,
                          fontFamily: T.mono,
                        }}
                      >
                        {progressText}
                      </span>
                    )}
                    {status === "indexing" && (
                      <span
                        className="typing-dot"
                        title="Indexing"
                        style={{
                          color: T.amber,
                          fontSize: 8,
                          marginLeft: 1,
                        }}
                      >
                        ●
                      </span>
                    )}
                    {status === "error" && (
                      <button
                        onClick={() => onReindexAttachment && onReindexAttachment(a.id)}
                        title="Retry indexing"
                        style={{
                          background: "none",
                          border: "none",
                          color: T.red,
                          cursor: "pointer",
                          padding: 0,
                          marginLeft: 1,
                          fontSize: 11,
                          lineHeight: 1,
                          display: "inline-flex",
                        }}
                      >
                        ↻
                      </button>
                    )}
                    {isFolder && status === "ready" && (
                      <button
                        onClick={() => onReindexAttachment && onReindexAttachment(a.id)}
                        title="Re-walk folder (pick up new/changed files)"
                        style={{
                          background: "none",
                          border: "none",
                          color: T.fg3,
                          cursor: "pointer",
                          padding: 0,
                          marginLeft: 1,
                          fontSize: 11,
                          lineHeight: 1,
                          display: "inline-flex",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = T.fg)}
                        onMouseLeave={(e) => (e.currentTarget.style.color = T.fg3)}
                      >
                        ↻
                      </button>
                    )}
                    {visionActive && (
                      <span
                        title="Model supports vision"
                        style={{
                          padding: "0 4px",
                          borderRadius: 2,
                          background: T.amber + "22",
                          color: T.amber,
                          fontSize: 8,
                          fontWeight: 700,
                          letterSpacing: 0.4,
                        }}
                      >
                        VISION
                      </span>
                    )}
                    <button
                      onClick={() => onDetachAttachment && onDetachAttachment(a.id)}
                      style={{
                        background: "none",
                        border: "none",
                        color: T.fg3,
                        cursor: "pointer",
                        padding: 0,
                        marginLeft: 2,
                        display: "inline-flex",
                      }}
                    >
                      <I.X size={9} />
                    </button>
                  </span>
                );
              })}
              {/* Chip is tinted by the prompt's Favorite color when it has
                  one; otherwise it renders as a neutral chip with no dot. */}
              {attachedPrompts.map((p) => {
                const fav = p.favorite
                  ? FAVORITE_COLOR_MAP[p.favorite]
                  : null;
                const favColor = fav?.color || null;
                // Locked chips originate from a Space's `space_prompts`
                // row with locked=1. The chip still renders normally
                // (colored dot, name) but the × is replaced by a small
                // lock glyph and detach is wired to nothing — the user
                // must unlock via the Space settings modal. `p.id` is
                // the prompt slug (filename without `.md`), which is
                // exactly what `lockedPromptSlugs` is keyed by.
                const isLocked = lockedPromptSlugs && lockedPromptSlugs.has(p.id);
                return (
                  <span
                    key={p.id}
                    data-attached-prompt-chip={p.id}
                    data-locked={isLocked ? "1" : "0"}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "2px 6px 2px 6px",
                      background: favColor ? favColor + "22" : T.bg2,
                      border: `1px solid ${favColor ? favColor + "55" : T.border}`,
                      borderRadius: 4,
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: T.fg1,
                    }}
                    title={isLocked ? "Locked by Space — unlock in Space settings" : undefined}
                  >
                    {favColor && (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 99,
                          background: favColor,
                          display: "inline-block",
                        }}
                      />
                    )}
                    <span style={{ color: favColor || T.fg }}>{p.name}</span>
                    {isLocked ? (
                      <span
                        data-attached-prompt-lock={p.id}
                        style={{
                          color: T.fg3,
                          marginLeft: 2,
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <I.Lock size={9} />
                      </span>
                    ) : (
                      <button
                        data-attached-prompt-detach={p.id}
                        onClick={() => onDetachPrompt && onDetachPrompt(p.id)}
                        style={{
                          background: "none",
                          border: "none",
                          color: T.fg3,
                          cursor: "pointer",
                          padding: 0,
                          marginLeft: 2,
                          display: "inline-flex",
                        }}
                      >
                        <I.X size={9} />
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          )}
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              const v = e.target.value;
              setText(v);
              // Validate AFTER the text update lands (see comment on
              // validatePickerAgainstText). Cheap no-op when picker
              // isn't open.
              validatePickerAgainstText(v);
            }}
            onKeyDown={onKey}
            placeholder={placeholder}
            rows={2}
            style={{
              width: "100%",
              resize: "none",
              border: "none",
              background: "transparent",
              color: T.fg,
              fontFamily: T.sans,
              fontSize: 14,
              lineHeight: 1.55,
              minHeight: 44,
              maxHeight: 200,
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              paddingTop: 8,
              borderTop: `1px solid ${T.border}`,
              marginTop: 8,
              position: "relative",
            }}
          >
            {!ephemeral && (
              <>
                <IconButton
                  icon={I.Attach}
                  onClick={() => onAttachFile && onAttachFile()}
                  title="Attach file (.txt, .md, .pdf, image)"
                  size={24}
                />
                <IconButton
                  icon={I.Folder}
                  onClick={() => onAttachFolder && onAttachFolder()}
                  title="Attach folder (indexed for retrieval)"
                  size={24}
                />
              </>
            )}
            <IconButton
              icon={I.Library}
              // Trigger the inline slash picker. Synthesises a `/` at
              // the caret position (see triggerSlashPickerFromButton)
              // so the picker path is identical to typing `/` directly.
              // Manage prompts (create, edit, delete) still lives in
              // the right-side Prompts panel — opened from the tab bar
              // on the right edge of the chat window.
              onClick={triggerSlashPickerFromButton}
              title="Insert prompt (/)"
              size={24}
            />
            {/* Voice dictation — records mic audio and inserts the local
                Whisper transcript at the caret. Always available (even in
                private chats — it's just text entry). See voice.jsx. */}
            <VoiceMicButton
              disabled={isStreaming}
              onInsert={(t) => {
                if (!t) return;
                const ta = taRef.current;
                const cur = text;
                let start = cur.length;
                let end = cur.length;
                if (ta) {
                  start = ta.selectionStart != null ? ta.selectionStart : cur.length;
                  end = ta.selectionEnd != null ? ta.selectionEnd : cur.length;
                }
                const pre = cur.slice(0, start);
                const needsSpace = pre.length > 0 && !/\s$/.test(pre);
                const ins = (needsSpace ? " " : "") + t;
                setText(pre + ins + cur.slice(end));
                requestAnimationFrame(() => {
                  try {
                    if (ta) {
                      ta.focus();
                      const p = start + ins.length;
                      ta.setSelectionRange(p, p);
                    }
                  } catch (_) {}
                });
              }}
            />
            <span style={{ flex: 1 }} />
            {/* Model selector */}
            <button
              onClick={() => setPickerOpen((o) => !o)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 8px",
                height: 24,
                borderRadius: 5,
                background: pickerOpen ? T.bg3 : T.bg2,
                border: `1px solid ${pickerOpen ? T.borderStrong : T.border}`,
                color: T.fg2,
                cursor: "pointer",
                fontFamily: T.mono,
                fontSize: 11,
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.borderColor = T.borderStrong)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.borderColor = pickerOpen
                  ? T.borderStrong
                  : T.border)
              }
            >
              <ModelDot color={modelColor(model.id)} size={6} glow={false} />
              {model.id}
              <I.Chevron
                size={9}
                style={{
                  opacity: 0.5,
                  transform: pickerOpen ? "rotate(180deg)" : "none",
                }}
              />
            </button>
            {pickerOpen && (
              <ModelPicker
                active={model.id}
                onPick={(id) => {
                  onModelChange(id);
                  setPickerOpen(false);
                }}
                onClose={() => setPickerOpen(false)}
              />
            )}
            {/* TOOL chip: marks models that report the "tools" capability
                via /api/show. When present, write_file is injected into
                /api/chat requests for this chat — see Phase 3 tool loop in
                ollama.rs. Placed outside the picker button so it reads as a
                state indicator, not an action. */}
            {modelHasTools && (
              <span
                title="Model supports tool use — can save files via write_file"
                style={{
                  marginLeft: 4,
                  padding: "0 5px",
                  height: 16,
                  display: "inline-flex",
                  alignItems: "center",
                  borderRadius: 3,
                  background: T.green + "22",
                  color: T.green,
                  fontFamily: T.mono,
                  fontSize: 8,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                }}
              >
                TOOL
              </span>
            )}

            {isStreaming ? (
              <button
                onClick={onStop}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "0 10px",
                  height: 24,
                  background: T.red,
                  border: "none",
                  borderRadius: 5,
                  color: T.bg0,
                  cursor: "pointer",
                  fontFamily: T.mono,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                <I.Stop size={9} /> Stop
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!text.trim()}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "0 10px",
                  height: 24,
                  background: text.trim() ? T.amber : T.bg2,
                  border: "none",
                  borderRadius: 5,
                  color: text.trim() ? T.bg0 : T.fg3,
                  cursor: text.trim() ? "pointer" : "default",
                  fontFamily: T.mono,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                Send <span style={{ opacity: 0.6 }}>{MOD_GLYPH}{ENTER_GLYPH}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
