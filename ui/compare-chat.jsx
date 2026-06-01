// compare-chat.jsx — Multi-model comparison pane (Mockup A — Phase 4).
//
// Layout: header → single user-message bubble → N-column grid of
// streaming assistant responses → composer. Each column has its own
// per-stream Stop button while streaming and a "Keep this" button once
// the stream completes; clicking Keep transitions the tab to
// 'single-from-multi' via the parent's keepVariant handler.
//
// One-shot model (per the design): the composer is enabled only when
// there's no user message yet. After the first send, the user picks a
// winner; that picked variant becomes the canonical response and the
// chat re-routes to the standard ChatPane on the next render.
//
// Component contract:
//   props.chat            — { id, title, models: string[], messages: [...] }
//   props.isStreaming     — bool, true while any column is in flight
//   props.onSend          — (text: string) => void  (= handleSendMultiModel)
//   props.onStopAll       — ()             => void  (= handleStopMultiModel())
//   props.onStopColumn    — (asstId)       => void  (= handleStopMultiModel(id))
//   props.onKeep          — (asstId)       => void  (= keepVariant(id))
//   props.onCancel        — ()             => void  (close the tab)
//
// Don't add ES `import`/`export` — Babel-standalone, no bundler. Top-
// level `function` declarations land on `window` (see CLAUDE.md).

function CompareChatPane({
  chat,
  isStreaming,
  onSend,
  onStopAll,
  onStopColumn,
  onKeep,
  onCancel,
  // Attached prompts from the right-panel library. Plumbed through so
  // the same prompt prefix applies to all N columns of the comparison.
  // The chip strip above the composer renders these; clicking the X
  // chip calls onDetachPrompt(promptId).
  attachedPrompts = [],
  onDetachPrompt,
}) {
  const messages = chat?.messages || [];
  const models = chat?.models || [];

  // ── Uninstalled-model sanity check (Phase 5 polish) ────────────────
  // A multi-pending chat persists its `multi_models` list as JSON. If
  // the user un-pulls a model (`ollama rm gemma4:26b`) between sessions
  // and then reopens this chat, the column for that model would just
  // sit forever waiting for a load that can't happen. We fetch /api/tags
  // on mount and compare; any models missing get surfaced in a banner
  // and Send is disabled until they're available again.
  //
  // missing === null  →  still loading (no banner, no Send lock)
  // missing === []    →  all good (no banner)
  // missing.length>0  →  banner + Send locked
  const [missing, setMissing] = React.useState(null);
  React.useEffect(() => {
    if (!models.length) return;
    let cancelled = false;
    fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (cancelled) return;
        const installed = new Set(
          (data.models || []).map((m) => m.name).filter(Boolean),
        );
        const gap = models.filter((m) => !installed.has(m));
        setMissing(gap);
      })
      .catch(() => {
        // Ollama unreachable: don't show a false banner. The standard
        // "Ollama not running" handling in handleSendMultiModel will
        // surface a per-column error if the user tries to send.
        if (!cancelled) setMissing([]);
      });
    return () => {
      cancelled = true;
    };
    // Re-run if the model list changes (e.g. tab swapped chats in place).
  }, [models.join("|")]);
  const sendLocked = (missing?.length || 0) > 0;

  // For compare-mode v1 there's at most one user message and N assistant
  // variants. find() is O(messages) but messages.length ≤ 4 in practice
  // (1 user + up to 3 variants), so the cost is negligible vs. a Map.
  const userMessage = React.useMemo(
    () => messages.find((m) => m.role === "user"),
    [messages],
  );

  // Build one column descriptor per declared model. We always render
  // a column even if the assistant row hasn't arrived yet (e.g. stream
  // is in flight) so the layout stays stable while content fills in.
  const columns = React.useMemo(
    () =>
      models.map((model) => ({
        model,
        message: messages.find(
          (m) =>
            m.role === "assistant" &&
            m.model === model &&
            m.variantGroupId,
        ),
      })),
    [models, messages],
  );

  const cols = Math.max(1, Math.min(3, columns.length));
  const gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

  return (
    <div
      data-compare-pane
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: T.bg0,
        overflow: "hidden",
      }}
    >
      <CompareHeader
        chat={chat}
        modelCount={models.length}
        isStreaming={isStreaming}
        onStopAll={onStopAll}
        onCancel={onCancel}
      />

      {/* Uninstalled-model banner. Renders above everything else so the
          user notices before trying to send. Disables Send below until
          all models are installed. */}
      {missing && missing.length > 0 && (
        <CompareMissingBanner missing={missing} />
      )}

      {/* User message bubble — rendered once above the grid so the same
          input doesn't repeat across columns. Compare-mode v1 has at
          most one user message; future versions that allow follow-up
          comparisons would render a list here. */}
      {userMessage && (
        <div
          style={{
            padding: "10px 24px 14px",
            borderBottom: `1px solid ${T.border}`,
            fontFamily: T.sans,
            fontSize: 13.5,
            color: T.fg,
            lineHeight: 1.55,
            background: T.bg1,
          }}
        >
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 10,
              color: T.fg3,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              marginBottom: 4,
            }}
          >
            You
          </div>
          <div style={{ whiteSpace: "pre-wrap" }}>{userMessage.content}</div>
        </div>
      )}

      {/* Columns grid. Empty state when there's no user message yet — the
          composer is enabled and the body shows a friendly hint. Once a
          message is sent, the grid replaces the hint with N columns. */}
      {!userMessage ? (
        <CompareEmptyState models={models} />
      ) : (
        <div
          data-compare-grid
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridTemplateColumns,
            background: T.border,
            gap: 1,
          }}
        >
          {columns.map(({ model, message }) => (
            <CompareColumn
              key={model}
              model={model}
              message={message}
              onStop={() => message?.id && onStopColumn?.(message.id)}
              onKeep={() => message?.id && onKeep?.(message.id)}
            />
          ))}
        </div>
      )}

      <CompareComposer
        modelCount={models.length}
        // Compare-mode v1 = one user message per chat. Once it's sent,
        // the composer is locked until the user picks a winner (which
        // transitions the tab to single-from-multi and re-routes
        // rendering to ChatPane + the standard Composer). Also locked
        // when any selected model is missing (see banner above).
        disabled={!!userMessage || sendLocked}
        // Distinct messaging for the missing-models case so the user
        // knows WHY the composer is locked instead of just "Pick a
        // winner above" (which doesn't apply pre-send).
        disabledReason={sendLocked ? "missing-models" : null}
        isStreaming={isStreaming}
        onSend={(text) => onSend?.(text)}
        onStop={onStopAll}
        attachedPrompts={attachedPrompts}
        onDetachPrompt={onDetachPrompt}
      />
    </div>
  );
}

// Inline banner shown when one or more selected models aren't installed.
// Uses amber accents to flag attention without the alarm of a red error
// state — the chat itself is fine, the user just needs to pull or swap.
function CompareMissingBanner({ missing }) {
  const cmd = missing.map((m) => `ollama pull ${m}`).join(" && ");
  return (
    <div
      data-compare-missing-banner
      style={{
        padding: "10px 20px",
        borderBottom: `1px solid ${T.border}`,
        background: "rgba(212, 138, 80, 0.08)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontFamily: T.sans,
          fontSize: 12.5,
          color: T.fg,
          fontWeight: 500,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={{ color: T.amber }}>⚠</span>
        {missing.length === 1
          ? "1 model is no longer installed"
          : `${missing.length} models are no longer installed`}
      </div>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 11,
          color: T.fg2,
          display: "flex",
          flexWrap: "wrap",
          gap: 5,
        }}
      >
        {missing.map((m) => (
          <span
            key={m}
            data-missing-model={m}
            style={{
              padding: "1px 6px",
              borderRadius: 3,
              background: T.bg2,
              border: `1px solid ${T.border}`,
            }}
          >
            {m}
          </span>
        ))}
      </div>
      <div
        style={{ fontFamily: T.mono, fontSize: 11, color: T.fg3 }}
      >
        Compare mode needs every selected model. Run{" "}
        <span style={{ color: T.amber }}>{cmd}</span> to restore — or close
        this chat and start a new comparison.
      </div>
    </div>
  );
}

function CompareHeader({ chat, modelCount, isStreaming, onStopAll, onCancel }) {
  return (
    <div
      style={{
        padding: "10px 20px",
        borderBottom: `1px solid ${T.border}`,
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexShrink: 0,
        background: T.bg1,
      }}
    >
      <span
        style={{
          fontFamily: T.mono,
          fontSize: 10,
          color: T.amber,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          padding: "2px 6px",
          border: `1px solid rgba(212, 138, 80, 0.4)`,
          borderRadius: 4,
        }}
      >
        Compare {modelCount}
      </span>
      <span
        style={{
          fontFamily: T.sans,
          fontSize: 13,
          color: T.fg,
          fontWeight: 500,
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {chat?.title || "New comparison chat"}
      </span>
      {isStreaming && (
        <button
          onClick={onStopAll}
          data-stop-all
          style={{
            padding: "4px 10px",
            background: "transparent",
            border: `1px solid ${T.border}`,
            borderRadius: 4,
            color: T.fg2,
            fontFamily: T.mono,
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          Stop all
        </button>
      )}
      {onCancel && (
        <button
          onClick={onCancel}
          aria-label="Close tab"
          title="Close tab"
          style={{
            padding: 4,
            background: "transparent",
            border: "none",
            color: T.fg3,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = T.fg)}
          onMouseLeave={(e) => (e.currentTarget.style.color = T.fg3)}
        >
          <I.X size={11} />
        </button>
      )}
    </div>
  );
}

function CompareEmptyState({ models }) {
  return (
    <div
      data-compare-empty
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
        background: T.bg0,
      }}
    >
      <div
        style={{
          maxWidth: 480,
          textAlign: "center",
          fontFamily: T.mono,
          fontSize: 12.5,
          color: T.fg2,
          lineHeight: 1.6,
        }}
      >
        <div
          style={{
            fontFamily: T.sans,
            fontSize: 15,
            color: T.fg,
            fontWeight: 500,
            marginBottom: 12,
          }}
        >
          Ready to compare {models.length} models
        </div>
        <div style={{ marginBottom: 16 }}>
          {models.map((m) => (
            <span
              key={m}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 8px",
                margin: 2,
                borderRadius: 4,
                background: T.bg2,
                border: `1px solid ${T.border}`,
                fontFamily: T.mono,
                fontSize: 11,
                color: T.fg,
              }}
            >
              <ModelDot
                color={
                  typeof modelColor === "function" ? modelColor(m) : "#9bbf83"
                }
                size={6}
              />
              {m}
            </span>
          ))}
        </div>
        <div style={{ color: T.fg3 }}>
          Type a message below — it goes to all {models.length} models in
          parallel. Pick a winner to continue the chat with that model.
        </div>
      </div>
    </div>
  );
}

function CompareColumn({ model, message, onStop, onKeep }) {
  // A column is "in flight" while its stream is still going. The
  // streaming flag rides on the in-memory message; the persisted row
  // never carries it (handleSendMultiModel clears it on finalize).
  const streaming = !!message?.streaming;
  // Keep is allowed when the column has finalized AND produced
  // non-empty content (an errored stream that completed with no text
  // shouldn't be pickable — pick a sibling instead).
  const canKeep = !!message && !streaming && !!message.content;

  return (
    <div
      data-compare-column
      data-model={model}
      style={{
        background: T.bg0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          borderBottom: `1px solid ${T.border}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
          background: T.bg1,
        }}
      >
        <ModelDot
          color={typeof modelColor === "function" ? modelColor(model) : "#9bbf83"}
          size={7}
        />
        <span
          style={{
            fontFamily: T.mono,
            fontSize: 11.5,
            color: T.fg,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={model}
        >
          {model}
        </span>
        {streaming && (
          <button
            onClick={onStop}
            data-stop-column
            title="Stop this column"
            style={{
              padding: "3px 8px",
              background: "transparent",
              border: `1px solid ${T.border}`,
              borderRadius: 4,
              color: T.fg2,
              fontFamily: T.mono,
              fontSize: 10.5,
              cursor: "pointer",
            }}
          >
            Stop
          </button>
        )}
      </div>

      {/* Content scroll region. Each column scrolls independently so a
          long response in one model doesn't push the others' viewports
          around. minHeight:0 is mandatory for flex-child overflow to
          actually clip — without it the column grows to fit content. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "12px 14px",
        }}
      >
        {!message ? (
          // No assistant row yet — either the stream hasn't kicked off
          // for this column, or the user hasn't sent yet. Shouldn't
          // really show in normal flow (CompareEmptyState catches the
          // pre-send case) but defensively guard.
          <div
            style={{ fontFamily: T.mono, fontSize: 11, color: T.fg3 }}
          >
            Waiting…
          </div>
        ) : streaming && !message.content ? (
          // Pre-first-token: TTFT can be several seconds with the bigger
          // models per the Phase 0 spike. Show a typing indicator rather
          // than an empty card so the user knows the column is alive.
          <div
            style={{ fontFamily: T.mono, fontSize: 11, color: T.fg3 }}
          >
            <span className="typing-dot">●</span>{" "}
            <span className="typing-dot">●</span>{" "}
            <span className="typing-dot">●</span>
          </div>
        ) : (
          // MarkdownMessage handles streaming vs. finalized internally
          // (plaintext branch while streaming, parsed markdown when done)
          // — see ui/markdown.jsx. We pass `streaming` so it does the
          // right thing without us re-implementing the branch.
          <div
            style={{
              fontFamily: T.sans,
              fontSize: 13.5,
              color: T.fg,
              lineHeight: 1.55,
              whiteSpace: streaming ? "pre-wrap" : undefined,
            }}
          >
            <MarkdownMessage
              content={message.content || ""}
              streaming={streaming}
            />
            {message.incomplete && !message.content && (
              <div
                style={{
                  marginTop: 6,
                  fontFamily: T.mono,
                  fontSize: 10.5,
                  color: T.fg3,
                  fontStyle: "italic",
                }}
              >
                (no response — this model may be unavailable)
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer with Keep button + token info. Hidden while streaming so
          the column doesn't reflow as the stream ends. */}
      {!streaming && message && (
        <div
          style={{
            padding: "8px 12px",
            borderTop: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
            background: T.bg1,
          }}
        >
          {message.tokens && (
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 10,
                color: T.fg3,
                flex: 1,
              }}
            >
              {message.tokens.in || 0}/{message.tokens.out || 0} tok ·{" "}
              {Math.round((message.tokens.ms || 0) / 100) / 10}s
            </span>
          )}
          {!message.tokens && <span style={{ flex: 1 }} />}
          <button
            onClick={onKeep}
            disabled={!canKeep}
            data-keep
            title={canKeep ? "Keep this response" : "No content to keep"}
            style={{
              padding: "5px 14px",
              background: canKeep ? T.bg4 : T.bg2,
              border: `1px solid ${canKeep ? T.borderStrong : T.border}`,
              borderRadius: 4,
              color: canKeep ? T.fg : T.fg3,
              fontFamily: T.mono,
              fontSize: 11,
              cursor: canKeep ? "pointer" : "not-allowed",
            }}
          >
            ✓ Keep this
          </button>
        </div>
      )}
    </div>
  );
}

// Minimal composer for compare mode. Deliberately not the main Composer
// from chat.jsx — that one carries attachments, prompts, model picker,
// vision/tools badges, all of which don't apply in compare-mode v1.
// Submit-on-Enter / shift+Enter newline behaviour mirrors the main one
// so muscle memory transfers.
function CompareComposer({
  modelCount,
  disabled,
  // Optional discriminator on why the composer is disabled — affects
  // which hint string we show. Currently:
  //   null              → generic disabled state ("Pick a winner above")
  //   'missing-models'  → uninstalled-model banner above is already
  //                       explaining the situation; we just adjust the
  //                       hint to match.
  disabledReason = null,
  isStreaming,
  onSend,
  onStop,
  attachedPrompts = [],
  onDetachPrompt,
}) {
  const [text, setText] = React.useState("");
  const textareaRef = React.useRef(null);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || isStreaming) return;
    setText("");
    onSend?.(trimmed);
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Hint states: pre-send (live), during-stream (locked), post-send-
  // pre-pick (locked), and missing-models (locked but different reason).
  let hint;
  if (isStreaming) hint = "Streaming…";
  else if (disabledReason === "missing-models")
    hint = "Composer locked — install the missing models above";
  else if (disabled) hint = "Pick a winner above to continue the chat";
  else hint = `Send to all ${modelCount} models — ${MOD_GLYPH}${ENTER_GLYPH}`;

  return (
    <div
      data-compare-composer
      style={{
        padding: "10px 16px",
        borderTop: `1px solid ${T.border}`,
        background: T.bg1,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {/* Attached-prompt chip strip — mirrors the regular Composer's
          attached-prompts row so the same affordance carries into
          compare-mode. Hidden when nothing is attached so the composer
          stays compact for unattached sends. */}
      {attachedPrompts.length > 0 && !disabled && (
        <div
          data-compare-prompt-chips
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 5,
          }}
        >
          {attachedPrompts.map((p) => {
            const fav = p.favorite ? FAVORITE_COLOR_MAP[p.favorite] : null;
            return (
              <span
                key={p.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "2px 6px 2px 8px",
                  background: T.bg2,
                  border: `1px solid ${T.border}`,
                  borderRadius: 4,
                  fontFamily: T.mono,
                  fontSize: 11,
                  color: T.fg,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 99,
                    background: fav?.color || T.fg3,
                    flexShrink: 0,
                  }}
                />
                {p.name}
                {onDetachPrompt && (
                  <button
                    onClick={() => onDetachPrompt(p.id)}
                    aria-label={`Detach ${p.name}`}
                    title="Detach prompt"
                    style={{
                      marginLeft: 2,
                      padding: 0,
                      width: 14,
                      height: 14,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "transparent",
                      border: "none",
                      color: T.fg3,
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.color = T.fg)
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.color = T.fg3)
                    }
                  >
                    <I.X size={9} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 10,
          color: T.fg3,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        {hint}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled || isStreaming}
          placeholder={
            disabled
              ? "Composer locked — pick a column above"
              : "Type your prompt…"
          }
          rows={2}
          style={{
            flex: 1,
            resize: "none",
            background: T.bg2,
            border: `1px solid ${T.border}`,
            borderRadius: 5,
            padding: "8px 10px",
            color: T.fg,
            fontFamily: T.sans,
            fontSize: 13,
            lineHeight: 1.5,
            opacity: disabled || isStreaming ? 0.6 : 1,
          }}
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            data-composer-stop
            style={{
              padding: "8px 14px",
              background: T.bg4,
              border: `1px solid ${T.borderStrong}`,
              borderRadius: 5,
              color: T.fg,
              fontFamily: T.mono,
              fontSize: 11.5,
              cursor: "pointer",
            }}
          >
            Stop
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={disabled || !text.trim()}
            data-compare-send
            style={{
              padding: "8px 14px",
              background: disabled || !text.trim() ? T.bg2 : T.bg4,
              border: `1px solid ${
                disabled || !text.trim() ? T.border : T.borderStrong
              }`,
              borderRadius: 5,
              color: disabled || !text.trim() ? T.fg3 : T.fg,
              fontFamily: T.mono,
              fontSize: 11.5,
              cursor: disabled || !text.trim() ? "not-allowed" : "pointer",
            }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
