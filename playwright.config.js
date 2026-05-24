// Playwright config for the Ekorbia UI test suite.
//
// Strategy: serve the repo over a local HTTP server (so /ui/*.jsx +
// /tests/e2e/fixtures/* are accessible by absolute path), open
// /tests/e2e/fixtures/playwright.html in WebKit, and exercise components
// via window.__TEST_MOUNT + window.__TAURI__ mocks.
//
// Why not chromium? WebKit is the closest of Playwright's three browsers
// to the WKWebView that ships with Tauri on macOS. Same engine family
// (Apple WebKit upstream); same JIT; same DOM quirks. If a particular
// test ever needs Chromium it can override with `test.use({ browserName:
// 'chromium' })` locally, but the default should mirror production.
//
// Tauri WebDriver does NOT exist on macOS today, so there's no path to
// driving the real `cargo tauri dev` window here. We test the UI layer
// only; the Rust IPC layer is covered by `cargo test --lib`.

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  // Don't pick up the fixtures themselves as tests.
  testMatch: /.*\.spec\.js$/,
  // Per-test ceiling. Tests themselves run in <1s, but every beforeEach
  // does page.goto(fixture) which forces a fresh fetch of ~6 CDN scripts
  // (React, ReactDOM, Babel-standalone, marked, highlight.js, DOMPurify)
  // and Babel-standalone then compiles 16 .jsx files before __JSX_READY
  // fires. On GitHub Actions runners with cold caches and occasional
  // unpkg slowness, 10s was tight enough to flake ~30% of the suite.
  // 30s gives comfortable headroom without masking genuine hangs.
  timeout: 30_000,
  // One auto-retry under CI to handle the residual CDN-flake long tail.
  // Local runs get 0 retries — a flake on your machine is signal, not
  // noise. Set CI=true env var if you want to mirror CI locally.
  retries: process.env.CI ? 1 : 0,
  // Parallel by default but cap at 4 workers — each worker spawns its own
  // WebKit, and the components-on-window pattern means there's no shared
  // state to fight over.
  workers: 4,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    browserName: "webkit",
    baseURL: "http://localhost:18765",
    // Save a trace whenever a test fails. Open later with
    // `npx playwright show-trace test-results/<...>.zip`.
    trace: "retain-on-failure",
    // Headless by default; flip via `npm run test:ui:headed`.
    headless: true,
    // Reasonable viewport — most components style themselves against
    // these dimensions.
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    // python3 -m http.server roots wherever it's launched. We launch from
    // the repo root so /ui/* and /tests/e2e/* both resolve.
    command: "python3 -m http.server 18765",
    cwd: __dirname,
    port: 18765,
    // Reuse a running server when iterating locally (`python3 -m
    // http.server 18765 &` in another shell), spin up fresh in CI.
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 30_000,
  },
});
