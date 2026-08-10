// Command palette (⌘K, ui/command-palette.jsx). The component is
// data-only: commands come in as {id,label,section,hint,keywords} and
// execution goes out through onRun(id) — so these smokes mount it with
// plain JSON and assert the interaction contract: fuzzy filtering,
// section headers in browse mode, keyboard navigation, Enter/click
// execution, Esc close. App-side wiring (⌘K toggle, runner map) lives
// in main.jsx and follows the same pattern as the ⌘\ sidebar toggle.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const COMMANDS = [
  { id: "new-chat", label: "New chat", section: "Actions", keywords: "create start" },
  { id: "new-private", label: "New private chat", section: "Actions", keywords: "incognito" },
  { id: "open-settings", label: "Open Settings", section: "Actions" },
  { id: "theme-midnight", label: "Midnight", section: "Theme", hint: "current" },
  { id: "chat-1", label: "Trip planning", section: "Recent chats", hint: "Pack layers…" },
];

async function mount(page, props = {}) {
  await page.evaluate(
    ({ cmds, extra }) => {
      window.__TEST_MOUNT("CommandPalette", {
        open: true,
        commands: cmds,
        ...extra,
      });
    },
    { cmds: COMMANDS, extra: props },
  );
}

test("browse mode lists everything under section headers", async ({ page }) => {
  await mount(page);
  const root = page.locator("[data-command-palette]");
  await expect(root).toBeVisible();
  // All five commands present…
  await expect(root.locator("[data-palette-item]")).toHaveCount(5);
  // …grouped under their authored section headers (uppercasing is CSS —
  // the DOM keeps the authored casing).
  await expect(root).toContainText("Actions");
  await expect(root).toContainText("Theme");
  await expect(root).toContainText("Recent chats");
  // Hints render alongside their rows.
  await expect(root).toContainText("Pack layers…");
});

test("typing filters fuzzily (initials-style subsequence)", async ({ page }) => {
  await mount(page);
  const input = page.locator("[data-palette-input]");
  // Autofocus on open — typing works with no extra click.
  await expect(input).toBeFocused();
  await input.fill("npc");
  // Subsequence match: only "New private chat" survives the seeded set.
  await expect(page.locator("[data-palette-item]")).toHaveCount(1);
  await expect(page.locator('[data-palette-item="new-private"]')).toBeVisible();
  // Flat results while searching — no section headers.
  await expect(page.locator("[data-command-palette]")).not.toContainText("Actions");
});

test("onRun receives the highlighted command's id", async ({ page }) => {
  await page.evaluate((cmds) => {
    window.__PALETTE_RAN = [];
    window.__TEST_MOUNT("CommandPalette", {
      open: true,
      commands: cmds,
      onRun: (id) => window.__PALETTE_RAN.push(id),
    });
  }, COMMANDS);
  const input = page.locator("[data-palette-input]");
  await input.fill("settings");
  await input.press("Enter");
  expect(await page.evaluate(() => window.__PALETTE_RAN)).toEqual(["open-settings"]);
});

test("arrow keys move the highlight and wrap", async ({ page }) => {
  await page.evaluate((cmds) => {
    window.__PALETTE_RAN = [];
    window.__TEST_MOUNT("CommandPalette", {
      open: true,
      commands: cmds,
      onRun: (id) => window.__PALETTE_RAN.push(id),
    });
  }, COMMANDS);
  const input = page.locator("[data-palette-input]");
  // Down twice → third row; selection attribute follows.
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  await expect(
    page.locator('[data-palette-item="open-settings"]'),
  ).toHaveAttribute("data-palette-selected", "true");
  // Up three times wraps to the last row.
  await input.press("ArrowUp");
  await input.press("ArrowUp");
  await input.press("ArrowUp");
  await expect(page.locator('[data-palette-item="chat-1"]')).toHaveAttribute(
    "data-palette-selected",
    "true",
  );
  await input.press("Enter");
  expect(await page.evaluate(() => window.__PALETTE_RAN)).toEqual(["chat-1"]);
});

test("click runs a row; Esc and backdrop close", async ({ page }) => {
  await page.evaluate((cmds) => {
    window.__PALETTE_RAN = [];
    window.__TEST_MOUNT("CommandPalette", {
      open: true,
      commands: cmds,
      onRun: (id) => window.__PALETTE_RAN.push(id),
    });
  }, COMMANDS);
  await page.locator('[data-palette-item="new-chat"]').click();
  expect(await page.evaluate(() => window.__PALETTE_RAN)).toEqual(["new-chat"]);
  // Esc → onClose fires (harness-tracked).
  await page.locator("[data-palette-input]").press("Escape");
  expect(await page.evaluate(() => window.__TEST_CALLS.onClose || 0)).toBe(1);
  // Backdrop mousedown → onClose again.
  await page.locator("[data-command-palette]").click({ position: { x: 8, y: 8 } });
  expect(await page.evaluate(() => window.__TEST_CALLS.onClose || 0)).toBe(2);
});

test("no matches state and closed render", async ({ page }) => {
  await mount(page);
  await page.locator("[data-palette-input]").fill("zzzzzz");
  await expect(page.locator("[data-palette-item]")).toHaveCount(0);
  await expect(page.locator("[data-command-palette]")).toContainText("No matches.");
  // open=false renders nothing at all.
  await page.evaluate((cmds) => {
    window.__TEST_MOUNT("CommandPalette", { open: false, commands: cmds });
  }, COMMANDS);
  await expect(page.locator("[data-command-palette]")).toHaveCount(0);
});
