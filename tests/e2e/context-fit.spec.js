// Context-window fit: what the user sees when a message is too long for
// the model (see contextPreflight / describeContextOverflow in ui/utils.js;
// their decision logic is node-tested in ui/__tests__/utils.test.js).
//
// Pins:
//   • Composer: when onSend resolves `false` (main.jsx's pre-flight refused
//     the message), the text comes BACK — nothing typed is lost. A normal
//     send still clears, and text typed while the send was deciding is
//     never overwritten.
//   • Overlay: a server's "prompt too long" rejection reads as plain
//     language with both sizes, not raw JSON. This is the exact error body
//     a user hit pasting the Tessera4X mod brief.

const { test, expect } = require("@playwright/test");

const LLAMA_OVERFLOW =
  'Endpoint /v1/chat/completions returned 400 Bad Request: {"error":{"code":400,' +
  '"message":"request (8209 tokens) exceeds the available context size (8192 tokens), ' +
  'try increasing it","type":"exceed_context_size_error","n_prompt_tokens":8209,"n_ctx":8192}}';

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

// Mount the Composer with an onSend that records the text and returns
// whatever window.__SEND_RESULT holds at call time (a value or a Promise).
async function mountComposer(page) {
  await page.evaluate(() => {
    window.__SENT = [];
    window.__TEST_MOUNT("Composer", {
      model: { id: "gemma4-12b", name: "Gemma", color: "#7ee787" },
      onModelChange: () => undefined,
      onSend: (t) => {
        window.__SENT.push(t);
        return window.__SEND_RESULT;
      },
      isStreaming: false,
      onStop: () => undefined,
      prompts: [],
      onPickPrompt: () => undefined,
      attachedPrompts: [],
      onDetachPrompt: () => undefined,
      attachments: [],
      onAttachFile: () => undefined,
      onAttachFolder: () => undefined,
      onDetachAttachment: () => undefined,
      onReindexAttachment: () => undefined,
      modelHasVision: false,
      modelHasTools: false,
      ephemeral: false,
    });
  });
}

test("a refused send puts the text back in the composer", async ({ page }) => {
  await mountComposer(page);
  await page.evaluate(() => { window.__SEND_RESULT = Promise.resolve(false); });
  const ta = page.locator("#test-root textarea");
  const long = "The whole mod brief. ".repeat(200).trim();
  await ta.fill(long);
  await ta.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__SENT.length)).toBe(1);
  await expect(ta).toHaveValue(long);
});

test("a normal send still clears the composer", async ({ page }) => {
  await mountComposer(page);
  await page.evaluate(() => { window.__SEND_RESULT = Promise.resolve(undefined); });
  const ta = page.locator("#test-root textarea");
  await ta.fill("Rename the Warrior to Brawler.");
  await ta.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__SENT.length)).toBe(1);
  await expect(ta).toHaveValue("");
});

test("text typed while the send decides is never overwritten", async ({ page }) => {
  await mountComposer(page);
  // Hold the decision open until the test releases it.
  await page.evaluate(() => {
    window.__SEND_RESULT = new Promise((resolve) => { window.__RELEASE = resolve; });
  });
  const ta = page.locator("#test-root textarea");
  await ta.fill("first message");
  await ta.press("Enter");
  await expect(ta).toHaveValue("");
  await ta.fill("something new");
  await page.evaluate(() => window.__RELEASE(false));
  // Give the restore a chance to run, then confirm it stood down.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  await expect(ta).toHaveValue("something new");
});

test("overlay explains a too-long prompt in plain words", async ({ page }) => {
  await page.evaluate((err) => {
    window.__INVOKE_RESPONSES.llm_chat_stream = () => { throw err; };
    window.__TEST_MOUNT("QuickQuery", {});
  }, LLAMA_OVERFLOW);
  const input = page.locator("input").first();
  await input.fill("Make a mod from this brief");
  await input.press("Enter");
  const root = page.locator("#test-root");
  await expect(root).toContainText(
    "This message is 8,209 tokens, and the model's context window holds 8,192. " +
      "Shorten it, or split it into smaller parts.",
  );
  await expect(root).not.toContainText("exceed_context_size_error");
});
