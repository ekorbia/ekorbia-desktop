// First run, in the REAL app (helpers/app.js): one welcome screen with the
// four shortcuts, then the model choice. Nothing else stands between a new
// person and their first chat.
//
// The two screens' own contents are pinned in onboarding.spec.js and
// engine-gate-guided.spec.js; this is the order App shows them in, and what
// it records.

const { test, expect } = require("@playwright/test");
const { openApp } = require("./helpers/app");

// A new install: no settings saved, no model on disk.
function seedNewInstall() {
  const R = window.__INVOKE_RESPONSES;
  window.__SETTINGS = {};
  R.setting_get = (a) => (a && window.__SETTINGS[a.key] != null ? window.__SETTINGS[a.key] : null);
  R.setting_set = (a) => { window.__SETTINGS[a.key] = a.value; };
  R.llm_list_models = () => ({ models: [] });
  R.system_profile = () => ({ totalRamBytes: 24 * 1024 * 1024 * 1024, platform: "macos", arch: "aarch64" });
  R.engine_catalog = () => ({
    version: 1,
    models: [
      { id: "gemma4-e4b", label: "Gemma 4 E4B", purpose: "chat", suggest: true, minRamGb: 8, caps: { vision: true }, totalBytes: 6.1e9, installed: false },
      { id: "gemma4-12b", label: "Gemma 4 12B", purpose: "chat", suggest: true, recommended: true, minRamGb: 16, caps: { vision: true }, totalBytes: 7.2e9, installed: false },
      { id: "nomic-embed-text", label: "Nomic Embed", purpose: "embed", minRamGb: 8, caps: {}, totalBytes: 3e8, installed: false },
    ],
  });
}

test("a new install sees the welcome, then the model choice, and nothing else", async ({ page }) => {
  await openApp(page, seedNewInstall);
  const welcome = page.locator("[data-onboarding]");
  const choice = page.locator("[data-engine-gate]");

  // The welcome comes first, alone.
  await expect(welcome).toBeVisible();
  await expect(welcome.locator("[data-onboarding-shortcut]")).toHaveCount(4);
  await expect(choice).toHaveCount(0);
  // Until a model is installed the line at the foot says so in plain
  // words, not by an identifier.
  await expect(page.locator("[data-status-line]")).toHaveText("No model is installed yet");

  await welcome.locator("[data-onboarding-continue]").click();
  await expect(welcome).toHaveCount(0);
  // Seen once: the flag is written when it closes.
  expect(await page.evaluate(() => window.__SETTINGS["onboarding.completed"])).toBe("1");

  // Then the model that fits this Mac (24 GB → the 12B).
  await expect(choice).toBeVisible();
  await expect(choice).toContainText("Choose a model");
  await expect(choice.locator("[data-engine-gate-model]")).toContainText("Gemma 4 12B");
  // A new install answers with the built-in engine.
  const set = await page.evaluate(() => window.__INVOKES.filter((c) => c.cmd === "llm_backend_config_set").map((c) => c.args));
  expect(set).toEqual([{ backendKind: "engine", baseUrl: null, apiKey: null }]);

  // Skipping leaves the app usable, on Home.
  await choice.locator("[data-engine-gate-skip]").click();
  await expect(choice).toHaveCount(0);
  await expect(page.locator("[data-workspace-card][data-general]")).toBeVisible();
});

test("someone who has seen the welcome is not shown it again", async ({ page }) => {
  // helpers/app.js seeds onboarding.completed and an installed model.
  await openApp(page);
  await expect(page.locator("[data-workspace-card][data-general]")).toBeVisible();
  await expect(page.locator("[data-onboarding]")).toHaveCount(0);
  await expect(page.locator("[data-engine-gate]")).toHaveCount(0);
  await expect(page.locator("[data-status-line]")).toHaveText("Chats stay on this Mac");
});
