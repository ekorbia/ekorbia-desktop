// Smokes for the Spaces sidebar feature: section render, "All chats"
// pseudo-row, per-Space rows with color dots, the create-Space modal,
// the per-row overflow menu (Rename / Change color / Delete), and the
// new "Move to Space" submenu in the chat right-click menu.
//
// What this spec DOES cover:
//   • Sidebar renders the Spaces section header with the "All chats"
//     pseudo-row, the per-Space rows, and the "+ New Space" button.
//   • "All chats" is data-active="true" when activeSpaceId is null.
//   • A Space row is data-active="true" when activeSpaceId matches.
//   • Clicking a Space row fires onSelectSpace with its id; clicking
//     "All chats" fires with null.
//   • Clicking "+ New Space" opens the SpaceCreateModal; submitting
//     name + color fires onCreateSpace.
//   • SpaceCreateModal: Create disabled when empty; Cancel + Esc
//     close without firing.
//   • Hovering a Space row reveals the ⋯ overflow button; clicking
//     it opens Rename / Change color / Delete.
//   • Rename → NameModal pre-filled → submit calls onRenameSpace.
//   • Delete → ConfirmModal → confirm calls onDeleteSpace.
//   • ChatContextMenu adds a "Move to Space" submenu when there's at
//     least one Space, with rows for every Space + a "(none)" unfile
//     entry; selecting fires onMoveChatToSpace with the right id.
//
// What this spec does NOT cover (deferred to later phases):
//   • Active-Space filter on the chat list (Phase 2/3 — pre-filtering
//     happens upstream in main.jsx, not in Sidebar; integration test
//     would need a fuller mount).
//   • Color popover positioning (visual; tested by hand).
//   • Drag-and-drop of chats onto Space rows (deferred to Phase 5+).

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

// Mount the Sidebar with spy callbacks recording onto window arrays so
// tests can assert call shapes after user interaction.
async function mountSidebar(page, opts = {}) {
  await page.evaluate((opts) => {
    window.__SELECT_SPACE_CALLS = [];
    window.__CREATE_SPACE_CALLS = [];
    window.__RENAME_SPACE_CALLS = [];
    window.__RECOLOR_SPACE_CALLS = [];
    window.__DELETE_SPACE_CALLS = [];
    window.__MOVE_TO_SPACE_CALLS = [];

    const Component = window.Sidebar;
    const host = document.getElementById("test-root");
    if (window.__TEST_ROOT) {
      try { window.__TEST_ROOT.unmount(); } catch (_) {}
    }
    host.innerHTML = "";
    const root = ReactDOM.createRoot(host);
    root.render(
      React.createElement(Component, {
        chats: opts.chats || { dateSections: [] },
        
        spaces: opts.spaces || [],
        activeSpaceId: opts.activeSpaceId ?? null,
        activeId: null,
        onPick: () => {},
        onDelete: () => {},
        onRename: () => {},
        query: "",
        onQuery: () => {},
        onNew: () => {},
        onNewPrivate: () => {},
        onNewCompare: () => {},
        width: 240,
        onSelectSpace: (id) => window.__SELECT_SPACE_CALLS.push(id),
        // Returns a deterministic id so the post-create selectSpace path
        // in the Sidebar can fire onSelectSpace with the new Space.
        // Returns the full SpaceRow (production shape — `createSpace` in
        // main.jsx returns whatever `space_create` returned). The
        // Sidebar's onSubmit handler extracts .id for selectSpace and
        // uses the full row when "Create & configure…" requests opening
        // the settings dialog.
        onCreateSpace: (name, color) => {
          window.__CREATE_SPACE_CALLS.push([name, color]);
          return Promise.resolve({
            id: "s-new",
            name,
            color: color || null,
            slug: "s-new",
            systemPrompt: null,
            defaultModel: null,
            memoryPath: null,
            sortIndex: 0,
            createdAt: 1,
            updatedAt: 1,
          });
        },
        onRenameSpace: (id, name) =>
          window.__RENAME_SPACE_CALLS.push([id, name]),
        onRecolorSpace: (id, color) =>
          window.__RECOLOR_SPACE_CALLS.push([id, color]),
        onDeleteSpace: (id) => window.__DELETE_SPACE_CALLS.push(id),
        onMoveChatToSpace: (chatId, spaceId) =>
          window.__MOVE_TO_SPACE_CALLS.push([chatId, spaceId]),
        messageHits: [],
      })
    );
    window.__TEST_ROOT = root;
  }, opts);
}

// ── Section render shape ────────────────────────────────────────────────

test("Sidebar: renders the Spaces section with All chats pseudo-row", async ({ page }) => {
  await mountSidebar(page, { spaces: [] });
  // Section landmark + pseudo-row.
  await expect(page.locator("[data-spaces-section]")).toBeVisible();
  await expect(page.locator("[data-all-chats-row]")).toBeVisible();
  await expect(page.locator("[data-all-chats-row]")).toContainText("All chats");
  // [+ New Space] always visible (so the affordance is discoverable on
  // first launch).
  await expect(page.locator("[data-new-space]")).toBeVisible();
});

test("Sidebar: All chats is active when activeSpaceId is null", async ({ page }) => {
  await mountSidebar(page, { spaces: [], activeSpaceId: null });
  await expect(page.locator("[data-all-chats-row]"))
    .toHaveAttribute("data-active", "true");
});

test("Sidebar: a Space row is active when activeSpaceId matches", async ({ page }) => {
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
      { id: "s2", name: "Work",  slug: "work",  color: "blue",  sortIndex: 1, createdAt: 1, updatedAt: 1 },
    ],
    activeSpaceId: "s2",
  });
  await expect(page.locator('[data-space-row][data-space-id="s1"]'))
    .toHaveAttribute("data-active", "false");
  await expect(page.locator('[data-space-row][data-space-id="s2"]'))
    .toHaveAttribute("data-active", "true");
  // All chats is INACTIVE when a Space is active.
  await expect(page.locator("[data-all-chats-row]"))
    .toHaveAttribute("data-active", "false");
});

test("Sidebar: every Space row renders with name + dot", async ({ page }) => {
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
      { id: "s2", name: "Therapy notes", slug: "therapy", color: "green", sortIndex: 1, createdAt: 1, updatedAt: 1 },
    ],
  });
  await expect(page.locator('[data-space-row][data-space-id="s1"]'))
    .toContainText("Novel");
  await expect(page.locator('[data-space-row][data-space-id="s2"]'))
    .toContainText("Therapy notes");
});

// ── Selection ──────────────────────────────────────────────────────────

test("Sidebar: clicking a Space row fires onSelectSpace with its id", async ({ page }) => {
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
    ],
  });
  await page.locator('[data-space-row][data-space-id="s1"]').click();
  const calls = await page.evaluate(() => window.__SELECT_SPACE_CALLS);
  expect(calls).toEqual(["s1"]);
});

test("Sidebar: clicking All chats fires onSelectSpace with null", async ({ page }) => {
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
    ],
    activeSpaceId: "s1",
  });
  await page.locator("[data-all-chats-row]").click();
  const calls = await page.evaluate(() => window.__SELECT_SPACE_CALLS);
  expect(calls).toEqual([null]);
});

// ── Create modal ───────────────────────────────────────────────────────

test("Sidebar: + New Space opens the create modal", async ({ page }) => {
  await mountSidebar(page, { spaces: [] });
  await page.locator("[data-new-space]").click();
  await expect(page.locator("[data-space-create-modal]")).toBeVisible();
});

test("SpaceCreateModal: Create is disabled until the user types a name", async ({ page }) => {
  await mountSidebar(page, { spaces: [] });
  await page.locator("[data-new-space]").click();
  const create = page.locator("[data-space-create-confirm]");
  await expect(create).toBeDisabled();
  await page.locator("[data-space-create-modal] input").fill("Novel");
  await expect(create).toBeEnabled();
});

test("SpaceCreateModal: submitting fires onCreateSpace with name + color", async ({ page }) => {
  await mountSidebar(page, { spaces: [] });
  await page.locator("[data-new-space]").click();
  await page.locator("[data-space-create-modal] input").fill("Novel");
  // Default color is the first palette key — pick a non-default to prove
  // the swatch wiring actually drives the payload.
  await page.locator('[data-color-swatch="green"]').click();
  await page.locator("[data-space-create-confirm]").click();
  const calls = await page.evaluate(() => window.__CREATE_SPACE_CALLS);
  expect(calls).toEqual([["Novel", "green"]]);
});

test("SpaceCreateModal: Cancel closes without firing onCreateSpace", async ({ page }) => {
  await mountSidebar(page, { spaces: [] });
  await page.locator("[data-new-space]").click();
  await page.locator("[data-space-create-modal] input").fill("Novel");
  await page.locator("[data-space-create-modal]").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-space-create-modal]")).toHaveCount(0);
  const calls = await page.evaluate(() => window.__CREATE_SPACE_CALLS);
  expect(calls).toEqual([]);
});

test("SpaceCreateModal: Create & configure… opens the settings dialog after creating", async ({ page }) => {
  // The secondary button is the affordance for "I want to fill in
  // system prompt, default model, memory file, pinned prompts, and
  // pinned attachments right now, without having to dig into the
  // overflow menu after the row appears."
  await mountSidebar(page, { spaces: [] });
  await page.locator("[data-new-space]").click();
  await page.locator("[data-space-create-modal] input").fill("Brand New");
  await page.locator("[data-space-create-and-configure]").click();
  // onCreateSpace fires (records args) — same as the plain Create
  // button — then the settings modal materialises on the new Space.
  const create = await page.evaluate(() => window.__CREATE_SPACE_CALLS);
  expect(create).toEqual([["Brand New", "amber"]]);
  await expect(page.locator("[data-space-settings-modal]")).toBeVisible();
  // Header copy includes the new Space's name so the user knows what
  // they're configuring.
  await expect(page.locator("[data-space-settings-modal]"))
    .toContainText("Space settings — Brand New");
});

test("SpaceCreateModal: plain Create does NOT open the settings dialog", async ({ page }) => {
  // Bug guard: only the secondary button should open the settings
  // dialog. The primary "Create" stays the quick path.
  await mountSidebar(page, { spaces: [] });
  await page.locator("[data-new-space]").click();
  await page.locator("[data-space-create-modal] input").fill("Brand New");
  await page.locator("[data-space-create-confirm]").click();
  await expect(page.locator("[data-space-settings-modal]")).toHaveCount(0);
});

test("SpaceCreateModal: after creating, the new Space is selected", async ({ page }) => {
  // Mount with an existing Space so we can confirm that the post-create
  // selectSpace fires (not just "selected by default"). onCreateSpace
  // returns "s-new" from the spy, which is what selectSpace must receive.
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Existing", slug: "existing", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
    ],
  });
  await page.locator("[data-new-space]").click();
  await page.locator("[data-space-create-modal] input").fill("Brand New");
  await page.locator("[data-space-create-confirm]").click();
  // Both callbacks fire — onCreateSpace records the create, then the
  // Sidebar dispatches onSelectSpace with the returned id.
  const create = await page.evaluate(() => window.__CREATE_SPACE_CALLS);
  const select = await page.evaluate(() => window.__SELECT_SPACE_CALLS);
  expect(create).toEqual([["Brand New", "amber"]]);
  expect(select).toEqual(["s-new"]);
});

// ── Overflow menu (Rename / Change color / Delete) ─────────────────────

test("Sidebar: hovering a Space row reveals the ⋯ overflow button", async ({ page }) => {
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
    ],
  });
  const row = page.locator('[data-space-row][data-space-id="s1"]');
  await row.hover();
  await expect(row.locator("[data-space-menu-btn]")).toBeVisible();
});

test("Sidebar: overflow menu → Rename → name modal pre-filled → submit fires onRenameSpace", async ({ page }) => {
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
    ],
  });
  const row = page.locator('[data-space-row][data-space-id="s1"]');
  await row.hover();
  await row.locator("[data-space-menu-btn]").click();
  await expect(page.locator("[data-space-overflow-menu]")).toBeVisible();
  await page.getByText("Rename Space").click();
  // NameModal opens (shared component with chat-rename + group-rename).
  // It has no data-* attr of its own, so we use the visible title.
  await expect(page.getByText("Rename Space")).toBeVisible();
  // The input pre-fills with the current name. Look for an input whose
  // value matches "Novel" (NameModal renders one text input).
  const input = page.locator('input[placeholder="Space name"]');
  await expect(input).toHaveValue("Novel");
  await input.fill("My Novel");
  await page.getByRole("button", { name: "Save" }).click();
  const calls = await page.evaluate(() => window.__RENAME_SPACE_CALLS);
  expect(calls).toEqual([["s1", "My Novel"]]);
});

test("Sidebar: overflow menu → Delete → confirm fires onDeleteSpace", async ({ page }) => {
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
    ],
  });
  const row = page.locator('[data-space-row][data-space-id="s1"]');
  await row.hover();
  await row.locator("[data-space-menu-btn]").click();
  await page.getByText("Delete Space").click();
  // ConfirmModal shows the destructive copy with a Delete button.
  await expect(page.getByText("Delete Space?")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  const calls = await page.evaluate(() => window.__DELETE_SPACE_CALLS);
  expect(calls).toEqual(["s1"]);
});

test("Sidebar: overflow menu → Change color → picking a swatch fires onRecolorSpace", async ({ page }) => {
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
    ],
  });
  const row = page.locator('[data-space-row][data-space-id="s1"]');
  await row.hover();
  await row.locator("[data-space-menu-btn]").click();
  await page.getByText("Change color…").click();
  await expect(page.locator("[data-space-color-popover]")).toBeVisible();
  // Pick a different swatch from the current one — confirms the click
  // wiring drives the payload (the call carries the picked color).
  await page.locator('[data-space-color-popover] [data-color-swatch="purple"]').click();
  const calls = await page.evaluate(() => window.__RECOLOR_SPACE_CALLS);
  expect(calls).toEqual([["s1", "purple"]]);
});

// ── Right-click on a Space row opens the same overflow menu ────────────

test("Sidebar: right-clicking a Space row opens the overflow menu", async ({ page }) => {
  // Symmetric with the chat-row "Move to Space" right-click: a right-click
  // on a Space row exposes the same Edit / Rename / Change color / Delete
  // actions as the ⋯ button — no need to hover then click.
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
    ],
  });
  await page.locator('[data-space-row][data-space-id="s1"]').click({ button: "right" });
  await expect(page.locator("[data-space-overflow-menu]")).toBeVisible();
  // All four items render.
  await expect(page.locator("[data-space-overflow-menu]")).toContainText("Edit settings…");
  await expect(page.locator("[data-space-overflow-menu]")).toContainText("Rename Space");
  await expect(page.locator("[data-space-overflow-menu]")).toContainText("Change color…");
  await expect(page.locator("[data-space-overflow-menu]")).toContainText("Delete Space");
});

test("Sidebar: right-click → Rename Space fires onRenameSpace", async ({ page }) => {
  // End-to-end that the right-click path is wired to the same action
  // handlers as the ⋯ button path.
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
    ],
  });
  await page.locator('[data-space-row][data-space-id="s1"]').click({ button: "right" });
  await page.getByText("Rename Space").click();
  await page.locator('input[placeholder="Space name"]').fill("Renamed Via Right Click");
  await page.getByRole("button", { name: "Save" }).click();
  const calls = await page.evaluate(() => window.__RENAME_SPACE_CALLS);
  expect(calls).toEqual([["s1", "Renamed Via Right Click"]]);
});

test("Sidebar: right-clicking the All chats row does NOT open the menu", async ({ page }) => {
  // The "All chats" pseudo-row has no edit/rename/delete actions, so
  // there's nothing to expose. A right-click on it must NOT open the
  // overflow menu (no rename modal to suddenly appear over the user's
  // typing, no confusing empty popover).
  await mountSidebar(page, { spaces: [] });
  await page.locator("[data-all-chats-row]").click({ button: "right" });
  await expect(page.locator("[data-space-overflow-menu]")).toHaveCount(0);
});

// ── Move-to-Space submenu in the chat right-click menu ─────────────────

// Mount a sidebar with at least one chat row + at least one Space, so the
// right-click menu has something to act on AND the Move-to-Space submenu
// has at least one target.
async function mountSidebarWithChatAndSpaces(page) {
  await mountSidebar(page, {
    chats: {
      
      dateSections: [
        {
          section: "Today",
          items: [{ id: "c1", title: "Hello", model: "m", when: "now", groupId: null, spaceId: null }],
        },
      ],
    },
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
      { id: "s2", name: "Work",  slug: "work",  color: "blue",  sortIndex: 1, createdAt: 1, updatedAt: 1 },
    ],
  });
  // Gate on the sidebar actually painting its rows before returning. The
  // drag-drop tests reach into the DOM with document.querySelector via
  // page.evaluate (synthetic DragEvents — Playwright's native D&D is
  // unreliable in WebKit), which does NOT auto-wait the way locator actions
  // do. Under parallel load the React mount can lag the evaluate, so the
  // query returns null → "drop target not found". Waiting on a Space row
  // (the drag targets) removes the race.
  await page.waitForSelector('[data-space-row][data-space-id="s2"]');
}

test("ChatContextMenu: shows the Move to Space submenu when spaces exist", async ({ page }) => {
  await mountSidebarWithChatAndSpaces(page);
  await page.locator('[data-chat-row][data-chat-id="c1"]').click({ button: "right" });
  await expect(page.locator("[data-chat-context-menu]")).toBeVisible();
  await expect(page.locator("[data-chat-context-menu]")).toContainText("Move to Space");
  // Both Spaces + the (none) row are present.
  await expect(page.locator('[data-move-to-space="none"]')).toBeVisible();
  await expect(page.locator('[data-move-to-space="s1"]')).toBeVisible();
  await expect(page.locator('[data-move-to-space="s2"]')).toBeVisible();
});

test("ChatContextMenu: HIDES the Move to Space submenu when no Spaces exist", async ({ page }) => {
  // A fresh install has zero Spaces — surfacing an empty "Move to Space"
  // section would be dead UX. Pin the absence.
  await mountSidebar(page, {
    chats: {
      
      dateSections: [
        {
          section: "Today",
          items: [{ id: "c1", title: "Hello", model: "m", when: "now", groupId: null, spaceId: null }],
        },
      ],
    },
    spaces: [],
  });
  await page.locator('[data-chat-row][data-chat-id="c1"]').click({ button: "right" });
  await expect(page.locator("[data-chat-context-menu]")).toBeVisible();
  // The menu opens, but the Move-to-Space landmark is absent.
  await expect(page.locator("[data-chat-context-menu]")).not.toContainText("Move to Space");
  await expect(page.locator('[data-move-to-space="none"]')).toHaveCount(0);
});

test("ChatContextMenu: picking a Space fires onMoveChatToSpace with (chatId, spaceId)", async ({ page }) => {
  await mountSidebarWithChatAndSpaces(page);
  await page.locator('[data-chat-row][data-chat-id="c1"]').click({ button: "right" });
  await page.locator('[data-move-to-space="s2"]').click();
  const calls = await page.evaluate(() => window.__MOVE_TO_SPACE_CALLS);
  expect(calls).toEqual([["c1", "s2"]]);
});

test("ChatContextMenu: picking (none) fires onMoveChatToSpace with (chatId, null)", async ({ page }) => {
  await mountSidebarWithChatAndSpaces(page);
  await page.locator('[data-chat-row][data-chat-id="c1"]').click({ button: "right" });
  await page.locator('[data-move-to-space="none"]').click();
  const calls = await page.evaluate(() => window.__MOVE_TO_SPACE_CALLS);
  expect(calls).toEqual([["c1", null]]);
});

// ── Drag-and-drop onto Space rows (Phase 1, replace-groups effort) ───────
//
// Playwright's first-party drag-drop API is unreliable for HTML5 D&D in
// WebKit (the same reason sidebar-groups.spec.js skipped it). The
// workaround: synthesise `dragover` and `drop` events directly in the
// page, build the DataTransfer with the same MIME (text/x-ekorbia-chat-id)
// that ChatRow's onDragStart sets, and dispatch them on the target row.
// The component's own handlers then run as they would for a real drag.

// Helper: fire dragover + drop on the element matching `selector`,
// carrying `chatId` as the dataTransfer payload. Returns void; the test
// asserts on the recorded onDropChat call afterwards.
async function dragChatOnto(page, selector, chatId) {
  await page.evaluate(({ selector, chatId }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error("drop target not found: " + selector);
    const makeEvent = (type) => {
      const dt = new DataTransfer();
      dt.setData("text/x-ekorbia-chat-id", chatId);
      const ev = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      return ev;
    };
    // dragover must be dispatched + preventDefault'd by the target for
    // the subsequent drop to fire in a real browser. The component's
    // onDragOver does call preventDefault.
    el.dispatchEvent(makeEvent("dragover"));
    el.dispatchEvent(makeEvent("drop"));
  }, { selector, chatId });
}

test("drag-drop: dropping a chat on a Space row fires onMoveChatToSpace with (chatId, spaceId)", async ({ page }) => {
  await mountSidebarWithChatAndSpaces(page);
  await dragChatOnto(page, '[data-space-row][data-space-id="s2"]', "c1");
  const calls = await page.evaluate(() => window.__MOVE_TO_SPACE_CALLS);
  expect(calls).toEqual([["c1", "s2"]]);
});

test("drag-drop: dropping a chat on All chats fires onMoveChatToSpace with (chatId, null)", async ({ page }) => {
  await mountSidebarWithChatAndSpaces(page);
  await dragChatOnto(page, "[data-all-chats-row]", "c1");
  const calls = await page.evaluate(() => window.__MOVE_TO_SPACE_CALLS);
  expect(calls).toEqual([["c1", null]]);
});

test("drag-drop: dragover sets data-drop-hover=true on the target row", async ({ page }) => {
  await mountSidebarWithChatAndSpaces(page);
  // Fire ONLY dragover (no drop) so the hover state stays applied.
  await page.evaluate(() => {
    const el = document.querySelector('[data-space-row][data-space-id="s1"]');
    const dt = new DataTransfer();
    dt.setData("text/x-ekorbia-chat-id", "c1");
    el.dispatchEvent(new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    }));
  });
  await expect(page.locator('[data-space-row][data-space-id="s1"]'))
    .toHaveAttribute("data-drop-hover", "true");
  // Sibling rows stay unhighlighted.
  await expect(page.locator('[data-space-row][data-space-id="s2"]'))
    .toHaveAttribute("data-drop-hover", "false");
});

test("drag-drop: an empty payload does NOT fire onMoveChatToSpace", async ({ page }) => {
  // Defence-in-depth: random page drags (not from a chat row) should
  // not mistakenly file anything. The handler reads the MIME at drop
  // time and ignores empty payloads.
  await mountSidebarWithChatAndSpaces(page);
  await page.evaluate(() => {
    const el = document.querySelector('[data-space-row][data-space-id="s1"]');
    const dt = new DataTransfer();
    // No setData call — the payload is empty.
    el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  const calls = await page.evaluate(() => window.__MOVE_TO_SPACE_CALLS);
  expect(calls).toEqual([]);
});
