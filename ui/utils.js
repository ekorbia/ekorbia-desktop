// ui/utils.js — pure helper functions extracted from the JSX files so they
// can be unit-tested under Node's built-in `node:test` runner. The file is
// loaded as plain JavaScript (NOT text/babel) BEFORE the JSX scripts in
// index.html, so every helper is on `window` by the time any JSX runs.
//
// Dual-export pattern:
//   • In the browser: each function is assigned to `window.foo` so JSX
//     files can reference it by bare name (same lookup path as if it were
//     declared with `function foo()` inline).
//   • In Node: the same names are added to `module.exports` so test
//     files can `require('../utils.js')`.
//
// IMPORTANT: do NOT add JSX or ES `import`/`export` to this file — the
// architecture rule from CLAUDE.md ("no bundler; no module scripts") still
// applies. Plain CommonJS-on-Node + globals-on-browser is the maximum
// allowed footprint.

// ── Platform detection (cross-platform port, Phases L1 / W1) ───────────────
//
// The UI renders some affordances differently per platform — most notably
// hotkey glyphs (⌘⇧Space on macOS vs the textual "Super+Shift+Space" on
// Linux / "Win+Shift+Space" on Windows) and the visibility of features
// that are only wired up on one OS today (the overlay window is macOS +
// Windows in this build; screenshot capture is macOS only).
//
// detectPlatform() reads `navigator.userAgent` because the no-bundler UI
// can't `await` an async Tauri API at module-init time. The UA strings
// from WKWebView (mac), WebView2 (Windows), and WebKitGTK (Linux) all
// include their OS name distinctively. We default to 'macos' when no
// navigator is available (Node test runner, very old fallback) so the
// existing test fixtures that call formatHotkey() without an explicit
// platform continue to assert the macOS glyph output.
function detectPlatform() {
  if (typeof navigator === "undefined") return "macos";
  const ua = (navigator.userAgent || "").toLowerCase();
  if (ua.includes("windows")) return "windows";
  // 'android' UA also includes 'linux' — exclude it explicitly so a
  // mobile build (if we ever ship one) doesn't render desktop chrome.
  if (ua.includes("linux") && !ua.includes("android")) return "linux";
  if (ua.includes("mac")) return "macos";
  return "macos";
}

// Boolean shorthands. Cached at module init in the browser; recomputed
// every call in Node (where there's no navigator to memoise around).
const _DETECTED_PLATFORM = detectPlatform();
const IS_MAC = _DETECTED_PLATFORM === "macos";
const IS_LINUX = _DETECTED_PLATFORM === "linux";
const IS_WIN = _DETECTED_PLATFORM === "windows";

// Short labels for inline hints: "⌘↵ to send" on macOS becomes
// "Ctrl+Enter to send" on Linux / Windows. The actual keypress
// handlers throughout the UI accept either metaKey OR ctrlKey, so
// macOS Cmd+Enter and Linux/Windows Ctrl+Enter both fire — we just
// need the visible label to match what the user expects per platform.
//
// MOD_GLYPH is the *prefix*; concatenate the suffix directly:
//   `${MOD_GLYPH}K`  → "⌘K" on mac, "Ctrl+K" elsewhere
//   `${MOD_GLYPH}${ENTER_GLYPH}` → "⌘↵" on mac, "Ctrl+Enter" elsewhere
const MOD_GLYPH = IS_MAC ? "⌘" : "Ctrl+";
const ENTER_GLYPH = IS_MAC ? "↵" : "Enter";

// Note: there used to be an `OLLAMA_BASE = "http://127.0.0.1:11434"`
// constant here for direct fetch() calls to Ollama from the UI. Phase
// B (Jun 2026) routed every Ollama call through Rust Tauri commands
// — see src/ollama.rs's `OLLAMA_BASE` for the canonical address and
// the WebView2-Private-Network-Access story that motivated the move.
// The constant is now Rust-side only; the UI has no business knowing
// the address.

// ── Hotkey helpers (settings.jsx, onboarding.jsx) ──────────────────────────

// Modifier-only keypresses (e.code values for left/right Cmd/Shift/Ctrl/Alt).
// We ignore these during capture — we want the user's *actual* key, not the
// modifier they pressed first while reaching for it.
const HOTKEY_MOD_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
]);

// Convert a "Super+Shift+Space"-style spec into a human-readable label
// using platform-appropriate symbols:
//   • macOS   → keyboard glyphs concatenated:  ⌘⇧Space
//   • Linux   → textual modifier names joined: Super+Shift+Space
//   • Windows → same as Linux but Super → Win: Win+Shift+Space
//
// The optional `platform` argument forces a specific platform's
// formatting — useful for unit tests that need to assert all three
// outputs without poking navigator. Defaults to the detected platform
// at module init, which preserves the existing macOS behaviour in the
// Node test runner (no navigator → defaults to 'macos').
function formatHotkey(spec, platform) {
  if (!spec) return "Not set";
  const p = platform || _DETECTED_PLATFORM;

  if (p === "macos") {
    const modGlyphs = {
      Super: "⌘",
      Cmd: "⌘",
      Command: "⌘",
      Meta: "⌘",
      Ctrl: "⌃",
      Control: "⌃",
      Alt: "⌥",
      Option: "⌥",
      Shift: "⇧",
    };
    const codeGlyphs = {
      Space: "Space",
      Enter: "↵",
      Tab: "⇥",
      Escape: "Esc",
      Backspace: "⌫",
      Delete: "⌦",
      ArrowLeft: "←",
      ArrowRight: "→",
      ArrowUp: "↑",
      ArrowDown: "↓",
      Backquote: "`",
      Minus: "−",
      Equal: "=",
      BracketLeft: "[",
      BracketRight: "]",
      Backslash: "\\",
      Semicolon: ";",
      Quote: "'",
      Comma: ",",
      Period: ".",
      Slash: "/",
    };
    return spec
      .split("+")
      .map((part) => {
        if (modGlyphs[part]) return modGlyphs[part];
        if (codeGlyphs[part]) return codeGlyphs[part];
        // KeyA / KeyB / ... — strip prefix
        if (part.startsWith("Key")) return part.slice(3);
        // Digit0 / Digit1 / ... — strip prefix
        if (part.startsWith("Digit")) return part.slice(5);
        // F1..F24 and anything else we don't handle — leave as-is
        return part;
      })
      .join("");
  }

  // Linux + Windows: textual rendering with `+` separators. The only
  // per-platform difference here is the primary-modifier label (Super
  // on Linux, Win on Windows — both map from the same Tauri "Super"
  // token in the underlying spec).
  const primaryMod = p === "windows" ? "Win" : "Super";
  const modText = {
    Super: primaryMod,
    Cmd: primaryMod,
    Command: primaryMod,
    Meta: primaryMod,
    Ctrl: "Ctrl",
    Control: "Ctrl",
    Alt: "Alt",
    Option: "Alt",
    Shift: "Shift",
  };
  const codeText = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Escape: "Esc",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Backquote: "`",
    Minus: "−",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
  };
  return spec
    .split("+")
    .map((part) => {
      if (modText[part]) return modText[part];
      if (codeText[part]) return codeText[part];
      if (part.startsWith("Key")) return part.slice(3);
      if (part.startsWith("Digit")) return part.slice(5);
      return part;
    })
    .join("+");
}

// Capture a KeyboardEvent into a hotkey spec string. Returns null on bare
// modifier keys (so the recorder keeps listening) and null when no modifier
// is held (we require at least one modifier to avoid accidentally binding
// plain letters to global shortcuts).
function hotkeyFromEvent(e) {
  if (HOTKEY_MOD_CODES.has(e.code)) return null;
  if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return null;
  const parts = [];
  if (e.metaKey) parts.push("Super");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(e.code);
  return parts.join("+");
}

// ── Fenced-block parsing (chat.jsx heuristic save-buttons fallback) ────────

// Default filename per language tag. Anything not listed falls back to
// `snippet.<lang>` — better to surface something the user can rename than
// to silently drop the block.
const LANG_DEFAULT_NAME = {
  html: 'index.html', xml: 'index.xml', svg: 'image.svg',
  css: 'style.css',
  js: 'main.js', javascript: 'main.js',
  jsx: 'App.jsx',
  ts: 'main.ts', typescript: 'main.ts',
  tsx: 'App.tsx',
  py: 'main.py', python: 'main.py',
  sh: 'run.sh', bash: 'run.sh', shell: 'run.sh', zsh: 'run.sh',
  rs: 'main.rs', rust: 'main.rs',
  go: 'main.go', golang: 'main.go',
  c: 'main.c', cpp: 'main.cpp', 'c++': 'main.cpp',
  java: 'Main.java', kotlin: 'Main.kt',
  rb: 'main.rb', ruby: 'main.rb',
  json: 'data.json',
  yaml: 'config.yaml', yml: 'config.yml',
  toml: 'config.toml',
  md: 'README.md', markdown: 'README.md',
  sql: 'schema.sql',
  swift: 'main.swift',
  php: 'index.php',
};

// First-line filename hint patterns, keyed by language families that
// commonly use the matching comment syntax.
const FILENAME_HINT_PATTERNS = [
  { test: /^<!--\s*([^\s<>"]+\.[a-z0-9]+)\s*-->/i,
    langs: ['html', 'xml', 'svg', 'markdown', 'md'] },
  { test: /^\/\*\s*([^\s/*"]+\.[a-z0-9]+)\s*\*\//,
    langs: ['css', 'js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx',
            'rs', 'rust', 'c', 'cpp', 'c++', 'go', 'java', 'swift', 'kotlin', 'php'] },
  { test: /^\/\/\s*([^\s/"]+\.[a-z0-9]+)/,
    langs: ['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx',
            'rs', 'rust', 'c', 'cpp', 'c++', 'go', 'java', 'swift', 'kotlin', 'php'] },
  { test: /^#\s*([^\s#"]+\.[a-z0-9]+)/,
    langs: ['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'rb', 'ruby',
            'yaml', 'yml', 'toml'] },
  { test: /^--\s*([^\s-"]+\.[a-z0-9]+)/,
    langs: ['sql', 'haskell', 'lua'] },
];

// Append "-2", "-3", … to disambiguate when the same name already exists
// in this message's parsed blocks. Cheap: typical messages have 1-3 blocks.
function uniquifyFilename(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (taken.has(`${stem}-${i}${ext}`)) i++;
  return `${stem}-${i}${ext}`;
}

function inferFilename(lang, content, takenSet) {
  const langKey = (lang || '').toLowerCase();
  // First-line filename hint wins over defaults.
  for (const p of FILENAME_HINT_PATTERNS) {
    if (p.langs.includes(langKey)) {
      const m = content.match(p.test);
      if (m && m[1]) return uniquifyFilename(m[1], takenSet);
    }
  }
  // HTML doctype fingerprint nudges plain `text` / unmarked blocks toward
  // index.html when the content is clearly a full document.
  if ((langKey === 'html' || langKey === '') && /^\s*<!doctype html>/i.test(content)) {
    return uniquifyFilename('index.html', takenSet);
  }
  const def = LANG_DEFAULT_NAME[langKey] || `snippet.${langKey || 'txt'}`;
  return uniquifyFilename(def, takenSet);
}

// Walk the markdown looking for ```lang ... ``` blocks. Ordinal is the
// index among ALL fences in the message — useful for stable keys + the
// model's mental model when the user later asks "regenerate the 2nd file".
function parseFencedBlocks(markdown) {
  if (!markdown) return [];
  // Match ``` followed by optional lang tag (no spaces), newline, content
  // (lazy, including newlines), then a ``` on its own line.
  const re = /```([a-zA-Z0-9_+\-.]*)\n([\s\S]*?)\n```/g;
  const out = [];
  const taken = new Set();
  let m;
  let ord = 0;
  while ((m = re.exec(markdown)) !== null) {
    const lang = (m[1] || '').toLowerCase();
    // Don't trip on terminal-output blocks marked ```output / ```text-only
    // when the content is obviously not a file (no newlines, no doctype,
    // very short). We still surface them — user can rename. Just avoids
    // creating index.html out of a 2-word block.
    const content = m[2];
    if (content.length < 6) { ord++; continue; }
    const filename = inferFilename(lang, content, taken);
    taken.add(filename);
    out.push({ language: lang, content, filename, ordinal: ord++ });
  }
  return out;
}

// ── Markdown escaping (markdown.jsx) ───────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// HTML attribute value sanitizer — strips everything that isn't an ASCII
// identifier-safe char. Used when injecting a value into an attribute we
// build by string concatenation (citation chips); rejects rather than
// escapes so a malicious model can't smuggle a payload through an
// unfamiliar attribute context.
function escapeAttr(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '');
}

// ── Time + JSON helpers (main.jsx) ─────────────────────────────────────────

// Compact relative-time formatter. Two styles via the `verbose` flag:
//   • verbose=false (default) — "now" / "5m" / "3h" / "2d"
//     Tight, scannable. Used by the sidebar ChatRow timestamp where
//     horizontal space is at a premium.
//   • verbose=true — "just now" / "5m ago" / "3h ago" / "2d ago"
//     Reads as a sentence. Used by the FilesPanel and WatchPanel rows
//     where the timestamp is part of a metadata line.
// Negative diffs (clock skew, or a future timestamp) clamp to the "now"
// branch — better than rendering "-3m ago" which would look like a bug.
function relativeTime(unixSecs, opts) {
  const verbose = !!(opts && opts.verbose);
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs);
  if (diff < 60) return verbose ? 'just now' : 'now';
  const suffix = verbose ? ' ago' : '';
  if (diff < 3600) return `${Math.floor(diff / 60)}m${suffix}`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h${suffix}`;
  return `${Math.floor(diff / 86400)}d${suffix}`;
}

function tryParseJson(s, fallback) {
  try { return JSON.parse(s); } catch (_) { return fallback; }
}

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── Watch defaults (watch.jsx) ─────────────────────────────────────────────

// Default poll cadence per watch kind. The UI calls this when the user
// switches kind in the form so the interval field jumps to a sensible
// starting point instead of carrying over a value that may be wildly
// inappropriate (e.g. 30 seconds for a daily-updated RSS feed).
function defaultIntervalForKind(kind) {
  if (kind === "rss") return 600;     // 10 min
  if (kind === "url") return 1800;    // 30 min
  return 30;                          // folder
}

// ── Model manager helpers (model-manager.jsx, overlays.jsx, overlay.jsx) ───

// Human-readable size for model bytes. Decimal units to match what
// `ollama list` and ollama.com display (a 9.6 GB model should read
// "9.6 GB" here too, not "8.9 GiB"). Formerly `fmt_size` in overlays.jsx —
// moved here for node:test coverage; do NOT re-declare it in a JSX file
// (later-loaded scripts would silently shadow this global).
function formatBytes(bytes) {
  if (!bytes) return "";
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

// Fold one /api/pull NDJSON chunk into accumulated download-progress state.
//
// Ollama reports per-LAYER progress: each `{"status":"pulling <digest>",
// "digest":"…","total":N,"completed":M}` line describes ONE blob of the
// model, and the stream interleaves layers. Tracking a single
// total/completed pair would make the progress bar jump backwards every
// time a new layer starts reporting — so we keep a digest→{total,completed}
// map and sum across it.
//
// Pure + immutable: returns a fresh state object, never mutates the input —
// safe for React's setState(prev => accumulatePullProgress(prev, chunk)).
//
//   state — previous return value, or null/undefined to start fresh
//   chunk — one parsed NDJSON object: {status?, digest?, total?,
//           completed?, error?}
//
// Returns { layers, statusLine, totalBytes, completedBytes, pct, done,
// error }. `pct` is null until the first layer reports a size (render an
// indeterminate bar until then). `done` flips on the final
// `{"status":"success"}` line — the UI must treat a stream that ends
// WITHOUT done=true as cancelled/incomplete, not as success. `error`
// carries Ollama's in-band error string (HTTP 200 + an {"error": …} line
// is how /api/pull reports a bad model name).
function accumulatePullProgress(state, chunk) {
  const prev = state || { layers: {}, statusLine: "", done: false, error: null };
  const layers = Object.assign({}, prev.layers);
  let statusLine = prev.statusLine;
  let error = prev.error;
  let done = prev.done;

  if (chunk && typeof chunk === "object") {
    if (chunk.error) error = String(chunk.error);
    if (typeof chunk.status === "string" && chunk.status) statusLine = chunk.status;
    if (chunk.digest && typeof chunk.total === "number") {
      const existing = layers[chunk.digest] || { total: 0, completed: 0 };
      layers[chunk.digest] = {
        total: chunk.total,
        // `completed` is absent on a layer's first line and must never
        // regress on later ones.
        completed: Math.max(existing.completed, chunk.completed || 0),
      };
    }
    if (chunk.status === "success") done = true;
  }

  let totalBytes = 0;
  let completedBytes = 0;
  for (const k in layers) {
    totalBytes += layers[k].total;
    completedBytes += layers[k].completed;
  }
  const pct =
    totalBytes > 0 ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : null;
  return { layers, statusLine, totalBytes, completedBytes, pct, done, error };
}

// Fold one voice-model download chunk into display state. Whisper models are
// a single file (unlike Ollama's per-layer pull), so each chunk already
// carries cumulative {completed, total} bytes. Pure — safe in setState.
//   chunk — { completed?, total?, done?, error? }, or null to seed
// Returns { completed, total, pct, done, error }. `pct` is null until the
// total is known (render an indeterminate bar until then).
function voiceModelProgress(chunk) {
  const c = chunk || {};
  const completed = typeof c.completed === "number" ? c.completed : 0;
  const total = typeof c.total === "number" ? c.total : 0;
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : null;
  return { completed, total, pct, done: !!c.done, error: c.error ? String(c.error) : null };
}

// Format a whole-second duration as "M:SS" for the recording timer.
//   42 → "0:42", 75 → "1:15". Negative / NaN clamps to "0:00".
function formatClock(secs) {
  const s = Math.max(0, Math.floor(Number(secs) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}

// Apply the thinking preference to an Ollama /api/chat request body.
//
// Reasoning models (qwen3.x, deepseek-r1, gpt-oss, …) auto-enable thinking
// in Ollama unless the request sets `think: false`, which makes chat sit
// blank while a long chain-of-thought streams into a field we don't render.
// We force it off for snappy replies.
//
// CRITICAL invariant: only set the field when the model is thinking-capable.
// Sending `think` (even false) to a NON-thinking model is a 400
// "does not support thinking" error in Ollama — so a non-capable model
// must leave the body untouched, NOT get `think: false`. Mutates and
// returns `body` for call-site convenience.
function applyThinkPref(body, thinkingCapable) {
  if (thinkingCapable) body.think = false;
  return body;
}

// Recommend a right-sized Gemma 4 model for the machine's RAM. Used by the
// guided first-run flow. Returns { model, approx, lowRam, unknownRam,
// reason } — `approx` is the download size, `reason` is a one-line "why"
// for the UI card.
//
// Tiers are deliberately conservative: the chosen model should load with
// headroom for the OS and the rest of the app, not max out the machine.
// The user can always pick a bigger one via "Choose a different model".
// Sizes verified against the Ollama gemma4 library (June 2026); all gemma4
// variants are multimodal (text + image). Thresholds sit just above the
// round GiB marks so a machine reporting e.g. 15.9 GiB still lands right.
const GEMMA_TIERS = [
  { maxGiB: 9,        model: "gemma4:e2b", approx: "7.2 GB", lowRam: true },
  { maxGiB: 17,       model: "gemma4:e4b", approx: "9.6 GB", lowRam: false },
  { maxGiB: 33,       model: "gemma4:12b", approx: "7.6 GB", lowRam: false },
  { maxGiB: 65,       model: "gemma4:26b", approx: "18 GB",  lowRam: false },
  { maxGiB: Infinity, model: "gemma4:31b", approx: "20 GB",  lowRam: false },
];

function recommendGemmaModel(ramBytes) {
  if (!ramBytes || ramBytes <= 0) {
    // RAM undetectable (Windows, or a probe failure). e4b is the balanced
    // "latest" default that runs on most machines.
    return {
      model: "gemma4:e4b",
      approx: "9.6 GB",
      lowRam: false,
      unknownRam: true,
      reason: "We couldn't detect your memory, so this is a safe all-round default.",
    };
  }
  const gib = ramBytes / (1024 * 1024 * 1024);
  const tier = GEMMA_TIERS.find((t) => gib < t.maxGiB) || GEMMA_TIERS[GEMMA_TIERS.length - 1];
  const gbRounded = Math.round(gib);
  const reason = tier.lowRam
    ? `Your machine has about ${gbRounded} GB of memory — this is the smallest, fastest Gemma 4 and the safest fit. It may still be tight; close other heavy apps.`
    : `Sized for your ${gbRounded} GB of memory, with headroom for the rest of your apps.`;
  return {
    model: tier.model,
    approx: tier.approx,
    lowRam: tier.lowRam,
    unknownRam: false,
    reason,
  };
}

// Recommend a right-sized chat model from the BUNDLED-ENGINE catalog for the
// machine's RAM. Unlike recommendGemmaModel (Ollama tags, hardcoded tiers)
// this is CATALOG-DRIVEN — it reads the live `engine_catalog` payload so it
// never drifts from catalog.json. Pure + unit-tested.
//
//   catalog  — array of engine_catalog entries ({id,label,purpose,minRamGb,
//              totalBytes,caps,recommended,installed,…}); chat + embed mixed
//   ramBytes — total system RAM in bytes, or null/0 when undetectable
//
// Returns { id, label, approx, vision, reason, lowRam, unknownRam } or null
// when the catalog carries no chat models. "approx" is a human GB string from
// totalBytes. Fit rule: a model qualifies when its catalog RAM floor
// (minRamGb) is ≤ actual memory — the floors already bake in OS/app headroom,
// so we pick the LARGEST qualifying model. Below every floor → smallest model
// with a lowRam warning; unknown RAM → the catalog's `recommended` pick.
function recommendEngineModel(catalog, ramBytes) {
  const chat = (Array.isArray(catalog) ? catalog : []).filter(
    (m) => m && m.purpose === "chat",
  );
  if (!chat.length) return null;
  const gbStr = (bytes) => `${((bytes || 0) / 1e9).toFixed(1)} GB`;
  const toCard = (m, extra) =>
    Object.assign(
      {
        id: m.id,
        label: m.label || m.id,
        approx: gbStr(m.totalBytes),
        vision: !!(m.caps && m.caps.vision),
        lowRam: false,
        unknownRam: false,
      },
      extra,
    );
  // Ascending by RAM floor, then size, so "largest that fits" is well-defined
  // even when two models share a floor.
  const asc = chat
    .slice()
    .sort(
      (a, b) =>
        a.minRamGb - b.minRamGb || (a.totalBytes || 0) - (b.totalBytes || 0),
    );
  if (!ramBytes || ramBytes <= 0) {
    // RAM undetectable (Windows, probe failure). Prefer the catalog's flagged
    // recommendation; fall back to the middle of the pack.
    const rec =
      chat.find((m) => m.recommended) || asc[Math.floor(asc.length / 2)];
    return toCard(rec, {
      unknownRam: true,
      reason:
        "We couldn't detect your memory, so this is a safe all-round default.",
    });
  }
  const gib = ramBytes / (1024 * 1024 * 1024);
  const gbRounded = Math.round(gib);
  const fits = asc.filter((m) => m.minRamGb <= gib);
  if (!fits.length) {
    // Even the smallest wants more than we have — recommend it anyway (it may
    // still run, just tight) with a warning.
    return toCard(asc[0], {
      lowRam: true,
      reason: `Your machine has about ${gbRounded} GB of memory — this is the smallest model and the safest fit. It may be tight; close other heavy apps.`,
    });
  }
  return toCard(fits[fits.length - 1], {
    reason: `Sized for your ${gbRounded} GB of memory, with headroom for the rest of your apps.`,
  });
}

// ── Watch recipes + Today digest (watch.jsx, main.jsx) ─────────────────────

// Turn a watch "recipe" + resolved default paths into a partial WatchModal
// form object (or null for the "custom" recipe / no recipe). Pure so the
// prefill mapping is unit-testable; `nowSecs` is passed in rather than read
// from the clock so tests are deterministic.
//
//   recipe — entry from WATCH_RECIPES (watch.jsx): { kind, promptSlug,
//            urlDiffMode?, useDownloadsDir?, skipExisting?, notesFileName?,
//            name?, custom? }
//   paths  — { downloadsDir, defaultNotesDir } from watch_default_paths
//   nowSecs — unix seconds, used as the ignore_before cutoff when the recipe
//            opts into skipping pre-existing files
function recipeToFormDefaults(recipe, paths, nowSecs) {
  if (!recipe || recipe.custom) return null;
  const p = paths || {};
  const kind = recipe.kind || "folder";
  const notesPath =
    p.defaultNotesDir && recipe.notesFileName
      ? `${p.defaultNotesDir}/${recipe.notesFileName}`
      : "";
  return {
    name: recipe.name || "",
    kind,
    folderPath: recipe.useDownloadsDir ? p.downloadsDir || "" : "",
    sourceUrl: "",
    urlSelector: "",
    urlDiffMode: recipe.urlDiffMode || "snapshot",
    intervalSecs: defaultIntervalForKind(kind),
    notesPath,
    promptId: recipe.promptSlug || null,
    notify: false,
    // Folder recipes that opt into skipping the existing backlog stamp the
    // cutoff at setup time; everything else leaves it unset (process all).
    ignoreBefore: recipe.skipExisting ? nowSecs : null,
  };
}

// Build a "Today" digest from watch events: group by watch, and produce a
// markdown `text` blob suitable for injecting into a chat. Error rows are
// counted (errors) but kept OUT of the chat text (they'd be noise to reason
// over). `count` is the number of summarised items included in `text`.
//
//   events  — [{ watchId, filePath, status, summary, error, createdAt }]
//   watches — [{ id, name }] used to label groups
function buildTodayDigest(events, watches) {
  const nameById = {};
  (watches || []).forEach((w) => {
    nameById[w.id] = w.name;
  });
  const order = [];
  const groupsMap = new Map();
  (events || []).forEach((e) => {
    if (!groupsMap.has(e.watchId)) {
      groupsMap.set(e.watchId, {
        watchId: e.watchId,
        watchName: nameById[e.watchId] || "Watch",
        items: [],
        errors: 0,
      });
      order.push(e.watchId);
    }
    const g = groupsMap.get(e.watchId);
    if (e.status === "error") g.errors += 1;
    g.items.push(e);
  });
  const groups = order.map((id) => groupsMap.get(id));

  let text = "";
  let count = 0;
  for (const g of groups) {
    const dones = g.items.filter(
      (it) => it.status === "done" && it.summary && it.summary.trim(),
    );
    if (!dones.length) continue;
    text += `## ${g.watchName}\n\n`;
    for (const it of dones) {
      const label = (it.filePath || "").split("/").pop() || "";
      text += label
        ? `### ${label}\n${it.summary.trim()}\n\n`
        : `${it.summary.trim()}\n\n`;
      count += 1;
    }
  }
  return { groups, text: text.trim(), count };
}

// ── Sidebar chat date-bucketing (main.jsx + shell.jsx) ─────────────────────
//
// Group chats into Today / Yesterday / Last 7 days / Last 30 days / Older.
// One pass over `chatRows`, no global mutation; safe to call on every render.
//
// Shape of the return value:
//   {
//     dateSections: [
//       { section: 'Today',         items: [...] },
//       { section: 'Yesterday',     items: [...] },
//       { section: 'Last 7 days',   items: [...] },
//       { section: 'Last 30 days',  items: [...] },
//       { section: 'Older',         items: [...] },
//       // empty date buckets are FILTERED out (matches prior behaviour)
//     ],
//   }
//
// Earlier this helper also produced per-group sections (sidebar folders).
// That concept was replaced by Spaces (workspace bundles) which carry
// system prompt + default model + pinned context on top of the same
// organizational role. The filter-by-Space step happens BEFORE this
// helper is called (in main.jsx: `chatRows.filter(c => c.spaceId === ...)`),
// so this function only ever sees the chats that should appear in the
// active view — pure date bucketing is all that's left.
//
// `chatRows` shape: the raw rows from `db_load_chats` (camelCased by serde).
function bucketChatsByDate(chatRows) {
  const now = new Date();
  const startOf = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
  const todayStart     = startOf(now);
  const yesterdayStart = startOf(new Date(now - 86400000));
  const weekStart      = startOf(new Date(now - 7  * 86400000));
  const monthStart     = startOf(new Date(now - 30 * 86400000));

  const dateBuckets = [
    { section: 'Today',        items: [] },
    { section: 'Yesterday',    items: [] },
    { section: 'Last 7 days',  items: [] },
    { section: 'Last 30 days', items: [] },
    { section: 'Older',        items: [] },
  ];

  for (const r of (chatRows || [])) {
    // Per-row reshape: parse multiModels JSON once (the DB stores it as
    // text), normalise tabType, format the relative-time label so the
    // ChatRow can render it without further work.
    const parsedModels = r.multiModels ? tryParseJson(r.multiModels, null) : null;
    const item = {
      id: r.id,
      title: r.title,
      model: r.model,
      when: relativeTime(r.updatedAt),
      preview: r.preview || null,
      tabType: r.tabType || null,
      models: Array.isArray(parsedModels) ? parsedModels : null,
      // spaceId is needed by the context menu's "Move to Space" submenu
      // (greys out the chat's current Space). Null means the chat is
      // not in any Space ("All chats" view).
      spaceId: r.spaceId || null,
    };

    const d = new Date(r.createdAt * 1000);
    if      (d >= todayStart)     dateBuckets[0].items.push(item);
    else if (d >= yesterdayStart) dateBuckets[1].items.push(item);
    else if (d >= weekStart)      dateBuckets[2].items.push(item);
    else if (d >= monthStart)     dateBuckets[3].items.push(item);
    else                          dateBuckets[4].items.push(item);
  }

  return {
    dateSections: dateBuckets.filter((b) => b.items.length > 0),
  };
}

// ── Chat-files grouping (files.jsx) ────────────────────────────────────────

// Collapse a flat list of chat_files rows into per-path entries. Each
// entry's `head` is the most recently-saved version; `versions` keeps all
// versions in insertion order so the UI can show "v3 of index.html". The
// returned list is sorted by `head.savedAt` descending so newest files
// appear at the top.
function ekFilesGroupByPath(rows) {
  const byPath = new Map();
  for (const r of rows) {
    const existing = byPath.get(r.relPath);
    if (!existing) {
      byPath.set(r.relPath, {
        relPath: r.relPath,
        head: r,
        versions: [r],
      });
    } else {
      existing.versions.push(r);
      if (r.savedAt > existing.head.savedAt) existing.head = r;
    }
  }
  return Array.from(byPath.values()).sort(
    (a, b) => b.head.savedAt - a.head.savedAt
  );
}

// ── Tauri API accessors (every JSX file used to re-derive these) ───────────
//
// Why these exist as helpers rather than inline lookups: the `invoke`
// expression in particular varied between files —
//   `(window.__TAURI__?.core ?? window.__TAURI__?.tauri)?.invoke`
//   `window.__TAURI__?.core?.invoke ?? window.__TAURI__?.tauri?.invoke`
// — both equivalent, but the second-form `??` fallback hides a subtle
// trap: if `?.core?.invoke` evaluates to `undefined` and `?.tauri` is
// present but its `.invoke` is also undefined, the result is still
// undefined. The first form picks the FIRST present namespace, then asks
// for `.invoke` once. Centralising removes the room for drift.
//
// All helpers return `undefined` when the API isn't present (non-Tauri
// dev, or the plugin isn't enabled). Callers MUST null-check — these
// helpers deliberately do NOT throw, because the most common call path
// is a feature-detect (`if (!getInvoke()) return;`).
//
// Note: in Node (the unit-test runtime) `window` is absent, so all of
// these return undefined. Pure tests don't exercise IPC.

function getTauriRoot() {
  return typeof window !== "undefined" ? window.__TAURI__ : undefined;
}

// The Tauri v2 IPC entry point. `core` is the v2 namespace; `tauri` is
// the v1-compat alias still present in some bundles. We pick whichever
// exists, then read `.invoke` from that branch — see comment above on
// why the order matters.
function getInvoke() {
  const t = getTauriRoot();
  return (t?.core ?? t?.tauri)?.invoke;
}

// Tauri 2's `Channel<T>` constructor — used for streaming Rust→JS data
// (chat tokens, large attachment indexing progress, etc). Same v2/v1
// dual-namespace lookup as getInvoke. Callers do
// `const ch = new (getChannel())(); ch.onmessage = (chunk) => ...;`
// and pass `ch` as a Tauri command argument; Rust's
// `Channel<T>::send(value)` fires `ch.onmessage(value)` on the JS side.
// Returns undefined when no Tauri runtime is present (Node tests).
function getChannel() {
  const t = getTauriRoot();
  return (t?.core ?? t?.tauri)?.Channel;
}

// tauri-plugin-dialog wrapper (open/save file pickers).
function getDialogApi() {
  return getTauriRoot()?.dialog;
}

// tauri-plugin-shell wrapper. NOTE: its `open()` rejects bare
// filesystem paths via the default capability scope (only mailto/tel/
// http URLs pass). For files/folders use the native commands —
// `chat_file_open`, `chat_file_reveal`, `attachment_reveal`,
// `attachment_hit_open`, `prompts_dir_reveal`. This accessor exists for
// the genuine URL-open call sites (memory.md edit-in-default-app, etc).
function getShellApi() {
  return getTauriRoot()?.shell;
}

// tauri::Event bridge — listen()/emit() for cross-process events.
function getEventApi() {
  return getTauriRoot()?.event;
}

// tauri-plugin-notification — used by WatchModal for the OS-permission
// prompt + status read.
function getNotificationApi() {
  return getTauriRoot()?.notification;
}

// Window namespace (getCurrentWindow / startDragging / etc). The v1
// fallback names are getCurrent / appWindow; callers that need them
// should reach into the root directly since the right shape varies by
// Tauri version. Kept here for the common-case label lookup.
function getWindowApi() {
  return getTauriRoot()?.window;
}

// ── Color helpers (theming) ─────────────────────────────────────────────
//
// hexToRgbTriplet: "#f0934a" → "240,147,74" — the shape CSS
// `rgba(var(--ek-accent-rgb), a)` needs. Accepts #rgb and #rrggbb; anything
// unparsable falls back to a neutral mid-gray triplet so a bad theme value
// degrades to legible output rather than a CSS parse error.
function hexToRgbTriplet(hex) {
  const h = String(hex || "").replace("#", "").trim();
  const x = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  if (!/^[0-9a-fA-F]{6}$/.test(x)) return "128,128,128";
  const n = parseInt(x, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

// lightenHex: mix a hex color toward white (amount > 0) or black
// (amount < 0). `amount` is clamped to [-1, 1]; 0 returns the input
// normalised to #rrggbb. Drives the derived accent shades (--ek-accent-hover,
// --ek-accent-ink) so themes only have to declare one accent hex.
function lightenHex(hex, amount) {
  const t = hexToRgbTriplet(hex).split(",").map(Number);
  const a = Math.max(-1, Math.min(1, Number(amount) || 0));
  const target = a >= 0 ? 255 : 0;
  return (
    "#" +
    t
      .map((c) => Math.round(c + (target - c) * Math.abs(a)))
      .map((c) => c.toString(16).padStart(2, "0"))
      .join("")
  );
}

// ── isLocalEndpoint ────────────────────────────────────────────────────────
//
// True when inference runs on THIS machine: the bundled engine, or an
// endpoint whose host is loopback (localhost / 127.0.0.0-8 / ::1 /
// *.localhost). Drives the StatusBar "Local · Private" caption — a remote
// host must NEVER be labeled private. Ollama with no base-URL override
// defaults to 127.0.0.1:11434, so a bare Ollama backend is local; an
// OpenAI-compatible backend REQUIRES a base URL, so an empty one there is
// treated as not-local rather than guessed. A LM Studio / llama-server BYO
// endpoint at 127.0.0.1 correctly reads as local.
function isLocalEndpoint(backendKind, baseUrl) {
  if (backendKind === "engine") return true;
  if (!baseUrl) return backendKind === "ollama";
  let host;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl)
      ? baseUrl
      : "http://" + baseUrl;
    host = new URL(withScheme).hostname.toLowerCase();
  } catch (_e) {
    return false;
  }
  // URL() keeps the brackets on IPv6 literals ('[::1]'); strip them so the
  // loopback compare below sees a bare '::1'.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

// ── greetingForHour ────────────────────────────────────────────────────────
//
// Time-of-day greeting for the empty-chat state. Pure (takes the hour) so
// it's node-testable; the component passes `new Date().getHours()`. No name —
// Ekorbia doesn't store one.
function greetingForHour(hour) {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// ── Publish on window (browser) and module.exports (Node) ──────────────────
//
// `typeof window` lets the same file work as both a global-scope script
// (loaded via <script src="utils.js">) and a CommonJS module (require'd
// from a node:test file). Both guards are necessary: Node has no `window`,
// the browser has no `module`.

if (typeof window !== "undefined") {
  window.detectPlatform = detectPlatform;
  window.IS_MAC = IS_MAC;
  window.IS_LINUX = IS_LINUX;
  window.IS_WIN = IS_WIN;
  window.MOD_GLYPH = MOD_GLYPH;
  window.ENTER_GLYPH = ENTER_GLYPH;
  window.HOTKEY_MOD_CODES = HOTKEY_MOD_CODES;
  window.formatHotkey = formatHotkey;
  window.hotkeyFromEvent = hotkeyFromEvent;
  window.LANG_DEFAULT_NAME = LANG_DEFAULT_NAME;
  window.FILENAME_HINT_PATTERNS = FILENAME_HINT_PATTERNS;
  window.uniquifyFilename = uniquifyFilename;
  window.inferFilename = inferFilename;
  window.parseFencedBlocks = parseFencedBlocks;
  window.escapeHtml = escapeHtml;
  window.escapeAttr = escapeAttr;
  window.relativeTime = relativeTime;
  window.tryParseJson = tryParseJson;
  window.genId = genId;
  window.defaultIntervalForKind = defaultIntervalForKind;
  window.formatBytes = formatBytes;
  window.accumulatePullProgress = accumulatePullProgress;
  window.voiceModelProgress = voiceModelProgress;
  window.formatClock = formatClock;
  window.applyThinkPref = applyThinkPref;
  window.recommendGemmaModel = recommendGemmaModel;
  window.recommendEngineModel = recommendEngineModel;
  window.recipeToFormDefaults = recipeToFormDefaults;
  window.buildTodayDigest = buildTodayDigest;
  window.ekFilesGroupByPath = ekFilesGroupByPath;
  window.bucketChatsByDate = bucketChatsByDate;
  window.getTauriRoot = getTauriRoot;
  window.getInvoke = getInvoke;
  window.getChannel = getChannel;
  window.getDialogApi = getDialogApi;
  window.getShellApi = getShellApi;
  window.getEventApi = getEventApi;
  window.getNotificationApi = getNotificationApi;
  window.getWindowApi = getWindowApi;
  window.instantiateSpacePinnedAttachments = instantiateSpacePinnedAttachments;
  window.hexToRgbTriplet = hexToRgbTriplet;
  window.lightenHex = lightenHex;
  window.isLocalEndpoint = isLocalEndpoint;
  window.greetingForHour = greetingForHour;
}

// ── instantiateSpacePinnedAttachments ────────────────────────────────────
//
// Instantiate a Space's pinned files/folders as real chat attachments on a
// freshly-minted chat. Reuses the existing Rust commands —
// `attachment_add_files` (batches every file path in one call) and
// `attachment_add_folder` (one walker task per folder).
//
// Pure dispatcher: takes `invokeFn` as a parameter rather than reading a
// global so the node:test runner can stand it up against an in-memory
// recording mock without booting the WebView. Errors are surfaced via the
// optional `onError(e, kind, path?)` callback; the App layer turns those
// into toasts. `onComplete()` fires after every dispatch resolves — the
// App uses it to refresh `chatAttachments`.
//
// Contract pinned by ui/__tests__/utils.test.js:
//   • Files are batched into ONE attachment_add_files call regardless of
//     count — a Space with 12 pinned files doesn't make 12 round-trips.
//   • Folders are dispatched serially (one attachment_add_folder per
//     folder) so the Rust walker doesn't contend on the SQLite write
//     lock; running 3 walkers in parallel would just queue inside
//     rusqlite anyway.
//   • A per-folder failure does NOT block subsequent folders — useful
//     for partially-broken Space states (one pinned folder was moved
//     off disk; the rest should still load).
//   • Files dispatch BEFORE folders so the user sees small inline
//     attachments while the walker churns.
//   • Empty / non-array `pinned` → fast-return, no invokes, but
//     onComplete still fires so callers can do unconditional cleanup.
async function instantiateSpacePinnedAttachments(invokeFn, chatId, pinned, opts) {
  opts = opts || {};
  if (!chatId || !Array.isArray(pinned) || pinned.length === 0) {
    if (opts.onComplete) opts.onComplete();
    return;
  }
  const filePaths = pinned
    .filter(function (a) { return a && a.kind === "file"; })
    .map(function (a) { return a.path; })
    .filter(Boolean);
  const folderPaths = pinned
    .filter(function (a) { return a && a.kind === "folder"; })
    .map(function (a) { return a.path; })
    .filter(Boolean);

  if (filePaths.length) {
    try {
      await invokeFn("attachment_add_files", { chatId: chatId, paths: filePaths });
    } catch (e) {
      if (opts.onError) opts.onError(e, "files");
    }
  }

  for (const path of folderPaths) {
    try {
      await invokeFn("attachment_add_folder", { chatId: chatId, path: path });
    } catch (e) {
      if (opts.onError) opts.onError(e, "folder", path);
    }
  }

  if (opts.onComplete) opts.onComplete();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    detectPlatform,
    IS_MAC,
    IS_LINUX,
    IS_WIN,
    MOD_GLYPH,
    ENTER_GLYPH,
    HOTKEY_MOD_CODES,
    formatHotkey,
    hotkeyFromEvent,
    LANG_DEFAULT_NAME,
    FILENAME_HINT_PATTERNS,
    uniquifyFilename,
    inferFilename,
    parseFencedBlocks,
    escapeHtml,
    escapeAttr,
    relativeTime,
    tryParseJson,
    genId,
    defaultIntervalForKind,
    formatBytes,
    accumulatePullProgress,
    voiceModelProgress,
    formatClock,
    applyThinkPref,
    recommendGemmaModel,
    recommendEngineModel,
    recipeToFormDefaults,
    buildTodayDigest,
    ekFilesGroupByPath,
    bucketChatsByDate,
    getTauriRoot,
    getInvoke,
    getChannel,
    getDialogApi,
    getShellApi,
    getEventApi,
    getNotificationApi,
    getWindowApi,
    instantiateSpacePinnedAttachments,
    hexToRgbTriplet,
    lightenHex,
    isLocalEndpoint,
    greetingForHour,
  };
}
