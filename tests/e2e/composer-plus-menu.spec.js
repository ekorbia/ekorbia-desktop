// The message box's controls (Composer in ui/chat.jsx): the + menu that
// replaced a row of four icons and the model picker, the round send and
// stop buttons, the placeholder, and the note line under the box.
//
// There is no model picker here any more: a chat uses its workspace's
// model, or the app default (pinned against the real app in
// models.spec.js).

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

async function mountComposer(page, opts = {}) {
  await page.evaluate((opts) => {
    window.__C = { files: 0, folder: 0, capture: 0, thinking: [], sent: [], stop: 0 };
    const host = document.getElementById("test-root");
    if (window.__TEST_ROOT) { try { window.__TEST_ROOT.unmount(); } catch (_) {} }
    host.innerHTML = "";
    // The box sits at the bottom of the window, as it does in the app, so
    // the menu has room to open upwards.
    host.style.cssText = "display:flex;flex-direction:column;justify-content:flex-end;height:100vh";
    const root = ReactDOM.createRoot(host);
    const props = {
      model: { id: "gemma4-12b", name: "Balanced" },
      onSend: (t) => { window.__C.sent.push(t); },
      isStreaming: !!opts.isStreaming,
      onStop: () => { window.__C.stop += 1; },
      prompts: [{ id: "summarize", name: "Summarize", body: "Summarise.", tags: [] }],
      onPickPrompt: () => {},
      attachedPrompts: [],
      attachments: [],
      onAttachFile: () => { window.__C.files += 1; },
      onAttachFolder: () => { window.__C.folder += 1; },
      ephemeral: !!opts.ephemeral,
      note: opts.note === undefined ? "Answered on this Mac. Check anything important against its source." : opts.note,
      thinking: opts.thinking === undefined ? false : opts.thinking,
      onToggleThinking: (on) => { window.__C.thinking.push(on); },
      documentCount: opts.documentCount || 0,
    };
    if (!opts.noCapture) props.onCapture = () => { window.__C.capture += 1; };
    root.render(React.createElement(window.Composer, props));
    window.__TEST_ROOT = root;
  }, opts);
  await expect(page.locator("[data-composer-input]")).toBeVisible();
}

const c = (page) => page.evaluate(() => window.__C);
const menu = (page) => page.locator("[data-composer-plus-menu]");

test("the box has a + button, a send button and no model picker", async ({ page }) => {
  await mountComposer(page);
  await expect(page.locator("[data-composer-plus]")).toBeVisible();
  await expect(page.locator("[data-composer-send]")).toBeVisible();
  // No model id anywhere in the box.
  await expect(page.locator("[data-composer]")).not.toContainText("gemma4-12b");
  await expect(menu(page)).toHaveCount(0);
});

test("+ opens a menu with words: files, a folder, a template, a capture, thinking", async ({ page }) => {
  await mountComposer(page);
  const plus = page.locator("[data-composer-plus]");
  await expect(plus).toHaveAttribute("aria-expanded", "false");
  await plus.click();
  await expect(plus).toHaveAttribute("aria-expanded", "true");
  await expect(menu(page).locator("[data-plus-files]")).toContainText("Add files…");
  await expect(menu(page).locator("[data-plus-folder]")).toContainText("Add a folder…");
  await expect(menu(page).locator("[data-plus-template]")).toContainText("Use a template");
  await expect(menu(page).locator("[data-plus-capture]")).toContainText("Capture part of the screen");
  await expect(menu(page).locator("[data-plus-thinking]")).toContainText("Take more time to think");
});

test("Add files and Add a folder run and close the menu", async ({ page }) => {
  await mountComposer(page);
  await page.locator("[data-composer-plus]").click();
  await page.locator("[data-plus-files]").click();
  await expect(menu(page)).toHaveCount(0);
  await page.locator("[data-composer-plus]").click();
  await page.locator("[data-plus-folder]").click();
  const s = await c(page);
  expect([s.files, s.folder]).toEqual([1, 1]);
});

test("Use a template opens the same picker as typing a slash", async ({ page }) => {
  await mountComposer(page);
  await page.locator("[data-composer-plus]").click();
  await page.locator("[data-plus-template]").click();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator("[data-prompt-picker]")).toBeVisible();
  await expect(page.locator("[data-prompt-picker]")).toContainText("Summarize");
});

test("Capture part of the screen starts a capture; it is absent when there is no way to start one", async ({ page }) => {
  await mountComposer(page);
  await page.locator("[data-composer-plus]").click();
  await page.locator("[data-plus-capture]").click();
  expect((await c(page)).capture).toBe(1);
  await mountComposer(page, { noCapture: true });
  await page.locator("[data-composer-plus]").click();
  await expect(page.locator("[data-plus-capture]")).toHaveCount(0);
});

test("Take more time to think reports the new setting and stays open", async ({ page }) => {
  await mountComposer(page, { thinking: false });
  await page.locator("[data-composer-plus]").click();
  const row = page.locator("[data-plus-thinking]");
  await expect(row).toHaveAttribute("aria-checked", "false");
  await row.click();
  expect((await c(page)).thinking).toEqual([true]);
  // A switch, not a command: the menu stays so the result can be seen.
  await expect(menu(page)).toBeVisible();
});

test("the thinking switch shows on, and is absent when there is nothing to switch", async ({ page }) => {
  await mountComposer(page, { thinking: true });
  await page.locator("[data-composer-plus]").click();
  await expect(page.locator("[data-plus-thinking]")).toHaveAttribute("aria-checked", "true");
  await mountComposer(page, { thinking: null });
  await page.locator("[data-composer-plus]").click();
  await expect(page.locator("[data-plus-thinking]")).toHaveCount(0);
});

test("a private chat takes no attachments or captures", async ({ page }) => {
  await mountComposer(page, { ephemeral: true });
  await page.locator("[data-composer-plus]").click();
  await expect(page.locator("[data-plus-files]")).toHaveCount(0);
  await expect(page.locator("[data-plus-folder]")).toHaveCount(0);
  await expect(page.locator("[data-plus-capture]")).toHaveCount(0);
  await expect(page.locator("[data-plus-template]")).toBeVisible();
});

test("Escape and a click elsewhere close the menu", async ({ page }) => {
  await mountComposer(page);
  await page.locator("[data-composer-plus]").click();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await page.locator("[data-composer-plus]").click();
  await expect(menu(page)).toBeVisible();
  await page.locator("[data-composer-note]").click();
  await expect(menu(page)).toHaveCount(0);
});

test("send is off until there is text, then sends it", async ({ page }) => {
  await mountComposer(page);
  const send = page.locator("[data-composer-send]");
  await expect(send).toBeDisabled();
  await page.locator("[data-composer-input]").fill("What does clause 7 say?");
  await expect(send).toBeEnabled();
  await send.click();
  expect((await c(page)).sent).toEqual(["What does clause 7 say?"]);
});

test("while a reply is arriving the button stops it", async ({ page }) => {
  await mountComposer(page, { isStreaming: true });
  await expect(page.locator("[data-composer-send]")).toHaveCount(0);
  await page.locator("[data-composer-stop]").click();
  expect((await c(page)).stop).toBe(1);
});

test("the placeholder names the documents attached, or just invites a question", async ({ page }) => {
  await mountComposer(page);
  await expect(page.locator("[data-composer-input]")).toHaveAttribute("placeholder", "Ask anything");
  await mountComposer(page, { documentCount: 14 });
  await expect(page.locator("[data-composer-input]")).toHaveAttribute("placeholder", "Ask about the 14 documents attached");
});

test("the note under the box is shown as given, and omitted when empty", async ({ page }) => {
  await mountComposer(page);
  await expect(page.locator("[data-composer-note]")).toHaveText("Answered on this Mac. Check anything important against its source.");
  await mountComposer(page, { note: "" });
  await expect(page.locator("[data-composer-note]")).toHaveCount(0);
});
