// Capability badges: the TOOL chip next to the composer's model selector
// (ui/chat.jsx). Regression coverage for the Babel-var-hoisting bug where
// `activeModelHasTools` was computed ABOVE the `modelId` declaration in
// main.jsx — `const` downlevels to `var`, so instead of a TDZ crash the
// read silently evaluated `modelToolsMap[undefined]` and the chip stayed
// permanently dark from the day it shipped (see the CLAUDE.md gotcha).
// These smokes pin the Composer half of the chain: prop true → chip
// visible. The main.jsx half (map → prop ordering) can't mount in this
// harness; the gotcha comment + in-file NOTEs guard it.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test("TOOL chip renders next to the model selector when the model reports tools", async ({ page }) => {
  await page.evaluate(() => {
    window.__TEST_MOUNT("Composer", {
      model: { id: "gemma4:12b", name: "gemma4:12b" },
      isStreaming: false,
      modelHasTools: true,
    });
  });
  const chip = page.locator('#test-root span:has-text("TOOL")');
  await expect(chip).toBeVisible();
  // The chip is a state indicator with an explanatory tooltip.
  await expect(chip).toHaveAttribute("title", /tool use/i);
});

test("TOOL chip absent for a model without tools", async ({ page }) => {
  await page.evaluate(() => {
    window.__TEST_MOUNT("Composer", {
      model: { id: "tinyllama:1b", name: "tinyllama:1b" },
      isStreaming: false,
      modelHasTools: false,
    });
  });
  await expect(page.locator("#test-root")).toContainText("tinyllama:1b");
  await expect(page.locator("#test-root")).not.toContainText("TOOL");
});
