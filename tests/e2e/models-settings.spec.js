// Settings → Models (ModelsSettings in ui/settings.jsx): the app's default
// model, in plain names.
//
// For the bundled engine the pane shows the tiers modelTiers (utils.js)
// works out from the catalog and this Mac's memory — Fast, Balanced, Most
// capable. Each can be downloaded; any installed one can be made the
// default. On another backend it lists that backend's models as they are.
//
// The tier rule itself is node-tested over the real catalog; how the
// default and a workspace's model reach a send is pinned against the real
// app in models.spec.js.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const GIB = 1024 * 1024 * 1024;

async function mountModels(page, opts = {}) {
  await page.evaluate(({ opts, GIB }) => {
    const R = window.__INVOKE_RESPONSES;
    R.llm_backend_config_get = () => ({ backend: opts.backend || "engine", baseUrl: null, apiKey: null });
    R.system_profile = () => ({ totalRamBytes: (opts.ramGb || 36) * GIB, platform: "macos", arch: "aarch64" });
    // The real payload shape: { version, models }.
    R.engine_catalog = () => ({
      version: 1,
      models: [
        { id: "gemma4-e2b", label: "Gemma 4 E2B", purpose: "chat", minRamGb: 8, totalBytes: 4.3e9, suggest: true },
        { id: "gemma4-e4b", label: "Gemma 4 E4B", purpose: "chat", minRamGb: 8, totalBytes: 6.1e9, suggest: true },
        { id: "gemma4-12b", label: "Gemma 4 12B", purpose: "chat", minRamGb: 16, totalBytes: 7.2e9, suggest: true, recommended: true },
        { id: "gemma4-26b-a4b", label: "Gemma 4 26B (A4B)", purpose: "chat", minRamGb: 32, totalBytes: 15.4e9, suggest: true },
        { id: "gemma4-31b", label: "Gemma 4 31B", purpose: "chat", minRamGb: 36, totalBytes: 18.9e9, suggest: false },
        { id: "nomic-embed-text", label: "Nomic Embed Text v1.5", purpose: "embed", minRamGb: 8, totalBytes: 0.3e9, suggest: true },
      ],
    });
    const installed = opts.installed || ["gemma4-12b", "gemma4-26b-a4b", "nomic-embed-text"];
    R.llm_list_models = () => ({ models: installed.map((name) => ({ name, model: name, size: 1 })) });
    R.engine_download = () => new Promise(() => {}); // stays "downloading"
    window.__M = { def: [], adv: 0 };
    const host = document.getElementById("test-root");
    if (window.__TEST_ROOT) { try { window.__TEST_ROOT.unmount(); } catch (_) {} }
    host.innerHTML = "";
    const root = ReactDOM.createRoot(host);
    root.render(
      React.createElement(window.ModelsSettings, {
        defaultModel: opts.defaultModel || "gemma4-12b",
        onDefaultModel: (id) => window.__M.def.push(id),
        spaces: opts.spaces || [],
        onOpenAdvanced: () => { window.__M.adv += 1; },
      }),
    );
    window.__TEST_ROOT = root;
  }, { opts, GIB });
  await expect(page.locator("[data-models-settings][data-backend]")).toBeVisible();
}

const rows = (page) => page.locator("[data-model-row]");
const row = (page, id) => page.locator(`[data-model-row="${id}"]`);

test("three tiers in plain names, each with the catalog's name and size", async ({ page }) => {
  await mountModels(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(row(page, "gemma4-e4b").locator("[data-model-name]")).toHaveText("Fast");
  await expect(row(page, "gemma4-e4b").locator("[data-model-detail]")).toHaveText("Gemma 4 E4B · 6.1 GB");
  await expect(row(page, "gemma4-12b").locator("[data-model-name]")).toHaveText("Balanced");
  await expect(row(page, "gemma4-26b-a4b").locator("[data-model-name]")).toHaveText("Most capable");
  await expect(row(page, "gemma4-26b-a4b").locator("[data-model-detail]")).toHaveText("Gemma 4 26B (A4B) · 15.4 GB");
  // The opt-in 31B and the search model are not tiers.
  await expect(row(page, "gemma4-31b")).toHaveCount(0);
  await expect(row(page, "nomic-embed-text")).toHaveCount(0);
  await expect(page.locator("[data-models-settings]")).toContainText("36 GB of memory");
});

test("the default is marked; another installed model can be made the default", async ({ page }) => {
  await mountModels(page);
  await expect(row(page, "gemma4-12b")).toHaveAttribute("data-default", "true");
  await expect(row(page, "gemma4-12b").locator("[data-model-is-default]")).toHaveText("Default");
  await row(page, "gemma4-26b-a4b").locator("[data-model-make-default]").click();
  expect(await page.evaluate(() => window.__M.def)).toEqual(["gemma4-26b-a4b"]);
});

test("a tier that is not on disk offers Download, and shows progress once started", async ({ page }) => {
  await mountModels(page);
  const fast = row(page, "gemma4-e4b");
  await expect(fast.locator("[data-model-make-default]")).toHaveCount(0);
  await fast.locator("[data-model-download]").click();
  await expect(fast.locator("[data-model-progress]")).toBeVisible();
  const started = await page.evaluate(() =>
    window.__INVOKES.filter((i) => i.cmd === "engine_download").map((i) => i.args.modelId));
  expect(started).toEqual(["gemma4-e4b"]);
});

test("a smaller Mac gets fewer tiers", async ({ page }) => {
  await mountModels(page, { ramGb: 8, installed: ["gemma4-e4b"], defaultModel: "gemma4-e4b" });
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, "gemma4-e2b").locator("[data-model-name]")).toHaveText("Fast");
  await expect(row(page, "gemma4-e4b").locator("[data-model-name]")).toHaveText("Most capable");
});

test("a default that is not one of the tiers is still shown", async ({ page }) => {
  await mountModels(page, { defaultModel: "gemma4-31b", installed: ["gemma4-31b", "gemma4-12b"] });
  await expect(rows(page)).toHaveCount(4);
  await expect(row(page, "gemma4-31b").locator("[data-model-name]")).toHaveText("Gemma 4 31B");
  await expect(row(page, "gemma4-31b")).toHaveAttribute("data-default", "true");
});

test("it says which models workspaces use", async ({ page }) => {
  await mountModels(page, {
    spaces: [
      { id: "s1", name: "A", defaultModel: "gemma4-26b-a4b" },
      { id: "s2", name: "B", defaultModel: "gemma4-26b-a4b" },
      { id: "s3", name: "C", defaultModel: null },
    ],
  });
  await expect(page.locator('[data-model-used-by="gemma4-26b-a4b"]')).toHaveText("Most capable is used by 2 workspaces.");
  await expect(page.locator("[data-model-used-by]")).toHaveCount(1);
});

test("on another backend the models are listed under their own names", async ({ page }) => {
  await mountModels(page, { backend: "ollama", installed: ["llama3.3:70b", "gemma4:12b"], defaultModel: "gemma4:12b" });
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, "llama3.3:70b").locator("[data-model-name]")).toHaveText("llama3.3:70b");
  await expect(row(page, "gemma4:12b")).toHaveAttribute("data-default", "true");
  // Nothing to download from here: that is Ollama's job.
  await expect(page.locator("[data-model-download]")).toHaveCount(0);
  await expect(page.locator("[data-models-settings]")).toContainText("These come from Ollama");
});

test("the link at the foot opens Advanced", async ({ page }) => {
  await mountModels(page);
  await page.locator("[data-models-open-advanced]").click();
  expect(await page.evaluate(() => window.__M.adv)).toBe(1);
});
