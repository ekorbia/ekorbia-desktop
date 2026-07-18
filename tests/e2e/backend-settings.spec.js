// Settings → Backend (no-Ollama plan, Phase 1): backend picker, custom
// endpoint fields, test-connection flow, and the save invoke contract.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test("defaults to Ollama with endpoint fields hidden", async ({ page }) => {
  await page.evaluate(() => window.__TEST_MOUNT("BackendSettings", {}));
  const root = page.locator("#test-root");
  await expect(root).toContainText("Ollama (default)");
  await expect(root.locator("[data-backend-url]")).toHaveCount(0);
});

test("hydrates a saved custom-endpoint config", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.llm_backend_config_get = () => ({
      backend: "openai",
      baseUrl: "http://127.0.0.1:1234",
      apiKey: "sk-local",
    });
    window.__TEST_MOUNT("BackendSettings", {});
  });
  const url = page.locator("[data-backend-url]");
  await expect(url).toHaveValue("http://127.0.0.1:1234");
  await expect(page.locator("[data-backend-key]")).toHaveValue("sk-local");
});

test("switching to custom reveals fields; save sends the full config", async ({ page }) => {
  await page.evaluate(() => window.__TEST_MOUNT("BackendSettings", {}));
  await page.locator('[data-backend-option="openai"]').click();
  await page.locator("[data-backend-url]").fill("http://localhost:8080/v1");
  await page.locator("[data-backend-save]").click();
  await page.waitForFunction(() =>
    window.__INVOKE_FIND("llm_backend_config_set", (a) =>
      a.backendKind === "openai" && a.baseUrl === "http://localhost:8080/v1",
    ),
  );
});

test("test-connection reports reachable model count", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.llm_backend_test = () => ({ ok: true, models: 3, error: null });
    window.__TEST_MOUNT("BackendSettings", {});
  });
  await page.locator('[data-backend-option="openai"]').click();
  await page.locator("[data-backend-url]").fill("http://localhost:1234");
  await page.locator("[data-backend-test]").click();
  await expect(page.locator("[data-backend-test-result]")).toContainText("3 models");
});

test("save error from Rust surfaces inline", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.llm_backend_config_set = () => {
      throw new Error("A base URL is required for a custom endpoint");
    };
    window.__TEST_MOUNT("BackendSettings", {});
  });
  await page.locator('[data-backend-option="openai"]').click();
  await page.locator("[data-backend-save]").click();
  await expect(page.locator("[data-backend-save-error]")).toContainText("base URL is required");
});
