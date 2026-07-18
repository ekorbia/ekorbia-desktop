// Bundled engine backend (no-Ollama plan, Phase 2): Settings → Backend
// engine card, model-manager engine view, and the `status` stream
// event's placeholder rendering in Message.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test.describe("BackendSettings — engine card", () => {
  test("selecting the engine shows status, hides endpoint fields", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.engine_status = () => ({
        binaryOk: true,
        binaryPath: "/Applications/Ekorbia.app/Contents/MacOS/llama-server",
        binaryError: null,
        modelsDir: "/Users/me/Library/Application Support/com.ekorbia.desktop/models",
        modelCount: 2,
      });
      window.__TEST_MOUNT("BackendSettings", {});
    });
    await page.locator('[data-backend-option="engine"]').click();
    // No endpoint fields on the engine backend…
    await expect(page.locator("[data-backend-url]")).toHaveCount(0);
    // …but a live engine readout + the models folder.
    await expect(page.locator("[data-backend-engine-binary]")).toContainText(
      "Engine ready (2 models",
    );
    await expect(page.locator("[data-backend-engine-info]")).toContainText(
      "com.ekorbia.desktop/models",
    );
  });

  test("missing engine binary surfaces the fetch-script hint", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.engine_status = () => ({
        binaryOk: false,
        binaryPath: null,
        binaryError:
          "llama-server binary not found (tried: …). Run scripts/fetch-llama-server.sh once to build it.",
        modelsDir: "/tmp/models",
        modelCount: 0,
      });
      window.__TEST_MOUNT("BackendSettings", {});
    });
    await page.locator('[data-backend-option="engine"]').click();
    await expect(page.locator("[data-backend-engine-binary]")).toContainText(
      "fetch-llama-server.sh",
    );
  });

  test("reveal button opens the models folder; save needs no URL", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.engine_status = () => ({
        binaryOk: true,
        binaryPath: "/x/llama-server",
        binaryError: null,
        modelsDir: "/tmp/models",
        modelCount: 0,
      });
      window.__TEST_MOUNT("BackendSettings", {});
    });
    await page.locator('[data-backend-option="engine"]').click();
    await page.locator("[data-backend-engine-reveal]").click();
    await page.waitForFunction(() =>
      window.__INVOKE_FIND("engine_models_dir_reveal", () => true),
    );
    // Saving the engine backend must succeed with no base URL at all.
    await page.locator("[data-backend-save]").click();
    await page.waitForFunction(() =>
      window.__INVOKE_FIND(
        "llm_backend_config_set",
        (a) => a.backendKind === "engine" && !a.baseUrl,
      ),
    );
  });
});

test.describe("ModelManagerPanel — engine view", () => {
  test("hides pull/delete, shows folder hint + discovered ggufs", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.llm_backend_config_get = () => ({
        backend: "engine",
        baseUrl: null,
        apiKey: null,
      });
      window.__INVOKE_RESPONSES.engine_status = () => ({
        binaryOk: true,
        binaryPath: "/x/llama-server",
        binaryError: null,
        modelsDir: "/Users/me/models",
        modelCount: 2,
      });
      window.__INVOKE_RESPONSES.llm_list_models = () => ({
        models: [
          { name: "gemma-3-4b", model: "gemma-3-4b", size: 3200000000 },
          { name: "nomic-embed-text", model: "nomic-embed-text", size: 270000000 },
        ],
      });
      window.__TEST_MOUNT("ModelManagerPanel", { activeModel: "gemma-3-4b" });
    });
    const root = page.locator("#test-root");
    // Discovered models render from the dir scan…
    await expect(root).toContainText("gemma-3-4b");
    await expect(root).toContainText("nomic-embed-text");
    // …with the engine hint + reveal instead of Ollama affordances.
    await expect(page.locator("[data-engine-hint]")).toContainText("models folder");
    await expect(page.locator("[data-engine-reveal]")).toBeVisible();
    await expect(root).not.toContainText("Download a model");
    await expect(root.locator("button", { hasText: "Delete" })).toHaveCount(0);
  });
});

test.describe("Message — engine status placeholder", () => {
  test("statusText renders while streaming with no content", async ({ page }) => {
    await page.evaluate(() => {
      window.__TEST_MOUNT("Message", {
        m: {
          id: "a1",
          role: "assistant",
          content: "",
          streaming: true,
          statusText: "loading gemma-3-4b…",
        },
      });
    });
    await expect(page.locator("[data-stream-status]")).toContainText(
      "loading gemma-3-4b…",
    );
  });

  test("statusText is suppressed once content arrives", async ({ page }) => {
    await page.evaluate(() => {
      window.__TEST_MOUNT("Message", {
        m: {
          id: "a2",
          role: "assistant",
          content: "First tokens",
          streaming: true,
          statusText: "should not show",
        },
      });
    });
    await expect(page.locator("[data-stream-status]")).toHaveCount(0);
    await expect(page.locator("#test-root")).toContainText("First tokens");
  });
});
