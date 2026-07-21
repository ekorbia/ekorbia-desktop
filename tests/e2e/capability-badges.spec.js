// Capability badges: the TOOL chip next to the composer's model selector
// (ui/chat.jsx). Regression coverage for the Babel-var-hoisting bug where
// `activeModelHasTools` was computed ABOVE the `modelId` declaration in
// main.jsx — `const` downlevels to `var`, so instead of a TDZ crash the
// read silently evaluated `modelToolsMap[undefined]` and the chip stayed
// permanently dark from the day it shipped (see the CLAUDE.md gotcha).
//
// Phase 2 UX polish: capabilities now live on the model row inside the
// picker ("Supports: …", pinned by model-picker.spec.js). The explicit
// green TOOL chip renders in the composer ONLY when "Show technical
// details" is on; the resting composer shows no capability chrome. These
// smokes pin the prop-true chain (the regression guard). The main.jsx half
// (map → prop ordering) can't mount in this harness; the gotcha comment +
// in-file NOTEs guard it.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test("TOOL chip renders with details on when the model reports tools", async ({ page }) => {
  await page.evaluate(() => {
    window.__TEST_MOUNT("Composer", {
      model: { id: "gemma4:12b", name: "gemma4:12b" },
      isStreaming: false,
      modelHasTools: true,
      showDetails: true,
    });
  });
  const chip = page.locator('#test-root span:has-text("TOOL")');
  await expect(chip).toBeVisible();
  // The chip is a state indicator with an explanatory tooltip.
  await expect(chip).toHaveAttribute("title", /tool use/i);
});

test("composer shows no capability chrome by default (caps live in the picker)", async ({ page }) => {
  await page.evaluate(() => {
    window.__TEST_MOUNT("Composer", {
      model: { id: "gemma4:12b", name: "gemma4:12b" },
      isStreaming: false,
      modelHasTools: true,
      modelHasVision: true,
      // showDetails omitted → default off
    });
  });
  await expect(page.locator("#test-root")).not.toContainText("TOOL");
  // The old inline ⓘ affordance is gone — capabilities moved to the picker.
  await expect(page.locator("#test-root [data-model-caps-info]")).toHaveCount(0);
});

test("no TOOL chip for a model without tools, even with details on", async ({ page }) => {
  await page.evaluate(() => {
    window.__TEST_MOUNT("Composer", {
      model: { id: "tinyllama:1b", name: "tinyllama:1b" },
      isStreaming: false,
      modelHasTools: false,
      showDetails: true,
    });
  });
  await expect(page.locator("#test-root")).toContainText("tinyllama:1b");
  await expect(page.locator("#test-root")).not.toContainText("TOOL");
});
