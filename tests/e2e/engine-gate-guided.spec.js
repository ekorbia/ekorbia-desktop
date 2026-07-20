// Guided first-run flow in EngineGate (ui/overlays.jsx, Phase 5).
//
// The bundled-engine counterpart to OllamaGate: there's no external process
// to install/start, so the gate just asks "do you have a model?" — reads RAM
// via system_profile, recommends a right-sized model from the ENGINE catalog,
// and downloads it in-app via engine_download. Distinguishes chat vs embed
// installs so a lone nomic-embed-text never reads as "ready".

const { test, expect } = require("@playwright/test");

const GiB = 1024 * 1024 * 1024;

// Mirrors the engine_catalog payload shape (floors from catalog.json).
const CATALOG = [
  { id: "gemma4-e2b", label: "Gemma 4 E2B", purpose: "chat", minRamGb: 8, totalBytes: 4.3e9, caps: { vision: true }, recommended: false, installed: false },
  { id: "gemma4-e4b", label: "Gemma 4 E4B", purpose: "chat", minRamGb: 8, totalBytes: 6.1e9, caps: { vision: true }, recommended: false, installed: false },
  { id: "gemma4-12b", label: "Gemma 4 12B", purpose: "chat", minRamGb: 16, totalBytes: 7.2e9, caps: { vision: true }, recommended: true, installed: false },
  { id: "gemma4-26b-a4b", label: "Gemma 4 26B-A4B", purpose: "chat", minRamGb: 32, totalBytes: 15.4e9, caps: { vision: true }, recommended: false, installed: false },
  { id: "nomic-embed-text", label: "Nomic Embed", purpose: "embed", minRamGb: 8, totalBytes: 0.27e9, caps: { vision: false }, recommended: false, installed: false },
];

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

// Base mocks: engine present, catalog available, RAM detectable, nothing
// installed. Individual tests override as needed.
async function mountEngineGate(page, { ram = 32 * GiB, installed = [], modelId = "gemma4:latest" } = {}) {
  await page.evaluate(
    ({ catalog, ram, installed, modelId }) => {
      window.__INVOKE_RESPONSES.engine_status = () => ({ binaryOk: true, binaryError: null });
      // Real shape: engine_catalog returns { version, models: [...] }.
      window.__INVOKE_RESPONSES.engine_catalog = () => ({ version: 1, models: catalog });
      window.__INVOKE_RESPONSES.system_profile = () => ({ totalRamBytes: ram, platform: "macos", arch: "aarch64" });
      window.__INVOKE_RESPONSES.llm_list_models = () => ({ models: installed.map((n) => ({ name: n })) });
      window.__TEST_MOUNT("EngineGate", { open: true, modelId });
    },
    { catalog: CATALOG, ram, installed, modelId },
  );
}

test("recommends the 12B on a 20 GB machine (largest that fits) and offers setup", async ({ page }) => {
  // 26B-A4B's floor is 32 GB, so on 20 GB the largest that fits is the 12B.
  await mountEngineGate(page, { ram: 20 * GiB });
  const root = page.locator("#test-root");
  await expect(root).toContainText("Gemma 4 12B");
  await expect(root).toContainText("Download and set up");
  await expect(root).toContainText("👁 vision");
  await expect(root).not.toContainText("Limited memory");
});

test("recommends the smallest with a low-RAM warning on a 4 GB machine", async ({ page }) => {
  await mountEngineGate(page, { ram: 4 * GiB });
  const root = page.locator("#test-root");
  await expect(root).toContainText("Gemma 4 E2B");
  await expect(root).toContainText("Limited memory");
});

test("a lone embedding model does NOT read as ready — still recommends a chat model", async ({ page }) => {
  // Regression guard for the chat-vs-embed distinction: nomic-embed-text is
  // installed but it's not a chat model, so the gate must still guide a
  // chat-model download rather than closing as "ready".
  await mountEngineGate(page, { ram: 32 * GiB, installed: ["nomic-embed-text"] });
  const root = page.locator("#test-root");
  await expect(root).toContainText("Download and set up");
  const calls = await page.evaluate(() => ({
    ready: window.__TEST_CALLS.onReady || 0,
    installed: window.__TEST_CALLS.onModelInstalled || 0,
  }));
  expect(calls.ready).toBe(0);
  expect(calls.installed).toBe(0);
});

test("an installed chat model that IS active → onReady", async ({ page }) => {
  await mountEngineGate(page, { installed: ["gemma4-12b"], modelId: "gemma4-12b" });
  await page.waitForFunction(() => (window.__TEST_CALLS.onReady || 0) >= 1);
});

test("an installed chat model that is NOT active → switches to it", async ({ page }) => {
  // A stale Ollama-style default (gemma4:latest) that isn't on the engine
  // heals to an installed model rather than trapping the user.
  await mountEngineGate(page, { installed: ["gemma4-12b"], modelId: "gemma4:latest" });
  await page.waitForFunction(() => (window.__TEST_CALLS.onModelInstalled || 0) >= 1);
});

test("no-binary phase when the engine sidecar is absent (dev build)", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.engine_status = () => ({
      binaryOk: false,
      binaryError: "llama-server binary not found. Run scripts/fetch-llama-server.sh once to build it.",
    });
    window.__TEST_MOUNT("EngineGate", { open: true, modelId: "gemma4:latest" });
  });
  const root = page.locator("#test-root");
  await expect(root).toContainText("Engine unavailable");
  await expect(root).toContainText("Settings → Backend");
});

test("Escape dismisses the gate (safety net)", async ({ page }) => {
  await mountEngineGate(page, { ram: 16 * GiB });
  await expect(page.locator("#test-root")).toContainText("Download and set up");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => (window.__TEST_CALLS.onDismiss || 0) >= 1);
});

test("Download and set up calls engine_download for the recommended catalog id", async ({ page }) => {
  await page.evaluate(
    ({ catalog, ram }) => {
      window.__INVOKE_RESPONSES.engine_status = () => ({ binaryOk: true, binaryError: null });
      // Real shape: engine_catalog returns { version, models: [...] }.
      window.__INVOKE_RESPONSES.engine_catalog = () => ({ version: 1, models: catalog });
      window.__INVOKE_RESPONSES.system_profile = () => ({ totalRamBytes: ram, platform: "macos", arch: "aarch64" });
      window.__INVOKE_RESPONSES.llm_list_models = () => ({ models: [] });
      // Hold the download open so we can drive progress + completion.
      window.__INVOKE_RESPONSES.engine_download = (args) => {
        window.__PULL_CH = args.onProgress;
        return new Promise((res) => { window.__PULL_RES = res; });
      };
      window.__TEST_MOUNT("EngineGate", { open: true, modelId: "gemma4:latest" });
    },
    { catalog: CATALOG, ram: 20 * GiB },
  );

  const root = page.locator("#test-root");
  await expect(root).toContainText("Gemma 4 12B");
  // Single download: skip the embedding model.
  await page.locator('#test-root input[type="checkbox"]').uncheck();
  await page.locator("#test-root button", { hasText: "Download and set up" }).click();

  // The engine (catalog) id — not an Ollama tag — is what gets downloaded.
  await page.waitForFunction(() =>
    window.__INVOKE_FIND("engine_download", (a) => a.modelId === "gemma4-12b"),
  );

  await page.evaluate(() => {
    window.__PULL_CH.__deliver({ status: "pulling", digest: "a", total: 100, completed: 50 });
  });
  await expect(root).toContainText("50%");

  await page.evaluate(() => {
    window.__PULL_CH.__deliver({ status: "success" });
    window.__INVOKE_RESPONSES.llm_list_models = () => ({ models: [{ name: "gemma4-12b" }] });
    window.__PULL_RES();
  });
  await page.waitForFunction(() => (window.__TEST_CALLS.onModelInstalled || 0) >= 1);
});

// ── EngineMigrationOffer ──────────────────────────────────────────────────

test.describe("EngineMigrationOffer", () => {
  test("Keep Ollama fires onKeepOllama", async ({ page }) => {
    await page.evaluate(() => window.__TEST_MOUNT("EngineMigrationOffer", { open: true }));
    const root = page.locator("#test-root");
    await expect(root).toContainText("Ekorbia can run models itself now");
    await page.locator("#test-root button", { hasText: "Keep Ollama" }).click();
    await page.waitForFunction(() => (window.__TEST_CALLS.onKeepOllama || 0) >= 1);
  });

  test("Switch to bundled engine fires onSwitchToEngine", async ({ page }) => {
    await page.evaluate(() => window.__TEST_MOUNT("EngineMigrationOffer", { open: true }));
    await page.locator("#test-root button", { hasText: "Switch to bundled engine" }).click();
    await page.waitForFunction(() => (window.__TEST_CALLS.onSwitchToEngine || 0) >= 1);
  });

  test("Escape fires onDismiss", async ({ page }) => {
    await page.evaluate(() => window.__TEST_MOUNT("EngineMigrationOffer", { open: true }));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => (window.__TEST_CALLS.onDismiss || 0) >= 1);
  });
});
