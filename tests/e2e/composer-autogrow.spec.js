// Composer auto-grow (ui/chat.jsx Composer + useStickToBottomOnResize).
//
// Pins:
//   • The text box starts at two lines and grows to fit its content —
//     soft-wrapped lines included, not just newlines — with no inner
//     scrollbar until the cap.
//   • The cap is 40% of the window; past it the box scrolls inside.
//   • It shrinks back after a send, and re-measures when its width changes.
//   • A chat scrolled to the bottom stays at the bottom when the pane above
//     the composer gets shorter; a reader who scrolled up keeps their place.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

async function mountComposer(page, width = 700) {
  await page.evaluate((width) => {
    document.getElementById("test-root").style.width = `${width}px`;
    window.__TEST_MOUNT("Composer", {
      model: { id: "gemma4-12b", name: "Gemma", color: "#7ee787" },
      onModelChange: () => undefined,
      onSend: () => undefined,
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
  }, width);
  const ta = page.locator("[data-composer-input]");
  await expect(ta).toBeVisible();
  return ta;
}

const box = (ta) =>
  ta.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    cap: window.innerHeight * 0.4,
  }));

const PARAGRAPH = "Rename every melee unit after a famous general and make walls cheaper. ".repeat(12).trim();

test("grows line by line with no inner scrollbar", async ({ page }) => {
  const ta = await mountComposer(page);
  const start = await box(ta);
  expect(start.height).toBeGreaterThanOrEqual(44);
  expect(start.height).toBeLessThan(60);

  await ta.fill(["one", "two", "three", "four", "five", "six"].join("\n"));
  const six = await box(ta);
  // 6 lines × 14px × 1.55 ≈ 130px of text.
  expect(six.height).toBeGreaterThan(125);
  expect(six.scrollHeight).toBeLessThanOrEqual(six.clientHeight + 1);
});

test("soft-wrapped text grows the box too", async ({ page }) => {
  const ta = await mountComposer(page, 400);
  const start = await box(ta);
  // No newlines — wrapping alone must grow it. A third of PARAGRAPH stays
  // under the cap at this width, so the box should fit it exactly.
  await ta.fill(PARAGRAPH.slice(0, Math.floor(PARAGRAPH.length / 3)));
  const grown = await box(ta);
  expect(grown.height).toBeGreaterThan(start.height + 60);
  expect(grown.scrollHeight).toBeLessThanOrEqual(grown.clientHeight + 1);
});

test("caps at 40% of the window, then scrolls inside", async ({ page }) => {
  const ta = await mountComposer(page);
  await ta.fill(Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));
  const capped = await box(ta);
  expect(Math.abs(capped.height - capped.cap)).toBeLessThanOrEqual(2);
  expect(capped.scrollHeight).toBeGreaterThan(capped.clientHeight + 100);
});

test("shrinks back to two lines after a send", async ({ page }) => {
  const ta = await mountComposer(page);
  const start = await box(ta);
  await ta.fill("first\nsecond\nthird\nfourth\nfifth");
  expect((await box(ta)).height).toBeGreaterThan(start.height + 40);
  await ta.press("Enter");
  await expect(ta).toHaveValue("");
  await expect.poll(async () => (await box(ta)).height).toBe(start.height);
});

test("re-measures when its width changes", async ({ page }) => {
  const ta = await mountComposer(page, 800);
  await ta.fill(PARAGRAPH);
  const wide = await box(ta);
  await page.evaluate(() => { document.getElementById("test-root").style.width = "350px"; });
  await expect.poll(async () => (await box(ta)).height).toBeGreaterThan(wide.height + 40);
});

// ── Chat stays pinned while the pane shrinks ──────────────────────────────

async function mountLongChat(page) {
  await page.evaluate(() => {
    const host = document.getElementById("test-root");
    Object.assign(host.style, { display: "flex", flexDirection: "column", height: "600px" });
    const messages = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ id: `u${i}`, role: "user", content: `Question ${i}` });
      messages.push({ id: `a${i}`, role: "assistant", content: `Answer ${i}. `.repeat(20), model: "gemma4-12b" });
    }
    window.__TEST_MOUNT("ChatPane", {
      chat: { id: "c1", title: "Long chat", messages },
      model: { id: "gemma4-12b", name: "Gemma", color: "#7ee787" },
    });
  });
  const scroller = page.locator("#test-root [data-chat-scroller]");
  await expect(scroller).toBeVisible();
  return scroller;
}

const distanceFromBottom = (scroller) =>
  scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

test("a chat at the bottom stays at the bottom when the pane shrinks", async ({ page }) => {
  const scroller = await mountLongChat(page);
  // Put the reader at the bottom explicitly: ChatPane's own scroll-on-open
  // can land a few px short when content finishes rendering a beat later
  // (within the hook's 8px "at bottom" tolerance, but not this assertion's).
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => distanceFromBottom(scroller)).toBeLessThanOrEqual(1);
  // What a growing composer does to the pane above it.
  await page.evaluate(() => { document.getElementById("test-root").style.height = "380px"; });
  await expect.poll(() => distanceFromBottom(scroller)).toBeLessThanOrEqual(1);
});

test("a reader who scrolled up keeps their place when the pane shrinks", async ({ page }) => {
  const scroller = await mountLongChat(page);
  await scroller.evaluate((el) => { el.scrollTop = 200; });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  await page.evaluate(() => { document.getElementById("test-root").style.height = "380px"; });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(200);
});
