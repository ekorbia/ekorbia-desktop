// Mock Tauri IPC layer for the Playwright test harness.
//
// Loaded as the VERY FIRST script in playwright.html (before React/Babel/
// the JSX files). By the time the JSX runs, window.__TAURI__ is populated
// with stub implementations of invoke() and event.listen()/.emit().
//
// Every invoke() call is recorded on window.__INVOKES so tests can assert
// over them later via page.evaluate(() => window.__INVOKES).
//
// Per-command responses default to no-op-friendly values (so a bare mount
// of the app doesn't crash during its startup probes). Tests override
// individual commands via:
//   await page.evaluate(() => {
//     window.__INVOKE_RESPONSES.ollama_models = () => ["llama3"];
//   });
//
// Two surface shapes exist in the production UI:
//   • window.__TAURI__.core.invoke  (newer)
//   • window.__TAURI__.tauri.invoke (legacy fallback in files.jsx)
// We publish both so neither code path breaks.

(function () {
  // Recorded calls. Each entry is { cmd, args, t (timestamp) }.
  window.__INVOKES = [];

  // Recorded event listeners, keyed by event name. Tests can synthesise
  // an event by emit()-ing through the same mock — useful for asserting
  // that UI components react correctly to backend-pushed events
  // (attachment:status_changed, watch:event_changed, etc).
  window.__EVENT_LISTENERS = {};

  // Default canned responses. Keep this list lean — most tests will
  // override the responses they care about. The entries below are the
  // startup probes that fire on every chat mount or settings load; if
  // they were missing we'd flood the console with "unmocked" warnings.
  window.__INVOKE_RESPONSES = {
    // app_settings KV
    setting_get: () => null,
    setting_set: () => undefined,

    // memory file (Phase 4a)
    memory_info: () => ({
      path: "",
      exists: false,
      bytes: 0,
      oversized: false,
      unresolvable: false,
    }),
    memory_read: () => null,

    // ollama
    ollama_models: () => [],
    ollama_ping: () => true,

    // chat store
    db_load_chats: () => [],
    db_load_messages: () => [],
    chat_files_list: () => [],

    // prompts
    prompts_list: () => [],

    // watch
    watch_list: () => [],
    watch_events_list: () => [],

    // attachments
    attachment_list: () => [],
  };

  const invoke = function (cmd, args) {
    window.__INVOKES.push({ cmd, args, t: Date.now() });
    const responder = window.__INVOKE_RESPONSES[cmd];
    if (responder === undefined) {
      // Don't reject — most useEffects swallow rejections, which would
      // mask real bugs. Warn instead so the test author can add a mock.
      console.warn("[mock-tauri] unmocked invoke: " + cmd);
      return Promise.resolve(undefined);
    }
    try {
      const v = typeof responder === "function" ? responder(args) : responder;
      // Allow both sync values and Promises.
      return Promise.resolve(v);
    } catch (e) {
      return Promise.reject(e);
    }
  };

  const listen = function (name, fn) {
    (window.__EVENT_LISTENERS[name] = window.__EVENT_LISTENERS[name] || []).push(fn);
    return Promise.resolve(function unlisten() {
      const arr = window.__EVENT_LISTENERS[name] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    });
  };

  const emit = function (name, payload) {
    (window.__EVENT_LISTENERS[name] || []).forEach(function (fn) {
      fn({ event: name, payload: payload });
    });
    return Promise.resolve(undefined);
  };

  window.__TAURI__ = {
    core: { invoke: invoke },
    // Legacy shape — files.jsx checks both.
    tauri: { invoke: invoke },
    event: { listen: listen, emit: emit },
  };

  // Convenience helpers for tests. The harness exposes these so spec files
  // can do high-level assertions without re-deriving them every time.
  window.__INVOKE_FIND = function (cmd, predicate) {
    return window.__INVOKES.find(function (call) {
      if (call.cmd !== cmd) return false;
      return predicate ? predicate(call.args || {}) : true;
    });
  };
  window.__INVOKE_COUNT = function (cmd) {
    return window.__INVOKES.filter(function (c) { return c.cmd === cmd; }).length;
  };
  window.__INVOKE_RESET = function () {
    window.__INVOKES.length = 0;
  };
})();
