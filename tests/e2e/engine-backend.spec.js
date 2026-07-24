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

// Shared mocks for the engine-backend model manager (Phase 3 catalog).
const mountEngineManager = (overrides) =>
  `(() => {
    window.__INVOKE_RESPONSES.llm_backend_config_get = () => ({
      backend: "engine", baseUrl: null, apiKey: null,
    });
    window.__INVOKE_RESPONSES.engine_status = () => ({
      binaryOk: true, binaryPath: "/x/llama-server", binaryError: null,
      modelsDir: "/Users/me/models", modelCount: 1,
    });
    window.__INVOKE_RESPONSES.system_profile = () => ({
      totalRamBytes: 16 * 1073741824,
    });
    window.__INVOKE_RESPONSES.engine_catalog = () => ({
      version: 1,
      models: [
        { id: "gemma4-12b", label: "Gemma 4 12B", blurb: "Daily driver",
          purpose: "chat", recommended: true, minRamGb: 16,
          caps: { vision: true, tools: true }, license: "apache-2.0",
          source: "google/x", totalBytes: 7160000000, installed: false,
          files: [] },
        { id: "gemma4-26b-a4b", label: "Gemma 4 26B (A4B)", blurb: "Power option",
          purpose: "chat", recommended: false, minRamGb: 32,
          caps: { vision: true, tools: true }, license: "apache-2.0",
          source: "ggml-org/x", totalBytes: 15430000000, installed: false,
          files: [] },
        { id: "nomic-embed-text", label: "Nomic Embed Text v1.5", blurb: "RAG",
          purpose: "embed", recommended: false, minRamGb: 8,
          caps: { vision: false, tools: false }, license: "apache-2.0",
          source: "nomic-ai/x", totalBytes: 274000000, installed: true,
          files: [] },
      ],
    });
    window.__INVOKE_RESPONSES.llm_list_models = () => ({
      models: [{ name: "nomic-embed-text", model: "nomic-embed-text", size: 274000000 }],
    });
    ${overrides || ""}
    window.__TEST_MOUNT("ModelManagerPanel", { activeModel: "gemma4-12b" });
  })()`;

test.describe("ModelManagerPanel — engine view", () => {
  test("hides Ollama pull box, shows folder hint + discovered ggufs", async ({ page }) => {
    await page.evaluate(mountEngineManager());
    const root = page.locator("#test-root");
    // Discovered models render from the dir scan…
    await expect(root).toContainText("nomic-embed-text");
    // …with the engine hint + reveal instead of the Ollama pull box.
    await expect(page.locator("[data-engine-hint]")).toContainText("models folder");
    await expect(page.locator("[data-engine-reveal]")).toBeVisible();
    await expect(root).not.toContainText("Download a model");
    await expect(root).not.toContainText("ollama.com/library");
  });

  test("catalog renders states: download, installed, RAM warning, chips", async ({ page }) => {
    await page.evaluate(mountEngineManager());
    const root = page.locator("#test-root");
    await expect(root).toContainText("Model catalog");
    // Fits-in-RAM chat model → plain Download button, recommended chip.
    await expect(page.locator('[data-catalog-download="gemma4-12b"]')).toBeVisible();
    await expect(page.locator('[data-catalog-model="gemma4-12b"]')).toContainText("recommended");
    // 32 GB model on a 16 GB machine → amber RAM warning (still downloadable).
    const big = page.locator('[data-catalog-model="gemma4-26b-a4b"]');
    await expect(big.locator("[data-catalog-ram-warning]")).toContainText("32 GB");
    await expect(page.locator('[data-catalog-download="gemma4-26b-a4b"]')).toBeVisible();
    // Installed embed model → ✓ + embeddings chip, no Download button.
    const nomic = page.locator('[data-catalog-model="nomic-embed-text"]');
    await expect(nomic.locator("[data-catalog-installed]")).toContainText("installed");
    await expect(nomic).toContainText("embeddings");
    await expect(page.locator('[data-catalog-download="nomic-embed-text"]')).toHaveCount(0);
  });

  test("catalog Download invokes engine_download with the model id", async ({ page }) => {
    await page.evaluate(
      mountEngineManager(`
        window.__INVOKE_RESPONSES.engine_download = () => null;
      `),
    );
    await page.locator('[data-catalog-download="gemma4-12b"]').click();
    await page.waitForFunction(() =>
      window.__INVOKE_FIND(
        "engine_download",
        (a) => a.modelId === "gemma4-12b" && /^dl:gemma4-12b:/.test(a.requestId),
      ),
    );
  });

  test("custom GGUF row invokes engine_download_custom", async ({ page }) => {
    await page.evaluate(
      mountEngineManager(`
        window.__INVOKE_RESPONSES.engine_download_custom = () => null;
      `),
    );
    await page.locator("[data-custom-gguf-url]").fill("https://huggingface.co/x/y/resolve/main/m.gguf");
    await page.locator("[data-custom-gguf-name]").fill("my-model");
    await page.locator("[data-custom-gguf-download]").click();
    await page.waitForFunction(() =>
      window.__INVOKE_FIND(
        "engine_download_custom",
        (a) => a.name === "my-model" && a.url.startsWith("https://huggingface.co/"),
      ),
    );
  });

  test("Delete on an engine model invokes engine_model_delete", async ({ page }) => {
    await page.evaluate(
      mountEngineManager(`
        window.__INVOKE_RESPONSES.engine_model_delete = () => null;
      `),
    );
    await page.locator("button", { hasText: "Delete" }).first().click();
    // ConfirmDialog → engine-specific copy → confirm.
    await expect(page.locator("#test-root")).toContainText("models folder");
    await page.locator("button", { hasText: /^Delete$/ }).last().click();
    await page.waitForFunction(() =>
      window.__INVOKE_FIND("engine_model_delete", (a) => a.name === "nomic-embed-text"),
    );
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

  test("generic Thinking label shows while streaming with no engine status", async ({ page }) => {
    await page.evaluate(() => {
      window.__TEST_MOUNT("Message", {
        m: { id: "a3", role: "assistant", content: "", streaming: true },
      });
    });
    // No statusText → the rotating reassurance label, starting at "Thinking…".
    await expect(page.locator("[data-stream-status]")).toContainText("Thinking");
  });
});
