// The list in Settings → Watches (ui/watch.jsx WatchPanel).
//
// Each watch is a section: its row, then ITS OWN summaries beneath it.
// Only folders are watched; a feed or page watch left by an older version
// is not listed, only counted in a note where it can be removed.

const { test, expect } = require("@playwright/test");

const NOW = Math.floor(Date.now() / 1000);

const WATCHES = [
  {
    id: "wi", name: "Intake", kind: "folder", enabled: true, notify: true,
    notesPath: "/i.md", folderPath: "/Users/you/Matters/Intake", model: "gemma4-12b",
    promptId: "summarise-a-document",
  },
  {
    id: "wd", name: "Downloads", kind: "folder", enabled: false,
    notesPath: "/d.md", folderPath: "/Users/you/Downloads", model: "gemma4-e4b",
    promptId: null,
  },
];
const OLD_FEED = {
  id: "wf", name: "HackerNews", kind: "rss", enabled: true,
  notesPath: "/h.md", sourceUrl: "https://news.example.com/rss", model: "gemma4-e4b",
};
const EVENTS = [
  {
    id: "ei", watchId: "wi", filePath: "/Users/you/Matters/Intake/Engagement letter.pdf",
    status: "done", summary: "Intake alpha summary.", error: null, createdAt: NOW,
  },
  {
    id: "ed", watchId: "wd", filePath: "/Users/you/Downloads/report.txt",
    status: "done", summary: "Downloads bravo summary.", error: null, createdAt: NOW - 100,
  },
  // Left by the old feed watch: belongs to no listed watch, so not shown.
  { id: "ef", watchId: "wf", filePath: "guid-abc", status: "done", summary: "Feed charlie summary.", error: null, createdAt: NOW - 5 },
];

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const mount = (page, watches = WATCHES) =>
  page.evaluate(({ watches, events }) => {
    window.__WATCHES = watches.slice();
    window.__INVOKE_RESPONSES.watch_list = () => window.__WATCHES;
    window.__INVOKE_RESPONSES.watch_events_list = () => events;
    window.__INVOKE_RESPONSES.watch_delete = (a) => {
      window.__WATCHES = window.__WATCHES.filter((w) => w.id !== a.id);
    };
    window.__INVOKE_RESPONSES.watch_set_enabled = (a) => {
      window.__WATCHES = window.__WATCHES.map((w) => (w.id === a.id ? { ...w, enabled: a.enabled } : w));
    };
    window.__TEST_MOUNT("WatchPanel", {
      prompts: [{ id: "summarise-a-document", name: "Summarise a document" }],
      nameOfModel: (id) => ({ name: id === "gemma4-12b" ? "Balanced" : "Fast", detail: "" }),
    });
  }, { watches, events: EVENTS });

test("each watch's summaries sit under its own row, in order", async ({ page }) => {
  await mount(page);
  const root = page.locator("#test-root");
  await expect(root.getByText("Intake alpha summary.")).toBeVisible();
  await expect(root.getByText("Downloads bravo summary.")).toBeVisible();
  const text = await root.innerText();
  expect(text.indexOf("Intake alpha summary.")).toBeLessThan(text.indexOf("Downloads"));
  // A summary is named by its file, not by a path.
  await expect(root.locator('[data-watch-row="wi"] [data-watch-event]')).toContainText("Engagement letter.pdf");
});

test("a row says where it watches, with which template and model, in plain words", async ({ page }) => {
  await mount(page);
  const intake = page.locator('[data-watch-row="wi"] [data-watch-detail]');
  await expect(intake).toHaveText("Matters/Intake · Summarise a document · Balanced · Notifies");
  const downloads = page.locator('[data-watch-row="wd"] [data-watch-detail]');
  await expect(downloads).toHaveText("you/Downloads · Built-in summary · Fast");
  // No raw model id anywhere in the list.
  await expect(page.locator("[data-watch-panel]")).not.toContainText("gemma4");
});

test("clicking a watch's row folds just that section", async ({ page }) => {
  await mount(page);
  const root = page.locator("#test-root");
  await expect(root.getByText("Intake alpha summary.")).toBeVisible();
  await root.locator('[data-watch-row="wi"] [data-watch-name]').click();
  await expect(root.getByText("Intake alpha summary.")).toHaveCount(0);
  await expect(root.getByText("Downloads bravo summary.")).toBeVisible();
});

test("the switch on a row pauses and resumes the watch without folding it", async ({ page }) => {
  await mount(page);
  const sw = page.locator('[data-toggle="watch-on-wi"]');
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await page.waitForFunction(() => window.__INVOKE_FIND("watch_set_enabled", (a) => a.id === "wi" && a.enabled === false));
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Intake alpha summary.")).toBeVisible();
});

test("the pencil hands the watch to the form; the bin asks first", async ({ page }) => {
  await mount(page);
  await page.locator('[data-watch-row="wi"] [data-watch-edit]').click();
  await page.waitForFunction(() => (window.__TEST_CALLS.onEdit || 0) >= 1);
  await page.locator('[data-watch-row="wd"] [data-watch-delete]').click();
  await expect(page.getByText("Delete this watch?")).toBeVisible();
  expect(await page.evaluate(() => !!window.__INVOKE_FIND("watch_delete"))).toBe(false);
  await page.getByRole("button", { name: "Delete watch" }).click();
  await expect(page.locator('[data-watch-row="wd"]')).toHaveCount(0);
  await expect(page.locator('[data-watch-row="wi"]')).toHaveCount(1);
});

test("an old feed watch is not listed, only counted, and can be removed", async ({ page }) => {
  await mount(page, [...WATCHES, OLD_FEED]);
  const panel = page.locator("[data-watch-panel]");
  await expect(panel.locator("[data-watch-row]")).toHaveCount(2);
  await expect(panel).not.toContainText("HackerNews");
  await expect(panel).not.toContainText("Feed charlie summary.");
  const note = panel.locator("[data-watch-retired]");
  await expect(note).toContainText("1 watch of a feed or web page, set up in an earlier version, is no longer run.");
  await note.locator("[data-watch-retired-remove]").click();
  await page.waitForFunction(() => window.__INVOKE_FIND("watch_delete", (a) => a.id === "wf"));
  await expect(note).toHaveCount(0);
  // The folder watches are untouched.
  await expect(panel.locator("[data-watch-row]")).toHaveCount(2);
});

test("with only folder watches there is no note about old ones", async ({ page }) => {
  await mount(page);
  await expect(page.locator("[data-watch-panel]")).toBeVisible();
  await expect(page.locator("[data-watch-retired]")).toHaveCount(0);
});
