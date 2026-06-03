// node:test cases for the pure helpers extracted to ui/utils.js. Run with:
//   node --test ui/__tests__/
// from the repo root. Zero dependencies — node:test ships with Node 18+.

const { test } = require("node:test");
const assert = require("node:assert");
const {
  detectPlatform,
  formatHotkey,
  hotkeyFromEvent,
  parseFencedBlocks,
  inferFilename,
  uniquifyFilename,
  escapeHtml,
  escapeAttr,
  relativeTime,
  tryParseJson,
  genId,
  defaultIntervalForKind,
  ekFilesGroupByPath,
  groupChatsForSidebar,
  OLLAMA_BASE,
} = require("../utils.js");

// ── formatHotkey ─────────────────────────────────────────────────────────

test("formatHotkey: empty / null returns 'Not set'", () => {
  assert.equal(formatHotkey(""), "Not set");
  assert.equal(formatHotkey(null), "Not set");
  assert.equal(formatHotkey(undefined), "Not set");
});

test("formatHotkey: known modifiers and code", () => {
  // The default Quick-query hotkey in CLAUDE.md / settings.
  assert.equal(formatHotkey("Super+Shift+Space"), "⌘⇧Space");
});

test("formatHotkey: KeyA / Digit5 prefix strips", () => {
  assert.equal(formatHotkey("Super+KeyA"), "⌘A");
  assert.equal(formatHotkey("Super+Shift+Digit5"), "⌘⇧5");
});

test("formatHotkey: arrows + esc + tab map to symbols", () => {
  assert.equal(formatHotkey("Ctrl+ArrowUp"), "⌃↑");
  assert.equal(formatHotkey("Alt+Escape"), "⌥Esc");
  assert.equal(formatHotkey("Shift+Tab"), "⇧⇥");
});

test("formatHotkey: unknown token passes through", () => {
  // F-keys aren't in either glyph map → returned verbatim.
  assert.equal(formatHotkey("Ctrl+F12"), "⌃F12");
});

test("formatHotkey: equivalent modifier names map to same glyph", () => {
  // Tauri uses "Super"; some specs use "Cmd"/"Meta" — UI shouldn't care.
  assert.equal(formatHotkey("Cmd+KeyA"), "⌘A");
  assert.equal(formatHotkey("Meta+KeyA"), "⌘A");
  assert.equal(formatHotkey("Option+KeyA"), "⌥A");
});

// ── formatHotkey: cross-platform rendering (Phases L1 / W1) ─────────────

test("formatHotkey: Linux renders modifiers as text with + separators", () => {
  // Linux convention is plain text labels — the platform doesn't have a
  // dedicated Spotlight-style icon vocabulary the way macOS does.
  assert.equal(formatHotkey("Super+Shift+Space", "linux"), "Super+Shift+Space");
  assert.equal(formatHotkey("Ctrl+Alt+KeyN", "linux"), "Ctrl+Alt+N");
  assert.equal(formatHotkey("Super+Digit5", "linux"), "Super+5");
});

test("formatHotkey: Windows renders Super as 'Win' with + separators", () => {
  // Windows users expect "Win+Shift+Space", not "Super+...". The Tauri
  // underlying spec still uses "Super" — we translate at the UI layer
  // so storage stays cross-platform.
  assert.equal(formatHotkey("Super+Shift+Space", "windows"), "Win+Shift+Space");
  assert.equal(formatHotkey("Super+KeyA", "windows"), "Win+A");
  assert.equal(formatHotkey("Cmd+KeyA", "windows"), "Win+A");
  assert.equal(formatHotkey("Meta+KeyA", "windows"), "Win+A");
});

test("formatHotkey: Linux + Windows pass through unknown tokens", () => {
  assert.equal(formatHotkey("Ctrl+F12", "linux"), "Ctrl+F12");
  assert.equal(formatHotkey("Ctrl+F12", "windows"), "Ctrl+F12");
});

test("formatHotkey: empty / null returns 'Not set' on every platform", () => {
  assert.equal(formatHotkey("", "linux"), "Not set");
  assert.equal(formatHotkey(null, "windows"), "Not set");
});

// ── detectPlatform ──────────────────────────────────────────────────────

test("detectPlatform: Node (no navigator) returns 'macos'", () => {
  // Default to macOS in Node because the existing test suite was written
  // against the macOS glyphs. Real browsers populate navigator and route
  // to the correct branch automatically.
  assert.equal(detectPlatform(), "macos");
});

// ── OLLAMA_BASE ──────────────────────────────────────────────────────────

test("OLLAMA_BASE: uses IPv4 explicitly (not 'localhost')", () => {
  // Regression guard: the Windows WebView2 startup crash that shipped in
  // 0.3.0-rc1 was caused by `http://localhost:11434` — Chromium tried
  // IPv6 ::1 first, Ollama wasn't listening there, and the 3s fetch
  // timeout fired before IPv4 fallback. The fix is forcing 127.0.0.1.
  // If anyone reverts the constant to localhost, this fails and the
  // PR description explains why.
  assert.equal(OLLAMA_BASE, "http://127.0.0.1:11434");
  assert.ok(!OLLAMA_BASE.includes("localhost"), "must NOT use 'localhost'");
});

// ── hotkeyFromEvent ──────────────────────────────────────────────────────

test("hotkeyFromEvent: bare modifier press returns null", () => {
  // Capture should keep listening when only a modifier is down — the user
  // is reaching for the actual key.
  assert.equal(
    hotkeyFromEvent({ code: "ShiftLeft", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }),
    null
  );
});

test("hotkeyFromEvent: no modifier returns null", () => {
  // Don't bind plain letters to global shortcuts.
  assert.equal(
    hotkeyFromEvent({ code: "KeyA", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }),
    null
  );
});

test("hotkeyFromEvent: valid combo produces spec", () => {
  const spec = hotkeyFromEvent({
    code: "KeyA",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
  });
  assert.equal(spec, "Super+Shift+KeyA");
});

test("hotkeyFromEvent: modifier order is canonical", () => {
  // Meta → Ctrl → Alt → Shift → code. Locks in the spec format so the
  // Rust-side registry can match on string equality.
  const spec = hotkeyFromEvent({
    code: "Space",
    metaKey: true,
    ctrlKey: true,
    altKey: true,
    shiftKey: true,
  });
  assert.equal(spec, "Super+Ctrl+Alt+Shift+Space");
});

// ── parseFencedBlocks ────────────────────────────────────────────────────

test("parseFencedBlocks: no markdown returns empty", () => {
  assert.deepEqual(parseFencedBlocks(""), []);
  assert.deepEqual(parseFencedBlocks(null), []);
});

test("parseFencedBlocks: plain text without fences returns empty", () => {
  assert.deepEqual(parseFencedBlocks("Just some prose, no code blocks."), []);
});

test("parseFencedBlocks: single fence with language tag", () => {
  const md = "Here:\n```python\nprint('hello world')\n```\nDone.";
  const out = parseFencedBlocks(md);
  assert.equal(out.length, 1);
  assert.equal(out[0].language, "python");
  assert.equal(out[0].content, "print('hello world')");
  assert.equal(out[0].filename, "main.py");
  assert.equal(out[0].ordinal, 0);
});

test("parseFencedBlocks: short content (< 6 chars) is skipped but bumps ordinal", () => {
  // Documented in chat.jsx: bare ```output\nhi\n``` shouldn't produce a
  // save button (it's not a file), but the ordinal must still advance so
  // subsequent blocks get stable indices.
  const md = "```\nhi\n```\n```js\nconsole.log('hello world');\n```";
  const out = parseFencedBlocks(md);
  assert.equal(out.length, 1);
  assert.equal(out[0].ordinal, 1);
  assert.equal(out[0].filename, "main.js");
});

test("parseFencedBlocks: doctype HTML routes to index.html", () => {
  // Plain ``` block (no language tag) but obvious HTML doc → save as
  // index.html, not snippet.txt. Documented heuristic in inferFilename.
  const md = "```\n<!doctype html>\n<html><body>hi</body></html>\n```";
  const out = parseFencedBlocks(md);
  assert.equal(out[0].filename, "index.html");
});

test("parseFencedBlocks: comment-hint pattern wins over default", () => {
  // `// foo.js` first-line hint in a JS block should override main.js.
  const md = "```javascript\n// utils.js\nexport const x = 1;\n```";
  const out = parseFencedBlocks(md);
  assert.equal(out[0].filename, "utils.js");
});

test("parseFencedBlocks: duplicate filenames get -2, -3 suffixes", () => {
  const md = [
    "```python\nimport sys\nprint('a')\n```",
    "```python\nimport os\nprint('b')\n```",
    "```python\nimport re\nprint('c')\n```",
  ].join("\n");
  const out = parseFencedBlocks(md);
  assert.deepEqual(out.map((o) => o.filename), ["main.py", "main-2.py", "main-3.py"]);
});

test("parseFencedBlocks: unknown language falls back to snippet.<lang>", () => {
  const md = "```elixir\ndefmodule Foo do\nend\n```";
  const out = parseFencedBlocks(md);
  assert.equal(out[0].filename, "snippet.elixir");
});

// ── uniquifyFilename ─────────────────────────────────────────────────────

test("uniquifyFilename: not taken returns unchanged", () => {
  assert.equal(uniquifyFilename("fresh.txt", new Set()), "fresh.txt");
});

test("uniquifyFilename: taken returns -2", () => {
  assert.equal(uniquifyFilename("foo.js", new Set(["foo.js"])), "foo-2.js");
});

test("uniquifyFilename: taken-2 also taken returns -3", () => {
  assert.equal(
    uniquifyFilename("foo.js", new Set(["foo.js", "foo-2.js"])),
    "foo-3.js"
  );
});

test("uniquifyFilename: extension handling preserves stem.ext shape", () => {
  // dotfiles (.gitignore) have no stem before the dot — uniquify treats
  // the whole thing as a stem since `lastIndexOf('.')` is 0.
  assert.equal(
    uniquifyFilename(".gitignore", new Set([".gitignore"])),
    ".gitignore-2"
  );
});

// ── escapeHtml / escapeAttr ──────────────────────────────────────────────

test("escapeHtml: dangerous chars are entity-encoded", () => {
  // Security-critical: assistant message text rendered as markdown HTML
  // goes through this before injection. A regression here is an XSS.
  assert.equal(
    escapeHtml("<script>alert('XSS&\"hi\"')</script>"),
    "&lt;script&gt;alert(&#39;XSS&amp;&quot;hi&quot;&#39;)&lt;/script&gt;"
  );
});

test("escapeHtml: non-string input is coerced", () => {
  // Defensive — markdown.jsx feeds numbers + objects through here.
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(null), "null");
});

test("escapeAttr: strips everything but alnum + _-", () => {
  // Whitelist-based — used when building attribute values by string
  // concatenation (citation chips). Stricter than escapeHtml because
  // attribute contexts have more injection surface.
  assert.equal(escapeAttr("file-1_abc"), "file-1_abc");
  assert.equal(escapeAttr("foo bar/../etc"), "foobaretc");
  assert.equal(escapeAttr("\" onclick=alert(1) \""), "onclickalert1");
});

// ── relativeTime ─────────────────────────────────────────────────────────

test("relativeTime: < 60s returns 'now'", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(relativeTime(now), "now");
  assert.equal(relativeTime(now - 30), "now");
});

test("relativeTime: < 1h returns minutes", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(relativeTime(now - 60), "1m");
  assert.equal(relativeTime(now - 1800), "30m");
});

test("relativeTime: < 1d returns hours", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(relativeTime(now - 3600), "1h");
  assert.equal(relativeTime(now - 7200), "2h");
});

test("relativeTime: >= 1d returns days", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(relativeTime(now - 86400), "1d");
  assert.equal(relativeTime(now - 86400 * 7), "7d");
});

test("relativeTime: verbose mode adds 'ago' suffix + 'just now'", () => {
  const now = Math.floor(Date.now() / 1000);
  const v = { verbose: true };
  assert.equal(relativeTime(now,             v), "just now");
  assert.equal(relativeTime(now - 30,        v), "just now");
  assert.equal(relativeTime(now - 60,        v), "1m ago");
  assert.equal(relativeTime(now - 1800,      v), "30m ago");
  assert.equal(relativeTime(now - 3600,      v), "1h ago");
  assert.equal(relativeTime(now - 86400,     v), "1d ago");
  assert.equal(relativeTime(now - 86400 * 7, v), "7d ago");
});

test("relativeTime: future timestamps clamp to 'now' (no negative diffs)", () => {
  // Clock skew or a server-side timestamp slightly ahead would otherwise
  // render as "-3m" / "-3m ago". Clamp keeps the label benign.
  const now = Math.floor(Date.now() / 1000);
  assert.equal(relativeTime(now + 30), "now");
  assert.equal(relativeTime(now + 60, { verbose: true }), "just now");
});

// ── tryParseJson ─────────────────────────────────────────────────────────

test("tryParseJson: valid JSON parses", () => {
  assert.deepEqual(tryParseJson('{"a":1}', null), { a: 1 });
  assert.deepEqual(tryParseJson("[1,2,3]", null), [1, 2, 3]);
});

test("tryParseJson: invalid JSON returns fallback", () => {
  assert.equal(tryParseJson("not json", "fallback"), "fallback");
  assert.equal(tryParseJson("{unterminated", null), null);
  assert.deepEqual(tryParseJson("[", []), []);
});

// ── genId ────────────────────────────────────────────────────────────────

test("genId: non-empty string", () => {
  const id = genId();
  assert.equal(typeof id, "string");
  assert.ok(id.length > 5, "id should be at least a few chars");
});

test("genId: two calls produce different ids", () => {
  // Time-based + random suffix — collision rate is astronomically low.
  // If this ever flakes, the random slice is too short.
  const a = genId();
  const b = genId();
  assert.notEqual(a, b);
});

// ── defaultIntervalForKind ───────────────────────────────────────────────

test("defaultIntervalForKind: rss => 600", () => {
  assert.equal(defaultIntervalForKind("rss"), 600);
});

test("defaultIntervalForKind: url => 1800", () => {
  assert.equal(defaultIntervalForKind("url"), 1800);
});

test("defaultIntervalForKind: folder + unknown => 30", () => {
  assert.equal(defaultIntervalForKind("folder"), 30);
  // Defensive: an unrecognised kind shouldn't pick "url" by accident —
  // 30s is the safest default for any new file-watch flavour.
  assert.equal(defaultIntervalForKind("bogus"), 30);
  assert.equal(defaultIntervalForKind(""), 30);
});

// ── ekFilesGroupByPath ───────────────────────────────────────────────────

test("ekFilesGroupByPath: empty list returns empty", () => {
  assert.deepEqual(ekFilesGroupByPath([]), []);
});

test("ekFilesGroupByPath: groups by relPath", () => {
  const rows = [
    { relPath: "index.html", savedAt: 10, version: 1 },
    { relPath: "style.css", savedAt: 20, version: 1 },
    { relPath: "index.html", savedAt: 30, version: 2 },
  ];
  const groups = ekFilesGroupByPath(rows);
  assert.equal(groups.length, 2);
  const html = groups.find((g) => g.relPath === "index.html");
  assert.equal(html.versions.length, 2);
});

test("ekFilesGroupByPath: head is the row with max savedAt", () => {
  const rows = [
    { relPath: "x.txt", savedAt: 10, version: 1 },
    { relPath: "x.txt", savedAt: 100, version: 2 }, // newer
    { relPath: "x.txt", savedAt: 50, version: 3 },
  ];
  const [g] = ekFilesGroupByPath(rows);
  assert.equal(g.head.savedAt, 100);
  assert.equal(g.head.version, 2);
});

test("ekFilesGroupByPath: sorted by head.savedAt desc", () => {
  const rows = [
    { relPath: "old.txt", savedAt: 5, version: 1 },
    { relPath: "new.txt", savedAt: 100, version: 1 },
    { relPath: "mid.txt", savedAt: 50, version: 1 },
  ];
  const groups = ekFilesGroupByPath(rows);
  assert.deepEqual(
    groups.map((g) => g.relPath),
    ["new.txt", "mid.txt", "old.txt"]
  );
});

// ── groupChatsForSidebar ─────────────────────────────────────────────────

// Convenience: build a chat row with date-aware createdAt + updatedAt.
// All tests fix `now` to a known timestamp so bucket boundaries are stable.
function mkChat(overrides) {
  const nowSec = Math.floor(Date.now() / 1000);
  return Object.assign(
    {
      id: "c-x",
      title: "untitled",
      model: "m",
      createdAt: nowSec,
      updatedAt: nowSec,
      tabType: null,
      multiModels: null,
      groupId: null,
    },
    overrides
  );
}

test("groupChatsForSidebar: no groups + no chats returns empty shape", () => {
  const out = groupChatsForSidebar([], []);
  assert.deepEqual(out, { groups: [], dateSections: [] });
});

test("groupChatsForSidebar: handles null/undefined args without crashing", () => {
  // Defensive: callers may invoke this before the first db_load_groups
  // returns. Should not throw — empty shape is the right answer.
  assert.deepEqual(groupChatsForSidebar(null, null), {
    groups: [],
    dateSections: [],
  });
  assert.deepEqual(groupChatsForSidebar(undefined, undefined), {
    groups: [],
    dateSections: [],
  });
});

test("groupChatsForSidebar: chats with no groups fall into date sections", () => {
  const chats = [mkChat({ id: "c1", title: "today" })];
  const out = groupChatsForSidebar(chats, []);
  assert.equal(out.groups.length, 0);
  assert.equal(out.dateSections.length, 1);
  assert.equal(out.dateSections[0].section, "Today");
  assert.equal(out.dateSections[0].items[0].id, "c1");
});

test("groupChatsForSidebar: empty groups are KEPT in output (just-created folder visibility)", () => {
  // A user who just created "Work" must see it in the sidebar even
  // before they've filed anything into it.
  const out = groupChatsForSidebar([], [{ id: "g1", name: "Work" }]);
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].id, "g1");
  assert.equal(out.groups[0].name, "Work");
  assert.deepEqual(out.groups[0].items, []);
});

test("groupChatsForSidebar: empty DATE buckets are filtered (no 'Older' if nothing's old)", () => {
  // Symmetric assertion to the previous test: empty groups stay, empty
  // date buckets go. Matches the legacy groupChatsByDate behaviour.
  const chats = [mkChat({ id: "c1", title: "today" })];
  const out = groupChatsForSidebar(chats, []);
  // Only the Today section, no Yesterday/Last 7 days/etc.
  assert.equal(out.dateSections.length, 1);
  assert.equal(out.dateSections[0].section, "Today");
});

test("groupChatsForSidebar: chats route to their group, not to date sections", () => {
  const chats = [
    mkChat({ id: "c1", title: "filed", groupId: "g1" }),
    mkChat({ id: "c2", title: "loose" }),
  ];
  const out = groupChatsForSidebar(chats, [{ id: "g1", name: "Work" }]);
  // c1 in the group; c2 in Today.
  assert.equal(out.groups[0].items.length, 1);
  assert.equal(out.groups[0].items[0].id, "c1");
  assert.equal(out.dateSections.length, 1);
  assert.equal(out.dateSections[0].items[0].id, "c2");
});

test("groupChatsForSidebar: chat referencing a deleted group falls through to date sections", () => {
  // Defensive: race between db_delete_group and the sidebar render. The
  // stale groupId on the chat row points to a group that's no longer in
  // the list — shouldn't crash, shouldn't lose the chat. It surfaces in
  // its date bucket until the next reload picks up the NULLed column.
  const chats = [mkChat({ id: "c1", groupId: "ghost-group" })];
  const out = groupChatsForSidebar(chats, []);
  assert.equal(out.groups.length, 0);
  assert.equal(out.dateSections.length, 1);
  assert.equal(out.dateSections[0].items[0].id, "c1");
});

test("groupChatsForSidebar: group display order matches input order (sort_order)", () => {
  // The Rust side returns groups already sorted by sort_order ASC. We
  // preserve that order verbatim — no re-sort here.
  const out = groupChatsForSidebar(
    [],
    [
      { id: "g2", name: "Personal" },
      { id: "g1", name: "Work" },
      { id: "g3", name: "Research" },
    ]
  );
  assert.deepEqual(
    out.groups.map((g) => g.id),
    ["g2", "g1", "g3"]
  );
});

test("groupChatsForSidebar: groupId is exposed on each item", () => {
  // The context menu needs this to grey out "Move to {currentGroup}".
  const chats = [
    mkChat({ id: "c1", groupId: "g1" }),
    mkChat({ id: "c2" }),
  ];
  const out = groupChatsForSidebar(chats, [{ id: "g1", name: "Work" }]);
  assert.equal(out.groups[0].items[0].groupId, "g1");
  assert.equal(out.dateSections[0].items[0].groupId, null);
});

test("groupChatsForSidebar: multiModels JSON is parsed once per chat", () => {
  // Same per-row reshape as the legacy date grouper — sidebar items get
  // a parsed `models` array (or null on malformed/absent).
  const chats = [
    mkChat({
      id: "c1",
      tabType: "multi-pending",
      multiModels: '["llama3","gemma4"]',
    }),
    mkChat({ id: "c2", multiModels: "not valid json" }),
  ];
  const out = groupChatsForSidebar(chats, []);
  const items = out.dateSections[0].items;
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(byId.c1.models, ["llama3", "gemma4"]);
  assert.equal(byId.c1.tabType, "multi-pending");
  // Malformed JSON falls back to null — chat behaves as single-mode.
  assert.equal(byId.c2.models, null);
});

test("groupChatsForSidebar: filed chat does NOT also appear in a date section", () => {
  // Bug guard: each chat must be in EXACTLY one place across the two
  // output lists, never both.
  const chats = [mkChat({ id: "c1", groupId: "g1" })];
  const out = groupChatsForSidebar(chats, [{ id: "g1", name: "Work" }]);
  const idsInDateSections = out.dateSections.flatMap((s) =>
    s.items.map((i) => i.id)
  );
  assert.ok(!idsInDateSections.includes("c1"));
});
