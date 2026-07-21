// Progressive disclosure of the assistant message footer (Phase 2 UX
// polish, ui/chat.jsx Message). By default the token/timing footer is
// collapsed to a quiet "Details ›" affordance that reveals it for THAT
// message on click; with the "Show technical details" pref on, the footer
// renders inline. Pins that the details are hidden-by-default but never
// buried (one click away).

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const ASSISTANT_MSG = {
  id: "a1",
  role: "assistant",
  content: "Here is the answer.",
  model: "gemma4:12b",
  tokens: { in: 12, out: 34, ms: 2300 },
};

test("footer is collapsed to a Details toggle by default", async ({ page }) => {
  await page.evaluate((m) => {
    window.__TEST_MOUNT("Message", { m });
  }, ASSISTANT_MSG);
  // Token/timing footer hidden at rest…
  await expect(page.locator("#test-root [data-message-footer]")).toHaveCount(0);
  await expect(page.locator("#test-root")).not.toContainText("tok");
  // …behind a quiet reveal that expands THIS message's footer on click.
  const toggle = page.locator("#test-root [data-message-details-toggle]");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator("#test-root [data-message-footer]")).toBeVisible();
  await expect(page.locator("#test-root [data-message-tokens]")).toContainText(
    "12/34 tok",
  );
});

test("footer renders inline when Show technical details is on", async ({ page }) => {
  await page.evaluate((m) => {
    window.__TEST_MOUNT("Message", { m, showDetails: true });
  }, ASSISTANT_MSG);
  await expect(page.locator("#test-root [data-message-footer]")).toBeVisible();
  await expect(page.locator("#test-root [data-message-tokens]")).toContainText(
    "12/34 tok",
  );
  // No redundant toggle when everything is already shown.
  await expect(
    page.locator("#test-root [data-message-details-toggle]"),
  ).toHaveCount(0);
});
