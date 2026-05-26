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

// Convert a "Super+Shift+Space"-style spec into a human-readable label using
// macOS keyboard symbols. Falls back to the raw token for anything we don't
// have a glyph for.
function formatHotkey(spec) {
  if (!spec) return "Not set";
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
    .map((p) => {
      if (modGlyphs[p]) return modGlyphs[p];
      if (codeGlyphs[p]) return codeGlyphs[p];
      // KeyA / KeyB / ... — strip prefix
      if (p.startsWith("Key")) return p.slice(3);
      // Digit0 / Digit1 / ... — strip prefix
      if (p.startsWith("Digit")) return p.slice(5);
      // F1..F24 and anything else we don't handle — leave as-is
      return p;
    })
    .join("");
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

// ── Sidebar chat grouping (main.jsx + shell.jsx) ───────────────────────────
//
// Lay out the sidebar in two stacked sections: user-defined groups (above)
// and date buckets (below, for chats not filed into any group). One pass
// over `chatRows`, no global mutation; safe to call on every render.
//
// Shape of the return value:
//   {
//     groups: [
//       { id, name, items: [item, ...] },  // in group sort order
//       // empty groups are KEPT (user just created one → must show)
//       ...
//     ],
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
// Each `item` mirrors what the sidebar consumed before groups existed —
// callers (ChatRow) don't need to know whether they came from a group or
// a date bucket. `groupId` rides along so the context-menu can tell which
// group a chat is already in (to grey out the matching menu entry).
//
// `chatRows` shape: the raw rows from `db_load_chats` (camelCased by serde).
// `groups`   shape: rows from `db_load_groups`, already in display order.
function groupChatsForSidebar(chatRows, groups) {
  // Bucket boundaries — same semantics as the legacy date-only grouper.
  const now = new Date();
  const startOf = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
  const todayStart     = startOf(now);
  const yesterdayStart = startOf(new Date(now - 86400000));
  const weekStart      = startOf(new Date(now - 7  * 86400000));
  const monthStart     = startOf(new Date(now - 30 * 86400000));

  // Pre-build the group containers + an id→items map for O(1) routing.
  // Empty groups stay in the output list so a freshly-created folder
  // shows up immediately even before the user files anything into it.
  const groupList = (groups || []).map((g) => ({
    id: g.id,
    name: g.name,
    items: [],
  }));
  const groupItemsById = new Map(groupList.map((g) => [g.id, g.items]));

  const dateBuckets = [
    { section: 'Today',        items: [] },
    { section: 'Yesterday',    items: [] },
    { section: 'Last 7 days',  items: [] },
    { section: 'Last 30 days', items: [] },
    { section: 'Older',        items: [] },
  ];

  for (const r of (chatRows || [])) {
    // Same per-row reshape as the legacy date-only path: parse multiModels
    // JSON once (the DB stores it as text), normalize tabType, format the
    // relative-time label so the ChatRow can render it without further work.
    const parsedModels = r.multiModels ? tryParseJson(r.multiModels, null) : null;
    const item = {
      id: r.id,
      title: r.title,
      model: r.model,
      when: relativeTime(r.updatedAt),
      tabType: r.tabType || null,
      models: Array.isArray(parsedModels) ? parsedModels : null,
      // groupId is needed by the context menu to grey-out the
      // "Move to {currentGroup}" option. Null on ungrouped chats.
      groupId: r.groupId || null,
    };

    // Route into a group if one exists for this chat's groupId; otherwise
    // fall through to the date buckets. A chat whose groupId points to a
    // group that's been deleted (race) treats as ungrouped — no crash,
    // chat just shows under date sections until the next reload picks up
    // the NULLed column from the cascade / unfile.
    const groupBucket = item.groupId ? groupItemsById.get(item.groupId) : null;
    if (groupBucket) {
      groupBucket.push(item);
      continue;
    }

    const d = new Date(r.createdAt * 1000);
    if      (d >= todayStart)     dateBuckets[0].items.push(item);
    else if (d >= yesterdayStart) dateBuckets[1].items.push(item);
    else if (d >= weekStart)      dateBuckets[2].items.push(item);
    else if (d >= monthStart)     dateBuckets[3].items.push(item);
    else                          dateBuckets[4].items.push(item);
  }

  return {
    groups: groupList,
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

// ── Publish on window (browser) and module.exports (Node) ──────────────────
//
// `typeof window` lets the same file work as both a global-scope script
// (loaded via <script src="utils.js">) and a CommonJS module (require'd
// from a node:test file). Both guards are necessary: Node has no `window`,
// the browser has no `module`.

if (typeof window !== "undefined") {
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
  window.ekFilesGroupByPath = ekFilesGroupByPath;
  window.groupChatsForSidebar = groupChatsForSidebar;
  window.getTauriRoot = getTauriRoot;
  window.getInvoke = getInvoke;
  window.getDialogApi = getDialogApi;
  window.getShellApi = getShellApi;
  window.getEventApi = getEventApi;
  window.getNotificationApi = getNotificationApi;
  window.getWindowApi = getWindowApi;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
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
    ekFilesGroupByPath,
    groupChatsForSidebar,
    getTauriRoot,
    getInvoke,
    getDialogApi,
    getShellApi,
    getEventApi,
    getNotificationApi,
    getWindowApi,
  };
}
