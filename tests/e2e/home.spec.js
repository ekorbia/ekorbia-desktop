// The Home screen (ui/home.jsx): what the app opens on.
//
// Mounts <HomeScreen /> alone, with spy callbacks, and pins:
//   • a card per workspace plus General, with the figures each card shows;
//   • opening a workspace or a recent chat;
//   • the quick-question row;
//   • the workspace dialogs Home hosts (create, rename, colour, delete),
//     reached from a card's ⋯ button or a right-click;
//   • search replacing the cards with results.
//
// How Home is wired into the app (opening on it, landing in a workspace,
// the quick question becoming a chat in General) is App's own plumbing and
// is pinned against the real app in workspace-navigation.spec.js.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const SPACES = [
  { id: "s1", name: "Hartwell v. Meridian", slug: "hartwell", color: "amber", defaultModel: null, sortIndex: 0, createdAt: 1, updatedAt: 1 },
  { id: "s2", name: "Okafor estate", slug: "okafor", color: null, defaultModel: "gemma4-31b", sortIndex: 1, createdAt: 1, updatedAt: 1 },
];

// Chat rows as db_load_chats returns them. Times are relative to now so
// the "when" labels are stable.
function chatRows() {
  const now = Math.floor(Date.now() / 1000);
  return [
    { id: "c1", title: "Termination notice periods", model: "m", spaceId: "s1", createdAt: now - 600, updatedAt: now - 60 },
    { id: "c2", title: "Indemnity or warranty?", model: "m", spaceId: "s1", createdAt: now - 900, updatedAt: now - 300, tabType: "multi-pending", multiModels: '["a","b"]' },
    { id: "c3", title: "Residuary gift", model: "m", spaceId: "s2", createdAt: now - 90000, updatedAt: now - 90000 },
    { id: "c4", title: "Lease clause in plain English", model: "m", spaceId: null, createdAt: now - 200000, updatedAt: now - 200000 },
    { id: "c5", title: "Older general chat", model: "m", spaceId: null, createdAt: now - 900000, updatedAt: now - 900000 },
  ];
}

async function mountHome(page, opts = {}) {
  await page.evaluate(({ opts, rows, spaces }) => {
    window.__HOME = { open: [], chat: [], ask: [], create: [], rename: [], recolor: [], del: [], query: [], hit: [] };
    const host = document.getElementById("test-root");
    if (window.__TEST_ROOT) { try { window.__TEST_ROOT.unmount(); } catch (_) {} }
    host.innerHTML = "";
    host.style.display = "flex";
    const root = ReactDOM.createRoot(host);
    root.render(
      React.createElement(window.HomeScreen, {
        spaces: opts.spaces || spaces,
        chatRows: opts.chatRows || rows,
        pinsBySpace: opts.pinsBySpace || { s1: [{ kind: "folder", path: "/Users/x/Matters/Hartwell" }] },
        defaultModelId: "gemma4-12b",
        query: opts.query || "",
        onQuery: (q) => window.__HOME.query.push(q),
        messageHits: opts.messageHits || [],
        onPickHit: (h) => window.__HOME.hit.push(h.chatId),
        onOpenSpace: (id) => window.__HOME.open.push(id),
        onOpenChat: (c) => window.__HOME.chat.push([c.id, c.spaceId, c.tabType]),
        onAsk: (t) => window.__HOME.ask.push(t),
        askDisabled: !!opts.askDisabled,
        onCreateSpace: (name, color) => {
          window.__HOME.create.push([name, color]);
          return Promise.resolve({ id: "s-new", name, color: color || null, slug: "s-new", defaultModel: null, memoryPath: null, sortIndex: 0, createdAt: 1, updatedAt: 1 });
        },
        onRenameSpace: (id, name) => window.__HOME.rename.push([id, name]),
        onDeleteSpace: (id) => window.__HOME.del.push(id),
        onEditSpaceSave: () => {},
        promptsLibrary: [],
        footer: React.createElement("span", { "data-test-footer": "" }, "footer"),
      }),
    );
    window.__TEST_ROOT = root;
  }, { opts, rows: chatRows(), spaces: SPACES });
  await expect(page.locator("[data-home]")).toBeVisible();
}

const calls = (page, key) => page.evaluate((k) => window.__HOME[k], key);

// ── Cards ──────────────────────────────────────────────────────────────

test("a card per workspace, then General, with the count in the heading", async ({ page }) => {
  await mountHome(page);
  const cards = page.locator("[data-workspace-card]");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0).locator("[data-workspace-card-name]")).toHaveText("Hartwell v. Meridian");
  await expect(cards.nth(1).locator("[data-workspace-card-name]")).toHaveText("Okafor estate");
  await expect(cards.nth(2)).toHaveAttribute("data-general", "");
  await expect(cards.nth(2).locator("[data-workspace-card-name]")).toHaveText("General");
  // General is not counted as a workspace.
  await expect(page.locator("[data-workspace-count]")).toHaveText("2");
});

test("a card shows where its documents live and how many chats it holds", async ({ page }) => {
  await mountHome(page);
  const s1 = page.locator('[data-workspace-card][data-space-id="s1"]');
  await expect(s1.locator("[data-workspace-card-docs]")).toHaveText("Matters/Hartwell");
  await expect(s1.locator("[data-workspace-card-chats]")).toHaveText("2 chats");
  const s2 = page.locator('[data-workspace-card][data-space-id="s2"]');
  await expect(s2.locator("[data-workspace-card-docs]")).toHaveText("No documents yet");
  await expect(s2.locator("[data-workspace-card-chats]")).toHaveText("1 chat");
  // General holds the chats with no workspace.
  await expect(page.locator("[data-general] [data-workspace-card-chats]")).toHaveText("2 chats");
});

test("a card names the model only when the workspace uses a different one", async ({ page }) => {
  await mountHome(page);
  await expect(page.locator('[data-space-id="s1"] [data-workspace-card-model]')).toHaveCount(0);
  await expect(page.locator('[data-space-id="s2"] [data-workspace-card-model]')).toHaveText("gemma4-31b");
});

test("clicking a card opens that workspace; General opens with null", async ({ page }) => {
  await mountHome(page);
  await page.locator('[data-workspace-card][data-space-id="s2"]').click();
  await page.locator("[data-workspace-card][data-general]").click();
  expect(await calls(page, "open")).toEqual(["s2", null]);
});

test("with no workspaces yet, General is still there", async ({ page }) => {
  await mountHome(page, { spaces: [], chatRows: [] });
  await expect(page.locator("[data-workspace-card]")).toHaveCount(1);
  await expect(page.locator("[data-workspace-count]")).toHaveText("0");
  await expect(page.locator("[data-home-recent]")).toHaveCount(0);
});

// ── Recent chats ───────────────────────────────────────────────────────

test("recent chats: the four newest, each with its workspace", async ({ page }) => {
  await mountHome(page);
  const rows = page.locator("[data-home-recent] [data-home-chat-id]");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveAttribute("data-home-chat-id", "c1");
  await expect(rows.nth(0).locator("[data-home-chat-workspace]")).toHaveText("Hartwell v. Meridian");
  await expect(rows.nth(3)).toHaveAttribute("data-home-chat-id", "c4");
  await expect(rows.nth(3).locator("[data-home-chat-workspace]")).toHaveText("General");
});

test("opening a recent chat passes its workspace, and a comparison stays one", async ({ page }) => {
  await mountHome(page);
  await page.locator('[data-home-chat-id="c2"]').click();
  await page.locator('[data-home-chat-id="c4"]').click();
  expect(await calls(page, "chat")).toEqual([["c2", "s1", "multi-pending"], ["c4", null, null]]);
});

// ── The quick question ─────────────────────────────────────────────────

test("quick question: send is off until there is text; Enter asks and clears the row", async ({ page }) => {
  await mountHome(page);
  const input = page.locator("[data-home-ask-input]");
  const send = page.locator("[data-home-ask-send]");
  await expect(send).toBeDisabled();
  await input.fill("   ");
  await expect(send).toBeDisabled();
  await input.fill("  What is a break clause?  ");
  await expect(send).toBeEnabled();
  await input.press("Enter");
  expect(await calls(page, "ask")).toEqual(["What is a break clause?"]);
  await expect(input).toHaveValue("");
});

test("quick question: the send button asks too", async ({ page }) => {
  await mountHome(page);
  await page.locator("[data-home-ask-input]").fill("Summarise IFRS 16 in two lines");
  await page.locator("[data-home-ask-send]").click();
  expect(await calls(page, "ask")).toEqual(["Summarise IFRS 16 in two lines"]);
});

test("quick question: nothing is asked while another reply is arriving", async ({ page }) => {
  await mountHome(page, { askDisabled: true });
  const input = page.locator("[data-home-ask-input]");
  await input.fill("Hello");
  await expect(page.locator("[data-home-ask-send]")).toBeDisabled();
  await input.press("Enter");
  expect(await calls(page, "ask")).toEqual([]);
  // The text is kept, so it can be sent once the other reply is done.
  await expect(input).toHaveValue("Hello");
});

// ── Workspace dialogs ──────────────────────────────────────────────────

test("New workspace: the name is required; Create opens the new workspace", async ({ page }) => {
  await mountHome(page);
  await page.locator("[data-new-workspace]").click();
  const create = page.locator("[data-space-create-confirm]");
  await expect(page.locator("[data-space-create-modal]")).toContainText("New workspace");
  await expect(create).toBeDisabled();
  await page.locator("[data-space-create-modal] input").fill("Lindqvist lease");
  // A workspace has a name and nothing else to choose: no colour.
  await expect(page.locator("[data-space-create-modal] [data-color-swatch]")).toHaveCount(0);
  await expect(page.locator("[data-space-create-modal]")).not.toContainText("Color");
  await create.click();
  expect(await calls(page, "create")).toEqual([["Lindqvist lease", null]]);
  await expect.poll(() => calls(page, "open")).toEqual(["s-new"]);
  await expect(page.locator("[data-space-settings-modal]")).toHaveCount(0);
});

test("New workspace: Create & configure stays on Home with its settings open", async ({ page }) => {
  await mountHome(page);
  await page.locator("[data-new-workspace]").click();
  await page.locator("[data-space-create-modal] input").fill("Brand New");
  await page.locator("[data-space-create-and-configure]").click();
  await expect(page.locator("[data-space-settings-modal]")).toContainText("Workspace settings — Brand New");
  expect(await calls(page, "open")).toEqual([]);
});

test("New workspace: Cancel creates nothing", async ({ page }) => {
  await mountHome(page);
  await page.locator("[data-new-workspace]").click();
  await page.locator("[data-space-create-modal] input").fill("Nope");
  await page.locator("[data-space-create-modal]").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-space-create-modal]")).toHaveCount(0);
  expect(await calls(page, "create")).toEqual([]);
});

test("a card's ⋯ button: Rename, pre-filled, saves the new name", async ({ page }) => {
  await mountHome(page);
  const card = page.locator('[data-workspace-card][data-space-id="s1"]');
  await card.hover();
  await card.locator("[data-workspace-card-more]").click();
  await expect(page.locator("[data-space-overflow-menu]")).toBeVisible();
  // Opening the menu must not open the workspace.
  expect(await calls(page, "open")).toEqual([]);
  await page.locator("[data-space-overflow-menu]").getByText("Rename workspace").click();
  const input = page.locator('input[placeholder="Workspace name"]');
  await expect(input).toHaveValue("Hartwell v. Meridian");
  await input.fill("Hartwell");
  await page.getByRole("button", { name: "Save" }).click();
  expect(await calls(page, "rename")).toEqual([["s1", "Hartwell"]]);
});

test("a card's ⋯ button: Delete asks first, and says the chats are kept", async ({ page }) => {
  await mountHome(page);
  const card = page.locator('[data-workspace-card][data-space-id="s1"]');
  await card.hover();
  await card.locator("[data-workspace-card-more]").click();
  await page.locator("[data-space-overflow-menu]").getByText("Delete workspace").click();
  await expect(page.getByText("Delete workspace?")).toBeVisible();
  await expect(page.getByText("Its chats are kept and move to")).toBeVisible();
  expect(await calls(page, "del")).toEqual([]);
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await calls(page, "del")).toEqual(["s1"]);
});

test("a card's ⋯ menu has no colour to change", async ({ page }) => {
  await mountHome(page);
  const card = page.locator('[data-workspace-card][data-space-id="s1"]');
  await card.hover();
  await card.locator("[data-workspace-card-more]").click();
  const menu = page.locator("[data-space-overflow-menu]");
  await expect(menu).toBeVisible();
  await expect(menu).not.toContainText("Change color");
});

test("right-clicking a card opens the same menu; General has none", async ({ page }) => {
  await mountHome(page);
  await page.locator('[data-workspace-card][data-space-id="s2"]').click({ button: "right" });
  const menu = page.locator("[data-space-overflow-menu]");
  await expect(menu).toContainText("Rename workspace");
  await expect(menu).toContainText("Delete workspace");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.locator("[data-workspace-card][data-general]").click({ button: "right" });
  await expect(menu).toHaveCount(0);
  await expect(page.locator("[data-general] [data-workspace-card-more]")).toHaveCount(0);
});

// ── Search ─────────────────────────────────────────────────────────────

test("typing in the search box reports the query", async ({ page }) => {
  await mountHome(page);
  await page.locator("[data-home-search]").fill("lease");
  expect((await calls(page, "query")).pop()).toBe("lease");
});

test("a query replaces the cards with matching workspaces, chats and messages", async ({ page }) => {
  await mountHome(page, {
    query: "okafor",
    messageHits: [{ msgId: "m9", chatId: "c3", chatTitle: "Residuary gift", chatModel: "m", snippet: "the Okafor estate", role: "assistant" }],
  });
  const results = page.locator("[data-home-results]");
  await expect(results).toBeVisible();
  await expect(page.locator("[data-workspace-grid]")).toHaveCount(0);
  await expect(results.locator("[data-workspace-card]")).toHaveCount(1);
  await expect(results.locator("[data-workspace-card-name]")).toHaveText("Okafor estate");
  await expect(results).toContainText("Messages");
});

test("a query matches chat titles in every workspace", async ({ page }) => {
  await mountHome(page, { query: "LEASE" });
  const rows = page.locator("[data-home-results] [data-home-chat-id]");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-home-chat-id", "c4");
});

test("a query with no matches says so", async ({ page }) => {
  await mountHome(page, { query: "zzzz" });
  await expect(page.locator("[data-home-no-results]")).toBeVisible();
});

test("the footer handed in is shown", async ({ page }) => {
  await mountHome(page);
  await expect(page.locator("[data-home-foot] [data-test-footer]")).toBeVisible();
});
