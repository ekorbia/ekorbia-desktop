// Per-watch grouping in the Watches panel (ui/watch.jsx WatchPanel).
//
// Each watch renders as a section: its header followed by ITS OWN summaries,
// sections stacked in watch order. This replaced the old design (a compact
// watch list on top + one merged, time-sorted feed below), where a watch's
// summaries could appear physically beneath a different watch's header.

const { test, expect } = require("@playwright/test");

const NOW = Math.floor(Date.now() / 1000);

// HackerNews first, Downloads second — sections render in this order.
const WATCHES = [
  {
    id: "wh", name: "HackerNews", kind: "rss", enabled: 1,
    notesPath: "/h.md", sourceUrl: "https://news.ycombinator.com/rss",
    model: "gemma4-e2b",
  },
  {
    id: "wd", name: "Downloads", kind: "folder", enabled: 1,
    notesPath: "/d.md", folderPath: "/x/watch", model: "gemma4-e2b",
  },
];
const EVENTS = [
  {
    id: "eh", watchId: "wh", filePath: "guid-abc",
    status: "done", summary: "HN alpha summary.", error: null, createdAt: NOW,
  },
  {
    id: "ed", watchId: "wd", filePath: "/x/report.txt",
    status: "done", summary: "Downloads bravo summary.", error: null,
    createdAt: NOW - 100,
  },
];

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const mount = (page) =>
  page.evaluate(({ watches, events }) => {
    window.__INVOKE_RESPONSES.watch_list = () => watches;
    window.__INVOKE_RESPONSES.watch_events_list = () => events;
    window.__TEST_MOUNT("WatchPanel", { width: 380 });
  }, { watches: WATCHES, events: EVENTS });

test("each watch's summaries sit under its own header, in order", async ({ page }) => {
  await mount(page);
  const root = page.locator("#test-root");
  // rss headline == the summary's first line, so it appears twice — .first().
  await expect(root.getByText("HN alpha summary.").first()).toBeVisible();
  await expect(root.getByText("Downloads bravo summary.")).toBeVisible();

  // The reported bug: HackerNews's summary must come BEFORE the Downloads
  // section header, not below it. Assert DOM/text order.
  const text = await root.innerText();
  expect(text.indexOf("HN alpha summary.")).toBeLessThan(text.indexOf("Downloads"));
  expect(text.indexOf("HackerNews")).toBeLessThan(text.indexOf("Downloads"));
});

test("clicking a watch header collapses just that section", async ({ page }) => {
  await mount(page);
  const root = page.locator("#test-root");
  await expect(root.getByText("HN alpha summary.").first()).toBeVisible();

  // Click the HackerNews header (its name, not a control button) to collapse.
  await root.getByText("HackerNews", { exact: true }).click();

  // Its summary is hidden; the other watch's stays.
  await expect(root.getByText("HN alpha summary.")).toHaveCount(0);
  await expect(root.getByText("Downloads bravo summary.")).toBeVisible();
});
