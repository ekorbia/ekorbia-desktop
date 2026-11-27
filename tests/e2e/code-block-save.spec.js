// Save… on a code block in a reply (ui/markdown.jsx): a file the model
// wrote in its answer can be saved as that file, at a place the person
// picks in the save dialog. The model cannot write to disk by itself; this
// is the person saving what they were shown.
//
// The file-name rule is pinned by the codeBlockFileName node tests and the
// write by the Rust tests (files/commands.rs). Here: the button, what it
// asks, and what it hands to Rust.

const { test, expect } = require("@playwright/test");
const { openApp, openWorkspace } = require("./helpers/app");

const FENCE = "```";
const REPLY =
  `Here are the figures:\n\n${FENCE}csv\nitem,fee\nDrafting,4500\nFiling,120\n${FENCE}\n\n` +
  `And a script to total them:\n\n${FENCE}python\nimport csv\n\nprint(sum(int(r["fee"]) for r in csv.DictReader(open("data.csv"))))\n${FENCE}\n\n` +
  `And a note with no language:\n\n${FENCE}\nKeep the receipts.\n${FENCE}\n`;

test.describe("in a mounted reply", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tests/e2e/fixtures/playwright.html");
    await page.waitForFunction(() => window.__JSX_READY === true);
  });

  // Mount the reply with a save dialog that answers `path` (null = cancelled).
  const mount = (page, path, props = {}) =>
    page.evaluate(({ content, path, props }) => {
      window.__SAVE_ASKED = [];
      window.__TAURI__.dialog = {
        save: async (opts) => {
          window.__SAVE_ASKED.push(opts);
          return path;
        },
      };
      window.__INVOKE_RESPONSES.text_file_save = () => undefined;
      window.__TEST_MOUNT("MarkdownMessage", { content, ...props });
    }, { content: REPLY, path, props });

  const blocks = (page) => page.locator("#test-root pre.ek-code");
  const saved = (page) =>
    page.evaluate(() => window.__INVOKES.filter((c) => c.cmd === "text_file_save").map((c) => c.args));

  test("every code block has Save… and Copy", async ({ page }) => {
    await mount(page, "/x/data.csv");
    await expect(blocks(page)).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(blocks(page).nth(i).locator(".ek-code-actions button")).toHaveText(["Save…", "Copy"]);
    }
    await expect(blocks(page).first().getByRole("button", { name: "Save this as a file" })).toBeVisible();
  });

  test("Save… asks where, suggesting a name for the language, then hands Rust the block's text", async ({ page }) => {
    await mount(page, "/Users/you/Documents/figures.csv");
    const save = blocks(page).nth(0).locator(".ek-save-btn");
    await save.click();
    await expect(save).toHaveText("Saved");
    const asked = await page.evaluate(() => window.__SAVE_ASKED);
    expect(asked).toHaveLength(1);
    expect(asked[0].defaultPath).toBe("data.csv");
    // No filter: the person may give it any name and extension.
    expect(asked[0].filters).toBeUndefined();
    // The text exactly as written: no fence, no colouring markup, one final newline.
    expect(await saved(page)).toEqual([
      { path: "/Users/you/Documents/figures.csv", contents: "item,fee\nDrafting,4500\nFiling,120\n" },
    ]);
    // The label goes back, ready for another save.
    await expect(save).toHaveText("Save…");
  });

  test("each block saves its own text under its own suggested name", async ({ page }) => {
    await mount(page, "/Users/you/Documents/out");
    await blocks(page).nth(1).locator(".ek-save-btn").click();
    await blocks(page).nth(2).locator(".ek-save-btn").click();
    await expect.poll(async () => (await saved(page)).length).toBe(2);
    const asked = await page.evaluate(() => window.__SAVE_ASKED.map((o) => o.defaultPath));
    // A block with no stated language is plain text, whatever the colouring guessed.
    expect(asked).toEqual(["script.py", "text.txt"]);
    const sent = await saved(page);
    expect(sent[0].contents).toBe('import csv\n\nprint(sum(int(r["fee"]) for r in csv.DictReader(open("data.csv"))))\n');
    expect(sent[1].contents).toBe("Keep the receipts.\n");
  });

  test("cancelling the dialog writes nothing and changes nothing", async ({ page }) => {
    await mount(page, null);
    const save = blocks(page).nth(0).locator(".ek-save-btn");
    await save.click();
    await page.waitForFunction(() => window.__SAVE_ASKED.length === 1);
    await page.waitForTimeout(150);
    expect(await saved(page)).toEqual([]);
    await expect(save).toHaveText("Save…");
  });

  test("a write that fails says so on the button", async ({ page }) => {
    await mount(page, "/Volumes/Gone/data.csv");
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.text_file_save = () => { throw new Error("could not write /Volumes/Gone/data.csv"); };
    });
    const save = blocks(page).nth(0).locator(".ek-save-btn");
    await save.click();
    await expect(save).toHaveText("Not saved");
    await expect(save).toHaveText("Save…");
  });

  test("a reply still arriving has no buttons; they appear when it is complete", async ({ page }) => {
    await mount(page, "/x/data.csv", { streaming: true });
    await expect(page.locator("#test-root")).toContainText("item,fee");
    await expect(page.locator("#test-root .ek-code-actions")).toHaveCount(0);
    await page.evaluate((content) => window.__TEST_RERENDER("MarkdownMessage", { content, streaming: false }), REPLY);
    await expect(blocks(page).first().locator(".ek-save-btn")).toBeVisible();
    // Rendering again does not stack a second set.
    await page.evaluate((content) => window.__TEST_RERENDER("MarkdownMessage", { content, streaming: false, highlightRegex: null }), REPLY);
    await expect(blocks(page).first().locator(".ek-code-actions")).toHaveCount(1);
  });

  test("where there is no save dialog, only Copy is offered", async ({ page }) => {
    await page.evaluate((content) => {
      delete window.__TAURI__.dialog;
      window.__TEST_MOUNT("MarkdownMessage", { content });
    }, REPLY);
    await expect(blocks(page).first().locator(".ek-code-actions button")).toHaveText(["Copy"]);
  });

  test("a reply cannot plant a name: the suggestion comes only from the known list", async ({ page }) => {
    const sneaky = `${FENCE}../../.zshrc\nexport X=1\n${FENCE}\n\n<pre class="ek-code" data-fence="/etc/passwd"><code>root</code></pre>`;
    await page.evaluate(({ content }) => {
      window.__SAVE_ASKED = [];
      window.__TAURI__.dialog = { save: async (o) => { window.__SAVE_ASKED.push(o); return null; } };
      window.__TEST_MOUNT("MarkdownMessage", { content });
    }, { content: sneaky });
    const all = blocks(page);
    const n = await all.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await all.nth(i).locator(".ek-save-btn").click();
    await page.waitForFunction((n) => window.__SAVE_ASKED.length === n, n);
    const names = await page.evaluate(() => window.__SAVE_ASKED.map((o) => o.defaultPath));
    for (const name of names) expect(name).toBe("text.txt");
  });
});

// In the real app, under its own stylesheet and content policy: the buttons
// are on show without hovering, drawn in the interface font, and work.
test("in the app: Save… is on show on a code block, in the app's look, and saves", async ({ page }) => {
  await openApp(page, () => {
    const R = window.__INVOKE_RESPONSES;
    const now = Math.floor(Date.now() / 1000);
    const F = "```";
    window.__SAVE_ASKED = [];
    window.__TAURI__.dialog = {
      save: async (o) => { window.__SAVE_ASKED.push(o); return "/Users/you/Documents/figures.csv"; },
    };
    R.text_file_save = () => undefined;
    R.db_load_chats = () => [
      { id: "c1", title: "Fee table", model: "gemma4-12b", spaceId: null, createdAt: now - 500, updatedAt: now - 100 },
    ];
    R.db_load_messages = () => [
      { id: "m1", role: "user", content: "Give me the fees as a CSV.", model: "gemma4-12b", time: "09:41", seq: 1 },
      { id: "m2", role: "assistant", content: `Here it is:\n\n${F}csv\nitem,fee\nDrafting,4500\n${F}\n`, model: "gemma4-12b", time: "09:41", seq: 2 },
    ];
  });
  const violations = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await openWorkspace(page, null);
  await page.locator('[data-chat-row][data-chat-id="c1"]').click();

  const block = page.locator("[data-chat-scroller] pre.ek-code");
  await expect(block).toHaveCount(1);
  const save = block.locator(".ek-save-btn");
  const copy = block.locator(".ek-copy-btn");
  await expect(save).toBeVisible();
  for (const btn of [save, copy]) {
    const style = await btn.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { font: cs.fontFamily.split(",")[0], size: parseFloat(cs.fontSize), upper: cs.textTransform, opacity: cs.opacity };
    });
    expect(style.font).not.toMatch(/mono|menlo|courier/i);
    expect(style.size).toBeGreaterThanOrEqual(11);
    expect(style.upper).not.toBe("uppercase");
    // Shown without hovering over the block.
    expect(style.opacity).toBe("1");
  }
  // The buttons sit in the band above the code, not over its first line.
  const codeTop = await block.locator("code").evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getClientRects()[0].top;
  });
  const btnBox = await save.boundingBox();
  expect(btnBox.y + btnBox.height).toBeLessThanOrEqual(codeTop + 1);

  await save.click();
  await expect(save).toHaveText("Saved");
  const sent = await page.evaluate(() => window.__INVOKES.filter((c) => c.cmd === "text_file_save").map((c) => c.args));
  expect(sent).toEqual([{ path: "/Users/you/Documents/figures.csv", contents: "item,fee\nDrafting,4500\n" }]);
  expect(await page.evaluate(() => window.__SAVE_ASKED[0].defaultPath)).toBe("data.csv");
  expect(violations).toEqual([]);
});
