// The first-run welcome (ui/onboarding.jsx): one screen, the four shortcuts.
//
// This file also owns the Rules-of-Hooks regression: an `if (!open) return
// null;` placed BETWEEN two hooks once changed the hook count when `open`
// flipped, and React refused to render (a blank app on first launch). Every
// hook must run on every render; the early return comes after them.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test.describe("OnboardingTour", () => {
  test("open=false renders nothing", async ({ page }) => {
    await page.evaluate(() => window.__TEST_MOUNT("OnboardingTour", { open: false }));
    const innerHtml = await page.evaluate(() => document.getElementById("test-root").innerHTML);
    expect(innerHtml).toBe("");
  });

  test("it is one screen: the four shortcuts and Continue", async ({ page }) => {
    await page.evaluate(() => window.__TEST_MOUNT("OnboardingTour", { open: true }));
    const box = page.locator("[data-onboarding]");
    await expect(box).toContainText("Welcome to Ekorbia");
    const rows = box.locator("[data-onboarding-shortcut]");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("Ask a quick question");
    await expect(rows.nth(1)).toContainText("Act on copied text");
    await expect(rows.nth(2)).toContainText("Dictate a question");
    await expect(rows.nth(3)).toContainText("Ask about part of the screen");
    // No slides to page through, and nothing about what was removed.
    await expect(box.getByRole("button")).toHaveCount(1);
    await expect(box.getByRole("button")).toHaveText("Continue");
    await expect(box).not.toContainText(/memory file|prompts library|themes|RSS|Space\b/i);
  });

  test("the keys shown are the ones in force, defaults unless changed", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("ekorbia.selection.hotkey", "Super+Alt+KeyJ");
      window.__TEST_MOUNT("OnboardingTour", { open: true });
    });
    const keys = (id) => page.locator(`[data-onboarding-shortcut="${id}"] [data-onboarding-keys]`);
    const shown = await page.evaluate(() => ({
      question: window.formatHotkey("Super+Shift+Space"),
      selection: window.formatHotkey("Super+Alt+KeyJ"),
      dictation: window.formatHotkey("Super+Shift+KeyV"),
      capture: window.formatHotkey("Super+Shift+Digit1"),
    }));
    for (const id of Object.keys(shown)) await expect(keys(id)).toHaveText(shown[id]);
    await page.evaluate(() => localStorage.removeItem("ekorbia.selection.hotkey"));
  });

  test("REGRESSION: open false→true does not throw Rules-of-Hooks", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await page.evaluate(() => window.__TEST_MOUNT("OnboardingTour", { open: false }));
    await page.evaluate(() => window.__TEST_RERENDER("OnboardingTour", { open: true }));
    await expect(page.locator("[data-onboarding-continue]")).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  for (const key of ["Escape", "Enter"]) {
    test(`${key} continues`, async ({ page }) => {
      await page.evaluate(() => window.__TEST_MOUNT("OnboardingTour", { open: true }));
      await expect(page.locator("[data-onboarding-continue]")).toBeVisible();
      await page.keyboard.press(key);
      await expect.poll(() => page.evaluate(() => window.__TEST_CALLS.onClose || 0)).toBeGreaterThan(0);
    });
  }

  test("Continue closes it", async ({ page }) => {
    await page.evaluate(() => window.__TEST_MOUNT("OnboardingTour", { open: true }));
    await page.locator("[data-onboarding-continue]").click();
    await expect.poll(() => page.evaluate(() => window.__TEST_CALLS.onClose || 0)).toBe(1);
  });
});
