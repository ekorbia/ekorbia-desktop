// Which model answers (main.jsx: `chatModelId`).
//
// A chat is no longer given a model of its own. It uses its workspace's
// model if that workspace names one, otherwise the app default; General
// and private chats always use the default. This mounts the REAL app
// (helpers/app.js) because the rule lives in App's state.
//
// Models are shown by plain name (Fast / Balanced / Most capable), worked
// out from the catalog and this Mac's memory.

const { test, expect } = require("@playwright/test");
const { openApp, openWorkspace, send } = require("./helpers/app");

const GIB = 1024 * 1024 * 1024;

// A 36 GB Mac with the ladder's top three installed, the app default set
// to the 12B, and one workspace that asks for the 26B.
function seedModels() {
  try { localStorage.setItem("ekorbia.main.model", "gemma4-12b"); } catch (_) {}
  const R = window.__INVOKE_RESPONSES;
  R.system_profile = () => ({ totalRamBytes: 36 * 1024 * 1024 * 1024, platform: "macos", arch: "aarch64" });
  R.engine_catalog = () => ({
    version: 1,
    models: [
      { id: "gemma4-e2b", label: "Gemma 4 E2B", purpose: "chat", minRamGb: 8, totalBytes: 4.3e9, suggest: true, caps: { vision: true, tools: true } },
      { id: "gemma4-e4b", label: "Gemma 4 E4B", purpose: "chat", minRamGb: 8, totalBytes: 6.1e9, suggest: true, caps: { vision: true, tools: true } },
      { id: "gemma4-12b", label: "Gemma 4 12B", purpose: "chat", minRamGb: 16, totalBytes: 7.2e9, suggest: true, recommended: true, caps: { vision: true, tools: true } },
      { id: "gemma4-26b-a4b", label: "Gemma 4 26B (A4B)", purpose: "chat", minRamGb: 32, totalBytes: 15.4e9, suggest: true, caps: { vision: true, tools: true } },
      { id: "nomic-embed-text", label: "Nomic Embed", purpose: "embed", minRamGb: 8, totalBytes: 3e8, suggest: true, caps: { vision: false, tools: false } },
    ],
  });
  R.llm_list_models = () => ({
    models: ["gemma4-e4b", "gemma4-12b", "gemma4-26b-a4b", "nomic-embed-text"].map((name) => ({ name, model: name, size: 1 })),
  });
  R.space_list = () => [
    { id: "plain", name: "Okafor estate", slug: "okafor", color: null, defaultModel: null, sortIndex: 0, createdAt: 1, updatedAt: 1 },
    { id: "big", name: "Brightwater", slug: "brightwater", color: null, defaultModel: "gemma4-26b-a4b", sortIndex: 1, createdAt: 1, updatedAt: 1 },
  ];
  R.space_get = (a) => R.space_list().find((s) => s.id === a.id);
}

const sentModels = (page) =>
  page.evaluate(() => window.__INVOKES.filter((i) => i.cmd === "llm_chat_stream").map((i) => i.args.body.model));

test("Home names a workspace's model only when it differs, and in plain words", async ({ page }) => {
  await openApp(page, seedModels);
  await expect(page.locator('[data-space-id="big"] [data-workspace-card-model]')).toHaveText("Most capable");
  await expect(page.locator('[data-space-id="plain"] [data-workspace-card-model]')).toHaveCount(0);
});

test("the sidebar says which model the workspace uses", async ({ page }) => {
  await openApp(page, seedModels);
  await openWorkspace(page, "plain");
  await expect(page.locator("[data-workspace-meta]")).toContainText("Balanced");
  await page.locator("[data-back-home]").click();
  await openWorkspace(page, "big");
  await expect(page.locator("[data-workspace-meta]")).toContainText("Most capable");
});

test("General answers with the app default", async ({ page }) => {
  await openApp(page, seedModels);
  await openWorkspace(page, null);
  await send(page, "hello");
  expect(await sentModels(page)).toEqual(["gemma4-12b"]);
});

test("a workspace with its own model answers with that model", async ({ page }) => {
  await openApp(page, seedModels);
  await openWorkspace(page, "big");
  await send(page, "summarise the data room");
  expect(await sentModels(page)).toEqual(["gemma4-26b-a4b"]);
});

test("a workspace without one answers with the app default", async ({ page }) => {
  await openApp(page, seedModels);
  await openWorkspace(page, "plain");
  await send(page, "who are the executors?");
  expect(await sentModels(page)).toEqual(["gemma4-12b"]);
});

test("the message box has no model picker", async ({ page }) => {
  await openApp(page, seedModels);
  await openWorkspace(page, "big");
  await expect(page.locator("[data-composer]")).not.toContainText("gemma4");
  await expect(page.locator("[data-composer-note]")).toHaveText(
    "Answered on this Mac. Check anything important against its source.",
  );
});

test("changing the default in Settings changes what General answers with", async ({ page }) => {
  await openApp(page, seedModels);
  await page.locator("[data-more-menu-button]").click();
  await page.locator("[data-more-settings]").click();
  await page.locator('[data-settings-tab="models"]').click();
  await expect(page.locator('[data-model-row="gemma4-12b"]')).toHaveAttribute("data-default", "true");
  await page.locator('[data-model-make-default="gemma4-e4b"]').click();
  await expect(page.locator('[data-model-row="gemma4-e4b"]')).toHaveAttribute("data-default", "true");
  await page.keyboard.press("Escape");
  // It is remembered for the next launch…
  expect(await page.evaluate(() => localStorage.getItem("ekorbia.main.model"))).toBe("gemma4-e4b");
});
