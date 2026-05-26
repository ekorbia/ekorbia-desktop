// Smokes for the sidebar groups feature: collapsible folder sections,
// the right-click context menu, and the new-group modal.
//
// Drag-and-drop isn't exercised here — Playwright's drag API is
// notoriously flaky with HTML5 D&D events in WebKit, and the same
// underlying move path is covered via the context menu's "Move to
// group" entries. The Rust-side write is unit-tested in chat.rs.
//
// What this spec DOES cover:
//   • Sidebar mounts with the new { groups, dateSections } shape.
//   • Group section renders header + item count.
//   • Empty group shows the "Empty — drag a chat here" placeholder.
//   • Collapse toggle hides items and persists across re-renders.
//   • Right-click on a ChatRow opens the context menu.
//   • Selecting a group from the menu fires onMoveChatToGroup with the
//     right (chatId, groupId) pair.
//   • Selecting "(none)" calls onMoveChatToGroup with groupId = null.
//   • Selecting "+ New group…" opens the name modal.
//   • The [+ New group] sidebar button opens the same modal.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

// Mount the Sidebar with spies on the four group-related callbacks plus
// onPick / onDelete / onRename. Each spy records onto window arrays so
// tests can assert on them after the user interaction.
async function mountSidebar(page, opts = {}) {
  await page.evaluate((opts) => {
    window.__MOVE_CALLS = [];
    window.__CREATE_CALLS = [];
    window.__RENAME_CALLS = [];
    window.__DELETE_CALLS = [];
    window.__DELETE_GROUP_CALLS = [];
    window.__PICK_CALLS = [];
    window.__RENAME_CHAT_CALLS = [];

    const Component = window.Sidebar;
    const host = document.getElementById("test-root");
    if (window.__TEST_ROOT) {
      try { window.__TEST_ROOT.unmount(); } catch (_) {}
    }
    host.innerHTML = "";
    const root = ReactDOM.createRoot(host);
    root.render(
      React.createElement(Component, {
        chats: opts.chats || { groups: [], dateSections: [] },
        groups: opts.groups || [],
        activeId: null,
        onPick: (c) => window.__PICK_CALLS.push(c.id),
        onDelete: (id) => window.__DELETE_CALLS.push(id),
        onRename: (id, t) => window.__RENAME_CHAT_CALLS.push([id, t]),
        query: "",
        onQuery: () => {},
        onNew: () => {},
        onNewPrivate: () => {},
        onNewCompare: () => {},
        width: 240,
        onCreateGroup: (name) => {
          window.__CREATE_CALLS.push(name);
          // Return a deterministic id so the chain in handleMenuNewGroup
          // can call onMoveChatToGroup with a real value.
          return Promise.resolve("g-new");
        },
        onRenameGroup: (id, name) => window.__RENAME_CALLS.push([id, name]),
        onDeleteGroup: (id) => window.__DELETE_GROUP_CALLS.push(id),
        onMoveChatToGroup: (chatId, groupId) =>
          window.__MOVE_CALLS.push([chatId, groupId]),
        messageHits: [],
      })
    );
    window.__TEST_ROOT = root;
  }, opts);
}

// ── Render shape ─────────────────────────────────────────────────────────

test("Sidebar: renders a group section with item count", async ({ page }) => {
  await mountSidebar(page, {
    groups: [{ id: "g1", name: "Work" }],
    chats: {
      groups: [
        {
          id: "g1",
          name: "Work",
          items: [
            { id: "c1", title: "Q2 plan", model: "m", when: "1h", groupId: "g1" },
            { id: "c2", title: "API redesign", model: "m", when: "2d", groupId: "g1" },
          ],
        },
      ],
      dateSections: [],
    },
  });
  // Group header is present and shows the count.
  const header = page.locator('[data-group-header][data-group-id="g1"]');
  await expect(header).toBeVisible();
  await expect(header).toContainText("Work");
  await expect(header).toContainText("2");
  // Two chat rows underneath, with the chat ids in dataset.
  await expect(page.locator('[data-chat-row][data-chat-id="c1"]')).toBeVisible();
  await expect(page.locator('[data-chat-row][data-chat-id="c2"]')).toBeVisible();
});

test("Sidebar: empty group shows placeholder text", async ({ page }) => {
  await mountSidebar(page, {
    groups: [{ id: "g1", name: "Research" }],
    chats: {
      groups: [{ id: "g1", name: "Research", items: [] }],
      dateSections: [],
    },
  });
  // The placeholder copy comes from GroupSection's empty branch.
  await expect(page.getByText("Empty — drag a chat here")).toBeVisible();
});

test("Sidebar: ungrouped chats render under date sections", async ({ page }) => {
  await mountSidebar(page, {
    groups: [],
    chats: {
      groups: [],
      dateSections: [
        { section: "Today", items: [{ id: "c1", title: "Loose", model: "m", when: "now", groupId: null }] },
      ],
    },
  });
  await expect(page.getByText("Today")).toBeVisible();
  await expect(page.locator('[data-chat-row][data-chat-id="c1"]')).toBeVisible();
});

// ── Collapse toggle ─────────────────────────────────────────────────────

test("Sidebar: collapse toggle hides the group's items", async ({ page }) => {
  await mountSidebar(page, {
    groups: [{ id: "g1", name: "Work" }],
    chats: {
      groups: [
        {
          id: "g1",
          name: "Work",
          items: [{ id: "c1", title: "Q2 plan", model: "m", when: "1h", groupId: "g1" }],
        },
      ],
      dateSections: [],
    },
  });
  // Initially expanded — chat row visible.
  await expect(page.locator('[data-chat-id="c1"]')).toBeVisible();
  // Click the header → collapses.
  await page.locator('[data-group-header][data-group-id="g1"]').click();
  await expect(page.locator('[data-chat-id="c1"]')).toHaveCount(0);
  // Click again → expands.
  await page.locator('[data-group-header][data-group-id="g1"]').click();
  await expect(page.locator('[data-chat-id="c1"]')).toBeVisible();
});

// ── Context menu ────────────────────────────────────────────────────────

test("Sidebar: right-click on a chat row opens the context menu", async ({ page }) => {
  await mountSidebar(page, {
    groups: [{ id: "g1", name: "Work" }],
    chats: {
      groups: [],
      dateSections: [
        { section: "Today", items: [{ id: "c1", title: "Loose", model: "m", when: "now", groupId: null }] },
      ],
    },
  });
  await page.locator('[data-chat-id="c1"]').click({ button: "right" });
  const menu = page.locator("[data-chat-context-menu]");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Open");
  await expect(menu).toContainText("Rename");
  await expect(menu).toContainText("Move to group");
  // The known group is listed inside the menu, and the (none) entry too.
  await expect(menu).toContainText("Work");
  await expect(menu).toContainText("(none)");
  await expect(menu).toContainText("+ New group…");
  await expect(menu).toContainText("Delete chat");
});

test("Sidebar: context menu 'Move to {group}' fires onMoveChatToGroup with the group id", async ({ page }) => {
  await mountSidebar(page, {
    groups: [
      { id: "g1", name: "Work" },
      { id: "g2", name: "Research" },
    ],
    chats: {
      groups: [],
      dateSections: [
        { section: "Today", items: [{ id: "c1", title: "Loose", model: "m", when: "now", groupId: null }] },
      ],
    },
  });
  await page.locator('[data-chat-id="c1"]').click({ button: "right" });
  // Click "Research" inside the menu. Constrained to the menu so the
  // group header in the sidebar (also named in real layouts) doesn't
  // win the click.
  await page.locator("[data-chat-context-menu]").getByText("Research").click();
  // Spy fired with (chatId, groupId).
  const calls = await page.evaluate(() => window.__MOVE_CALLS);
  expect(calls).toEqual([["c1", "g2"]]);
});

test("Sidebar: context menu '(none)' calls onMoveChatToGroup with null group", async ({ page }) => {
  await mountSidebar(page, {
    groups: [{ id: "g1", name: "Work" }],
    chats: {
      groups: [
        {
          id: "g1",
          name: "Work",
          items: [{ id: "c1", title: "Filed chat", model: "m", when: "1h", groupId: "g1" }],
        },
      ],
      dateSections: [],
    },
  });
  await page.locator('[data-chat-id="c1"]').click({ button: "right" });
  await page.locator("[data-chat-context-menu]").getByText("(none)").click();
  const calls = await page.evaluate(() => window.__MOVE_CALLS);
  expect(calls).toEqual([["c1", null]]);
});

test("Sidebar: context menu '+ New group…' opens the name modal", async ({ page }) => {
  await mountSidebar(page, {
    groups: [],
    chats: {
      groups: [],
      dateSections: [
        { section: "Today", items: [{ id: "c1", title: "Loose", model: "m", when: "now", groupId: null }] },
      ],
    },
  });
  await page.locator('[data-chat-id="c1"]').click({ button: "right" });
  await page.locator("[data-chat-context-menu]").getByText("+ New group…").click();
  // Modal shows up. role="dialog" + the "New group" heading text
  // (scoped to the dialog because the sidebar's [+ New group] button also
  // contains the same text).
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("New group")).toBeVisible();
});

// ── [+ New group] button ────────────────────────────────────────────────

test("Sidebar: [+ New group] button opens the name modal; submit fires onCreateGroup", async ({ page }) => {
  await mountSidebar(page, {
    groups: [],
    chats: { groups: [], dateSections: [] },
  });
  await page.locator("[data-new-group]").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Type a name and submit via Enter.
  const input = page.getByPlaceholder("Group name");
  await input.fill("Side projects");
  await input.press("Enter");
  // Modal closes; create spy fired with the typed name.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const calls = await page.evaluate(() => window.__CREATE_CALLS);
  expect(calls).toEqual(["Side projects"]);
});

test("Sidebar: name modal cancels on Esc without firing onCreateGroup", async ({ page }) => {
  await mountSidebar(page, {
    groups: [],
    chats: { groups: [], dateSections: [] },
  });
  await page.locator("[data-new-group]").click();
  const input = page.getByPlaceholder("Group name");
  await input.fill("Nope");
  await input.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const calls = await page.evaluate(() => window.__CREATE_CALLS);
  expect(calls).toEqual([]);
});

// ── Rename chat (modal-based — window.prompt is blocked in WKWebView) ────

test("Sidebar: context menu 'Rename…' opens the rename-chat modal", async ({ page }) => {
  await mountSidebar(page, {
    groups: [],
    chats: {
      groups: [],
      dateSections: [
        { section: "Today", items: [{ id: "c1", title: "Old name", model: "m", when: "now", groupId: null }] },
      ],
    },
  });
  await page.locator('[data-chat-id="c1"]').click({ button: "right" });
  await page.locator("[data-chat-context-menu]").getByText("Rename…").click();
  // Modal opens with the current title pre-filled.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Rename chat")).toBeVisible();
  const input = page.getByPlaceholder("Chat title");
  await expect(input).toHaveValue("Old name");
});

test("Sidebar: rename-chat modal submit fires onRename with the new title", async ({ page }) => {
  await mountSidebar(page, {
    groups: [],
    chats: {
      groups: [],
      dateSections: [
        { section: "Today", items: [{ id: "c1", title: "Old name", model: "m", when: "now", groupId: null }] },
      ],
    },
  });
  await page.locator('[data-chat-id="c1"]').click({ button: "right" });
  await page.locator("[data-chat-context-menu]").getByText("Rename…").click();
  const input = page.getByPlaceholder("Chat title");
  await input.fill("New name");
  await input.press("Enter");
  // Modal closed; rename spy fired with (id, newTitle).
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const calls = await page.evaluate(() => window.__RENAME_CHAT_CALLS);
  expect(calls).toEqual([["c1", "New name"]]);
});

test("Sidebar: rename-chat modal cancels on Esc without firing onRename", async ({ page }) => {
  await mountSidebar(page, {
    groups: [],
    chats: {
      groups: [],
      dateSections: [
        { section: "Today", items: [{ id: "c1", title: "Old name", model: "m", when: "now", groupId: null }] },
      ],
    },
  });
  await page.locator('[data-chat-id="c1"]').click({ button: "right" });
  await page.locator("[data-chat-context-menu]").getByText("Rename…").click();
  await page.getByPlaceholder("Chat title").press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const calls = await page.evaluate(() => window.__RENAME_CHAT_CALLS);
  expect(calls).toEqual([]);
});

// ── Delete confirmation ─────────────────────────────────────────────────

test("Sidebar: context menu 'Delete chat' opens a confirm dialog (does NOT delete immediately)", async ({ page }) => {
  await mountSidebar(page, {
    groups: [],
    chats: {
      groups: [],
      dateSections: [
        { section: "Today", items: [{ id: "c1", title: "Doomed", model: "m", when: "now", groupId: null }] },
      ],
    },
  });
  await page.locator('[data-chat-id="c1"]').click({ button: "right" });
  await page.locator("[data-chat-context-menu]").getByText("Delete chat").click();
  // Confirm dialog shows. The bare onDelete must NOT have fired yet.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Delete chat?")).toBeVisible();
  const deleteCalls = await page.evaluate(() => window.__DELETE_CALLS);
  expect(deleteCalls).toEqual([]);
});

test("Sidebar: confirming delete fires onDelete with the chat id", async ({ page }) => {
  await mountSidebar(page, {
    groups: [],
    chats: {
      groups: [],
      dateSections: [
        { section: "Today", items: [{ id: "c1", title: "Doomed", model: "m", when: "now", groupId: null }] },
      ],
    },
  });
  await page.locator('[data-chat-id="c1"]').click({ button: "right" });
  await page.locator("[data-chat-context-menu]").getByText("Delete chat").click();
  await page.locator("[data-confirm-button]").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const calls = await page.evaluate(() => window.__DELETE_CALLS);
  expect(calls).toEqual(["c1"]);
});

test("Sidebar: cancelling the delete confirm keeps the chat", async ({ page }) => {
  await mountSidebar(page, {
    groups: [],
    chats: {
      groups: [],
      dateSections: [
        { section: "Today", items: [{ id: "c1", title: "Safe", model: "m", when: "now", groupId: null }] },
      ],
    },
  });
  await page.locator('[data-chat-id="c1"]').click({ button: "right" });
  await page.locator("[data-chat-context-menu]").getByText("Delete chat").click();
  await page.getByRole("dialog").getByText("Cancel").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const calls = await page.evaluate(() => window.__DELETE_CALLS);
  expect(calls).toEqual([]);
});

// ── Open ────────────────────────────────────────────────────────────────

test("Sidebar: context menu 'Open' fires onPick with the chat", async ({ page }) => {
  await mountSidebar(page, {
    groups: [],
    chats: {
      groups: [],
      dateSections: [
        { section: "Today", items: [{ id: "c1", title: "x", model: "m", when: "now", groupId: null }] },
      ],
    },
  });
  await page.locator('[data-chat-id="c1"]').click({ button: "right" });
  await page.locator("[data-chat-context-menu]").getByText("Open").click();
  const calls = await page.evaluate(() => window.__PICK_CALLS);
  expect(calls).toEqual(["c1"]);
});
