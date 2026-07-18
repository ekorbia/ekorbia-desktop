// Guided first-run flow in OllamaGate (ui/overlays.jsx).
//
// When Ollama is running but no model is pulled, the gate detects RAM via
// system_profile, recommends a right-sized Gemma 4, and pulls it in-app
// (reusing the model-manager pull machinery) — instead of the old
// "run `ollama pull` in a terminal" dead end.

const { test, expect } = require("@playwright/test");

const GiB = 1024 * 1024 * 1024;

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test("recommends e4b on a 16 GB machine and offers to set it up", async ({ page }) => {
  await page.evaluate((bytes) => {
    window.__INVOKE_RESPONSES.llm_list_models = () => ({ models: [] }); // no models → no-model
    window.__INVOKE_RESPONSES.system_profile = () => ({
      totalRamBytes: bytes, platform: "macos", arch: "aarch64",
    });
    window.__TEST_MOUNT("OllamaGate", { open: true, modelId: "gemma4:latest" });
  }, 16 * GiB);

  const root = page.locator("#test-root");
  await expect(root).toContainText("gemma4:e4b");
  await expect(root).toContainText("Download and set up");
  // No scary warning on a comfortable machine.
  await expect(root).not.toContainText("Limited memory");
});

test("recommends e2b with a low-RAM warning on a 4 GB machine", async ({ page }) => {
  await page.evaluate((bytes) => {
    window.__INVOKE_RESPONSES.llm_list_models = () => ({ models: [] });
    window.__INVOKE_RESPONSES.system_profile = () => ({
      totalRamBytes: bytes, platform: "macos", arch: "aarch64",
    });
    window.__TEST_MOUNT("OllamaGate", { open: true, modelId: "gemma4:latest" });
  }, 4 * GiB);

  const root = page.locator("#test-root");
  await expect(root).toContainText("gemma4:e2b");
  await expect(root).toContainText("Limited memory");
});

test("not-running phase shows an Install Ollama link", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.llm_list_models = () => { throw new Error("connection refused"); };
    window.__TEST_MOUNT("OllamaGate", { open: true, modelId: "gemma4:latest" });
  });
  const root = page.locator("#test-root");
  await expect(root).toContainText("Ollama is not running");
  await expect(root).toContainText("Install it");
});

test("starting Ollama with no models routes to the guided card, not a dead-end", async ({ page }) => {
  // Regression: the 'Start Ollama' path used to setPhase('no-model')
  // directly, which (after the guided rework) had no body and no buttons —
  // trapping the user in an undismissable modal titled "no-model".
  await page.evaluate((bytes) => {
    let started = false;
    window.__INVOKE_RESPONSES.start_ollama = () => { started = true; return undefined; };
    // Connection refused until "started", then running but model-less.
    window.__INVOKE_RESPONSES.llm_list_models = () => {
      if (!started) throw new Error("connection refused");
      return { models: [] };
    };
    window.__INVOKE_RESPONSES.system_profile = () => ({
      totalRamBytes: bytes, platform: "macos", arch: "aarch64",
    });
    window.__TEST_MOUNT("OllamaGate", { open: true, modelId: "qwen3.5:2b" });
  }, 16 * GiB);

  const root = page.locator("#test-root");
  await expect(root).toContainText("Ollama is not running");
  await page.locator("#test-root button", { hasText: "Start Ollama" }).click();

  // Lands on the guided recommend card — with actions — not a dead end.
  await expect(root).toContainText("Download and set up");
  await expect(root).toContainText("gemma4:e4b");
  await expect(root).not.toContainText("no-model");
});

test("Escape dismisses the gate (safety net)", async ({ page }) => {
  await page.evaluate((bytes) => {
    window.__INVOKE_RESPONSES.llm_list_models = () => ({ models: [] });
    window.__INVOKE_RESPONSES.system_profile = () => ({
      totalRamBytes: bytes, platform: "macos", arch: "aarch64",
    });
    window.__TEST_MOUNT("OllamaGate", { open: true, modelId: "gemma4:latest" });
  }, 16 * GiB);

  await expect(page.locator("#test-root")).toContainText("Download and set up");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => (window.__TEST_CALLS.onDismiss || 0) >= 1);
});

test("Download and set up pulls the model and reports it installed", async ({ page }) => {
  await page.evaluate((bytes) => {
    window.__INVOKE_RESPONSES.llm_list_models = () => ({ models: [] });
    window.__INVOKE_RESPONSES.system_profile = () => ({
      totalRamBytes: bytes, platform: "macos", arch: "aarch64",
    });
    // Hold the pull open so we can drive progress, then resolve it.
    window.__INVOKE_RESPONSES.ollama_pull = (args) => {
      window.__PULL_CH = args.onProgress;
      return new Promise((res) => { window.__PULL_RES = res; });
    };
    window.__TEST_MOUNT("OllamaGate", { open: true, modelId: "gemma4:latest" });
  }, 16 * GiB);

  const root = page.locator("#test-root");
  await expect(root).toContainText("gemma4:e4b");

  // Keep it to a single pull: skip the embedding model.
  await page.locator('#test-root input[type="checkbox"]').uncheck();
  await page.locator("#test-root button", { hasText: "Download and set up" }).click();

  // The recommended chat model is what gets pulled.
  await page.waitForFunction(() =>
    window.__INVOKE_FIND("ollama_pull", (a) => a.model === "gemma4:e4b")
  );

  // Progress renders, then completion drives onModelInstalled.
  await page.evaluate(() => {
    window.__PULL_CH.__deliver({ status: "pulling", digest: "a", total: 100, completed: 50 });
  });
  await expect(root).toContainText("50%");

  await page.evaluate(() => {
    window.__PULL_CH.__deliver({ status: "success" });
    // The model now appears in Ollama — isModelInstalled() (the source of
    // truth the gate verifies against) must see it before we resolve.
    window.__INVOKE_RESPONSES.llm_list_models = () => ({ models: [{ name: "gemma4:e4b" }] });
    window.__PULL_RES();
  });
  await page.waitForFunction(() => (window.__TEST_CALLS.onModelInstalled || 0) >= 1);
});

test("a pull that doesn't actually install the model shows a visible error", async ({ page }) => {
  // Regression: a failed pull used to bounce silently back to the card with
  // no explanation (errorMsg was only rendered in the 'error' phase). Now
  // the gate verifies against llm_list_models and surfaces the failure.
  await page.evaluate((bytes) => {
    window.__INVOKE_RESPONSES.system_profile = () => ({
      totalRamBytes: bytes, platform: "macos", arch: "aarch64",
    });
    window.__INVOKE_RESPONSES.llm_list_models = () => ({ models: [] }); // never installs
    // Pull "succeeds" at the stream level but the model never lands.
    window.__INVOKE_RESPONSES.ollama_pull = (args) => {
      args.onProgress.__deliver({ status: "success" });
      return undefined;
    };
    window.__TEST_MOUNT("OllamaGate", { open: true, modelId: "gemma4:latest" });
  }, 16 * GiB);

  const root = page.locator("#test-root");
  await expect(root).toContainText("Download and set up");
  await page.locator('#test-root input[type="checkbox"]').uncheck();
  await page.locator("#test-root button", { hasText: "Download and set up" }).click();

  // Visible error on the card — not a blank reappear — and no false success.
  await expect(root).toContainText("Couldn't download");
  await expect(root).toContainText("Download and set up");
  const installed = await page.evaluate(() => window.__TEST_CALLS.onModelInstalled || 0);
  expect(installed).toBe(0);
});
