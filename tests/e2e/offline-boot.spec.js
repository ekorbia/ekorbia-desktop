// Offline-boot regression test (Phase P0-1: vendored assets).
//
// Every third-party asset — React, ReactDOM, Babel-standalone, marked,
// highlight.js, DOMPurify, and the three font families — is vendored under
// ui/vendor/ so the app boots with ZERO network access beyond local Ollama.
// This spec enforces that two ways:
//
//   1. Dynamically: load the fixture with every non-localhost request
//      aborted (and recorded), then assert the page still boots fully and
//      that no external request was even ATTEMPTED.
//   2. Statically: scan ui/index.html and the fixture for http(s) URLs in
//      src/href attributes — the cheapest possible "someone reintroduced a
//      CDN tag" tripwire.
//
// If this file is red, the "runs fully offline" claim on the website is
// false. Fix the regression, don't loosen the test.

const { test, expect } = require("@playwright/test");

test.describe("offline boot (vendored assets)", () => {
  test("fixture boots fully with all external requests blocked", async ({ page }) => {
    const externalAttempts = [];
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
        return route.continue();
      }
      externalAttempts.push(url.href);
      return route.abort();
    });

    await page.goto("/tests/e2e/fixtures/playwright.html");
    await page.waitForFunction(() => window.__JSX_READY === true, null, {
      timeout: 10_000,
    });

    // Full boot: vendored production React + every library global present.
    const boot = await page.evaluate(() => ({
      reactVersion: window.React?.version,
      hasReactDOM: !!window.ReactDOM,
      hasMarked: !!window.marked,
      hasHljs: !!window.hljs,
      hasDOMPurify: !!window.DOMPurify,
      OnboardingTour: typeof window.OnboardingTour,
    }));
    expect(boot.reactVersion).toBe("18.3.1");
    expect(boot.hasReactDOM).toBe(true);
    expect(boot.hasMarked).toBe(true);
    expect(boot.hasHljs).toBe(true);
    expect(boot.hasDOMPurify).toBe(true);
    expect(boot.OnboardingTour).toBe("function");

    // A real component renders real text — not just "no exception thrown".
    await page.evaluate(() => window.__TEST_MOUNT("OnboardingTour", { open: true }));
    await expect(page.locator("#test-root")).toContainText("Welcome to Ekorbia");

    // Vendored fonts actually load (they're lazy — only fetched once
    // rendered text uses them, which the mount above guarantees).
    await page.evaluate(() => document.fonts.ready);
    const interLoaded = await page.evaluate(() =>
      Array.from(document.fonts).some(
        (f) => f.family.replace(/['"]/g, "") === "Inter" && f.status === "loaded"
      )
    );
    expect(interLoaded).toBe(true);

    // The headline assertion: nothing even tried to leave the machine.
    expect(externalAttempts).toEqual([]);
  });

  test("ui/index.html and the fixture reference no external URLs", async ({ page }) => {
    for (const path of ["/ui/index.html", "/tests/e2e/fixtures/playwright.html"]) {
      const resp = await page.request.get(path);
      const html = await resp.text();
      // src/href attributes pointing at http(s) — comments and prose may
      // mention URLs (e.g. vendor provenance notes); only attributes load.
      const externals = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(
        (m) => m[1]
      );
      expect(externals, `${path} must not load external resources`).toEqual([]);
    }
  });
});
