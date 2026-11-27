// Modal stacking contracts.
//
// Most stacking lives in App, but each modal's outermost element carries a
// documented z-index; these pin the values so a refactor that moves style
// declarations around cannot reorder them silently. (Settings 9998 sits
// over the first-run welcome at 9990; the setup gates are 9999.)

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
