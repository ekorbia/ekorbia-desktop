// overlay.jsx — Spotlight-style quick-query panel (⌘⇧Space)
//
// This file is loaded into *every* webview but only mounts a React root
// when its window's label is "overlay". The same trick keeps main.jsx
// from rendering <App /> here (see the bottom of main.jsx).

'use strict';
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
const PICKER_H = 360; //   prompt list open
const EXPANDED_H = 480; // streaming or response visible
// Measured, not guessed: with the snippet at its 76px cap the selection panel
// ends at y=260, so 268 leaves a hairline of room under its border. Expanded
// keeps ~210px for the result above the 38px action bar. Re-measure if the
// panel gains or loses a row.
const SELECTION_H = 268; // captured selection + verb chips, no result yet
const SELECTION_EXPANDED_H = 510; // selection panel AND a result on screen
const SELECTION_HINT_H = 168; // "nothing copied yet" explainer only

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

  // The global voice hotkey shows this overlay and emits "voice:start"; bump a
  // counter the mic button watches (its `startSignal` prop) so a hotkey press
  // begins recording without a click.
  const [voiceStartSignal, setVoiceStartSignal] = qS(0);
  qE(() => {
    let un = null;
    let cancelled = false;
    getEventApi()
      .listen("voice:start", () => setVoiceStartSignal((n) => n + 1))
      .then((u) => {
        if (cancelled) u();
        else un = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (un) un();
    };
  }, []);
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
  // The panel answers with the app's default model (Settings → Models, kept
  // under `ekorbia.main.model`). It has no chooser of its own: one place to
  // choose a model, as in the main window. Read on mount and again every
  // time the panel comes forward, so a change of default applies to the next
  // question. If the default is not installed (first run, or removed since),
  // fall back to the first installed chat model rather than fail the send.
  const readDefaultModel = () => {
    try {
      return localStorage.getItem("ekorbia.main.model") || QUICK_DEFAULT_MODEL;
    } catch {
      return QUICK_DEFAULT_MODEL;
    }
  };
  const [modelId, setModelId] = qS(readDefaultModel);
  qE(() => {
    const sync = () => {
      const want = readDefaultModel();
      const inv = getInvoke();
      if (!inv) {
        setModelId(want);
        return;
      }
      inv("llm_list_models")
        .then((data) => {
          const names = (data?.models || [])
            .map((m) => m.name)
            .filter((n) => n && !/embed/i.test(n));
          setModelId(!names.length || names.includes(want) ? want : names[0]);
        })
        .catch(() => setModelId(want));
    };
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  // ── The look: light or dark, following the app ───────────────────────────
  // This window never mounts <App />, so nothing applies the chosen look to
  // it. Read the same saved choice the app does (`ekorbia.tweaks`), again
  // each time the panel comes forward and when the system appearance flips.
  const readLight = () => {
    let key = "one_dark";
    try {
      const saved = JSON.parse(localStorage.getItem("ekorbia.tweaks") || "{}");
      if (saved && saved.theme) key = saved.theme;
    } catch {}
    if (key === "system") {
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
    }
    const themes = typeof THEMES !== "undefined" ? THEMES : null;
    if (themes && themes[key]) return !!themes[key].light;
    return /light/.test(key);
  };
  const [light, setLight] = qS(readLight);
  qE(() => {
    const sync = () => setLight(readLight());
    window.addEventListener("focus", sync);
    window.addEventListener("storage", sync);
    const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
    if (mq && mq.addEventListener) mq.addEventListener("change", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", sync);
      if (mq && mq.removeEventListener) mq.removeEventListener("change", sync);
    };
  }, []);

  // Active backend kind — the failure messaging below is Ollama-specific
  // ("run ollama serve") and must not lie on the engine / custom-endpoint
  // backends, whose errors are already user-directed.
  const [backendKind, setBackendKind] = qS('ollama');
  qE(() => {
    const inv = getInvoke();
    if (!inv) return;
    inv('llm_backend_config_get')
      .then((c) => {
        setBackendKind((c && c.backend) || 'ollama');
      })
      .catch(() => {});
  }, []);

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
  const [picker, setPicker] = qS(null); // 'prompt' | null

  // ── Selection actions (⌘⇧E) ────────────────────────────────────────────────
  // Rust reads the clipboard and pushes it here (see src/selection.rs). Four
  // pieces of state:
  //   selection      {text, chars, truncated} — what we're acting on, or null
  //   selectionEmpty true when the hotkey fired over an empty clipboard, so
  //                  we can explain that instead of looking broken
  //   selectionReq   {question, title} from the run that produced `response`,
  //                  so "Send to main" persists the instruction AND the text
  //                  rather than an answer to an invisible question
  //   ranAction      {id, label} of what produced `response`. The label
  //                  ("Fix grammar", the attached prompt's name, or whatever
  //                  the user typed) is shown above the result; the ID is
  //                  what lights a verb chip — never the label, because the
  //                  library ships a prompt named "Summarize" and running it
  //                  must not mark the Summarize chip as the thing that ran
  //
  // None of these are cleared by the window-focus reset below. The capture
  // event lands moments after the window takes focus, and a reset that
  // touched them could wipe the payload we were just handed — the same race
  // the voice hotkey's start-signal counter sidesteps. hide() owns clearing
  // them, which is where an overlay session actually ends.
  const [selection, setSelection] = qS(null);
  const [selectionEmpty, setSelectionEmpty] = qS(false);
  const [selectionReq, setSelectionReq] = qS(null);
  const [ranAction, setRanAction] = qS(null);
  const [copied, setCopied] = qS(false);

  qE(() => {
    const api = getEventApi();
    if (!api) return;
    const uns = [];
    let cancelled = false;
    const add = (name, fn) => {
      api
        .listen(name, fn)
        .then((u) => {
          if (cancelled) u();
          else uns.push(u);
        })
        .catch(() => {});
    };
    // Shared reset: a fresh capture (or a failed one) always starts from a
    // clean result area, whatever was on screen from the last invocation.
    const begin = () => {
      setSelectionReq(null);
      setRanAction(null);
      setResponse("");
      setSentMessage("");
      setPicker(null);
      setCopied(false);
    };
    add("selection:captured", (ev) => {
      const p = (ev && ev.payload) || {};
      begin();
      setSelectionEmpty(false);
      setSelection({
        text: p.text || "",
        chars: p.chars || 0,
        truncated: !!p.truncated,
      });
    });
    add("selection:empty", () => {
      begin();
      setSelection(null);
      setSelectionEmpty(true);
    });
    return () => {
      cancelled = true;
      uns.forEach((u) => {
        try {
          u();
        } catch (_) {}
      });
    };
  }, []);

  // Fallback to a rejecting stub so the rest of the component can use
  // `invoke(...)` unconditionally — the overlay window runs in non-Tauri
  // dev (pure-browser preview) where there's nothing to invoke.
  const invoke = getInvoke() ?? (() => Promise.reject("no tauri"));

  // ── Load templates from the shared folder ──────────────────────────────────
  // At mount, and again each time the panel comes forward, so a template
  // written or starred in the main window is here the next time it is
  // summoned. Rust copies the starter set in before any window is shown.
  qE(() => {
    const load = () => invoke("prompts_list")
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
      .catch(() => {});
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);

  // ── Dismiss ────────────────────────────────────────────────────────────────
  const hide = async () => {
    // Phase B.2: cancellation is an IPC ping; the in-flight Rust
    // streaming command picks it up at the next chunk boundary and
    // exits cleanly. We fire-and-forget; whether the cancel reaches
    // an active stream or no-ops on a finished one is fine.
    if (abortRef.current) {
      invoke('llm_chat_stream_cancel', { requestId: abortRef.current })
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
    //
    // The selection session ends here rather than in the focus reset: this
    // is the one place that runs on every real dismissal (⎋, blur, and the
    // window-hide that follows a toggle-away) but never in the window between
    // the selection hotkey showing the overlay and its payload arriving.
    setTimeout(() => {
      setText("");
      setSentMessage("");
      setResponse("");
      setPromptSearch("");
      setSelection(null);
      setSelectionEmpty(false);
      setSelectionReq(null);
      setRanAction(null);
      setCopied(false);
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
    else if (selection)
      h = response || streaming ? SELECTION_EXPANDED_H : SELECTION_H;
    else if (response || streaming) h = EXPANDED_H;
    else if (selectionEmpty) h = SELECTION_HINT_H;
    invoke("overlay_resize", { height: h }).catch(() => {});
  }, [picker, response, streaming, selection, selectionEmpty]);

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
    //
    // A selection run has no sentMessage — the question was "this verb,
    // applied to that text", which selectionReq carries in a form that
    // still reads correctly as a chat a week from now.
    const title = (
      selectionReq?.title ||
      sentMessage.trim().slice(0, 40) ||
      "Quick query"
    ).trim();
    const nowTs = Math.floor(Date.now() / 1000);
    const d = new Date();
    const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

    // If a prompt was attached, denormalize the same metadata the composer
    // writes — id, name, and a hex color resolved from the favorite — so
    // the main app's Message component renders an identical chip.
    let promptsJson = null;
    if (attached) {
      promptsJson = JSON.stringify([{ id: attached.id, name: attached.name }]);
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
          content: selectionReq?.question ?? sentMessage,
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

  // ── Run one stream ─────────────────────────────────────────────────────────
  // The shared streaming core behind both entry points: a typed question
  // (submit) and a selection action (runAction). Callers own the state that
  // describes WHAT was asked; this owns the request, the stream, and every
  // failure path.
  const runStream = async (messages) => {
    setStreaming(true);
    setResponse("");
    setPicker(null);
    setCopied(false);
    // Phase B.2: cancellation now goes through llm_chat_stream_cancel.
    // abortRef holds the requestId (the overlay reuses a single id since
    // it only ever has one in-flight stream — a second run while one is
    // streaming is gated by the `streaming` state in both callers).
    const requestId = `overlay-${Date.now().toString(36)}`;
    abortRef.current = requestId;

    let acc = "";
    try {
      const Channel = getChannel();
      const channel = new Channel();
      // Neutral stream contract (Phase 0 provider seam — StreamEvent in
      // src-tauri/src/llm.rs). The overlay renders prose only; toolCalls
      // never occur here (no tools field in the body) and error events
      // fall through to the existing no-output messaging below.
      let inBandError = null;
      channel.onmessage = (ev) => {
        if (ev?.type === 'delta') {
          acc += ev.text;
          setResponse(acc);
        } else if (ev?.type === 'status') {
          // Engine backend: pre-content progress ("loading gemma…").
          // Show it in the response area until the first delta replaces
          // it — an overlay query that has to cold-load a model would
          // otherwise look hung.
          if (!acc) setResponse(ev.message || '');
        } else if (ev?.type === 'error') {
          inBandError = ev.message || 'The model server reported an error.';
        }
      };
      // Gate thinking off for reasoning models (cached per model).
      let thinkCapable = thinkCapRef.current[modelId];
      if (thinkCapable === undefined) {
        try {
          const caps = await invoke('llm_capabilities', { model: modelId });
          thinkCapable = !!caps?.thinking;
        } catch (_) {
          thinkCapable = false;
        }
        thinkCapRef.current[modelId] = thinkCapable;
      }
      const body = applyThinkPref({ model: modelId, messages, stream: true }, thinkCapable);
      await invoke('llm_chat_stream', {
        requestId,
        body,
        onChunk: channel,
      });
      // In-band provider error with no output (Phase 1 polish): the
      // invoke resolves Ok, so the catch below never sees it.
      if (!acc && inBandError) {
        setResponse(`⚠️ ${inBandError}`);
      }
    } catch (e) {
      // Rust returns Err for connection-refused / non-2xx / parse errors.
      // A user-cancelled stream returns Ok by design, so reaching here with
      // no output is a real failure. Distinguish "model not available" (the
      // overlay keeps its own model pref, which may not be pulled) from a
      // genuine "Ollama is down" — they point at different fixes. On the
      // engine / custom-endpoint backends the Rust error already names the
      // real problem ("model file not found: …", endpoint + status) — show
      // it as-is instead of blaming Ollama.
      if (!acc) {
        const msg = String(e || "");
        // "Prompt too long" from any backend → the shared plain-language
        // explanation (see describeContextOverflow in utils.js).
        const overflow = describeContextOverflow(msg);
        if (overflow) {
          setResponse(`⚠️ ${overflow}`);
        } else if (backendKind !== 'ollama') {
          setResponse(msg ? `⚠️ ${msg}` : '⚠️ The model backend reported an error. Check Settings → Backend in the main window.');
        } else if (/40\d|not found|no such model|try pulling|unknown model/i.test(msg)) {
          setResponse(
            "The default model isn't installed. Choose another in Settings → Models in the main window.",
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

  // ── Run a selection action ─────────────────────────────────────────────────
  // `action` is a SELECTION_ACTIONS verb, a one-off built from the input, or
  // the attached prompt itself (id "attached" — see submit). Library prompts
  // take part the same way they do everywhere else in the overlay: attached
  // through the context bar's "+ template", they ride along ahead of the
  // instruction. The one exception is when the attached prompt IS the
  // instruction — sending its body twice, once as persona and once as the
  // task, would just be the same paragraph stuttered at the model.
  const runAction = async (action) => {
    if (!selection || streaming) return;
    const persona =
      attached && action.id !== "attached" ? attached.body : null;
    const req = buildSelectionRequest(selection.text, action, persona);
    if (!req) return;
    setRanAction({ id: action.id || "custom", label: action.label || "" });
    setSelectionReq({ question: req.question, title: req.title });
    await runStream(req.messages);
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  // Single-turn ephemeral chat. The attached prompt's body becomes a system
  // message — same shape the main app uses for new chats.
  //
  // With a selection captured, the typed text is an INSTRUCTION rather than a
  // question: "translate to German", "turn this into bullets". It runs
  // against the captured text exactly as a chip would, which is what makes
  // the built-in verbs a starting set rather than a ceiling — and the only
  // honest way to translate, since a chip can't ask for the target language.
  //
  // With a selection captured AND a prompt attached, Enter on an EMPTY input
  // runs that prompt, by itself, on the captured text. A task-style library
  // prompt ("turn this into meeting notes") needs no verb and no typed words
  // — it already is the instruction. Because the attachment is sticky across
  // invocations, a go-to prompt becomes three keystrokes: ⌘C, the selection
  // hotkey, ⏎.
  const submit = async (override) => {
    // `override` lets voice auto-submit send the exact transcript without
    // racing the setText state flush.
    const q = typeof override === "string" ? override : text;
    if (streaming) return;

    if (!q.trim()) {
      if (selection && attached) {
        await runAction({
          id: "attached",
          label: attached.name,
          instruction: attached.body,
        });
      }
      return;
    }

    if (selection) {
      const typed = q.trim();
      setText("");
      await runAction({ id: "custom", label: typed, instruction: typed });
      return;
    }

    // Snapshot the question before clearing the input so we can show it
    // above the streaming response. Each submit replaces the previous
    // snapshot — only the most recent Q&A pair stays visible.
    setSentMessage(q);
    // Clear the input as soon as the request is fired so the user can start
    // typing their next question while the answer is still streaming in.
    // The `q` value is captured in this closure for the messages array
    // below — clearing the state doesn't affect what gets sent.
    setText("");

    const messages = attached
      ? [
          { role: "system", content: attached.body },
          { role: "user", content: q },
        ]
      : [{ role: "user", content: q }];
    await runStream(messages);
  };

  // ── Copy the result ────────────────────────────────────────────────────────
  // The point of a rewrite is to paste it back where the text came from, so
  // this is the primary action in selection mode. Feedback is the button's
  // own label — the overlay has no toast host of its own.
  const copyResult = async () => {
    if (!response.trim()) return;
    try {
      await navigator.clipboard.writeText(response);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      console.error("Copy failed:", e);
    }
  };

  // ── Derived render data ────────────────────────────────────────────────────
  // The expanded body shows up as soon as we have *anything* to show:
  // the sent message, the streaming indicator, or the response itself.
  // (sentMessage and streaming flip on within the same submit() call,
  // but sentMessage drives visibility so the question paints instantly
  // without waiting for the first streamed token.)
  const hasContent = !!response || streaming || !!sentMessage;
  // Starred first, then by name — the order every template list uses.
  // Searching matches names and descriptions.
  const visiblePrompts = filterTemplates(prompts, promptSearch);

  // The selection hotkey as the user actually has it bound. Both windows
  // share an origin, so the overlay can read the value Settings persisted
  // rather than hardcoding a default that a rebind would make a lie.
  const selectionHotkeyLabel = (() => {
    let spec = null;
    try {
      spec = localStorage.getItem("ekorbia.selection.hotkey");
    } catch {}
    return formatHotkey(spec || "Super+Shift+KeyE");
  })();

  // ── Styles (defined once outside the JSX for readability) ──────────────────
  const ROW_PAD = "0 18px";
  // Two palettes: translucent whites over a dark tint, or translucent
  // blacks over a light one. The tint under them sits on the system blur
  // (NSVisualEffectView, which follows the SYSTEM appearance, not the
  // app's): when the two disagree the tint goes nearly opaque so a light
  // panel never turns grey over a dark blur, or the reverse.
  const systemLight = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  const tintAlpha = light === systemLight ? (light ? 0.8 : 0.72) : 0.96;
  const C_TINT = light ? `rgba(248, 248, 249, ${tintAlpha})` : `rgba(20, 20, 26, ${tintAlpha})`;
  const C_BORDER = light ? "rgba(0,0,0,0.09)" : "rgba(255,255,255,0.05)";
  const C_BORDER_STRONG = light ? "rgba(0,0,0,0.16)" : "rgba(255,255,255,0.1)";
  const C_FG = light ? "#24262b" : "#e3e6ec";
  const C_FG1 = light ? "#4f525a" : "#a5acba";
  const C_FG2 = light ? "#74777e" : "#6b7384";
  const C_FG3 = light ? "#9a9ca3" : "#4e5564";
  const C_BG2 = light ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.04)";
  const C_BG3 = light ? "rgba(0,0,0,0.07)" : "rgba(255,255,255,0.08)";
  const C_BG4 = light ? "rgba(0,0,0,0.11)" : "rgba(255,255,255,0.12)";
  const C_AMBER = light ? "#b15c13" : "#f0934a";
  const FONT_SANS = '"Inter", system-ui, sans-serif';

  // Verb-chip styling; `active` marks the one whose result is on screen. A
  // plain style helper, not a component — components defined during render
  // lose focus on every keystroke (see CLAUDE.md).
  const chipStyle = (active) => ({
    display: "inline-flex",
    alignItems: "center",
    padding: "3px 10px",
    borderRadius: 999,
    border: `1px solid ${active ? C_AMBER + "88" : C_BORDER_STRONG}`,
    background: active ? C_AMBER + "24" : C_BG2,
    color: active ? C_AMBER : C_FG1,
    fontFamily: FONT_SANS,
    fontSize: 11.5,
    lineHeight: 1.6,
    cursor: streaming ? "default" : "pointer",
    opacity: streaming && !active ? 0.5 : 1,
    whiteSpace: "nowrap",
  });

  return (
    <div
      data-quick-panel
      data-quick-look={light ? "light" : "dark"}
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
        background: C_TINT,
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
          placeholder={
            // With a prompt attached, ⏎ on the empty input runs it — say so
            // here, since nothing else on screen hints at it. The prompt's
            // name leads so a long one ellipsizes the filler, not the cue.
            selection
              ? attached
                ? `Return runs ${attached.name} — or type what to do…`
                : "Or describe what to do with it…"
              : (attached && attached.hint) || "Ask anything…"
          }
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
            // A placeholder naming a long attached prompt should end in an
            // ellipsis, not a letter sliced in half. minWidth lets the flex
            // item actually shrink enough for the clip to be the input's.
            minWidth: 0,
            textOverflow: "ellipsis",
          }}
        />
        {streaming && (
          <span
            data-overlay-working
            style={{ fontFamily: FONT_SANS, fontSize: 12, color: C_FG1, flexShrink: 0 }}
          >
            Thinking…
          </span>
        )}
        {/* The microphone is the LAST thing in this row in every state, so
            it sits at the same place on the right edge whether or not a
            hint or a status is showing (the key hint lives in the bar
            below). */}
        {/* Voice dictation — inserts the local Whisper transcript into the
            overlay input. macOS only — the Whisper backend is macOS-gated
            (see voice.jsx / Cargo.toml). No model yet → toast. */}
        {IS_MAC && (
        <VoiceMicButton
          disabled={streaming}
          startSignal={voiceStartSignal}
          onRecordingChange={setVoiceRecording}
          onNeedsSetup={() =>
            window.ekToast?.({
              kind: "info",
              title: "Set up voice input",
              body: "Download a speech model in the main window: Settings → Voice.",
            })
          }
          onInsert={(t, opts) => {
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
            const next = pre + ins + cur.slice(end);
            // Auto-send after dictation (Settings → Voice) — submit the exact
            // text directly so we don't race the setText flush.
            if (opts && opts.submit && next.trim() && !streaming) {
              submit(next);
              return;
            }
            setText(next);
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
        )}
      </div>

      {/* ── Context bar ──────────────────────────────────────────────────── */}
      {/* Hosts the (at most one) prompt slot and, on the right, the key hint. */}
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
        {/* Template slot — either the chosen one's chip, or a "+ template" trigger. */}
        {/* Clicking the chip body re-opens the picker (to swap), the × clears. */}
        {attached ? (() => {
          return (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 6px 2px 9px",
                background: C_BG2,
                border: `1px solid ${C_BORDER_STRONG}`,
                borderRadius: 999,
                fontFamily: FONT_SANS,
                fontSize: 11.5,
                color: C_FG,
                maxWidth: 240,
              }}
            >
              <button
                onClick={() =>
                  setPicker((p) => (p === "prompt" ? null : "prompt"))
                }
                data-overlay-template={attached.id}
                title="Choose another template"
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  color: "inherit",
                  fontFamily: FONT_SANS,
                  fontSize: 11.5,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {attached.name}
              </button>
              <button
                onClick={() => setAttachedPromptId(null)}
                aria-label={`Remove ${attached.name}`}
                title="Remove"
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
              fontFamily: FONT_SANS,
              fontSize: 11.5,
            }}
          >
            + template
          </button>
        )}

        <span style={{ flex: 1 }} />
        {!streaming && !hasContent && !picker && (
          <span
            data-overlay-hint
            style={{ fontFamily: FONT_SANS, fontSize: 11.5, color: C_FG1, whiteSpace: "nowrap" }}
          >
            {selection ? "Return to run · Esc to close" : "Return to ask · Esc to close"}
          </span>
        )}
      </div>

      {/* ── Selection panel ──────────────────────────────────────────────── */}
      {/* What the selection hotkey captured, plus the verbs you can run on   */}
      {/* it. The chips stay put while a result is on screen so switching     */}
      {/* verbs is one click, not a click to go back and another to re-run.   */}
      {!picker && selection && (
        <div
          data-selection-panel
          style={{
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: 7,
            padding: "2px 16px 10px",
            borderBottom: `1px solid ${C_BORDER}`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              fontFamily: FONT_SANS,
              fontSize: 11.5,
            }}
          >
            <span style={{ color: C_FG1 }}>
              Copied text
            </span>
            <span style={{ color: C_FG2 }}>
              {selection.chars.toLocaleString()} characters
              {selection.truncated ? " · trimmed to fit" : ""}
            </span>
          </div>

          <div
            data-selection-snippet
            style={{
              maxHeight: 76,
              overflowY: "auto",
              background: C_BG2,
              border: `1px solid ${C_BORDER}`,
              borderRadius: 8,
              padding: "8px 10px",
              fontFamily: FONT_SANS,
              fontSize: 12,
              lineHeight: 1.5,
              color: C_FG1,
              whiteSpace: "pre-wrap",
            }}
          >
            {selection.text}
          </div>

          <div
            data-selection-actions
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 5,
            }}
          >
            {SELECTION_ACTIONS.map((a) => (
              <button
                key={a.id}
                data-selection-action={a.id}
                title={a.hint}
                disabled={streaming}
                onClick={() => runAction(a)}
                style={chipStyle(ranAction?.id === a.id)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Empty clipboard — say so rather than opening a panel that does    */}
      {/* nothing, which would read as a broken hotkey.                     */}
      {!picker && !selection && selectionEmpty && (
        <div
          data-selection-empty
          style={{
            flexShrink: 0,
            padding: "6px 18px 14px",
            fontFamily: FONT_SANS,
            fontSize: 12.5,
            lineHeight: 1.6,
            color: C_FG1,
          }}
        >
          Nothing to act on — the clipboard has no text in it. Copy something
          in any app, then press{" "}
          <span style={{ color: C_AMBER, fontFamily: FONT_SANS, fontSize: 12 }}>
            {selectionHotkeyLabel}
          </span>
          .
        </div>
      )}

      {/* ── Bottom area: picker OR response ──────────────────────────────── */}

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
              placeholder="Search templates…"
              value={promptSearch}
              onChange={(e) => setPromptSearch(e.target.value)}
              autoFocus
              style={{
                width: "100%",
                background: C_BG2,
                border: `1px solid ${C_BORDER}`,
                borderRadius: 4,
                color: C_FG,
                fontFamily: FONT_SANS,
                fontSize: 12,
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
                  fontFamily: FONT_SANS,
                  fontSize: 12,
                  textAlign: "center",
                }}
              >
                {prompts.length === 0
                  ? "No templates yet. Write one in Settings → Templates in the main window."
                  : "No template matches."}
              </div>
            )}
            {visiblePrompts.map((p) => {
              const sel = p.id === attachedPromptId;
              return (
                <button
                  key={p.id}
                  data-overlay-template-option={p.id}
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
                  <span style={{ color: C_FG, fontWeight: 500, whiteSpace: "nowrap", flexShrink: 0 }}>
                    {p.name}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      color: C_FG2,
                      fontSize: 12,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.description || ""}
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
                background: C_BG2,
                border: `1px solid ${C_BORDER}`,
                borderRadius: 8,
                whiteSpace: "pre-wrap",
                color: C_FG1,
              }}
            >
              {sentMessage}
            </div>
          )}
          {/* What produced this. The chips above show it too, but a typed
              instruction or an attached prompt has no chip to light up. */}
          {ranAction?.label && (
            <div
              data-ran-action
              style={{
                marginBottom: 6,
                fontFamily: FONT_SANS,
                fontSize: 11.5,
                color: C_AMBER,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {ranAction.label}
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
          {/* Copy leads in selection mode: a rewrite exists to be pasted
              back where the text came from. The button's own label is the
              confirmation — the overlay window has no toast host. */}
          {selection && (
            <button
              onClick={copyResult}
              data-copy-result
              title="Copy the result to the clipboard"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: copied ? C_BG3 : C_FG,
                border: `1px solid ${copied ? C_BORDER_STRONG : C_FG}`,
                borderRadius: 5,
                padding: "5px 10px",
                cursor: "pointer",
                color: copied ? C_FG : light ? "#fff" : "#14171d",
                fontFamily: FONT_SANS,
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              {copied ? "Copied ✓" : "Copy result"}
            </button>
          )}
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
              fontFamily: FONT_SANS,
              fontSize: 12,
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
  // <html> as well as <body> — otherwise the body's #0d0f13 shows through
  // the rounded card's corner cut-outs as a faint rectangular border.
  document.documentElement.dataset.window = "overlay";
  document.body.dataset.window = "overlay";
  ReactDOM.createRoot(document.getElementById("root")).render(<QuickQuery />);
})();
