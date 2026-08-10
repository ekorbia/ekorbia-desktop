// Continue chip for length-cut replies (ui/chat.jsx Message +
// ChatPane). When a provider ends generation with doneReason 'length'
// (token/ctx limit) the LAST assistant message grows a "Reply hit the
// length limit — Continue" chip; clicking fires onContinue (main.jsx
// sends a canned continuation with a tail-trimmed request window).
// Pins: the chip only appears on 'length', only on the last message,
// and never while a stream is running.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const CUT_MSG = {
  id: "a1",
  role: "assistant",
  content: "…and then the third step is to",
  model: "gemma4:12b",
  doneReason: "length",
};

test("length-cut reply shows the chip and click fires onContinue", async ({ page }) => {
  await page.evaluate((m) => {
    window.__TEST_MOUNT("Message", { m });
  }, CUT_MSG);
  const chip = page.locator("#test-root [data-continue-chip]");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Reply hit the length limit");
  await page.locator("#test-root [data-continue-button]").click();
  const calls = await page.evaluate(() => window.__TEST_CALLS.onContinue || 0);
  expect(calls).toBe(1);
});

test("naturally finished reply gets no chip", async ({ page }) => {
  await page.evaluate((m) => {
    window.__TEST_MOUNT("Message", { m: { ...m, doneReason: "stop" } });
  }, CUT_MSG);
  await expect(page.locator("#test-root [data-continue-chip]")).toHaveCount(0);
});

// NOTE: "no chip when onContinue is absent" can't be pinned at the
// Message level — the harness synthesizes a no-op for every tracked
// callback prop. The last-message gating is pinned via ChatPane below,
// which is where the real gate lives anyway.

test("chip hides while a stream is running", async ({ page }) => {
  await page.evaluate((m) => {
    window.__TEST_MOUNT("Message", { m, isStreaming: true });
  }, CUT_MSG);
  await expect(page.locator("#test-root [data-continue-chip]")).toHaveCount(0);
});

test("ChatPane gates the chip to the last assistant message", async ({ page }) => {
  await page.evaluate((cut) => {
    window.__TEST_MOUNT("ChatPane", {
      chat: {
        id: "c1",
        title: "Chat",
        messages: [
          { id: "u1", role: "user", content: "Tell me a long story" },
          // An OLD length-cut reply followed by a newer exchange — the
          // old one must NOT re-grow a chip.
          { ...cut, id: "a-old" },
          { id: "u2", role: "user", content: "continue" },
          { id: "a-new", role: "assistant", content: "The end.", doneReason: "stop" },
        ],
      },
      model: { id: "gemma4:12b", name: "Gemma", color: "#7ee787" },
    });
  }, CUT_MSG);
  await expect(page.locator("[data-continue-chip]")).toHaveCount(0);

  await page.evaluate((cut) => {
    window.__TEST_MOUNT("ChatPane", {
      chat: {
        id: "c2",
        title: "Chat",
        messages: [
          { id: "u1", role: "user", content: "Tell me a long story" },
          { ...cut },
        ],
      },
      model: { id: "gemma4:12b", name: "Gemma", color: "#7ee787" },
    });
  }, CUT_MSG);
  await expect(page.locator("[data-continue-chip]")).toBeVisible();
});
