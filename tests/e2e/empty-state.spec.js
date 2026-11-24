// A new chat (ui/chat.jsx ChatPane, with TemplateCards from
// ui/templates.jsx).
//
// It asks "What do you need?" and offers the starred templates as cards —
// up to six, each with its one-line description. Choosing a card turns
// that template on for the chat; "All templates" opens the full list.
// (This replaced a time-of-day greeting and six fixed hobby cards.)

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const TEMPLATES = [
  { id: "translate", name: "Translate", description: "Into the language you name", favorite: null },
  { id: "file-note", name: "File note", description: "Rough or dictated notes into a note for the file", favorite: "star" },
  { id: "summarise-a-document", name: "Summarise a document", description: "The main points, grouped by section", favorite: "star" },
  // Starred with a colour by an older version: still starred.
  { id: "old-favourite", name: "Board paper", description: "", favorite: "amber" },
  { id: "notes-1", name: "Downloads notes", _virtual: true, favorite: "star" },
];

async function mountEmpty(page, props = {}) {
  await page.evaluate(
    ({ templates, props }) => {
      window.__USED = [];
      window.__ALL = 0;
      const host = document.getElementById("test-root");
      if (window.__TEST_ROOT) { try { window.__TEST_ROOT.unmount(); } catch (_) {} }
      host.innerHTML = "";
      const root = ReactDOM.createRoot(host);
      root.render(
        React.createElement(window.ChatPane, {
          chat: { id: "c1", title: "New chat", messages: [] },
          model: { id: "gemma4-12b", name: "Balanced" },
          searchQuery: "",
          isStreaming: false,
          templates,
          activeTemplateIds: props.activeTemplateIds || [],
          onUseTemplate: (id) => window.__USED.push(id),
          onAllTemplates: () => { window.__ALL += 1; },
        }),
      );
      window.__TEST_ROOT = root;
    },
    { templates: props.templates || TEMPLATES, props },
  );
  await expect(page.locator("[data-empty-chat]")).toBeVisible();
}

test("a new chat asks what you need and offers the starred templates", async ({ page }) => {
  await mountEmpty(page);
  const empty = page.locator("[data-empty-chat]");
  await expect(empty).toContainText("What do you need?");
  await expect(empty).toContainText("Ask a question below, or start from a template.");
  // No greeting, no hobby cards.
  await expect(empty).not.toContainText(/Good (morning|afternoon|evening)/);
  await expect(empty).not.toContainText("Brainstorm");

  // The starred ones, by name; not the unstarred, not a one-chat row.
  const cards = page.locator("[data-template-card]");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("Board paper");
  await expect(cards.nth(1)).toContainText("File note");
  await expect(cards.nth(1)).toContainText("Rough or dictated notes into a note for the file");
  await expect(cards.nth(2)).toContainText("Summarise a document");
  await expect(page.locator('[data-template-card="translate"]')).toHaveCount(0);
});

test("choosing a card turns that template on; the card shows it is on", async ({ page }) => {
  await mountEmpty(page);
  await page.locator('[data-template-card="file-note"]').click();
  expect(await page.evaluate(() => window.__USED)).toEqual(["file-note"]);

  await mountEmpty(page, { activeTemplateIds: ["file-note"] });
  await expect(page.locator('[data-template-card="file-note"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-template-card="summarise-a-document"]')).toHaveAttribute("aria-pressed", "false");
});

test("at most six cards, and a way to the rest", async ({ page }) => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    id: `t${i}`, name: `Template ${i}`, description: "", favorite: "star",
  }));
  await mountEmpty(page, { templates: many });
  await expect(page.locator("[data-template-card]")).toHaveCount(6);
  await page.locator("[data-template-all]").click();
  expect(await page.evaluate(() => window.__ALL)).toBe(1);
});

test("with nothing starred there are no cards, only the way to the list", async ({ page }) => {
  await mountEmpty(page, { templates: [{ id: "a", name: "A", description: "", favorite: null }] });
  await expect(page.locator("[data-template-card]")).toHaveCount(0);
  await expect(page.locator("[data-template-all]")).toBeVisible();
});

test("the screen goes once there is a message", async ({ page }) => {
  await page.evaluate((templates) => {
    window.__TEST_MOUNT("ChatPane", {
      chat: { id: "c1", title: "Notice", messages: [{ id: "u1", role: "user", content: "hello" }] },
      model: { id: "gemma4-12b", name: "Balanced" },
      searchQuery: "",
      isStreaming: false,
      templates,
    });
  }, TEMPLATES);
  await expect(page.getByText("hello")).toBeVisible();
  await expect(page.locator("[data-empty-chat]")).toHaveCount(0);
});
