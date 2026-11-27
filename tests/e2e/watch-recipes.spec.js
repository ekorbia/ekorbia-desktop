// The Watch form and its two starting points (ui/watch.jsx). Only folders
// are watched: the form has no feed or web-page fields, and whatever it
// saves is a folder watch.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const DOWNLOADS = {
  id: "downloads",
  promptSlug: "summarise-a-document",
  useDownloadsDir: true,
  skipExisting: true,
  notesFileName: "downloads-summaries.md",
  name: "Downloads",
};

test("the starting points are Downloads and another folder, nothing else", async ({ page }) => {
  await page.evaluate(() => window.__TEST_MOUNT("RecipeGallery", {}));
  const root = page.locator("#test-root");
  await expect(root.locator("[data-recipe]")).toHaveCount(2);
  await expect(root).toContainText("Summarise new downloads");
  await expect(root).toContainText("Another folder");
  await expect(root).not.toContainText(/blog|feed|web page|price/i);
});

test("the picker hands back the starting point chosen", async ({ page }) => {
  await page.evaluate(() => window.__TEST_MOUNT("RecipePickerModal", { open: true }));
  await page.locator('[data-recipe="custom"]').click();
  await page.waitForFunction(() => (window.__TEST_CALLS.onPick || 0) >= 1);
});

test("the Downloads starting point fills in the folder, the notes file and 'skip'", async ({ page }) => {
  await page.evaluate((template) => {
    window.__TEST_MOUNT("WatchModal", { open: true, prompts: [], template });
  }, DOWNLOADS);
  // The folders come from Rust (mocked watch_default_paths).
  await expect(page.locator('[data-watch-field="folder"]')).toHaveValue("/Users/test/Downloads");
  await expect(page.locator('[data-watch-field="name"]')).toHaveValue("Downloads");
  await expect(page.locator('[data-watch-field="notes"]')).toHaveValue(/downloads-summaries\.md$/);
  await expect(page.locator("[data-watch-skip-existing]")).toBeChecked();
});

test("another folder opens the form blank, and it cannot be saved until it is filled in", async ({ page }) => {
  await page.evaluate(() => {
    window.__TEST_MOUNT("WatchModal", { open: true, prompts: [], template: null });
  });
  await expect(page.locator('[data-watch-field="folder"]')).toHaveValue("");
  await expect(page.locator("[data-watch-save]")).toBeDisabled();
  await expect(page.locator("[data-watch-save-run]")).toBeDisabled();
});

test("the form has no feed or web-page fields", async ({ page }) => {
  await page.evaluate(() => {
    window.__TEST_MOUNT("WatchModal", { open: true, prompts: [], template: null });
  });
  const form = page.locator("[data-watch-form]");
  await expect(form).toBeVisible();
  await expect(form).not.toContainText(/feed|rss|url|web page|selector|diff/i);
  await expect(form.locator("input[type=url]")).toHaveCount(0);
});

test("the model list shows the installed models by their plain names", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.llm_list_models = () => ({
      models: [{ name: "gemma4-12b" }, { name: "gemma4-e4b" }, { name: "nomic-embed-text" }],
    });
    window.__TEST_MOUNT("WatchModal", {
      open: true, prompts: [], template: null, defaultModel: "gemma4-12b",
      nameOfModel: (id) => ({ "gemma4-12b": "Balanced — Gemma 4 12B", "gemma4-e4b": "Fast — Gemma 4 E4B" })[id] || id,
    });
  });
  const model = page.locator("[data-watch-model]");
  // A new watch starts on the app's default model.
  await expect(model).toHaveValue("gemma4-12b");
  await expect(model.locator("option")).toHaveText(["Balanced — Gemma 4 12B", "Fast — Gemma 4 E4B"]);
  // The model that reads documents for search cannot write a summary.
  await expect(model).not.toContainText("nomic");
});

test("the template list offers the built-in summary and the person's templates", async ({ page }) => {
  await page.evaluate((template) => {
    window.__TEST_MOUNT("WatchModal", {
      open: true, template,
      prompts: [
        { id: "summarise-a-document", name: "Summarise a document", body: "x", favorite: "star" },
        { id: "attendance-note", name: "Attendance note", body: "y", favorite: null },
        { id: "one-chat", name: "One-off", body: "z", _virtual: true },
      ],
    });
  }, DOWNLOADS);
  const tpl = page.locator("[data-watch-template]");
  // The starting point's own template is chosen.
  await expect(tpl).toHaveValue("summarise-a-document");
  // Starred first, then by name; a one-chat template is not a file and is not offered.
  await expect(tpl.locator("option")).toHaveText(["Built-in summary", "Summarise a document", "Attendance note"]);
});

test("whatever the form saves is a folder watch", async ({ page }) => {
  await page.evaluate(() => {
    window.__TEST_MOUNT("WatchModal", { open: true, prompts: [], template: null, defaultModel: "gemma4-12b" });
  });
  await page.locator('[data-watch-field="name"]').fill("Intake");
  await page.locator('[data-watch-field="folder"]').fill("/Users/test/Matters/Intake");
  await page.locator('[data-watch-field="notes"]').fill("/Users/test/Documents/intake.md");
  await page.locator("[data-watch-interval]").selectOption("300");
  await page.locator("[data-watch-save]").click();
  await page.waitForFunction(() => window.__INVOKE_FIND("watch_create"));
  const sent = await page.evaluate(() => window.__INVOKES.find((c) => c.cmd === "watch_create").args.watch);
  expect(sent).toMatchObject({
    name: "Intake",
    kind: "folder",
    folderPath: "/Users/test/Matters/Intake",
    notesPath: "/Users/test/Documents/intake.md",
    model: "gemma4-12b",
    intervalSecs: 300,
    sourceUrl: null,
    urlSelector: null,
    urlDiffMode: null,
    enabled: true,
  });
  // Saving alone does not start a run.
  expect(await page.evaluate(() => !!window.__INVOKE_FIND("watch_run_one"))).toBe(false);
  await page.waitForFunction(() => (window.__TEST_CALLS.onCreated || 0) >= 1);
});

test("editing keeps the watch's id and whether it was paused", async ({ page }) => {
  await page.evaluate(() => {
    window.__TEST_MOUNT("WatchModal", {
      open: true, prompts: [], template: null, defaultModel: "gemma4-12b",
      editing: {
        id: "w-old", name: "Intake", kind: "folder", folderPath: "/a", notesPath: "/n.md",
        model: "gemma4-e4b", promptId: null, enabled: false, createdAt: 5, intervalSecs: 60, notify: false,
      },
    });
  });
  await expect(page.locator("[data-watch-form]")).toContainText("Edit watch");
  await expect(page.locator("[data-watch-interval]")).toHaveValue("60");
  await page.locator('[data-watch-field="name"]').fill("Intake 2");
  await page.locator("[data-watch-save]").click();
  await page.waitForFunction(() => window.__INVOKE_FIND("watch_create"));
  const sent = await page.evaluate(() => window.__INVOKES.find((c) => c.cmd === "watch_create").args.watch);
  expect(sent).toMatchObject({ id: "w-old", name: "Intake 2", enabled: false, createdAt: 5, model: "gemma4-e4b" });
});
