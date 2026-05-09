// Smoke test for the Playwright harness itself. Verifies that:
//   • playwright.html loads under WebKit
//   • mock-tauri.js installed window.__TAURI__ + the test helpers
//   • Babel processed every text/babel script (window.__JSX_READY === true)
//   • the UI's domain globals (OnboardingTour, MarkdownMessage, etc.)
//     are on window by the time JSX is ready
//
// If this file is red, every other spec is going to be red. Fix this first.

const { test, expect } = require("@playwright/test");

test.describe("harness smoke", () => {
  test("playwright.html loads + JSX is ready", async ({ page }) => {
    await page.goto("/tests/e2e/fixtures/playwright.html");
    // __JSX_READY is set by the last text/babel script — meaning Babel
    // has finished processing every prior script in order, including the
    // JSX files. This is the reliable readiness signal.
    await page.waitForFunction(() => window.__JSX_READY === true, null, {
      timeout: 5_000,
    });
  });

  test("mock-tauri exposes invoke + event + helpers", async ({ page }) => {
    await page.goto("/tests/e2e/fixtures/playwright.html");
    await page.waitForFunction(() => window.__JSX_READY === true);

    const surface = await page.evaluate(() => ({
      hasInvokeCore: typeof window.__TAURI__?.core?.invoke === "function",
      hasInvokeTauri: typeof window.__TAURI__?.tauri?.invoke === "function",
      hasListen: typeof window.__TAURI__?.event?.listen === "function",
      hasInvokeFind: typeof window.__INVOKE_FIND === "function",
      hasMount: typeof window.__TEST_MOUNT === "function",
    }));
    expect(surface).toEqual({
      hasInvokeCore: true,
      hasInvokeTauri: true,
      hasListen: true,
      hasInvokeFind: true,
      hasMount: true,
    });
  });

  test("production components are on window after JSX loads", async ({ page }) => {
    await page.goto("/tests/e2e/fixtures/playwright.html");
    await page.waitForFunction(() => window.__JSX_READY === true);

    const exposed = await page.evaluate(() => ({
      OnboardingTour: typeof window.OnboardingTour,
      MarkdownMessage: typeof window.MarkdownMessage,
      // Pure helpers from utils.js
      formatHotkey: typeof window.formatHotkey,
      parseFencedBlocks: typeof window.parseFencedBlocks,
    }));
    expect(exposed).toEqual({
      OnboardingTour: "function",
      MarkdownMessage: "function",
      formatHotkey: "function",
      parseFencedBlocks: "function",
    });
  });
});
