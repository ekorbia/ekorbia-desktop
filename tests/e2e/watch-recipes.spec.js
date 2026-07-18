// Watch recipes: the gallery, the picker modal, and recipe → WatchModal
// pre-fill (ui/watch.jsx).

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test("recipe gallery renders every recipe card", async ({ page }) => {
  await page.evaluate(() => window.__TEST_MOUNT("RecipeGallery", {}));
  const root = page.locator("#test-root");
  for (const label of [
    "Summarise new downloads",
    "Watch a price",
    "Watch job listings",
    "Follow a blog",
    "Custom watch",
  ]) {
    await expect(root).toContainText(label);
  }
});

test("picker fires onPick with the chosen recipe", async ({ page }) => {
  await page.evaluate(() => window.__TEST_MOUNT("RecipePickerModal", { open: true }));
  await page.locator('[data-recipe="price"]').click();
  await page.waitForFunction(() => (window.__TEST_CALLS.onPick || 0) >= 1);
});

test("WatchModal pre-fills from a Downloads recipe template", async ({ page }) => {
  await page.evaluate(() => {
    window.__TEST_MOUNT("WatchModal", {
      open: true,
      prompts: [],
      template: {
        id: "downloads",
        kind: "folder",
        promptSlug: "summarize",
        useDownloadsDir: true,
        skipExisting: true,
        notesFileName: "downloads-summaries.md",
        name: "Downloads",
      },
    });
  });

  // Folder path resolves from the mocked watch_default_paths (async).
  const folder = page.locator('#test-root input[placeholder="/Users/you/Downloads"]');
  await expect(folder).toHaveValue("/Users/test/Downloads");

  // "Skip files already in the folder" is checked (the recipe's ignore_before).
  // (notesPath construction itself is covered by the recipeToFormDefaults
  // node tests; here we just confirm the template→form wiring.)
  const skip = page
    .locator('#test-root label:has-text("Skip files already") input[type="checkbox"]');
  await expect(skip).toBeChecked();
});

test("WatchModal model field is an install-aware picker, not gemma4:latest", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.llm_list_models = () => ({
      models: [{ name: "llama3.2:3b" }, { name: "qwen3.5:9b" }],
    });
    window.__TEST_MOUNT("WatchModal", {
      open: true, prompts: [], template: null, defaultModel: "llama3.2:3b",
    });
  });
  const toggle = page.locator("#test-root [data-watch-model] > button");
  // Defaults to the caller's current (pulled) model, never the hardcoded
  // gemma4:latest the user may not have.
  await expect(toggle).toContainText("llama3.2:3b");
  await expect(toggle).not.toContainText("gemma4:latest");
  // Opening it lists the user's actually-pulled models.
  await toggle.click();
  await expect(page.locator("#test-root")).toContainText("qwen3.5:9b");
});

test("Custom recipe pre-fills nothing (blank form)", async ({ page }) => {
  await page.evaluate(() => {
    // template=null models the "Custom" pick (main.jsx maps custom → null).
    window.__TEST_MOUNT("WatchModal", { open: true, prompts: [], template: null });
  });
  const folder = page.locator('#test-root input[placeholder="/Users/you/Downloads"]');
  await expect(folder).toHaveValue("");
});
