// The row under a message (ui/chat.jsx Message): Copy, Try again and Save
// as Word on a reply; Edit on a message of yours. And "Save as Word…" in
// the chat's menu, for the whole conversation.
//
// Saving as Word hands Rust three XML parts (`docx_save`); what is in them
// is pinned by the docxParts node tests, and the packaging by the Rust
// tests. Here: that the right text goes to the right command, at the path
// the person chose.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const REPLY = {
  id: "a1",
  role: "assistant",
  content: "## Notice period\n\nThe period is **90 days**.\n\n1. Give notice in writing.\n2. Deliver it to the address in clause 27.",
  model: "gemma4-12b",
};
const YOURS = { id: "u1", role: "user", content: "What is the notice period?" };

// Mount one message with a save dialog that answers `path` (null = cancelled).
const mount = (page, props, path = "/Users/you/Documents/notice.docx") =>
  page.evaluate(({ props, path }) => {
    window.__SAVE_ASKED = [];
    window.__TAURI__.dialog = {
      save: async (opts) => {
        window.__SAVE_ASKED.push(opts);
        return path;
      },
    };
    window.__INVOKE_RESPONSES.docx_save = () => undefined;
    window.__TEST_MOUNT("Message", props);
  }, { props, path });

const action = (page, id) => page.locator(`#test-root [data-message-action="${id}"]`);

test("the last reply shows Copy, Try again and Save as Word without hovering", async ({ page }) => {
  // The fixture supplies onRetryMessage, which the chat passes only to the last reply.
  await mount(page, { m: REPLY, fileName: "notice-period" });
  const row = page.locator("#test-root [data-message-actions]");
  await expect(row.locator("button")).toHaveText(["Copy", "Try again", "Save as Word"]);
  await expect(row).toHaveCSS("opacity", "1");
  await action(page, "retry").click();
  await page.waitForFunction(() => (window.__TEST_CALLS.onRetryMessage || 0) === 1);
});

test("an earlier reply has Copy and Save as Word, shown on hover, and no Try again", async ({ page }) => {
  await page.evaluate((m) => {
    // Rendered directly: the fixture would otherwise add onRetryMessage.
    const host = document.getElementById("test-root");
    ReactDOM.createRoot(host).render(React.createElement(window.Message, { m, fileName: "x", onRetryMessage: null }));
  }, REPLY);
  const row = page.locator("#test-root [data-message-actions]");
  await expect(row.locator("button")).toHaveText(["Copy", "Save as Word"]);
  await expect(row).toHaveCSS("opacity", "0");
  await page.locator("#test-root").getByText("The period is").hover();
  await expect(row).toHaveCSS("opacity", "1");
});

test("a message of yours has Edit only", async ({ page }) => {
  await mount(page, { m: YOURS });
  await page.locator("#test-root").getByText("What is the notice period?").hover();
  await expect(page.locator("#test-root [data-message-actions] button")).toHaveText(["Edit"]);
});

test("a reply still streaming has no actions", async ({ page }) => {
  await mount(page, { m: { ...REPLY, streaming: true }, isStreaming: true });
  await expect(page.locator("#test-root")).toContainText("The period is");
  await expect(page.locator("#test-root [data-message-actions]")).toHaveCount(0);
});

test("Save as Word asks where, then hands Rust the reply as a document", async ({ page }) => {
  await mount(page, { m: REPLY, fileName: "notice-period" });
  await action(page, "save-word").click();
  await page.waitForFunction(() => window.__INVOKE_FIND("docx_save"));
  const asked = await page.evaluate(() => window.__SAVE_ASKED);
  expect(asked).toHaveLength(1);
  expect(asked[0].defaultPath).toBe("notice-period.docx");
  expect(asked[0].filters).toEqual([{ name: "Word document", extensions: ["docx"] }]);
  const sent = await page.evaluate(() => window.__INVOKES.find((c) => c.cmd === "docx_save").args);
  expect(sent.path).toBe("/Users/you/Documents/notice.docx");
  expect(Object.keys(sent.parts).sort()).toEqual(["document", "numbering", "styles"]);
  // The reply's own structure, not its Markdown marks.
  expect(sent.parts.document).toContain('<w:pStyle w:val="Heading2"/>');
  expect(sent.parts.document).toContain("<w:b/>");
  expect(sent.parts.document).toContain("90 days");
  expect(sent.parts.document).not.toContain("**");
  expect(sent.parts.document).not.toContain("## ");
  expect(sent.parts.numbering).toContain('<w:numFmt w:val="decimal"/>');
});

test("cancelling the dialog saves nothing", async ({ page }) => {
  await mount(page, { m: REPLY }, null);
  await action(page, "save-word").click();
  await page.waitForFunction(() => window.__SAVE_ASKED.length === 1);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => !!window.__INVOKE_FIND("docx_save"))).toBe(false);
});

test("Copy puts the reply's text on the clipboard and says so", async ({ page }) => {
  await mount(page, { m: REPLY });
  await page.evaluate(() => {
    window.__COPIED = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t) => { window.__COPIED = t; } },
    });
  });
  await action(page, "copy").click();
  await expect(action(page, "copy")).toHaveText("Copied");
  expect(await page.evaluate(() => window.__COPIED)).toBe(REPLY.content);
});

test("the chat's menu saves the whole conversation as Word or as Markdown", async ({ page }) => {
  await page.evaluate(({ reply, yours }) => {
    window.__TAURI__.dialog = { save: async () => "/Users/you/Documents/Notice period.docx" };
    window.__INVOKE_RESPONSES.chat_export_markdown = () =>
      "# Notice period\n\n## You\n\nWhat is the notice period?\n\n## Assistant\n\nThe period is **90 days**.\n";
    window.__INVOKE_RESPONSES.docx_save = () => undefined;
    window.__TEST_MOUNT("ChatPane", {
      chat: { id: "c1", title: "Notice period", messages: [yours, reply] },
      model: { id: "gemma4-12b", name: "Balanced" },
    });
  }, { reply: REPLY, yours: YOURS });
  await page.getByRole("button", { name: "Export chat" }).click();
  // Word first, then Markdown; the JSON export is gone.
  await expect(page.locator("[data-export]")).toHaveText(["Save as Word…", "Save as Markdown…"]);
  await page.locator('[data-export="word"]').click();
  await page.waitForFunction(() => window.__INVOKE_FIND("docx_save"));
  const read = await page.evaluate(() => window.__INVOKES.find((c) => c.cmd === "chat_export_markdown").args);
  expect(read).toEqual({ chatId: "c1" });
  const sent = await page.evaluate(() => window.__INVOKES.find((c) => c.cmd === "docx_save").args);
  expect(sent.path).toBe("/Users/you/Documents/Notice period.docx");
  expect(sent.parts.document).toContain('<w:pStyle w:val="Heading1"/>');
  expect(sent.parts.document).toContain("What is the notice period?");
  expect(sent.parts.document).toContain("90 days");
});
