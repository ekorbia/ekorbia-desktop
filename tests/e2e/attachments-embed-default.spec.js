// Regression: Settings → Files → Attachments embedding-model picker.
//
// When no embedding model is explicitly configured (the `embedding_model`
// setting is unset), Rust still falls back to its default and uses it for
// embedding — the install probe (`llm_embed_model_check`) reports that model.
// The picker must default to that model, not show "— pick a model —", when a
// matching embedding model is pulled.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test("embedding picker defaults to the pulled model when the setting is unset", async ({ page }) => {
  await page.evaluate(() => {
    // Setting unset → every setting_get returns null (the mock default).
    window.__INVOKE_RESPONSES.setting_get = () => null;
    // A chat model plus a pulled embedding model; only the latter is
    // embedding-like (isEmbeddingModelName), so it's the one the picker lists.
    window.__INVOKE_RESPONSES.llm_list_models = () => ({
      models: [{ name: "gemma4:latest" }, { name: "nomic-embed-text:latest" }],
    });
    // The probe reports the Rust-side default as installed.
    window.__INVOKE_RESPONSES.llm_embed_model_check = () => ({
      installed: true,
      model: "nomic-embed-text:latest",
    });
    window.__TEST_MOUNT("AttachmentsSettings", {});
  });

  const root = page.locator("#test-root");
  // Once the pulled list resolves the dropdown renders, pre-selecting the
  // installed embedding model rather than the empty placeholder.
  await expect(root.locator("select")).toHaveValue("nomic-embed-text:latest");
  await expect(root.getByText("— pick a model —")).toHaveCount(0);
  // Sanity: the install badge confirms the mock wired the "installed" path.
  await expect(root.getByText("pulled")).toBeVisible();
  // Default-backed fields surface their default as helper text (rather than a
  // value-like placeholder) so an empty field reads as "using the default".
  await expect(root.getByText("Defaults to 6")).toBeVisible();
});
