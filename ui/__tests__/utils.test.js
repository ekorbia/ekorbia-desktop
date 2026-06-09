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
  bucketChatsByDate,
  instantiateSpacePinnedAttachments,
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

// Note: the UI-side `OLLAMA_BASE: uses IPv4 explicitly` regression test
// was removed in Phase B (Jun 2026) when the UI stopped touching Ollama
// HTTP directly. The IPv4 invariant now lives in
// src-tauri/src/ollama.rs's `OLLAMA_BASE` constant; verify it there.

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

// ── bucketChatsByDate ────────────────────────────────────────────────────
//
// Earlier this helper was `groupChatsForSidebar`, which produced both a
// per-group array AND a per-date-section array. Groups were replaced
// entirely by Spaces (workspace bundles) — the Sidebar now filters
// chatRows by activeSpaceId BEFORE passing them in, so the helper only
// has to do pure date bucketing.

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
      spaceId: null,
    },
    overrides
  );
}

test("bucketChatsByDate: no chats returns empty shape", () => {
  assert.deepEqual(bucketChatsByDate([]), { dateSections: [] });
});

test("bucketChatsByDate: handles null/undefined args without crashing", () => {
  // Defensive: callers may invoke this before the first db_load_chats
  // returns. Should not throw — empty shape is the right answer.
  assert.deepEqual(bucketChatsByDate(null), { dateSections: [] });
  assert.deepEqual(bucketChatsByDate(undefined), { dateSections: [] });
});

test("bucketChatsByDate: chats fall into the Today section", () => {
  const out = bucketChatsByDate([mkChat({ id: "c1", title: "today" })]);
  assert.equal(out.dateSections.length, 1);
  assert.equal(out.dateSections[0].section, "Today");
  assert.equal(out.dateSections[0].items[0].id, "c1");
});

test("bucketChatsByDate: empty DATE buckets are filtered (no 'Older' if nothing's old)", () => {
  const out = bucketChatsByDate([mkChat({ id: "c1", title: "today" })]);
  // Only the Today section, no Yesterday/Last 7 days/etc.
  assert.equal(out.dateSections.length, 1);
  assert.equal(out.dateSections[0].section, "Today");
});

test("bucketChatsByDate: spaceId rides through onto each item", () => {
  // The context menu's "Move to Space" submenu needs this to grey out
  // the chat's current Space; the sidebar item shape must carry it.
  const chats = [
    mkChat({ id: "c1", spaceId: "s1" }),
    mkChat({ id: "c2" }), // spaceId default is null
  ];
  const out = bucketChatsByDate(chats);
  const items = out.dateSections[0].items;
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId.c1.spaceId, "s1");
  assert.equal(byId.c2.spaceId, null);
});

test("bucketChatsByDate: multiModels JSON is parsed once per chat", () => {
  // Per-row reshape: sidebar items get a parsed `models` array (or null
  // on malformed/absent).
  const chats = [
    mkChat({
      id: "c1",
      tabType: "multi-pending",
      multiModels: '["llama3","gemma4"]',
    }),
    mkChat({ id: "c2", multiModels: "not valid json" }),
  ];
  const out = bucketChatsByDate(chats);
  const items = out.dateSections[0].items;
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(byId.c1.models, ["llama3", "gemma4"]);
  assert.equal(byId.c1.tabType, "multi-pending");
  // Malformed JSON falls back to null — chat behaves as single-mode.
  assert.equal(byId.c2.models, null);
});

test("bucketChatsByDate: every chat appears in exactly one section", () => {
  // Bug guard: bucket boundaries must partition. The test uses 5 chats
  // straddling every bucket window so a misordered boundary would lose
  // or duplicate one.
  const day = 86400;
  const nowSec = Math.floor(Date.now() / 1000);
  const chats = [
    mkChat({ id: "today",     createdAt: nowSec }),
    mkChat({ id: "yesterday", createdAt: nowSec - day - 60 }),
    mkChat({ id: "this-week", createdAt: nowSec - 3 * day }),
    mkChat({ id: "this-month",createdAt: nowSec - 15 * day }),
    mkChat({ id: "older",     createdAt: nowSec - 100 * day }),
  ];
  const out = bucketChatsByDate(chats);
  const seen = new Set();
  for (const s of out.dateSections) {
    for (const it of s.items) {
      assert.ok(!seen.has(it.id), `id ${it.id} appeared twice across sections`);
      seen.add(it.id);
    }
  }
  assert.equal(seen.size, 5, "every chat must be bucketed exactly once");
});

// ── instantiateSpacePinnedAttachments (Phase 4) ───────────────────────────
//
// Pure dispatcher contract. The helper takes an `invokeFn` parameter
// (no global dependency) so tests can hand it a recording mock that
// pushes every call into an array. The contract pinned here is what
// the App-scope wrapper in main.jsx relies on — the comments at the
// helper's definition in utils.js spell it out.

// Build a fake invoke that records calls AND optionally throws on
// matches against synthetic-failure needles (substring match on the
// JSON-encoded call signature). Returns { invokeFn, calls } so each
// test can assert on the recorded sequence.
function recordingInvoke(throwIfMatch) {
  const calls = [];
  const invokeFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const sig = JSON.stringify({ cmd, args });
    for (const needle of throwIfMatch || []) {
      if (sig.includes(needle)) {
        throw new Error("synthetic failure: " + needle);
      }
    }
    return { ok: true };
  };
  return { invokeFn, calls };
}

test("instantiateSpacePinnedAttachments: empty list → no invokes, onComplete fires", async () => {
  const { invokeFn, calls } = recordingInvoke();
  let completes = 0;
  await instantiateSpacePinnedAttachments(invokeFn, "c1", [], {
    onComplete: () => { completes++; },
  });
  assert.deepEqual(calls, []);
  // onComplete must fire even on the fast-return path so callers don't
  // have to special-case empty.
  assert.equal(completes, 1);
});

test("instantiateSpacePinnedAttachments: missing chatId → no invokes, onComplete fires", async () => {
  const { invokeFn, calls } = recordingInvoke();
  let completes = 0;
  await instantiateSpacePinnedAttachments(invokeFn, "", [{ kind: "file", path: "/a.md" }], {
    onComplete: () => { completes++; },
  });
  assert.deepEqual(calls, []);
  assert.equal(completes, 1);
});

test("instantiateSpacePinnedAttachments: missing onComplete is harmless", async () => {
  // Saves callers from threading a no-op when they don't care.
  const { invokeFn } = recordingInvoke();
  await assert.doesNotReject(
    instantiateSpacePinnedAttachments(invokeFn, "c1", [], {}),
  );
  // And the function should also tolerate a completely-omitted opts
  // bag — App-side wrappers occasionally pass nothing.
  await assert.doesNotReject(
    instantiateSpacePinnedAttachments(invokeFn, "c1", []),
  );
});

test("instantiateSpacePinnedAttachments: every file path goes into ONE attachment_add_files", async () => {
  // The KEY perf property: 12 pinned files = 1 round-trip, not 12.
  const { invokeFn, calls } = recordingInvoke();
  await instantiateSpacePinnedAttachments(invokeFn, "c1", [
    { kind: "file", path: "/style-guide.md" },
    { kind: "file", path: "/glossary.md" },
    { kind: "file", path: "/character-sheet.md" },
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    cmd: "attachment_add_files",
    args: { chatId: "c1", paths: ["/style-guide.md", "/glossary.md", "/character-sheet.md"] },
  });
});

test("instantiateSpacePinnedAttachments: each folder gets its own attachment_add_folder", async () => {
  // Folders are dispatched serially — the Rust walker takes the
  // SQLite write lock; running 3 walkers concurrently would just
  // serialize inside rusqlite anyway.
  const { invokeFn, calls } = recordingInvoke();
  await instantiateSpacePinnedAttachments(invokeFn, "c1", [
    { kind: "folder", path: "/research" },
    { kind: "folder", path: "/drafts" },
  ]);
  assert.deepEqual(calls, [
    { cmd: "attachment_add_folder", args: { chatId: "c1", path: "/research" } },
    { cmd: "attachment_add_folder", args: { chatId: "c1", path: "/drafts" } },
  ]);
});

test("instantiateSpacePinnedAttachments: files dispatch BEFORE folders", async () => {
  // UX property: small files surface fast; the user gets feedback
  // before the folder walker churns.
  const { invokeFn, calls } = recordingInvoke();
  await instantiateSpacePinnedAttachments(invokeFn, "c1", [
    { kind: "folder", path: "/research" },
    { kind: "file", path: "/style-guide.md" },
  ]);
  assert.equal(calls[0].cmd, "attachment_add_files");
  assert.equal(calls[1].cmd, "attachment_add_folder");
});

test("instantiateSpacePinnedAttachments: a folder failure does NOT block subsequent folders", async () => {
  // Partial-broken-state resilience. One pinned folder moved off disk,
  // the rest should still try.
  const { invokeFn, calls } = recordingInvoke(["/broken"]);
  const errors = [];
  let completes = 0;
  await instantiateSpacePinnedAttachments(invokeFn, "c1", [
    { kind: "folder", path: "/broken" },
    { kind: "folder", path: "/good" },
  ], {
    onError: (e, kind, path) => errors.push({ kind, path: path || null, message: String(e) }),
    onComplete: () => { completes++; },
  });
  assert.deepEqual(calls, [
    { cmd: "attachment_add_folder", args: { chatId: "c1", path: "/broken" } },
    { cmd: "attachment_add_folder", args: { chatId: "c1", path: "/good" } },
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, "folder");
  assert.equal(errors[0].path, "/broken");
  assert.match(errors[0].message, /synthetic failure/);
  // onComplete still fires after all dispatches resolve.
  assert.equal(completes, 1);
});

test("instantiateSpacePinnedAttachments: a files-batch failure does NOT block folders", async () => {
  const { invokeFn, calls } = recordingInvoke(["attachment_add_files"]);
  const errors = [];
  await instantiateSpacePinnedAttachments(invokeFn, "c1", [
    { kind: "file", path: "/a.md" },
    { kind: "file", path: "/b.md" },
    { kind: "folder", path: "/research" },
  ], {
    onError: (e, kind, path) => errors.push({ kind, path: path || null }),
  });
  assert.deepEqual(calls, [
    { cmd: "attachment_add_files", args: { chatId: "c1", paths: ["/a.md", "/b.md"] } },
    { cmd: "attachment_add_folder", args: { chatId: "c1", path: "/research" } },
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, "files");
  // Files-batch errors don't carry a per-path — the batch failed as a
  // unit. The App's toast just says "some Space attachments failed".
  assert.equal(errors[0].path, null);
});

test("instantiateSpacePinnedAttachments: silently drops entries with no kind or no path", async () => {
  // Defensive: a corrupt space_attachments row shouldn't poison the
  // dispatch for the well-formed ones.
  const { invokeFn, calls } = recordingInvoke();
  await instantiateSpacePinnedAttachments(invokeFn, "c1", [
    null,
    undefined,
    { kind: "file" }, // no path
    { kind: "file", path: "/good.md" },
    { kind: "folder", path: "" }, // empty path
    { kind: "folder", path: "/research" },
  ]);
  assert.deepEqual(calls, [
    { cmd: "attachment_add_files", args: { chatId: "c1", paths: ["/good.md"] } },
    { cmd: "attachment_add_folder", args: { chatId: "c1", path: "/research" } },
  ]);
});
