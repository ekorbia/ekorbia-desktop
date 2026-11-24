// The workspace sidebar (Sidebar in ui/shell.jsx): the left rail of the
// workspace window. It shows ONE workspace — switching is Home's job
// (home.spec.js) — so this pins:
//   • the head: the way back to Home, the workspace's name, where its
//     documents live, and the settings button (a Space has one, General
//     does not);
//   • New chat and the menu behind its arrow (private chat, comparison);
//   • the open chats listed above the saved ones (private chats and the
//     unsent chat in front);
//   • search, the empty state, the footer slot;
//   • the chat row's right-click menu, including "Move to workspace".
//
// The chat list arrives already filtered to the workspace (main.jsx), so
// the filter itself is pinned against the real app in
// workspace-navigation.spec.js.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const SPACES = [
  { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
  { id: "s2", name: "Blue Ridge", slug: "blue-ridge", color: "blue", sortIndex: 1, createdAt: 1, updatedAt: 1 },
];
const ONE_CHAT = {
  dateSections: [
    { section: "Today", items: [{ id: "c1", title: "Hello", model: "m", when: "now", spaceId: null }] },
  ],
};

async function mountSidebar(page, opts = {}) {
  await page.evaluate(({ opts }) => {
    window.__SB = { home: 0, new: 0, priv: 0, compare: 0, pickOpen: [], closeOpen: [], query: [], move: [], pick: [], hit: [] };
    const host = document.getElementById("test-root");
    if (window.__TEST_ROOT) { try { window.__TEST_ROOT.unmount(); } catch (_) {} }
    host.innerHTML = "";
    host.style.display = "flex";
    const root = ReactDOM.createRoot(host);
    root.render(
      React.createElement(window.Sidebar, {
        chats: opts.chats || { dateSections: [] },
        activeId: opts.activeId ?? null,
        onPick: (c) => window.__SB.pick.push(c.id),
        onDelete: () => {},
        onRename: () => {},
        query: opts.query || "",
        onQuery: (q) => window.__SB.query.push(q),
        onNew: () => { window.__SB.new += 1; },
        onNewPrivate: () => { window.__SB.priv += 1; },
        onNewCompare: () => { window.__SB.compare += 1; },
        width: 252,
        onHome: () => { window.__SB.home += 1; },
        spaces: opts.spaces || [],
        activeSpaceId: opts.activeSpaceId ?? null,
        onMoveChatToSpace: (chatId, spaceId) => window.__SB.move.push([chatId, spaceId]),
        promptsLibrary: [],
        onEditSpaceSave: () => {},
        docsLabel: opts.docsLabel || "",
        openTabs: opts.openTabs || [],
        onPickOpen: (id) => window.__SB.pickOpen.push(id),
        onCloseOpen: (id) => window.__SB.closeOpen.push(id),
        messageHits: opts.messageHits || [],
        onPickHit: (h) => window.__SB.hit.push(h.chatId),
        footer: opts.noFooter ? null : React.createElement("span", { "data-test-footer": "" }, "footer"),
      }),
    );
    window.__TEST_ROOT = root;
  }, { opts });
  await expect(page.locator("[data-sidebar]")).toBeVisible();
}

const sb = (page) => page.evaluate(() => window.__SB);

// ── Head ───────────────────────────────────────────────────────────────

test("head: Workspaces goes back to Home", async ({ page }) => {
  await mountSidebar(page, { spaces: SPACES, activeSpaceId: "s1" });
  await page.locator("[data-back-home]").click();
  expect((await sb(page)).home).toBe(1);
});

test("head: a workspace shows its name, where its documents live, and a settings button", async ({ page }) => {
  await mountSidebar(page, { spaces: SPACES, activeSpaceId: "s1", docsLabel: "Matters/Novel" });
  await expect(page.locator("[data-workspace-name]")).toHaveText("Novel");
  await expect(page.locator("[data-workspace-meta]")).toHaveText("Matters/Novel");
  await page.locator("[data-workspace-settings]").click();
  await expect(page.locator("[data-space-settings-modal]")).toContainText("Workspace settings — Novel");
});

test("head: a workspace with nothing pinned says so", async ({ page }) => {
  await mountSidebar(page, { spaces: SPACES, activeSpaceId: "s2" });
  await expect(page.locator("[data-workspace-meta]")).toHaveText("No documents yet");
});

test("head: General has a name and no settings", async ({ page }) => {
  await mountSidebar(page, { spaces: SPACES, activeSpaceId: null });
  await expect(page.locator("[data-workspace-name]")).toHaveText("General");
  await expect(page.locator("[data-workspace-meta]")).toHaveText("Chats that belong to no workspace");
  await expect(page.locator("[data-workspace-settings]")).toHaveCount(0);
});

test("the rail does not list workspaces", async ({ page }) => {
  await mountSidebar(page, { spaces: SPACES, activeSpaceId: "s1" });
  // "Blue Ridge" is the other workspace; only this one's name appears.
  await expect(page.locator("[data-sidebar]")).not.toContainText("Blue Ridge");
  await expect(page.locator("[data-sidebar]")).toContainText("Novel");
});

// ── New chat and its menu ──────────────────────────────────────────────

test("New chat starts a chat; the menu stays closed", async ({ page }) => {
  await mountSidebar(page);
  await page.locator("[data-new-chat]").click();
  expect((await sb(page)).new).toBe(1);
  await expect(page.locator("[data-new-chat-menu]")).toHaveCount(0);
});

test("the arrow opens the other kinds of chat", async ({ page }) => {
  await mountSidebar(page);
  const more = page.locator("[data-new-chat-more]");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  const menu = page.locator("[data-new-chat-menu]");
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(menu.locator("[data-menu-new-chat]")).toContainText("New chat");
  await expect(menu.locator("[data-menu-new-private]")).toContainText("New private chat");
  await expect(menu.locator("[data-menu-new-private]")).toContainText("Not saved");
  await expect(menu.locator("[data-new-compare]")).toContainText("Compare models…");
});

test("menu: New private chat starts one and closes the menu", async ({ page }) => {
  await mountSidebar(page);
  await page.locator("[data-new-chat-more]").click();
  await page.locator("[data-menu-new-private]").click();
  const s = await sb(page);
  expect([s.priv, s.new, s.compare]).toEqual([1, 0, 0]);
  await expect(page.locator("[data-new-chat-menu]")).toHaveCount(0);
});

test("menu: Compare models opens the comparison flow", async ({ page }) => {
  await mountSidebar(page);
  await page.locator("[data-new-chat-more]").click();
  await page.locator("[data-new-compare]").click();
  expect((await sb(page)).compare).toBe(1);
  await expect(page.locator("[data-new-chat-menu]")).toHaveCount(0);
});

test("menu: Escape and a click elsewhere close it", async ({ page }) => {
  await mountSidebar(page);
  await page.locator("[data-new-chat-more]").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-new-chat-menu]")).toHaveCount(0);
  await page.locator("[data-new-chat-more]").click();
  await expect(page.locator("[data-new-chat-menu]")).toBeVisible();
  await page.locator("[data-workspace-name]").click();
  await expect(page.locator("[data-new-chat-menu]")).toHaveCount(0);
});

// ── Open chats above the saved ones ────────────────────────────────────

const OPEN = [
  { id: "draft", title: "New chat", ephemeral: false },
  { id: "priv", title: "Private chat", ephemeral: true },
];

test("open chats: the unsent chat and private chats are listed, the one in front marked", async ({ page }) => {
  await mountSidebar(page, { chats: ONE_CHAT, openTabs: OPEN, activeId: "draft" });
  const rows = page.locator("[data-open-chat-id]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText("New chat");
  await expect(rows.nth(0)).toHaveAttribute("data-active", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-open-chat-private", "");
  await expect(rows.nth(1)).not.toHaveAttribute("data-active", "true");
});

test("open chats: clicking one brings it to the front", async ({ page }) => {
  await mountSidebar(page, { openTabs: OPEN, activeId: "draft" });
  await page.locator('[data-open-chat-id="priv"]').click();
  expect((await sb(page)).pickOpen).toEqual(["priv"]);
});

test("open chats: only a private chat can be ended, and ending it does not open it", async ({ page }) => {
  await mountSidebar(page, { openTabs: OPEN, activeId: "draft" });
  await expect(page.locator('[data-open-chat-id="draft"] [data-end-private]')).toHaveCount(0);
  await page.locator('[data-open-chat-id="priv"] [data-end-private]').click();
  const s = await sb(page);
  expect(s.closeOpen).toEqual(["priv"]);
  expect(s.pickOpen).toEqual([]);
});

test("open chats are hidden while searching", async ({ page }) => {
  await mountSidebar(page, { chats: ONE_CHAT, openTabs: OPEN, query: "hel" });
  await expect(page.locator("[data-open-chat-id]")).toHaveCount(0);
  await expect(page.locator('[data-chat-row][data-chat-id="c1"]')).toBeVisible();
});

// ── Search, empty state, footer ────────────────────────────────────────

test("search is scoped to the workspace and reports the query", async ({ page }) => {
  await mountSidebar(page);
  const input = page.locator("[data-sidebar-search]");
  await expect(input).toHaveAttribute("placeholder", "Search this workspace");
  await input.fill("notice");
  expect((await sb(page)).query.pop()).toBe("notice");
});

test("search: message hits are listed under the title matches", async ({ page }) => {
  await mountSidebar(page, {
    chats: ONE_CHAT,
    query: "hel",
    messageHits: [{ msgId: "m1", chatId: "c1", chatTitle: "Hello", chatModel: "m", snippet: "hello there", role: "user" }],
  });
  await expect(page.locator("[data-sidebar]")).toContainText("Messages");
});

test("search: a miss says nothing in this workspace matches", async ({ page }) => {
  await mountSidebar(page, { chats: ONE_CHAT, query: "zzz" });
  await expect(page.locator("[data-sidebar]")).toContainText("Nothing in this workspace matches.");
});

test("a workspace with no saved chats says when a chat is saved", async ({ page }) => {
  await mountSidebar(page);
  await expect(page.locator("[data-sidebar-empty]")).toContainText("A chat is saved when you send its first message.");
});

test("the footer handed in is shown; none handed in, none shown", async ({ page }) => {
  await mountSidebar(page);
  await expect(page.locator("[data-sidebar-foot] [data-test-footer]")).toBeVisible();
  await mountSidebar(page, { noFooter: true });
  await expect(page.locator("[data-sidebar-foot]")).toHaveCount(0);
});

// ── Right-click menu on a chat row ─────────────────────────────────────

test("chat menu: Move to workspace lists every workspace and General", async ({ page }) => {
  await mountSidebar(page, { chats: ONE_CHAT, spaces: SPACES });
  await page.locator('[data-chat-row][data-chat-id="c1"]').click({ button: "right" });
  const menu = page.locator("[data-chat-context-menu]");
  await expect(menu).toContainText("Move to workspace");
  await expect(page.locator('[data-move-to-space="none"]')).toContainText("General");
  await expect(page.locator('[data-move-to-space="s1"]')).toBeVisible();
  await expect(page.locator('[data-move-to-space="s2"]')).toBeVisible();
});

test("chat menu: no Move to workspace section when there are no workspaces", async ({ page }) => {
  await mountSidebar(page, { chats: ONE_CHAT, spaces: [] });
  await page.locator('[data-chat-row][data-chat-id="c1"]').click({ button: "right" });
  await expect(page.locator("[data-chat-context-menu]")).toBeVisible();
  await expect(page.locator("[data-chat-context-menu]")).not.toContainText("Move to workspace");
  await expect(page.locator('[data-move-to-space="none"]')).toHaveCount(0);
});

test("chat menu: picking a workspace moves the chat there; General unfiles it", async ({ page }) => {
  await mountSidebar(page, { chats: ONE_CHAT, spaces: SPACES });
  await page.locator('[data-chat-row][data-chat-id="c1"]').click({ button: "right" });
  await page.locator('[data-move-to-space="s2"]').click();
  await page.locator('[data-chat-row][data-chat-id="c1"]').click({ button: "right" });
  await page.locator('[data-move-to-space="none"]').click();
  expect((await sb(page)).move).toEqual([["c1", "s2"], ["c1", null]]);
});

test("clicking a saved chat opens it", async ({ page }) => {
  await mountSidebar(page, { chats: ONE_CHAT });
  await page.locator('[data-chat-row][data-chat-id="c1"]').click();
  expect((await sb(page)).pick).toEqual(["c1"]);
});
