// Home ⇄ workspace: how the app moves between its two screens.
//
// The app opens on Home (ui/home.jsx). Opening a workspace shows the
// workspace window: that workspace's chats in the sidebar (ui/shell.jsx)
// and one chat in front. A workspace is a Space; General is every chat
// with no Space.
//
// This is App's own plumbing (main.jsx: `view`, `activeSpaceId`, the
// follow-the-chat-in-front effect, openWorkspace, askInGeneral), so it
// mounts the REAL <App /> via helpers/app.js. The two screens' own looks
// and controls are pinned in home.spec.js and sidebar.spec.js.

const { test, expect } = require("@playwright/test");
const { openApp, openWorkspace, send, newPrivateChat } = require("./helpers/app");

// Two workspaces and four saved chats: two in Hartwell, one in Okafor, one
// in no workspace.
function seedWorkspaces() {
  const R = window.__INVOKE_RESPONSES;
  const now = Math.floor(Date.now() / 1000);
  R.space_list = () => [
    { id: "s1", name: "Hartwell", slug: "hartwell", color: null, defaultModel: null, sortIndex: 0, createdAt: 1, updatedAt: 1 },
    { id: "s2", name: "Okafor estate", slug: "okafor", color: null, defaultModel: null, sortIndex: 1, createdAt: 1, updatedAt: 1 },
  ];
  R.space_get = (a) => R.space_list().find((s) => s.id === a.id);
  R.space_attachments_list = (a) =>
    a.spaceId === "s1" ? [{ id: "p1", spaceId: "s1", kind: "folder", path: "/Users/x/Matters/Hartwell" }] : [];
  window.__ROWS = [
    { id: "c1", title: "Notice periods", model: "gemma4-12b", spaceId: "s1", createdAt: now - 500, updatedAt: now - 100 },
    { id: "c2", title: "Chronology", model: "gemma4-12b", spaceId: "s1", createdAt: now - 900, updatedAt: now - 400 },
    { id: "c3", title: "Residuary gift", model: "gemma4-12b", spaceId: "s2", createdAt: now - 5000, updatedAt: now - 5000 },
    { id: "c4", title: "Lease clause", model: "gemma4-12b", spaceId: null, createdAt: now - 9000, updatedAt: now - 9000 },
  ];
  R.db_load_chats = () => window.__ROWS;
  // Like Rust: a first save inserts the row (with its workspace); later
  // saves leave the workspace alone.
  R.db_upsert_chat = (a) => {
    const c = a.chat;
    if (!window.__ROWS.some((r) => r.id === c.id)) {
      window.__ROWS = [{ id: c.id, title: c.title, model: c.model, spaceId: c.spaceId || null, createdAt: now, updatedAt: now + 1 }, ...window.__ROWS];
    }
  };
  R.db_load_messages = (a) => a.chatId === "c1"
    ? [
        { id: "m1", role: "user", content: "What notice must Meridian give?", model: "gemma4-12b", time: "09:41", seq: 1 },
        { id: "m2", role: "assistant", content: "Ninety days, in writing.", model: "gemma4-12b", time: "09:41", seq: 2 },
      ]
    : a.chatId === "c3"
      ? [{ id: "m3", role: "user", content: "Does the gift fail?", model: "gemma4-12b", time: "08:00", seq: 1 }]
      : [];
  R.search_chats = () => [
    { msgId: "m2", chatId: "c1", chatTitle: "Notice periods", chatModel: "gemma4-12b", snippet: "Ninety days, in writing.", role: "assistant" },
    { msgId: "m3", chatId: "c3", chatTitle: "Residuary gift", chatModel: "gemma4-12b", snippet: "Does the gift fail?", role: "user" },
  ];
}

const chatRows = (page) => page.locator("[data-sidebar] [data-chat-row]");
const rowIds = (page) =>
  chatRows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-chat-id")));
const invoked = (page, cmd) =>
  page.evaluate((c) => window.__INVOKES.filter((i) => i.cmd === c).map((i) => i.args), cmd);

test("the app opens on Home, with no chat opened", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await expect(page.locator("[data-workspace-card]")).toHaveCount(3);
  await expect(page.locator("[data-composer-input]")).toBeHidden();
  await expect(page.locator("[data-sidebar]")).toBeHidden();
  // Nothing was loaded behind the scenes either.
  expect(await invoked(page, "db_load_messages")).toEqual([]);
  // One status line, saying where chats stay.
  await expect(page.locator("[data-status-line]")).toHaveCount(1);
  await expect(page.locator("[data-status-line]")).toHaveText("Chats stay on this Mac");
});

test("opening a workspace shows only its chats, with an unsent chat in front", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await openWorkspace(page, "s1");
  await expect(page.locator("[data-home]")).toHaveCount(0);
  await expect(page.locator("[data-workspace-name]")).toHaveText("Hartwell");
  await expect(page.locator("[data-workspace-meta]")).toHaveText("Matters/Hartwell");
  await expect(chatRows(page)).toHaveCount(2);
  expect(await rowIds(page)).toEqual(["c1", "c2"]);
  // The unsent chat is listed above them and is the one in front.
  const open = page.locator("[data-open-chat-id]");
  await expect(open).toHaveCount(1);
  await expect(open.first()).toHaveAttribute("data-active", "true");
  await expect(page.locator("[data-composer-input]")).toHaveValue("");
  await expect(page.locator("[data-status-line]")).toHaveCount(1);
});

test("General lists the chats that belong to no workspace", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await openWorkspace(page, null);
  await expect(page.locator("[data-workspace-name]")).toHaveText("General");
  await expect(chatRows(page)).toHaveCount(1);
  expect(await rowIds(page)).toEqual(["c4"]);
});

test("Workspaces goes back to Home, and reopening returns to the chat that was in front", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await openWorkspace(page, "s1");
  await page.locator('[data-chat-row][data-chat-id="c1"]').click();
  await expect(page.getByText("Ninety days, in writing.")).toBeVisible();

  await page.locator("[data-back-home]").click();
  await expect(page.locator("[data-home]")).toBeVisible();
  await expect(page.locator("[data-sidebar]")).toBeHidden();

  // Another workspace in between does not disturb it.
  await openWorkspace(page, "s2");
  await expect(page.locator("[data-workspace-name]")).toHaveText("Okafor estate");
  await expect(page.getByText("Ninety days, in writing.")).toBeHidden();
  await page.locator("[data-back-home]").click();

  await page.locator('[data-workspace-card][data-space-id="s1"]').click();
  await expect(page.locator("[data-workspace-name]")).toHaveText("Hartwell");
  await expect(page.getByText("Ninety days, in writing.")).toBeVisible();
});

test("an unsent draft survives a trip to Home", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await openWorkspace(page, "s1");
  await page.locator("[data-composer-input]").fill("half a thought");
  await page.locator("[data-back-home]").click();
  await page.locator('[data-workspace-card][data-space-id="s1"]').click();
  await expect(page.locator("[data-composer-input]")).toHaveValue("half a thought");
});

test("a recent chat on Home opens in its own workspace", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await page.locator('[data-home-recent] [data-home-chat-id="c3"]').click();
  await expect(page.locator("[data-workspace-name]")).toHaveText("Okafor estate");
  await expect(page.getByText("Does the gift fail?")).toBeVisible();
  expect(await rowIds(page)).toEqual(["c3"]);
});

test("the quick question becomes a chat in General and is sent", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await page.locator("[data-home-ask-input]").fill("What is a break clause?");
  // Home is replaced by the workspace window as the key goes down, so the
  // key is sent to the page, not to an input that is about to be gone.
  await page.keyboard.press("Enter");

  await expect(page.locator("[data-workspace-name]")).toHaveText("General");
  await expect(page.getByText("What is a break clause?").first()).toBeVisible();
  await expect(page.getByText("Partial reply text")).toBeVisible();
  expect(await page.evaluate(() => window.__STREAMS.length)).toBe(1);
  // Saved like any other chat, in no workspace, and listed in General.
  const saved = await invoked(page, "db_upsert_chat");
  expect(saved.length).toBeGreaterThan(0);
  expect(saved[0].chat.spaceId).toBeNull();
  await expect(chatRows(page)).toHaveCount(2);
});

test("a chat started in a workspace is saved in that workspace", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await openWorkspace(page, "s1");
  await send(page, "Summarise the notice of breach");
  const saved = await invoked(page, "db_upsert_chat");
  expect(saved[0].chat.spaceId).toBe("s1");
  // It moves from the open rows to the saved list…
  await expect(page.locator("[data-open-chat-id]")).toHaveCount(0);
  await expect(chatRows(page)).toHaveCount(3);
  // …and Home counts it.
  await page.locator("[data-back-home]").click();
  await expect(page.locator('[data-space-id="s1"] [data-workspace-card-chats]')).toHaveText("3 chats");
});

test("a new chat in a workspace with pinned documents is filed there before it is sent", async ({ page }) => {
  // Attaching a workspace's documents creates the chat's row with no
  // workspace on it, and a later save never sets one. Without the explicit
  // filing, the chat would turn up in General after a relaunch.
  await openApp(page, seedWorkspaces);
  await openWorkspace(page, "s1");
  const id = await page.locator("[data-open-chat-id]").first().getAttribute("data-open-chat-id");
  await expect.poll(() => invoked(page, "attachment_add_folder").then((c) => c.length)).toBe(1);
  await expect
    .poll(() => invoked(page, "db_move_chat_to_space"))
    .toEqual([{ chatId: id, spaceId: "s1" }]);
  // A workspace with nothing pinned needs no filing until the chat is saved.
  await page.locator("[data-back-home]").click();
  await openWorkspace(page, "s2");
  await page.waitForTimeout(200);
  expect(await invoked(page, "db_move_chat_to_space")).toHaveLength(1);
});

test("a first message in a workspace files the chat there as well", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await openWorkspace(page, "s2");
  const id = await page.locator("[data-open-chat-id]").first().getAttribute("data-open-chat-id");
  await send(page, "Does the gift lapse?");
  await expect
    .poll(() => invoked(page, "db_move_chat_to_space"))
    .toEqual([{ chatId: id, spaceId: "s2" }]);
});

test("opening a workspace picks up the unsent chat an earlier session left there", async ({ page }) => {
  await openApp(page, () => {
    const R = window.__INVOKE_RESPONSES;
    const now = Math.floor(Date.now() / 1000);
    R.space_list = () => [
      { id: "s1", name: "Hartwell", slug: "hartwell", color: null, defaultModel: null, sortIndex: 0, createdAt: 1, updatedAt: 1 },
    ];
    R.space_get = () => R.space_list()[0];
    R.space_attachments_list = () => [{ id: "p1", spaceId: "s1", kind: "folder", path: "/Users/x/Matters/Hartwell" }];
    // What attaching documents leaves behind when nothing is sent: the
    // '' model placeholder and no messages.
    R.db_load_chats = () => [
      { id: "left-over", title: "New chat", model: "", spaceId: "s1", createdAt: now - 99999, updatedAt: now - 99999, preview: null },
      { id: "real", title: "Notice periods", model: "gemma4-12b", spaceId: "s1", createdAt: now - 500, updatedAt: now - 100, preview: "Ninety days." },
    ];
  });
  await openWorkspace(page, "s1");
  // It is the chat in front; no second unsent chat was made, and its
  // documents were not attached a second time.
  await expect(page.locator('[data-chat-row][data-chat-id="left-over"]')).toBeVisible();
  await expect(page.locator("[data-open-chat-id]")).toHaveCount(0);
  expect((await invoked(page, "db_load_messages")).map((a) => a.chatId)).toEqual(["left-over"]);
  expect(await invoked(page, "attachment_add_folder")).toEqual([]);
  await expect(page.locator("[data-composer-input]")).toBeEnabled();
});

test("New chat while an unsent one is open just returns to it", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await openWorkspace(page, "s1");
  await page.locator('[data-chat-row][data-chat-id="c1"]').click();
  await expect(page.getByText("Ninety days, in writing.")).toBeVisible();
  await page.locator("[data-new-chat]").click();
  await page.locator("[data-new-chat]").click();
  await expect(page.locator("[data-open-chat-id]")).toHaveCount(1);
  await expect(page.locator("[data-open-chat-id]").first()).toHaveAttribute("data-active", "true");
});

test("a private chat stays in the workspace it was started from", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await openWorkspace(page, "s1");
  await newPrivateChat(page);
  await expect(page.locator("[data-workspace-name]")).toHaveText("Hartwell");
  await expect(page.locator("[data-open-chat-private]")).toHaveCount(1);
  // It is not listed in another workspace.
  await page.locator("[data-back-home]").click();
  await openWorkspace(page, "s2");
  await expect(page.locator("[data-open-chat-private]")).toHaveCount(0);
});

test("⌘N starts a chat: in General from Home, in the workspace on show otherwise", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await page.keyboard.press("Meta+n");
  await expect(page.locator("[data-workspace-name]")).toHaveText("General");
  await expect(page.locator("[data-composer-input]")).toBeVisible();

  await page.locator("[data-back-home]").click();
  await openWorkspace(page, "s1");
  await page.locator('[data-chat-row][data-chat-id="c1"]').click();
  await expect(page.getByText("Ninety days, in writing.")).toBeVisible();
  await page.keyboard.press("Meta+n");
  await expect(page.locator("[data-workspace-name]")).toHaveText("Hartwell");
  await expect(page.getByText("Ninety days, in writing.")).toBeHidden();
  await expect(page.locator("[data-open-chat-id]").first()).toHaveAttribute("data-active", "true");
});

test("search: Home finds messages everywhere, a workspace only its own", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await page.locator("[data-home-search]").fill("gift");
  await expect(page.locator("[data-home-results]")).toContainText("Messages");
  await expect(page.locator("[data-home-results]")).toContainText("Ninety days, in writing.");
  await expect(page.locator("[data-home-results]")).toContainText("Does the gift fail?");

  // Leaving Home clears the query; searching inside Hartwell shows only
  // the hit from a Hartwell chat.
  await page.locator("[data-home-search]").fill("");
  await openWorkspace(page, "s1");
  await expect(page.locator("[data-sidebar-search]")).toHaveValue("");
  await page.locator("[data-sidebar-search]").fill("days");
  await expect(page.locator("[data-sidebar]")).toContainText("Ninety days, in writing.");
  await expect(page.locator("[data-sidebar]")).not.toContainText("Does the gift fail?");
});

test("the settings menu reaches Settings and the three panels", async ({ page }) => {
  await openApp(page, seedWorkspaces);
  await page.locator("[data-more-menu-button]").click();
  const menu = page.locator("[data-more-menu]");
  await expect(menu).toContainText("Settings…");
  await expect(menu.locator("[data-more-panel]")).toHaveCount(3);
  await menu.locator('[data-more-panel="watches"]').click();
  await expect(menu).toHaveCount(0);
  // The panel opens beside Home, on the tab asked for.
  await expect(page.getByTitle("Close panel")).toBeVisible();
});
