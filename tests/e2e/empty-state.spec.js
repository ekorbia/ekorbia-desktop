// Warm empty-chat state (ui/chat.jsx, Phase 4 UX polish). A newly-opened
// chat shows a time-of-day greeting and three starter cards that attach a
// matching library prompt (falling back to seeding text). Guards the render
// + the onStarter wiring.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

async function mountEmpty(page) {
  await page.evaluate(() => {
    window.__TEST_MOUNT("ChatPane", {
      chat: { id: "c1", title: "New chat", messages: [] },
      model: { id: "gemma4:12b", name: "gemma4:12b" },
      searchQuery: "",
      isStreaming: false,
    });
  });
}

test("renders a greeting and starter cards for an empty chat", async ({ page }) => {
  await mountEmpty(page);
  await expect(page.locator("#test-root")).toContainText(/Good (morning|afternoon|evening)/);
  const starters = page.locator("#test-root [data-empty-starter]");
  await expect(starters).toHaveCount(6);
  await expect(starters.first()).toContainText("Brainstorm");
  await expect(page.locator("#test-root")).toContainText("Translate to Spanish");
});

test("clicking a starter card invokes onStarter (attach prompt / seed fallback)", async ({ page }) => {
  await mountEmpty(page);
  await page.locator('#test-root [data-empty-starter]:has-text("Draft an email")').click();
  await page.waitForFunction(() => (window.__TEST_CALLS.onStarter || 0) >= 1);
  expect(await page.evaluate(() => window.__TEST_CALLS.onStarter)).toBeGreaterThanOrEqual(1);
});
