// Modal + keyboard interaction smokes (Ring 3 — D4).
//
// Scope-limited because most modal stacking lives in the App component
// in main.jsx — mounting App in isolation is impractical (it pulls in
// every effect that talks to Tauri). What we CAN test cheaply:
//   1. Each modal's outermost element carries the documented z-index
//      so the stacking order is preserved if a future refactor moves
//      style declarations around.
//   2. Click-through: clicking "Next" in OnboardingTour advances slides;
//      clicking "Done" on the last slide calls onClose.
//
// The full visual stacking test (OllamaGate 9999 over Settings 9998 over
// Onboarding 9990) is left to manual verification — it's a CSS+DOM
// interaction we'd need a real App mount to exercise.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test.describe("modal z-index contracts", () => {
  test("OnboardingTour root has zIndex 9990", async ({ page }) => {
    await page.evaluate(() =>
      window.__TEST_MOUNT("OnboardingTour", { open: true })
    );
    // The component's outermost rendered div has position:fixed + zIndex.
    // Querying through getComputedStyle is more honest than reading the
    // React element tree — if any ancestor wrapper drops the z-index
    // (e.g. stacking-context bug) we catch it.
    const zIndex = await page
      .locator("#test-root > div")
      .first()
      .evaluate((el) => window.getComputedStyle(el).zIndex);
    expect(zIndex).toBe("9990");
  });

  // Settings is harder to mount in isolation (depends on lots of state).
  // We assert on the SOURCE instead: the zIndex value must be 9998 and
  // strictly greater than the OnboardingTour value. If either drifts,
  // this test fires before runtime stacking goes wrong.
  test("Settings declares a higher zIndex than OnboardingTour in source", async ({ page }) => {
    const res = await page.request.fetch("/ui/settings.jsx");
    const settingsSrc = await res.text();
    const onbRes = await page.request.fetch("/ui/onboarding.jsx");
    const onbSrc = await onbRes.text();

    // Capture the first numeric zIndex literal in each file. Both files
    // use the camelCase `zIndex:` property (inline-style React shape).
    const settingsZ = parseInt(settingsSrc.match(/zIndex:\s*(\d+)/)[1], 10);
    const onbZ = parseInt(onbSrc.match(/zIndex:\s*(\d+)/)[1], 10);

    expect(settingsZ).toBe(9998);
    expect(onbZ).toBe(9990);
    expect(settingsZ).toBeGreaterThan(onbZ);
  });
});

test.describe("OnboardingTour navigation by click", () => {
  test("clicking Next 4× then Done calls onClose exactly once", async ({ page }) => {
    await page.evaluate(() =>
      window.__TEST_MOUNT("OnboardingTour", { open: true })
    );

    // 5 slides. The button text changes from "Next" → ... → "Done" on
    // the last slide. We click the *last* visible button each time
    // (the modal has Skip + Next; Skip is leftmost). The "Next" / "Done"
    // button is always the rightmost in the toolbar.
    for (let i = 0; i < 5; i++) {
      // Find a button matching either "Next" or "Done" / "Got it" /
      // "Get started" — onboarding copy varies, so be flexible.
      const next = page
        .locator("#test-root button")
        .filter({ hasText: /next|done|got it|get started/i })
        .last();
      await next.click();
      const closed = await page.evaluate(() => (window.__TEST_CALLS.onClose || 0) > 0);
      if (closed) break;
    }
    const closed = await page.evaluate(() => window.__TEST_CALLS.onClose || 0);
    expect(closed).toBe(1);
  });

  test("Skip button (if present) calls onClose immediately", async ({ page }) => {
    await page.evaluate(() =>
      window.__TEST_MOUNT("OnboardingTour", { open: true })
    );

    // Find a "Skip" button if the component exposes one. If it doesn't,
    // skip the test rather than fail — onboarding copy is editorial,
    // not a hard contract.
    const skip = page
      .locator("#test-root button")
      .filter({ hasText: /skip/i })
      .first();
    if ((await skip.count()) === 0) {
      test.skip(true, "OnboardingTour does not expose a Skip button");
    }
    await skip.click();
    await expect.poll(() =>
      page.evaluate(() => window.__TEST_CALLS.onClose || 0)
    ).toBe(1);
  });
});
