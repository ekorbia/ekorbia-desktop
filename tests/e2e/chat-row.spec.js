// Sidebar chat row (ui/shell.jsx ChatRow), Phase 4 6b. Rows are Bear-style
// two-line cards: title + relative time on top, a one-line message preview
// below. The preview line is absent when the chat has none.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test("renders title, relative time, and the message preview", async ({ page }) => {
  await page.evaluate(() => {
    window.__TEST_MOUNT("ChatRow", {
      chat: {
        id: "c1",
        title: "Q3 board notes",
        when: "2m",
        preview: "Flagged three risks; revenue concentration…",
      },
      query: "",
    });
  });
  const root = page.locator("#test-root");
  await expect(root).toContainText("Q3 board notes");
  await expect(root).toContainText("2m");
  await expect(root).toContainText("Flagged three risks");
});

test("omits the preview line when the chat has no messages", async ({ page }) => {
  await page.evaluate(() => {
    window.__TEST_MOUNT("ChatRow", {
      chat: { id: "c2", title: "New chat", when: "now", preview: null },
      query: "",
    });
  });
  const root = page.locator("#test-root");
  await expect(root).toContainText("New chat");
  await expect(root).toContainText("now");
  // No stray preview text.
  await expect(root).not.toContainText("…");
});
