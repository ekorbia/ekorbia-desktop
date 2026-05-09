// Mount smokes for the OnboardingTour component.
//
// This file owns the Rules-of-Hooks regression test that the Phase 6
// blank-screen bug would have failed. Concretely: the bug was an
// `if (!open) return null;` placed BETWEEN useState and useEffect, so
// flipping `open` from false to true changed the number of hooks called
// during render and React's reconciler threw. The current implementation
// calls every hook unconditionally and gates effect bodies on `open` —
// that's what we lock in here.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test.describe("OnboardingTour", () => {
  test("open=false renders nothing", async ({ page }) => {
    await page.evaluate(() =>
      window.__TEST_MOUNT("OnboardingTour", { open: false })
    );
    // Component returns null when closed — test-root should be empty.
    const innerHtml = await page.evaluate(
      () => document.getElementById("test-root").innerHTML
    );
    expect(innerHtml).toBe("");
  });

  test("open=true renders the modal with at least one button", async ({ page }) => {
    await page.evaluate(() =>
      window.__TEST_MOUNT("OnboardingTour", { open: true })
    );
    // Modal mounts a backdrop + slide content. We don't assert on exact
    // copy (would couple to writing) — just that *something* visible
    // rendered. expect().toBeVisible() polls automatically so React's
    // async render is handled for us.
    await expect(page.locator("#test-root button").first()).toBeVisible();
  });

  test("REGRESSION: open false→true does not throw Rules-of-Hooks", async ({ page }) => {
    // The exact sequence that crashed Phase 6 the first time.
    //
    // Mount with open=false (1 hook call: useState), then re-render with
    // open=true (would-be hook count: 2 = useState + useEffect, if the
    // early return is misplaced). If the bug regresses, React throws
    // "Rendered more hooks than during the previous render" inside its
    // reconciler — page-level uncaught errors get surfaced by Playwright
    // as a test failure via the `pageerror` handler below.
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.evaluate(() =>
      window.__TEST_MOUNT("OnboardingTour", { open: false })
    );
    await page.evaluate(() =>
      window.__TEST_RERENDER("OnboardingTour", { open: true })
    );
    // Wait for React's commit phase + effects to flush. With Playwright's
    // locator auto-wait the button check itself is enough of a barrier,
    // but we want to specifically assert "no exceptions thrown" so a
    // small idle wait gives any synchronous error room to surface.
    await expect(page.locator("#test-root button").first()).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test("Escape key calls onClose", async ({ page }) => {
    await page.evaluate(() =>
      window.__TEST_MOUNT("OnboardingTour", { open: true })
    );
    await expect(page.locator("#test-root button").first()).toBeVisible();
    await page.keyboard.press("Escape");
    // The mount helper records each synthesised handler invocation on
    // window.__TEST_CALLS — see playwright.html.
    await expect.poll(
      () => page.evaluate(() => window.__TEST_CALLS.onClose || 0)
    ).toBeGreaterThan(0);
  });

  test("ArrowRight advances slides until the last one closes", async ({ page }) => {
    await page.evaluate(() =>
      window.__TEST_MOUNT("OnboardingTour", { open: true })
    );
    await expect(page.locator("#test-root button").first()).toBeVisible();

    // 5 slides — pressing ArrowRight from the last slide is the same as
    // pressing Enter on the "Done" button (it calls onClose). We don't
    // assert on exact slide count to avoid coupling; we just verify that
    // some number of presses eventually triggers onClose.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("ArrowRight");
      const closed = await page.evaluate(() => (window.__TEST_CALLS.onClose || 0) > 0);
      if (closed) return;
    }
    throw new Error("ArrowRight pressed 10 times without ever calling onClose");
  });
});
