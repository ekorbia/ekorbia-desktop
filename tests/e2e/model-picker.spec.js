// Composer model picker (ui/overlays.jsx ModelPicker). Pins the Phase 2 UX
// polish: the group header is backend-aware ("Local models" vs "Models",
// no more hardcoded "· ollama"), and the ACTIVE model's row surfaces its
// capabilities in the subtitle ("… on disk · Supports: Tool use • Vision").

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test("active model row shows its capabilities in the subtitle", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.llm_list_models = () => ({
      models: [{ name: "gemma4:12b", size: 3300000000 }],
    });
    window.__TEST_MOUNT("ModelPicker", {
      active: "gemma4:12b",
      modelHasTools: true,
      modelHasVision: true,
    });
  });
  await expect(page.locator("#test-root")).toContainText(
    "Supports: Tool use • Vision",
  );
  await expect(page.locator("#test-root")).toContainText("on disk");
});

test("subtitle omits vision when the model only reports tools", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.llm_list_models = () => ({
      models: [{ name: "gemma4:12b", size: 3300000000 }],
    });
    window.__TEST_MOUNT("ModelPicker", {
      active: "gemma4:12b",
      modelHasTools: true,
      modelHasVision: false,
    });
  });
  await expect(page.locator("#test-root")).toContainText("Supports: Tool use");
  await expect(page.locator("#test-root")).not.toContainText("Vision");
});

test("header is backend-aware and drops the hardcoded 'ollama' jargon", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.llm_list_models = () => ({ models: [] });
    // Default mock backend is local Ollama → "Local models".
    window.__TEST_MOUNT("ModelPicker", { active: "" });
  });
  const picker = page.locator("[data-model-picker]");
  await expect(picker).toContainText(/Local models/i);
  await expect(picker).not.toContainText(/ollama/i);
});
