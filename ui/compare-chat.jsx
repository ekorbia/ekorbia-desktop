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

'use strict';
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
  // Bundled engine's context window, so each column's per-message footer
  // can show input as a budget against it. Null on Ollama/BYO.
  engineCtx = null,
  // (id) → { name, detail } — a model's plain name ("Balanced") and the
  // catalog's ("Gemma 4 12B"). Omitted, columns are headed by the id.
  nameOfModel,
  // Token and speed figures under each column: only with "technical
  // details" on. The column's head always shows the time taken.
  showDetails = false,
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
    // Rust-side `llm_list_models` (Phase B.1 proxy) — see ollama.rs.
    const invoke = getInvoke();
    if (!invoke) return;
    invoke('llm_list_models')
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
          data-compare-question
          style={{
            flexShrink: 0,
            display: "flex",
            justifyContent: "flex-end",
            padding: "18px 28px 14px",
          }}
        >
          <div
            style={{
              maxWidth: "80%",
              maxHeight: 132,
              overflowY: "auto",
              padding: "10px 14px",
              borderRadius: "16px 16px 4px 16px",
              background: T.bg2,
              color: T.fg,
              fontFamily: T.sans,
              fontSize: 13.5,
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
            }}
          >
            {userMessage.content}
          </div>
        </div>
      )}

      {/* Columns grid. Empty state when there's no user message yet — the
          composer is enabled and the body shows a friendly hint. Once a
          message is sent, the grid replaces the hint with N columns. */}
      {!userMessage ? (
        <CompareEmptyState models={models} nameOfModel={nameOfModel} />
      ) : (
        <div
          data-compare-grid
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridTemplateColumns,
            // The 1px gap over a border-coloured ground draws the line
            // between columns.
            background: T.border,
            gap: 1,
            margin: "0 28px 14px",
            border: `1px solid ${T.border}`,
            borderRadius: 14,
            overflow: "hidden",
          }}
        >
          {columns.map(({ model, message }) => (
            <CompareColumn
              key={model}
              model={model}
              message={message}
              onStop={() => message?.id && onStopColumn?.(message.id)}
              onKeep={() => message?.id && onKeep?.(message.id)}
              engineCtx={engineCtx}
              label={nameOfModel ? nameOfModel(model) : null}
              showDetails={showDetails}
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
        background: T.amber + "14",
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
          fontFamily: T.sans,
          fontSize: 12.5,
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
        style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg3 }}
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
        padding: "16px 20px 12px",
        borderBottom: `1px solid ${T.border}`,
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexShrink: 0,
        background: T.bg0,
      }}
    >
      <span
        style={{
          fontFamily: T.sans,
          fontSize: 15,
          color: T.fg,
          fontWeight: 600,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {chat?.title || "New comparison"}
      </span>
      <span
        data-compare-badge
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontFamily: T.sans,
          fontSize: 12,
          color: T.fg1,
          padding: "2px 9px",
          border: `1px solid ${T.border}`,
          borderRadius: 999,
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        <I.Columns size={12} />
        Comparing {modelCount} models
      </span>
      <span style={{ flex: 1 }} />
      {isStreaming && (
        <button
          onClick={onStopAll}
          data-stop-all
          style={ekBtn("secondary", { small: true })}
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

function CompareEmptyState({ models, nameOfModel }) {
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
          fontFamily: T.sans,
          fontSize: 13,
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
                borderRadius: 8,
                background: T.bg2,
                border: `1px solid ${T.border}`,
                fontFamily: T.sans,
                fontSize: 12.5,
                color: T.fg,
              }}
            >
              <ModelDot
                color={
                  typeof modelColor === "function" ? modelColor(m) : T.green
                }
                size={6}
              />
              {nameOfModel ? nameOfModel(m).name : m}
            </span>
          ))}
        </div>
        <div style={{ color: T.fg3 }}>
          Your question goes to {models.length === 2 ? "both" : `all ${models.length}`} models.
          Then choose the answer you want to carry on with.
        </div>
      </div>
    </div>
  );
}

function CompareColumn({ model, message, onStop, onKeep, engineCtx = null, label = null, showDetails = false }) {
  // The head names the model plainly and says how long it took — the one
  // figure worth comparing at a glance.
  const plainName = (label && label.name) || model;
  const plainDetail = (label && label.detail) || "";
  const tookMs = message && message.tokens && message.tokens.ms;
  const took = tookMs > 0
    ? (tookMs < 1500 ? "1 second" : `${Math.round(tookMs / 1000)} seconds`)
    : "";
  // A column is "in flight" while its stream is still going. The
  // streaming flag rides on the in-memory message; the persisted row
  // never carries it (handleSendMultiModel clears it on finalize).
  const streaming = !!message?.streaming;
  // Keep is allowed when the column has finalized AND produced
  // non-empty content (an errored stream that completed with no text
  // shouldn't be pickable — pick a sibling instead).
  const canKeep = !!message && !streaming && !!message.content;

  // Auto-scroll this column to the bottom as its reply streams in, so a
  // response that grows past the viewport keeps its tail visible — same
  // behaviour ChatPane gives single-model chats. Each column owns its
  // scroller (see the content region below), so they follow independently.
  // Keyed on the message content (grows per delta) + the streaming flag.
  const scrollerRef = React.useRef(null);
  React.useEffect(() => {
    if (scrollerRef.current)
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [message?.content, streaming]);
  // The composer below grows as the user types; keep this column's tail in
  // view while it does (hook lives in chat.jsx).
  useStickToBottomOnResize(scrollerRef);

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
          margin: "0 18px",
          padding: "12px 0 9px",
          borderBottom: `1px solid ${T.border}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <ModelDot
          color={typeof modelColor === "function" ? modelColor(model) : T.green}
          size={7}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            overflow: "hidden",
            whiteSpace: "nowrap",
            fontFamily: T.sans,
          }}
          title={model}
        >
          <span data-compare-model-name style={{ fontSize: 13, fontWeight: 600, color: T.fg }}>
            {plainName}
          </span>
          {plainDetail && (
            <span data-compare-model-detail style={{ fontSize: 12, color: T.fg2, overflow: "hidden", textOverflow: "ellipsis" }}>
              {plainDetail}
            </span>
          )}
        </span>
        {!streaming && took && (
          <span data-compare-took style={{ fontFamily: T.sans, fontSize: 12, color: T.fg2, flexShrink: 0 }}>
            {took}
          </span>
        )}
        {streaming && (
          <button
            onClick={onStop}
            data-stop-column
            title="Stop this column"
            style={{
              padding: "3px 8px",
              background: "transparent",
              border: `1px solid ${T.border}`,
              borderRadius: 8,
              color: T.fg2,
              fontFamily: T.sans,
              fontSize: 12,
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
        ref={scrollerRef}
        data-compare-scroll
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
            style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg3 }}
          >
            Waiting…
          </div>
        ) : streaming && !message.content ? (
          // Pre-first-token: TTFT can be several seconds with the bigger
          // models per the Phase 0 spike. Show a typing indicator rather
          // than an empty card so the user knows the column is alive —
          // or, when the model is reasoning first, its live thoughts
          // (ReasoningBlock lives in chat.jsx).
          message.reasoning ? (
            <>
              <ReasoningBlock
                text={message.reasoning}
                ms={message.thoughtMs}
                live={!!message.reasoningLive}
              />
              {!message.reasoningLive && (
                <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg3 }}>
                  <span className="typing-dot">●</span>{" "}
                  <span className="typing-dot">●</span>{" "}
                  <span className="typing-dot">●</span>
                </div>
              )}
            </>
          ) : (
            <div
              style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg3 }}
            >
              <span className="typing-dot">●</span>{" "}
              <span className="typing-dot">●</span>{" "}
              <span className="typing-dot">●</span>
            </div>
          )
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
            {message.reasoning && (
              // Folded to "Thought for N s" by now — the answer has begun.
              // whiteSpace reset: the block sets its own, and must not
              // inherit the streaming pre-wrap around its button.
              <div style={{ whiteSpace: "normal" }}>
                <ReasoningBlock
                  text={message.reasoning}
                  ms={message.thoughtMs}
                  live={streaming && !!message.reasoningLive}
                />
              </div>
            )}
            <MarkdownMessage
              content={message.content || ""}
              streaming={streaming}
            />
            {message.incomplete && !message.content && (
              <div
                style={{
                  marginTop: 6,
                  fontFamily: T.sans,
                  fontSize: 12,
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
            padding: "8px 18px 12px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          {message.tokens && showDetails ? (
            <span style={{ fontFamily: T.sans, fontSize: 12, flex: 1 }}>
              <TokenFooter tokens={message.tokens} engineCtx={engineCtx} />
            </span>
          ) : (
            <span style={{ flex: 1 }} />
          )}
          <button
            onClick={onKeep}
            disabled={!canKeep}
            data-keep
            title={canKeep ? "Keep this response" : "No content to keep"}
            style={ekBtn("secondary", { small: true, disabled: !canKeep })}
          >
            Continue with this answer
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
  const locked = !!disabled;
  const lockedForModels = disabledReason === "missing-models";
  // The one line under the box: why it is locked, or what a comparison
  // does not do. (A comparison sends the question and any attached
  // prompts — not the workspace's documents or notes.)
  let hint;
  if (isStreaming) hint = "The models are answering…";
  else if (lockedForModels) hint = "Install the missing models above to ask.";
  else if (locked) hint = "Pick a winner above to continue the chat with that model.";
  else hint = "A comparison does not read this workspace's documents.";

  const canSend = !locked && !isStreaming && !!text.trim();

  return (
    <div
      data-compare-composer
      style={{
        flexShrink: 0,
        width: "100%",
        maxWidth: 816,
        boxSizing: "border-box",
        margin: "0 auto",
        padding: "0 28px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 7,
      }}
    >
      <div
        style={{
          border: `1px solid ${T.border}`,
          borderRadius: 18,
          background: T.isLight ? T.bg0 : T.bg1,
          boxShadow: T.isLight ? "0 2px 10px rgba(23,25,30,0.06)" : "none",
          padding: "12px 12px 10px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          opacity: locked ? 0.6 : 1,
        }}
      >
        {/* Attached prompts ride along to every column. */}
        {attachedPrompts.length > 0 && !locked && (
          <div data-compare-prompt-chips style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {attachedPrompts.map((p) => (
              <span key={p.id} style={ekChip("plain")}>
                {p.name}
                {onDetachPrompt && (
                  <button
                    onClick={() => onDetachPrompt(p.id)}
                    aria-label={`Detach ${p.name}`}
                    title="Remove"
                    style={{
                      marginLeft: 1,
                      padding: 0,
                      width: 14,
                      height: 14,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "transparent",
                      border: "none",
                      color: T.fg2,
                      cursor: "pointer",
                    }}
                  >
                    <I.X size={9} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={locked || isStreaming}
            placeholder={
              locked
                ? "Choose an answer above"
                : modelCount === 2
                  ? "Ask both models"
                  : modelCount > 2
                    ? `Ask all ${modelCount} models`
                    : "Ask the models"
            }
            rows={2}
            style={{
              flex: 1,
              minWidth: 0,
              resize: "none",
              background: "transparent",
              border: "none",
              outline: "none",
              padding: "2px 0",
              color: T.fg,
              fontFamily: T.sans,
              fontSize: 14.5,
              lineHeight: 1.5,
            }}
          />
          {isStreaming ? (
            <button
              onClick={onStop}
              data-composer-stop
              aria-label="Stop"
              title="Stop all"
              style={{
                width: 32,
                height: 32,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: T.fg,
                border: "none",
                borderRadius: "50%",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <span style={{ width: 10, height: 10, borderRadius: 2, background: T.bg0 }} />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              data-compare-send
              aria-label="Send"
              title={`Send (${ENTER_GLYPH})`}
              style={{
                width: 32,
                height: 32,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: canSend ? T.fg : T.bg3,
                border: "none",
                borderRadius: "50%",
                color: canSend ? T.bg0 : T.fg3,
                cursor: canSend ? "pointer" : "default",
                flexShrink: 0,
              }}
            >
              <I.ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
      <div
        data-compare-hint
        style={ekHint({ textAlign: "center", color: locked && !lockedForModels ? T.fg1 : T.fg2 })}
      >
        {hint}
      </div>
    </div>
  );
}
