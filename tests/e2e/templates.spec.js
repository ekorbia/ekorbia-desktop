// Templates, end to end (the REAL app — helpers/app.js).
//
// A template is a saved instruction with a name: the file the app used to
// call a prompt, with two optional lines added (a description and a hint).
// These tests follow one from the folder to the screen and back:
//
//   • a new chat offers the starred ones as cards; choosing one puts its
//     chip above the message box, makes the box ask for what it needs, and
//     sends its instruction ahead of the message;
//   • Settings → Templates writes, stars and deletes them;
//   • a workspace can keep one always on;
//   • a file dropped into the folder shows up when the window comes forward.
//
// The folder is an array in the page: prompts_list reads it, prompts_save /
// prompts_delete / prompts_meta_set change it, as Rust does on disk.

const { test, expect } = require("@playwright/test");
const { openApp, openWorkspace, send } = require("./helpers/app");

function seedTemplates() {
  const R = window.__INVOKE_RESPONSES;
  const now = Math.floor(Date.now() / 1000);
  window.__FOLDER = [
    { id: "file-note", name: "File note", description: "Rough or dictated notes into a note for the file", hint: "Dictate or paste your notes", tags: ["notes"], body: "Turn the notes into a file note.", favorite: "star", builtin: true, updatedAt: now },
    { id: "summarise-a-document", name: "Summarise a document", description: "The main points, grouped by section", hint: "Attach a document or paste the text", tags: [], body: "Summarise it.", favorite: "star", builtin: true, updatedAt: now },
    { id: "translate", name: "Translate", description: "Into the language you name", hint: "Name the language, then paste the text", tags: [], body: "Translate it.", favorite: null, builtin: true, updatedAt: now },
    { id: "house-style", name: "House style", description: "Our spelling, tone and sign-off", hint: "", tags: [], body: "Write in British English.", favorite: null, builtin: true, updatedAt: now },
  ];
  R.prompts_list = () => window.__FOLDER.map((t) => ({ ...t }));
  R.prompts_save = (a) => {
    const slug = a.slug || a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const row = {
      id: slug, name: a.name, description: a.description || "", hint: a.hint || "",
      tags: a.tags || [], body: a.body, builtin: false, updatedAt: now,
    };
    const at = window.__FOLDER.findIndex((t) => t.id === slug);
    if (at >= 0) window.__FOLDER[at] = { ...window.__FOLDER[at], ...row };
    else window.__FOLDER.push({ ...row, favorite: null });
    return slug;
  };
  R.prompts_delete = (a) => { window.__FOLDER = window.__FOLDER.filter((t) => t.id !== a.slug); };
  R.prompts_meta_set = (a) => {
    const t = window.__FOLDER.find((x) => x.id === a.slug);
    if (t) t.favorite = a.favorite;
  };
  R.prompts_dir_get = () => "/Users/you/Documents/Ekorbia/Prompts";
  R.space_list = () => [
    { id: "hart", name: "Hartwell", slug: "hartwell", color: null, defaultModel: null, sortIndex: 0, createdAt: 1, updatedAt: 1 },
  ];
  R.space_get = () => R.space_list()[0];
  // Hartwell keeps the house style always on.
  R.space_prompts_list = (a) =>
    a && a.spaceId === "hart" ? [{ id: "sp1", spaceId: "hart", promptSlug: "house-style", sortIndex: 0, locked: true }] : [];
}

const invoked = (page, cmd) =>
  page.evaluate((cmd) => window.__INVOKES.filter((i) => i.cmd === cmd).map((i) => i.args), cmd);
const chip = (page, id) => page.locator(`[data-attached-prompt-chip="${id}"]`);
const input = (page) => page.locator("[data-composer-input]");

async function openTemplatesSettings(page) {
  await page.locator("[data-more-menu-button]").click();
  await page.locator("[data-more-templates]").click();
  await expect(page.locator("[data-templates-settings]")).toBeVisible();
}

test("a new chat offers the starred templates; choosing one turns it on and the box asks for what it needs", async ({ page }) => {
  await openApp(page, seedTemplates);
  await openWorkspace(page, null);
  await expect(page.locator("[data-empty-chat]")).toContainText("What do you need?");
  const cards = page.locator("[data-template-card]");
  await expect(cards).toHaveCount(2);
  await expect(input(page)).toHaveAttribute("placeholder", "Ask anything");

  await page.locator('[data-template-card="file-note"]').click();
  await expect(chip(page, "file-note")).toHaveText("File note");
  await expect(input(page)).toHaveAttribute("placeholder", "Dictate or paste your notes");
  await expect(page.locator('[data-template-card="file-note"]')).toHaveAttribute("aria-pressed", "true");
  await expect(input(page)).toBeFocused();

  // Choosing it again turns it off.
  await page.locator('[data-template-card="file-note"]').click();
  await expect(chip(page, "file-note")).toHaveCount(0);
  await expect(input(page)).toHaveAttribute("placeholder", "Ask anything");
});

test("the template's instruction goes ahead of the message, and the message records which was used", async ({ page }) => {
  await openApp(page, seedTemplates);
  await openWorkspace(page, null);
  await page.locator('[data-template-card="file-note"]').click();
  await send(page, "Met Ms Okafor at 3pm about the lease.");
  const body = (await invoked(page, "llm_chat_stream"))[0].body;
  const system = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  expect(system).toContain("Turn the notes into a file note.");
  await expect(page.locator('[data-message-template="file-note"]')).toHaveText("File note");
  // It stays on for the chat.
  await expect(chip(page, "file-note")).toBeVisible();
});

test("'All templates' opens the full list in the message box", async ({ page }) => {
  await openApp(page, seedTemplates);
  await openWorkspace(page, null);
  await page.locator("[data-template-all]").click();
  const picker = page.locator("[data-prompt-picker]");
  await expect(picker).toBeVisible();
  await expect(picker.locator("[data-template-option]")).toHaveCount(4);
  await picker.locator('[data-template-option="translate"]').click();
  await expect(chip(page, "translate")).toBeVisible();
  await expect(input(page)).toHaveAttribute("placeholder", "Name the language, then paste the text");
});

test("a workspace's always-on template is on in a new chat, locked, and says nothing in the box", async ({ page }) => {
  await openApp(page, seedTemplates);
  await openWorkspace(page, "hart");
  const house = chip(page, "house-style");
  await expect(house).toBeVisible();
  await expect(house).toHaveAttribute("data-locked", "1");
  await expect(house.locator('[data-attached-prompt-detach="house-style"]')).toHaveCount(0);
  await expect(input(page)).toHaveAttribute("placeholder", "Ask anything");
  // A card chosen on top of it does speak.
  await page.locator('[data-template-card="summarise-a-document"]').click();
  await expect(input(page)).toHaveAttribute("placeholder", "Attach a document or paste the text");
});

test("the corner menu opens Settings on Templates; a new template is written to the folder", async ({ page }) => {
  await openApp(page, seedTemplates);
  await openTemplatesSettings(page);
  await expect(page.locator("[data-template-row]")).toHaveCount(4);
  await expect(page.locator("[data-template-folder-path]")).toHaveText("/Users/you/Documents/Ekorbia/Prompts");

  await page.locator("[data-template-new]").click();
  const ed = page.locator("[data-template-editor]");
  await ed.locator('[data-template-field="name"]').fill("Attendance note");
  await ed.locator('[data-template-field="description"]').fill("A note of a call or meeting");
  await ed.locator('[data-template-field="hint"]').fill("Say who you spoke to and what was said");
  await ed.locator('[data-template-field="body"]').fill("Write an attendance note.");
  await ed.locator("[data-template-save]").click();
  await expect(ed).toHaveCount(0);

  expect(await invoked(page, "prompts_save")).toEqual([
    {
      slug: "",
      name: "Attendance note",
      tags: [],
      body: "Write an attendance note.",
      description: "A note of a call or meeting",
      hint: "Say who you spoke to and what was said",
    },
  ]);
  const row = page.locator('[data-template-row][data-template-id="attendance-note"]');
  await expect(row).toContainText("A note of a call or meeting");
});

test("editing keeps the tags a file already carries", async ({ page }) => {
  await openApp(page, seedTemplates);
  await openTemplatesSettings(page);
  await page.locator('[data-template-row][data-template-id="file-note"]').click();
  const ed = page.locator("[data-template-editor]");
  await ed.locator('[data-template-field="description"]').fill("Notes into a file note");
  await ed.locator("[data-template-save]").click();
  await expect(ed).toHaveCount(0);
  const saved = (await invoked(page, "prompts_save"))[0];
  expect(saved.slug).toBe("file-note");
  expect(saved.tags).toEqual(["notes"]);
  expect(saved.description).toBe("Notes into a file note");
  await expect(page.locator('[data-template-id="file-note"] [data-template-description]')).toHaveText("Notes into a file note");
});

test("a star puts a template on the new-chat cards and in the + menu; removing it takes it off", async ({ page }) => {
  await openApp(page, seedTemplates);
  await openTemplatesSettings(page);
  await page.locator('[data-template-id="translate"] [data-template-star]').click();
  await expect(page.locator('[data-template-id="translate"]')).toHaveAttribute("data-starred", "true");
  await page.locator('[data-template-id="file-note"] [data-template-star]').click();
  expect(await invoked(page, "prompts_meta_set")).toEqual([
    { slug: "translate", favorite: "star" },
    { slug: "file-note", favorite: null },
  ]);
  // Close Settings and look at a new chat.
  await page.locator("[data-settings-nav]").locator("xpath=../..").getByRole("button").first().click();
  await openWorkspace(page, null);
  await expect(page.locator('[data-template-card="translate"]')).toBeVisible();
  await expect(page.locator('[data-template-card="file-note"]')).toHaveCount(0);

  await page.locator("[data-composer-plus]").click();
  await page.locator("[data-plus-template]").click();
  await expect(page.locator('[data-plus-template-item="translate"]')).toBeVisible();
  await expect(page.locator('[data-plus-template-item="file-note"]')).toHaveCount(0);
});

test("Duplicate writes a copy under a free name", async ({ page }) => {
  await openApp(page, seedTemplates);
  await openTemplatesSettings(page);
  await page.locator('[data-template-row][data-template-id="file-note"]').click();
  await page.locator("[data-template-duplicate]").click();
  const saved = (await invoked(page, "prompts_save"))[0];
  expect(saved.slug).toBe("");
  expect(saved.name).toBe("File note copy");
  expect(saved.body).toBe("Turn the notes into a file note.");
  expect(saved.hint).toBe("Dictate or paste your notes");
  // The editor carries on in the copy.
  await expect(page.locator("[data-template-editor]")).toHaveAttribute("data-template-id", "file-note-copy");
  await expect(page.locator('[data-template-field="name"]')).toHaveValue("File note copy");
});

test("deleting a template removes its file and takes it off the chat it was on", async ({ page }) => {
  await openApp(page, seedTemplates);
  await openWorkspace(page, null);
  await page.locator('[data-template-card="file-note"]').click();
  await expect(chip(page, "file-note")).toBeVisible();

  await openTemplatesSettings(page);
  await page.locator('[data-template-row][data-template-id="file-note"]').click();
  await page.locator("[data-template-delete]").click();
  await page.locator("[data-template-delete-yes]").click();
  await expect(page.locator('[data-template-row][data-template-id="file-note"]')).toHaveCount(0);
  expect(await invoked(page, "prompts_delete")).toEqual([{ slug: "file-note" }]);
  await expect(chip(page, "file-note")).toHaveCount(0);
});

test("a file dropped into the folder shows up when the window comes forward", async ({ page }) => {
  await openApp(page, seedTemplates);
  await openWorkspace(page, null);
  await expect(page.locator("[data-template-card]")).toHaveCount(2);
  await page.evaluate(() => {
    window.__FOLDER.push({
      id: "attendance-note", name: "Attendance note", description: "A note of a call", hint: "", tags: [],
      body: "Write an attendance note.", favorite: "star", builtin: false, updatedAt: 1,
    });
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.locator('[data-template-card="attendance-note"]')).toBeVisible();
});

test("the picker's last row opens Settings on Templates", async ({ page }) => {
  await openApp(page, seedTemplates);
  await openWorkspace(page, null);
  await input(page).focus();
  await input(page).press("/");
  await page.locator("[data-template-manage]").click();
  await expect(page.locator("[data-templates-settings]")).toBeVisible();
});

test("the right-hand panel no longer has a prompt library", async ({ page }) => {
  await openApp(page, seedTemplates);
  await page.locator("[data-more-menu-button]").click();
  const menu = page.locator("[data-more-menu]");
  await expect(menu).toContainText("Templates…");
  await expect(menu).not.toContainText("Prompt library");
  await menu.locator('[data-more-panel="watches"]').click();
  await expect(page.getByRole("button", { name: "Prompts", exact: true })).toHaveCount(0);
});
