// Settings → Templates (ui/templates.jsx: TemplatesSettings + TemplateEditor).
//
// The pane replaced the right-hand prompt panel. It lists every template
// (starred first, then by name) with its one-line description, a star to
// put one on a new chat's cards and in the + menu, a search box and New.
// A row opens the editor: name, description, hint, instructions; Delete…,
// Duplicate, Cancel, Save. The foot says where the files are kept.
//
// The pane does not write files itself: it hands a draft to `onSave` and
// friends (main.jsx owns the folder). These tests mount the pane alone
// with recording callbacks.

const { test, expect } = require("@playwright/test");

const TEMPLATES = [
  { id: "translate", name: "Translate", description: "Into the language you name", hint: "Name the language, then paste the text", body: "Translate it.", tags: [], favorite: null },
  { id: "file-note", name: "File note", description: "Rough or dictated notes into a note for the file", hint: "Dictate or paste your notes", body: "Turn the notes into a file note.", tags: ["notes"], favorite: "star" },
  { id: "house-style", name: "House style", description: "Our spelling, tone and sign-off", hint: "", body: "Write in British English.", tags: [], favorite: null },
  { id: "notes-1", name: "Downloads notes", body: "…", _virtual: true, favorite: null },
];

async function mountPane(page, opts = {}) {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
  await page.evaluate(
    ({ templates, opts }) => {
      window.__T = { saved: [], deleted: [], duplicated: [], starred: [], changed: 0 };
      const R = window.__INVOKE_RESPONSES;
      R.prompts_dir_get = () => "/Users/you/Documents/Ekorbia/Prompts";
      R.prompts_dir_reveal = () => undefined;
      R.prompts_restore_builtins = () => 13;
      R.prompts_dir_set = () => undefined;
      if (opts.pickFolder) {
        window.__TAURI__.dialog = { open: async () => opts.pickFolder };
      }
      const host = document.getElementById("test-root");
      if (window.__TEST_ROOT) { try { window.__TEST_ROOT.unmount(); } catch (_) {} }
      host.innerHTML = "";
      host.style.cssText = "padding:20px;max-width:560px";
      const root = ReactDOM.createRoot(host);
      const render = (extra) =>
        root.render(
          React.createElement(window.TemplatesSettings, Object.assign({
            templates,
            onSave: async (draft) => {
              window.__T.saved.push(draft);
              return opts.saveFails ? null : draft.id || "new-slug";
            },
            onDelete: async (id) => { window.__T.deleted.push(id); },
            onDuplicate: async (id) => { window.__T.duplicated.push(id); return "translate"; },
            onToggleStar: (id) => { window.__T.starred.push(id); },
            onChanged: async () => { window.__T.changed += 1; },
          }, extra || {})),
        );
      window.__RENDER = render;
      render(opts.openRequest ? { openRequest: opts.openRequest } : null);
      window.__TEST_ROOT = root;
    },
    { templates: opts.templates || TEMPLATES, opts },
  );
  await expect(page.locator("[data-templates-settings]")).toBeVisible();
}

const calls = (page) => page.evaluate(() => window.__T);
const invoked = (page, cmd) =>
  page.evaluate((cmd) => window.__INVOKES.filter((i) => i.cmd === cmd).map((i) => i.args), cmd);

test("lists every template, starred first then by name, with its description", async ({ page }) => {
  await mountPane(page);
  const rows = page.locator("[data-template-row]");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-template-id", "file-note");
  await expect(rows.nth(0)).toHaveAttribute("data-starred", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-template-id", "house-style");
  await expect(rows.nth(2)).toHaveAttribute("data-template-id", "translate");
  await expect(rows.nth(0).locator("[data-template-description]")).toHaveText(
    "Rough or dictated notes into a note for the file",
  );
  // A row made for one chat (a Watch's notes) is not a template.
  await expect(page.locator("[data-templates-settings]")).not.toContainText("Downloads notes");
  // Tags are kept in the files but not shown.
  await expect(page.locator("[data-templates-settings]")).not.toContainText("notes" + ",");
});

test("search matches names and descriptions", async ({ page }) => {
  await mountPane(page);
  await page.locator("[data-template-search]").fill("spelling");
  await expect(page.locator("[data-template-row]")).toHaveCount(1);
  await expect(page.locator("[data-template-row]")).toHaveAttribute("data-template-id", "house-style");
  await page.locator("[data-template-search]").fill("zzz");
  await expect(page.locator("[data-template-row]")).toHaveCount(0);
  await expect(page.locator("[data-template-empty]")).toContainText("No template matches");
});

test("the star toggles without opening the template", async ({ page }) => {
  await mountPane(page);
  const star = page.locator('[data-template-id="translate"] [data-template-star]');
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  expect((await calls(page)).starred).toEqual(["translate"]);
  await expect(page.locator("[data-template-editor]")).toHaveCount(0);
  await expect(page.locator('[data-template-id="file-note"] [data-template-star]')).toHaveAttribute("aria-pressed", "true");
});

test("a row opens the editor with the template's four fields", async ({ page }) => {
  await mountPane(page);
  await page.locator('[data-template-id="file-note"]').click();
  const ed = page.locator("[data-template-editor]");
  await expect(ed).toBeVisible();
  await expect(ed.locator('[data-template-field="name"]')).toHaveValue("File note");
  await expect(ed.locator('[data-template-field="description"]')).toHaveValue("Rough or dictated notes into a note for the file");
  await expect(ed.locator('[data-template-field="hint"]')).toHaveValue("Dictate or paste your notes");
  await expect(ed.locator('[data-template-field="body"]')).toHaveValue("Turn the notes into a file note.");
});

test("Save hands back the edited draft and closes; Cancel changes nothing", async ({ page }) => {
  await mountPane(page);
  await page.locator('[data-template-id="file-note"]').click();
  const ed = page.locator("[data-template-editor]");
  await ed.locator('[data-template-field="hint"]').fill("Paste the attendance note");
  await ed.locator("[data-template-save]").click();
  await expect(ed).toHaveCount(0);
  expect((await calls(page)).saved).toEqual([
    {
      id: "file-note",
      name: "File note",
      description: "Rough or dictated notes into a note for the file",
      hint: "Paste the attendance note",
      body: "Turn the notes into a file note.",
    },
  ]);

  await page.locator('[data-template-id="translate"]').click();
  await ed.locator('[data-template-field="name"]').fill("Something else");
  await ed.locator("[data-template-cancel]").click();
  await expect(ed).toHaveCount(0);
  expect((await calls(page)).saved).toHaveLength(1);
});

test("New opens a blank editor; a name and instructions are needed to save", async ({ page }) => {
  await mountPane(page);
  await page.locator("[data-template-new]").click();
  const ed = page.locator("[data-template-editor]");
  await expect(ed).toContainText("New template");
  const save = ed.locator("[data-template-save]");
  await expect(save).toBeDisabled();
  // A new template has nothing to delete or copy yet.
  await expect(ed.locator("[data-template-delete]")).toHaveCount(0);
  await expect(ed.locator("[data-template-duplicate]")).toHaveCount(0);

  await ed.locator('[data-template-field="name"]').fill("  Attendance note ");
  await expect(save).toBeDisabled();
  await ed.locator('[data-template-field="body"]').fill("Write an attendance note.");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(ed).toHaveCount(0);
  expect((await calls(page)).saved).toEqual([
    { id: null, name: "Attendance note", description: "", hint: "", body: "Write an attendance note." },
  ]);
});

test("a save that fails keeps the editor open and says so", async ({ page }) => {
  await mountPane(page, { saveFails: true });
  await page.locator('[data-template-id="translate"]').click();
  const ed = page.locator("[data-template-editor]");
  await ed.locator("[data-template-save]").click();
  await expect(ed.locator("[data-template-error]")).toContainText("could not be saved");
  await expect(ed).toBeVisible();
});

test("Delete asks first", async ({ page }) => {
  await mountPane(page);
  await page.locator('[data-template-id="house-style"]').click();
  const ed = page.locator("[data-template-editor]");
  await ed.locator("[data-template-delete]").click();
  expect((await calls(page)).deleted).toEqual([]);
  await expect(ed).toContainText("Delete this template and its file?");
  await ed.getByRole("button", { name: "Keep it" }).click();
  await expect(ed.locator("[data-template-delete]")).toBeVisible();

  await ed.locator("[data-template-delete]").click();
  await ed.locator("[data-template-delete-yes]").click();
  await expect(ed).toHaveCount(0);
  expect((await calls(page)).deleted).toEqual(["house-style"]);
});

test("Duplicate makes a copy and carries on in it", async ({ page }) => {
  await mountPane(page);
  await page.locator('[data-template-id="file-note"]').click();
  await page.locator("[data-template-duplicate]").click();
  expect((await calls(page)).duplicated).toEqual(["file-note"]);
  // The mock answers with "translate" as the copy's id: the editor moves to it.
  await expect(page.locator("[data-template-editor]")).toHaveAttribute("data-template-id", "translate");
});

test("Escape closes the editor, not what is behind it", async ({ page }) => {
  await mountPane(page);
  await page.locator('[data-template-id="translate"]').click();
  await page.locator('[data-template-field="name"]').press("Escape");
  await expect(page.locator("[data-template-editor]")).toHaveCount(0);
  await expect(page.locator("[data-templates-settings]")).toBeVisible();
});

test("a request from outside opens that template, or a blank one", async ({ page }) => {
  await mountPane(page, { openRequest: { id: "house-style", n: 1 } });
  await expect(page.locator("[data-template-editor]")).toHaveAttribute("data-template-id", "house-style");
  await page.locator("[data-template-cancel]").click();
  await page.evaluate(() => window.__RENDER({ openRequest: { id: "new", n: 2 } }));
  await expect(page.locator("[data-template-editor]")).toContainText("New template");
});

test("the foot says where the files are and opens the folder", async ({ page }) => {
  await mountPane(page);
  const foot = page.locator("[data-template-folder]");
  await expect(foot.locator("[data-template-folder-path]")).toHaveText("/Users/you/Documents/Ekorbia/Prompts");
  await foot.locator("[data-template-open-folder]").click();
  expect(await invoked(page, "prompts_dir_reveal")).toHaveLength(1);
});

test("Use another folder… points the app at it and re-reads", async ({ page }) => {
  await mountPane(page, { pickFolder: "/Volumes/Shared/Templates" });
  await page.locator("[data-template-choose-folder]").click();
  await expect(page.locator("[data-template-folder-path]")).toHaveText("/Volumes/Shared/Templates");
  expect(await invoked(page, "prompts_dir_set")).toEqual([{ path: "/Volumes/Shared/Templates" }]);
  expect((await calls(page)).changed).toBe(1);
});

test("Restore the starter set asks first, then re-reads", async ({ page }) => {
  await mountPane(page);
  await page.locator("[data-template-restore]").click();
  expect(await invoked(page, "prompts_restore_builtins")).toHaveLength(0);
  await expect(page.locator("[data-template-restore-confirm]")).toContainText("your own templates are not touched");
  await page.locator("[data-template-restore-yes]").click();
  await expect(page.locator("[data-template-status]")).toHaveText("Restored 13 starter templates.");
  expect(await invoked(page, "prompts_restore_builtins")).toHaveLength(1);
  expect((await calls(page)).changed).toBe(1);
});

test("with no templates it says how to get some", async ({ page }) => {
  await mountPane(page, { templates: [{ id: "notes-1", name: "Downloads notes", _virtual: true }] });
  await expect(page.locator("[data-template-row]")).toHaveCount(0);
  await expect(page.locator("[data-template-empty]")).toContainText("No templates yet");
});
