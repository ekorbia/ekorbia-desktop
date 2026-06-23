// overlay.jsx — Spotlight-style quick-query panel (⌘⇧Space)
//
// This file is loaded into *every* webview but only mounts a React root
// when its window's label is "overlay". The same trick keeps main.jsx
// from rendering <App /> here (see the bottom of main.jsx).

const { useState: qS, useEffect: qE, useRef: qR } = React;

// Fallback model for the very first overlay open, before we've validated
// against what's actually pulled (the mount effect below switches to the main
// window's model — or the first installed model — if this one isn't available).
// The overlay keeps its OWN sticky choice (`ekorbia.overlay.model`, a separate
// key from the composer's `ekorbia.main.model`) so you can run a small, fast
// model here independent of the main window.
const QUICK_DEFAULT_MODEL = "gemma4:e4b";

// Window heights (px) for the three states. Driven by the overlay_resize
// Rust command rather than JS-side LogicalSize plumbing.
const COLLAPSED_H = 100; // input row + context bar, no picker/response
const PICKER_H = 360; //   picker open (model list or prompt list)
const EXPANDED_H = 480; // streaming or response visible

function QuickQuery() {
  // ── Query / streaming ──────────────────────────────────────────────────────
  const [text, setText] = qS("");
  // Suppress overlay auto-hide (blur + Esc) while a dictation is in flight so
  // an accidental focus change — or the Esc-to-cancel keystroke — doesn't
  // discard the recording. The ref mirrors the state for the []-deps
  // window/document listeners below (which close over first-render values).
  const [voiceRecording, setVoiceRecording] = qS(false);
  const voiceRecRef = qR(false);
  qE(() => {
    voiceRecRef.current = voiceRecording;
  }, [voiceRecording]);
  // `sentMessage` is the user's previously-submitted question, frozen at
  // send time. We snapshot it because `text` clears the moment the request
  // fires (so the input is ready for the next question) — but we still
  // want to *show* the question above its response so the user has
  // context, especially mid-stream.
  const [sentMessage, setSentMessage] = qS("");
  const [response, setResponse] = qS("");
  const [streaming, setStreaming] = qS(false);
  const inputRef = qR(null);
  const abortRef = qR(null);
  // Per-model "is this a reasoning model?" cache. Reasoning models default
  // thinking ON in Ollama, which would make the overlay (a quick-lookup
  // tool where speed matters most) sit blank for seconds. We send
  // `think: false` for them — but only them, since the flag 400s on
  // non-thinking models. Rust caches the capability too; this ref just
  // avoids re-invoking per submit.
  const thinkCapRef = qR({});

  // ── Model selection (persisted) ────────────────────────────────────────────
  // Inlined the localStorage dance instead of reaching for main.jsx's
  // usePersistedState — keeps this file self-contained.
  const [modelId, setModelId] = qS(() => {
    try {
      return localStorage.getItem("ekorbia.overlay.model") || QUICK_DEFAULT_MODEL;
    } catch {
      return QUICK_DEFAULT_MODEL;
    }
  });
  qE(() => {
    try {
      localStorage.setItem("ekorbia.overlay.model", modelId);
    } catch {}
  }, [modelId]);

  // The overlay's sticky model pref can point at a model that isn't pulled
  // (the first-run default, or one removed since). Unlike the composer, the
  // overlay had no fallback — it would just fail the send and mislabel it as
  // "Ollama isn't running". On mount, validate against what's installed and,
  // if our pick is missing, fall back to the main window's model (if pulled)
  // or the first installed model. No-op when Ollama is genuinely down
  // (empty/failed tags) so submit() can still surface that for real.
  qE(() => {
    const inv = getInvoke();
    if (!inv) return;
    inv("ollama_tags")
      .then((data) => {
        const names = (data?.models || []).map((m) => m.name);
        if (!names.length || names.includes(modelId)) return;
        let mainModel = null;
        try {
          mainModel = localStorage.getItem("ekorbia.main.model");
        } catch {}
        setModelId(mainModel && names.includes(mainModel) ? mainModel : names[0]);
      })
      .catch(() => {});
  }, []);

  // ── Available models (queried from Ollama, like the Composer picker) ───────
  // `null` = haven't fetched yet (or fetching). Empty array = fetched but
  // nothing is pulled. `error` non-null = the fetch failed (Ollama down).
  const [availableModels, setAvailableModels] = qS(null);
  const [modelsError, setModelsError] = qS(null);

  // ── Prompt library + single-prompt attachment ──────────────────────────────
  // Single-select keeps the overlay focused: the whole point of this panel is
  // "one query, one answer, dismiss". Multi-attach is for the main composer.
  //
  // The attached prompt is sticky across invocations — many quick-query
  // workflows reuse the same persona (rubber-duck debugging, German
  // translator, etc.). The user explicitly detaches when they want to
  // change context.
  const [prompts, setPrompts] = qS([]);
  const [attachedPromptId, setAttachedPromptId] = qS(() => {
    try {
      return localStorage.getItem("ekorbia.overlay.prompt") || null;
    } catch {
      return null;
    }
  });
  qE(() => {
    try {
      if (attachedPromptId) {
        localStorage.setItem("ekorbia.overlay.prompt", attachedPromptId);
      } else {
        localStorage.removeItem("ekorbia.overlay.prompt");
      }
    } catch {}
  }, [attachedPromptId]);
  const [promptSearch, setPromptSearch] = qS("");
  const attached = attachedPromptId
    ? prompts.find((p) => p.id === attachedPromptId)
    : null;

  // ── Picker visibility ──────────────────────────────────────────────────────
  // Single-string state instead of two booleans because only one picker can
  // be open at a time anyway.
  const [picker, setPicker] = qS(null); // 'model' | 'prompt' | null

  // Fallback to a rejecting stub so the rest of the component can use
  // `invoke(...)` unconditionally — the overlay window runs in non-Tauri
  // dev (pure-browser preview) where there's nothing to invoke.
  const invoke = getInvoke() ?? (() => Promise.reject("no tauri"));

  // ── Load prompts from the shared file-system store ─────────────────────────
  // Runs once at mount. Rust seeds built-ins on startup before any window is
  // shown, so this is reliable even on a cold launch. Prompts are returned
  // already shaped (tags as array, favorite from prompt_meta join) — no
  // post-processing needed beyond the favorite-null normalisation.
  qE(() => {
    invoke("prompts_list")
      .then((rows) => {
        const loaded = (rows || []).map((r) => ({
          ...r,
          favorite: r.favorite ?? null,
        }));
        setPrompts(loaded);
        // Drop the persisted attachment if its prompt has since been
        // deleted in the main window — otherwise the chip would render
        // with empty data and the system message would be empty too.
        setAttachedPromptId((curr) =>
          curr && !loaded.find((p) => p.id === curr) ? null : curr,
        );
      })
      .catch(() => setPrompts([]));
  }, []);

  // ── Fetch /api/tags whenever the model picker opens ────────────────────────
  // Re-fetching on each open keeps the list fresh after the user pulls or
  // removes a model in Ollama. Matches the Composer's ModelPicker behaviour.
  qE(() => {
    if (picker !== "model") return;
    setAvailableModels(null);
    setModelsError(null);
    // Rust-side `ollama_tags` (Phase B.1 proxy) — see ollama.rs for why.
    invoke('ollama_tags')
      .then((data) => setAvailableModels(data.models || []))
      .catch(() => {
        setAvailableModels([]);
        setModelsError("Ollama not running");
      });
  }, [picker]);

  // ── Dismiss ────────────────────────────────────────────────────────────────
  const hide = async () => {
    // Phase B.2: cancellation is an IPC ping; the in-flight Rust
    // streaming command picks it up at the next chunk boundary and
    // exits cleanly. We fire-and-forget; whether the cancel reaches
    // an active stream or no-ops on a finished one is fine.
    if (abortRef.current) {
      invoke('ollama_chat_stream_cancel', { requestId: abortRef.current })
        .catch(() => {});
    }
    abortRef.current = null;
    setStreaming(false);
    setPicker(null);
    try {
      await invoke("overlay_resize", { height: COLLAPSED_H });
      await invoke("overlay_hide");
    } catch {}
    // Reset visible state after the hide animation so the user sees a clean
    // slate on next ⌘⇧Space without flickering during the transition. We
    // *don't* reset attachedPromptId here — it's persisted across
    // invocations on purpose (see the localStorage hook above).
    setTimeout(() => {
      setText("");
      setSentMessage("");
      setResponse("");
      setPromptSearch("");
    }, 120);
  };

  // ── Re-focus + clear on each invocation ────────────────────────────────────
  qE(() => {
    const onFocus = () => {
      setText("");
      setSentMessage("");
      setResponse("");
      setStreaming(false);
      setPicker(null);
      // attachedPromptId is intentionally NOT reset — it's sticky across
      // invocations (persisted in localStorage). The user clears it
      // explicitly by clicking the chip's × or picking the same prompt
      // again in the picker.
      setPromptSearch("");
      setTimeout(() => inputRef.current?.focus(), 0);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // ── Auto-hide on blur ──────────────────────────────────────────────────────
  // Window-level blur fires when the overlay loses focus to another app or
  // window — clicking on the desktop, ⌘-Tab away, opening a notification.
  // Spotlight/Raycast convention is to dismiss in all of those cases. The
  // closure over `hide` captures the first-render version; that's fine
  // because hide only touches setState callbacks and refs, all of which
  // are stable across renders.
  qE(() => {
    const onBlur = () => {
      // Don't dismiss mid-dictation — an accidental focus change shouldn't
      // discard a recording in progress.
      if (voiceRecRef.current) return;
      hide();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  // ── ⎋ behaviour ────────────────────────────────────────────────────────────
  // First press closes any open picker; second press hides the overlay. This
  // mirrors what users expect from native pop-overs.
  qE(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        // While dictating, Esc cancels the recording (handled by the mic
        // button) — don't also dismiss the overlay or close the picker.
        if (voiceRecRef.current) return;
        e.preventDefault();
        if (picker) setPicker(null);
        else hide();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [picker]);

  // ── Auto-resize the OS window ──────────────────────────────────────────────
  // Priorities: picker beats response (the user opened the picker to do
  // something), response beats idle.
  qE(() => {
    let h = COLLAPSED_H;
    if (picker) h = PICKER_H;
    else if (response || streaming) h = EXPANDED_H;
    invoke("overlay_resize", { height: h }).catch(() => {});
  }, [picker, response, streaming]);

  // Single-select toggle. Clicking the already-selected prompt clears it.
  const pickPrompt = (id) => {
    setAttachedPromptId((curr) => (curr === id ? null : id));
    setPicker(null);
  };

  // ── "Send to main" ─────────────────────────────────────────────────────────
  // Materialise the current overlay session as a real chat in the main app:
  //   1. Insert the chat row + the two messages via the existing DB commands
  //   2. Emit a Tauri event so the main window opens the chat in a tab and
  //      adds it to the sidebar history
  //   3. Focus the main window
  //   4. Hide the overlay
  //
  // Note: the system prompt is intentionally NOT persisted as a message — the
  // main app only renders user/assistant rows. The attached prompt is
  // captured on the user message's `prompts_json` metadata so its chip
  // still appears in the main UI; follow-up messages in main won't have it
  // auto-re-attached (a "remembered system prompt" feature is V2).
  const sendToMain = async () => {
    if (streaming || !response.trim()) return;

    const r36 = () =>
      Math.floor(Math.random() * 36 ** 5)
        .toString(36)
        .padStart(5, "0");
    const chatId = `q-${Date.now().toString(36)}-${r36()}`;
    const userId = `m-u-${r36()}`;
    const asstId = `m-a-${r36()}`;

    // sentMessage, not text: submit() cleared text the moment the request
    // fired (so the input is ready for the next question). text is the
    // *next* question (probably empty); sentMessage is the one whose
    // answer is on screen.
    const title = (sentMessage.trim().slice(0, 40) || "Quick query").trim();
    const nowTs = Math.floor(Date.now() / 1000);
    const d = new Date();
    const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

    // If a prompt was attached, denormalize the same metadata the composer
    // writes — id, name, and a hex color resolved from the favorite — so
    // the main app's Message component renders an identical chip.
    let promptsJson = null;
    if (attached) {
      const fav = attached.favorite
        ? FAVORITE_COLOR_MAP[attached.favorite]
        : null;
      promptsJson = JSON.stringify([
        { id: attached.id, name: attached.name, color: fav?.color || null },
      ]);
    }

    try {
      await invoke("db_upsert_chat", {
        chat: {
          id: chatId,
          title,
          model: modelId,
          createdAt: nowTs,
          updatedAt: nowTs,
        },
      });
      await invoke("db_upsert_message", {
        msg: {
          id: userId,
          chatId,
          // Same reason as the title above: text is now empty/the next
          // question. sentMessage is the question the persisted assistant
          // reply actually answered.
          role: "user",
          content: sentMessage,
          model: null,
          time: timeStr,
          tokensIn: null,
          tokensOut: null,
          tokensMs: null,
          promptsJson,
          seq: 0,
        },
      });
      await invoke("db_upsert_message", {
        msg: {
          id: asstId,
          chatId,
          role: "assistant",
          content: response,
          model: modelId,
          time: timeStr,
          tokensIn: null,
          tokensOut: null,
          tokensMs: null,
          promptsJson: null,
          seq: 1,
        },
      });

      // Notify the main window. Payload carries the minimum the main app
      // needs to open a tab; messages come back via db_load_messages.
      // Non-optional chain: this branch only runs after a successful
      // `invoke(...)` round-trip, so the Tauri event bridge is known
      // present. A defensive `?.()` here would mask startup-order bugs.
      await getEventApi().emit("overlay:open_chat", {
        id: chatId,
        title,
        model: modelId,
        // Hand the attached prompt off to the main window's composer so
        // follow-up messages reuse the same persona without the user
        // having to re-pick it. Main resolves the full prompt object
        // from its own prompts_list cache by id.
        promptId: attached?.id || null,
      });
      await invoke("focus_main");
      await hide();
    } catch (e) {
      console.error("Failed to send to main:", e);
    }
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  // Single-turn ephemeral chat. The attached prompt's body becomes a system
  // message — same shape the main app uses for new chats.
  const submit = async () => {
    if (!text.trim() || streaming) return;
    setStreaming(true);
    setResponse("");
    setPicker(null);
    // Snapshot the question before clearing the input so we can show it
    // above the streaming response. Each submit replaces the previous
    // snapshot — only the most recent Q&A pair stays visible.
    setSentMessage(text);
    // Clear the input as soon as the request is fired so the user can start
    // typing their next question while the answer is still streaming in.
    // The `text` value is captured in this closure for the messages array
    // below — clearing the state doesn't affect what gets sent.
    setText("");
    // Phase B.2: cancellation now goes through ollama_chat_stream_cancel.
    // abortRef holds the requestId (the overlay reuses a single id since
    // it only ever has one in-flight stream — a submit while another
    // streams is gated by the `streaming` state above).
    const requestId = `overlay-${Date.now().toString(36)}`;
    abortRef.current = requestId;

    const messages = attached
      ? [
          { role: "system", content: attached.body },
          { role: "user", content: text },
        ]
      : [{ role: "user", content: text }];

    let acc = "";
    try {
      const Channel = getChannel();
      const channel = new Channel();
      channel.onmessage = (obj) => {
        if (obj?.message?.content) {
          acc += obj.message.content;
          setResponse(acc);
        }
      };
      // Gate thinking off for reasoning models (cached per model).
      let thinkCapable = thinkCapRef.current[modelId];
      if (thinkCapable === undefined) {
        try {
          const caps = await invoke('model_capabilities', { model: modelId });
          thinkCapable = !!caps?.thinking;
        } catch (_) {
          thinkCapable = false;
        }
        thinkCapRef.current[modelId] = thinkCapable;
      }
      const body = applyThinkPref({ model: modelId, messages, stream: true }, thinkCapable);
      await invoke('ollama_chat_stream', {
        requestId,
        body,
        onChunk: channel,
      });
    } catch (e) {
      // Rust returns Err for connection-refused / non-2xx / parse errors.
      // A user-cancelled stream returns Ok by design, so reaching here with
      // no output is a real failure. Distinguish "model not available" (the
      // overlay keeps its own model pref, which may not be pulled) from a
      // genuine "Ollama is down" — they point at different fixes.
      if (!acc) {
        const msg = String(e || "");
        if (/40\d|not found|no such model|try pulling|unknown model/i.test(msg)) {
          setResponse(
            `Model "${modelId}" isn't available in Ollama. Pick a pulled model from the list below.`,
          );
        } else {
          setResponse(
            "Couldn't reach Ollama on 127.0.0.1:11434. Open the main Ekorbia app to start it, or run `ollama serve`.",
          );
        }
      }
    }
    setStreaming(false);
  };

  // ── Derived render data ────────────────────────────────────────────────────
  // The expanded body shows up as soon as we have *anything* to show:
  // the sent message, the streaming indicator, or the response itself.
  // (sentMessage and streaming flip on within the same submit() call,
  // but sentMessage drives visibility so the question paints instantly
  // without waiting for the first streamed token.)
  const hasContent = !!response || streaming || !!sentMessage;
  // modelColor() is shared from components.jsx — hashes the model name into
  // one of MODEL_COLORS so the dot stays stable across renders even for
  // models that aren't in the static MODELS table.
  const modelDot = modelColor(modelId);

  // Filter first, then sort A→Z by name. prompts_list returns rows
  // sorted by updated_at DESC (the main app's "Recent" default), but
  // the overlay's prompt picker should match the main PromptLibrary's
  // default A→Z sort — easier to scan when you don't remember which
  // prompt you last edited. .slice() before sort so we don't mutate
  // the source array.
  const visiblePrompts = (promptSearch.trim()
    ? prompts.filter((p) => {
        const q = promptSearch.toLowerCase();
        return (
          p.name.toLowerCase().includes(q) ||
          (p.body || "").toLowerCase().includes(q) ||
          (p.tags || []).some((t) => t.toLowerCase().includes(q))
        );
      })
    : prompts
  ).slice().sort((a, b) => a.name.localeCompare(b.name));

  // ── Styles (defined once outside the JSX for readability) ──────────────────
  const ROW_PAD = "0 18px";
  const C_BG = "rgba(20, 20, 26, 0.94)";
  const C_BORDER = "rgba(255,255,255,0.05)";
  const C_BORDER_STRONG = "rgba(255,255,255,0.1)";
  const C_FG = "#e6e3dc";
  const C_FG1 = "#b8b4ab";
  const C_FG2 = "#8a877e";
  const C_FG3 = "#5e5c54";
  const C_BG2 = "rgba(255,255,255,0.04)";
  const C_BG3 = "rgba(255,255,255,0.08)";
  const C_BG4 = "rgba(255,255,255,0.12)";
  const C_AMBER = "#d48a50";
  const FONT_SANS = '"Inter", system-ui, sans-serif';
  const FONT_MONO = '"JetBrains Mono", monospace';

  return (
    <div
      style={{
        // Two OS-level effects sit under this div:
        //   • NSVisualEffectView (from apply_vibrancy in lib.rs) draws blur
        //     and masks the corners to 18px at the window level.
        //   • macOS adds the natural panel drop shadow for the Sidebar
        //     material — we don't need a CSS shadow.
        //
        // The translucent dark tint below carries contrast. Sidebar on
        // Sequoia is light enough that without this, light wallpapers
        // make the panel unreadable. ~0.72 alpha keeps Spotlight-style
        // contrast on any wallpaper while still letting the blur breathe.
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "rgba(20, 20, 26, 0.72)",
        // Must match the radius passed to apply_vibrancy in lib.rs. The
        // NSVisualEffectView is masked to a rounded shape at that radius;
        // without this CSS clip our rectangular dark tint paints into the
        // corners *outside* the vibrancy mask, drawing the rectangular
        // border you'd otherwise see.
        borderRadius: 18,
        color: C_FG,
        fontFamily: FONT_SANS,
      }}
    >
      {/* ── Input row ─────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: ROW_PAD,
          height: 60,
          flexShrink: 0,
        }}
      >
        <span style={{ color: C_AMBER, fontSize: 20, fontWeight: 600 }}>›</span>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask anything…"
          autoFocus
          style={{
            flex: 1,
            border: "none",
            background: "transparent",
            color: C_FG,
            fontFamily: FONT_SANS,
            fontSize: 17,
            outline: "none",
            padding: 0,
          }}
        />
        {/* Voice dictation — inserts the local Whisper transcript into the
            overlay input. No model yet → toast (the setup modal would be
            cramped in this small window). */}
        <VoiceMicButton
          disabled={streaming}
          onRecordingChange={setVoiceRecording}
          onNeedsSetup={() =>
            window.ekToast?.({
              kind: "info",
              title: "Set up voice input",
              body: "Download a speech model in the main window: Settings → Voice.",
            })
          }
          onInsert={(t) => {
            if (!t) return;
            const el = inputRef.current;
            const cur = text;
            let start = cur.length;
            let end = cur.length;
            if (el) {
              start = el.selectionStart != null ? el.selectionStart : cur.length;
              end = el.selectionEnd != null ? el.selectionEnd : cur.length;
            }
            const pre = cur.slice(0, start);
            const needsSpace = pre.length > 0 && !/\s$/.test(pre);
            const ins = (needsSpace ? " " : "") + t;
            setText(pre + ins + cur.slice(end));
            requestAnimationFrame(() => {
              try {
                if (el) {
                  el.focus();
                  const p = start + ins.length;
                  el.setSelectionRange(p, p);
                }
              } catch (_) {}
            });
          }}
        />
        {streaming && (
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              color: C_FG2,
              letterSpacing: 0.5,
              textTransform: "uppercase",
            }}
          >
            thinking…
          </span>
        )}
        {!streaming && !hasContent && !picker && (
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              color: C_FG3,
              letterSpacing: 0.4,
            }}
          >
            ⏎ ask · ⎋ close
          </span>
        )}
      </div>

      {/* ── Context bar ──────────────────────────────────────────────────── */}
      {/* Hosts the model picker trigger and the (at most one) prompt slot. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 16px 8px",
          height: 32,
          flexShrink: 0,
          borderBottom: hasContent || picker ? `1px solid ${C_BORDER}` : "none",
        }}
      >
        {/* Model picker trigger */}
        <button
          onClick={() =>
            setPicker((p) => (p === "model" ? null : "model"))
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: picker === "model" ? C_BG3 : C_BG2,
            border: `1px solid ${picker === "model" ? C_BORDER_STRONG : "transparent"}`,
            borderRadius: 4,
            padding: "3px 8px",
            cursor: "pointer",
            color: C_FG1,
            fontFamily: FONT_MONO,
            fontSize: 10.5,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 99,
              background: modelDot,
              boxShadow: `0 0 4px ${modelDot}88`,
            }}
          />
          <span>{modelId}</span>
          <span style={{ fontSize: 8, color: C_FG3 }}>▾</span>
        </button>

        <span style={{ color: C_FG3, fontFamily: FONT_MONO, fontSize: 10 }}>
          ·
        </span>

        {/* Prompt slot — either the attached chip, or a "+ prompt" trigger. */}
        {/* Clicking the chip body re-opens the picker (to swap), the × clears. */}
        {attached ? (() => {
          const fav = attached.favorite
            ? FAVORITE_COLOR_MAP[attached.favorite]
            : null;
          const favColor = fav?.color || null;
          return (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 4px 2px 7px",
                background: favColor ? favColor + "22" : C_BG2,
                border: `1px solid ${favColor ? favColor + "55" : C_BORDER_STRONG}`,
                borderRadius: 4,
                fontFamily: FONT_MONO,
                fontSize: 10,
                color: favColor || C_FG1,
                maxWidth: 220,
              }}
            >
              <button
                onClick={() =>
                  setPicker((p) => (p === "prompt" ? null : "prompt"))
                }
                title="Swap prompt"
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  color: "inherit",
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {attached.name}
              </button>
              <button
                onClick={() => setAttachedPromptId(null)}
                title="Detach"
                style={{
                  background: "none",
                  border: "none",
                  // Inherit the chip's text color (favColor when set,
                  // C_FG1 otherwise) so the × is always as visible as
                  // the chip's name. C_FG3 here was barely legible
                  // against the colored chip background.
                  color: "inherit",
                  opacity: 0.7,
                  cursor: "pointer",
                  padding: 0,
                  lineHeight: 1,
                  display: "inline-flex",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                ×
              </button>
            </span>
          );
        })() : (
          <button
            onClick={() =>
              setPicker((p) => (p === "prompt" ? null : "prompt"))
            }
            style={{
              background: picker === "prompt" ? C_BG3 : "transparent",
              border: `1px solid ${picker === "prompt" ? C_BORDER_STRONG : "transparent"}`,
              borderRadius: 4,
              padding: "3px 7px",
              cursor: "pointer",
              color: C_FG2,
              fontFamily: FONT_MONO,
              fontSize: 10.5,
            }}
          >
            + prompt
          </button>
        )}

        <span style={{ flex: 1 }} />
      </div>

      {/* ── Bottom area: picker OR response ──────────────────────────────── */}

      {/* Model picker — same content shape as the Composer's ModelPicker. */}
      {picker === "model" && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "6px 0",
          }}
        >
          <div
            style={{
              padding: "4px 14px 6px",
              fontFamily: FONT_MONO,
              // 10.5 (up from 9.5) + brighter color than the standard
              // section-label dim. Uppercase mono with letter-spacing
              // amplifies any contrast problem, so this label needs a
              // step or two more legibility than secondary text.
              fontSize: 10.5,
              color: C_FG1,
              textTransform: "uppercase",
              letterSpacing: 0.6,
            }}
          >
            Local models · ollama
          </div>

          {availableModels === null && (
            <div
              style={{
                padding: "12px 14px",
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: C_FG3,
              }}
            >
              <span className="typing-dot">●</span>{" "}
              <span className="typing-dot">●</span>{" "}
              <span className="typing-dot">●</span>
            </div>
          )}

          {modelsError && (
            <div
              style={{
                padding: "10px 14px",
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: C_FG3,
              }}
            >
              {modelsError}
            </div>
          )}

          {availableModels &&
            availableModels.length === 0 &&
            !modelsError && (
              <div
                style={{
                  padding: "10px 14px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: C_FG3,
                }}
              >
                No models pulled yet. Run{" "}
                <span style={{ color: C_AMBER }}>
                  ollama pull &lt;model&gt;
                </span>{" "}
                to add one.
              </div>
            )}

          {(availableModels || []).map((m) => {
            const sel = m.name === modelId;
            const color = modelColor(m.name);
            const size = m.details?.parameter_size || "";
            const quant = m.details?.quantization_level || "";
            const sizeOnDisk = formatBytes(m.size);
            return (
              <div
                key={m.name}
                onClick={() => {
                  setModelId(m.name);
                  setPicker(null);
                }}
                style={{
                  margin: "0 8px",
                  padding: "7px 10px",
                  borderRadius: 5,
                  cursor: "pointer",
                  background: sel ? C_BG4 : "transparent",
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: 10,
                  alignItems: "center",
                }}
                onMouseEnter={(e) =>
                  !sel && (e.currentTarget.style.background = C_BG2)
                }
                onMouseLeave={(e) =>
                  !sel && (e.currentTarget.style.background = "transparent")
                }
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 99,
                    background: color,
                    boxShadow: `0 0 5px ${color}aa`,
                  }}
                />
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: FONT_SANS,
                        fontSize: 12.5,
                        color: C_FG,
                        fontWeight: 500,
                      }}
                    >
                      {m.name}
                    </span>
                    {size && (
                      <span
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 10,
                          // Bumped from C_FG2 → C_FG1: secondary metadata
                          // needs more contrast against vibrancy+tint than
                          // it does against the main app's opaque bg.
                          color: C_FG1,
                        }}
                      >
                        {size}
                      </span>
                    )}
                    {quant && (
                      <span
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 9.5,
                          color: C_FG2,
                        }}
                      >
                        {quant}
                      </span>
                    )}
                  </div>
                  {sizeOnDisk && (
                    <div
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        color: C_FG2,
                        marginTop: 1,
                      }}
                    >
                      {sizeOnDisk} on disk
                    </div>
                  )}
                </div>
                {sel && (
                  <span style={{ color: C_AMBER, fontSize: 12 }}>✓</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Prompt picker — single-select. Click row to set, click selected row to clear. */}
      {picker === "prompt" && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ padding: "6px 10px 4px", flexShrink: 0 }}>
            <input
              placeholder="Search prompts…"
              value={promptSearch}
              onChange={(e) => setPromptSearch(e.target.value)}
              autoFocus
              style={{
                width: "100%",
                background: C_BG2,
                border: `1px solid ${C_BORDER}`,
                borderRadius: 4,
                color: C_FG,
                fontFamily: FONT_MONO,
                fontSize: 11,
                padding: "4px 8px",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: "4px 0 6px",
            }}
          >
            {visiblePrompts.length === 0 && (
              <div
                style={{
                  padding: "16px 14px",
                  color: C_FG3,
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  textAlign: "center",
                }}
              >
                {prompts.length === 0
                  ? "No prompts yet — create some in the main window."
                  : "no matches"}
              </div>
            )}
            {visiblePrompts.map((p) => {
              const sel = p.id === attachedPromptId;
              const fav = p.favorite
                ? FAVORITE_COLOR_MAP[p.favorite]
                : null;
              const favColor = fav?.color || null;
              return (
                <button
                  key={p.id}
                  onClick={() => pickPrompt(p.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "calc(100% - 16px)",
                    margin: "0 8px 1px",
                    padding: "6px 10px",
                    background: sel ? C_BG4 : "transparent",
                    border: "none",
                    borderRadius: 5,
                    cursor: "pointer",
                    color: sel ? C_FG : C_FG1,
                    fontFamily: FONT_SANS,
                    fontSize: 13,
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => {
                    if (!sel) e.currentTarget.style.background = C_BG2;
                  }}
                  onMouseLeave={(e) => {
                    if (!sel)
                      e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 99,
                      background: favColor || "transparent",
                      flexShrink: 0,
                      boxShadow: favColor ? `0 0 4px ${favColor}88` : "none",
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
                  {sel && (
                    <span style={{ color: C_AMBER, fontSize: 12 }}>✓</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Response body — visible when content arrives AND no picker is open. */}
      {/* Shows the user's question above the assistant's reply so they don't  */}
      {/* lose context after the input clears on submit.                        */}
      {!picker && hasContent && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            padding: "14px 18px 14px",
            overflowY: "auto",
            fontFamily: FONT_SANS,
            fontSize: 14,
            lineHeight: 1.55,
            color: C_FG,
          }}
        >
          {sentMessage && (
            <div
              style={{
                marginBottom: 10,
                padding: "8px 12px",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 8,
                whiteSpace: "pre-wrap",
                color: C_FG1,
              }}
            >
              {sentMessage}
            </div>
          )}
          <div style={{ whiteSpace: "pre-wrap" }}>
            {response || (streaming && "…")}
          </div>
        </div>
      )}

      {/* Action bar — only after streaming completes and we have something  */}
      {/* worth saving. Sticks to the bottom of the panel; doesn't scroll    */}
      {/* with the response body.                                            */}
      {!picker && response && !streaming && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            padding: "0 14px",
            height: 38,
            flexShrink: 0,
            borderTop: `1px solid ${C_BORDER}`,
          }}
        >
          <button
            onClick={sendToMain}
            title="Continue this conversation in the main window"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: C_BG3,
              border: `1px solid ${C_BORDER_STRONG}`,
              borderRadius: 5,
              padding: "5px 10px",
              cursor: "pointer",
              color: C_FG,
              fontFamily: FONT_MONO,
              fontSize: 11,
              fontWeight: 500,
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = C_BG4)
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = C_BG3)
            }
          >
            Send to main
            <span style={{ color: C_AMBER }}>→</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ── Mount gate ───────────────────────────────────────────────────────────────
// Both main.jsx and overlay.jsx run in every webview because they're loaded
// from the same index.html. Each file mounts a root only if it owns the
// current window — that's the cheapest way to dual-purpose one bundle.
(() => {
  const winApi = getWindowApi();
  const current = winApi?.getCurrentWindow?.() ?? winApi?.getCurrent?.();
  if (current?.label !== "overlay") return;
  // Tag both layers so the CSS rule that strips backgrounds applies to
  // <html> as well as <body> — otherwise the body's #0c0c0e shows through
  // the rounded card's corner cut-outs as a faint rectangular border.
  document.documentElement.dataset.window = "overlay";
  document.body.dataset.window = "overlay";
  ReactDOM.createRoot(document.getElementById("root")).render(<QuickQuery />);
})();
