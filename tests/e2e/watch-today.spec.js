// "Today" in the Watches list (ui/watch.jsx WatchPanel).

const { test, expect } = require("@playwright/test");

const NOW = Math.floor(Date.now() / 1000);

const ONE_WATCH = [
  { id: "w1", name: "Downloads", kind: "folder", enabled: true, notesPath: "/n.md", folderPath: "/a" },
];
const ONE_DONE_EVENT = [
  {
    id: "e1", watchId: "w1", filePath: "/a/report.pdf",
    status: "done", summary: "A summary.", error: null, createdAt: NOW,
  },
];

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test("Today toggle re-queries events with a since filter", async ({ page }) => {
  await page.evaluate(({ watches, events }) => {
    window.__INVOKE_RESPONSES.watch_list = () => watches;
    window.__INVOKE_RESPONSES.watch_events_list = () => events;
    window.__TEST_MOUNT("WatchPanel", {});
  }, { watches: ONE_WATCH, events: ONE_DONE_EVENT });

  // Initial (All) load: since is null.
  await page.waitForFunction(() => window.__INVOKE_FIND("watch_events_list"));

  await page.locator('[data-watch-scope="today"]').click();

  // Today load: since is a number (now - 24h).
  await page.waitForFunction(() =>
    window.__INVOKE_FIND("watch_events_list", (a) => typeof a.since === "number")
  );
});

test("Chat about today appears in Today mode and fires the handler", async ({ page }) => {
  await page.evaluate(({ watches, events }) => {
    window.__INVOKE_RESPONSES.watch_list = () => watches;
    window.__INVOKE_RESPONSES.watch_events_list = () => events;
    window.__TEST_MOUNT("WatchPanel", {});
  }, { watches: ONE_WATCH, events: ONE_DONE_EVENT });

  await page.waitForFunction(() => window.__INVOKE_FIND("watch_events_list"));

  // Not shown in All mode…
  await expect(page.locator("#test-root button", { hasText: "Chat about today" })).toHaveCount(0);

  await page.locator('[data-watch-scope="today"]').click();

  // …shown in Today mode once there's a summarised event.
  const btn = page.locator("#test-root button", { hasText: "Chat about today" });
  await expect(btn).toBeVisible();
  await btn.click();
  await page.waitForFunction(() => (window.__TEST_CALLS.onChatAboutToday || 0) >= 1);
});

test("with no watches the list offers the two starting points", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.watch_list = () => [];
    window.__INVOKE_RESPONSES.watch_events_list = () => [];
    window.__TEST_MOUNT("WatchPanel", {});
  });
  const empty = page.locator("[data-watch-empty]");
  await expect(empty).toContainText("No folders are watched yet.");
  await expect(empty).toContainText("Summarise new downloads");
  await expect(empty).toContainText("Another folder");
  // Nothing to check yet.
  await expect(page.getByRole("button", { name: "Check now" })).toBeDisabled();

  await page.locator('[data-recipe="downloads"]').click();
  await page.waitForFunction(() => (window.__TEST_CALLS.onPickRecipe || 0) >= 1);
});

test("Check now runs every watch once", async ({ page }) => {
  await page.evaluate(({ watches, events }) => {
    window.__INVOKE_RESPONSES.watch_list = () => watches;
    window.__INVOKE_RESPONSES.watch_events_list = () => events;
    window.__INVOKE_RESPONSES.watch_run_once = () => undefined;
    window.__TEST_MOUNT("WatchPanel", {});
  }, { watches: ONE_WATCH, events: ONE_DONE_EVENT });
  await page.getByRole("button", { name: "Check now" }).click();
  await page.waitForFunction(() => window.__INVOKE_FIND("watch_run_once"));
});
