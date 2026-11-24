// The quick-question panel (ui/overlay.jsx QuickQuery): what its top two
// rows show.
//
//   • Models are named plainly (Fast / Balanced / Most capable), by the
//     same rule as the main window, and the model that reads documents for
//     search is not offered.
//   • The microphone is the last thing in the input row in every state.
//     It used to sit left of a key hint that came and went, so it jumped
//     sideways when a list opened or an answer arrived.
//   • The key hint sits at the right end of the bar below, in words.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
  await page.evaluate(() => {
    try { localStorage.setItem("ekorbia.overlay.model", "gemma4-12b"); } catch (_) {}
    const R = window.__INVOKE_RESPONSES;
    R.system_profile = () => ({ totalRamBytes: 36 * 1024 * 1024 * 1024, platform: "macos", arch: "aarch64" });
    R.engine_catalog = () => ({
      version: 1,
      models: [
        { id: "gemma4-e4b", label: "Gemma 4 E4B", purpose: "chat", minRamGb: 8, totalBytes: 6.1e9, suggest: true, caps: {} },
        { id: "gemma4-12b", label: "Gemma 4 12B", purpose: "chat", minRamGb: 16, totalBytes: 7.2e9, suggest: true, recommended: true, caps: {} },
        { id: "gemma4-26b-a4b", label: "Gemma 4 26B (A4B)", purpose: "chat", minRamGb: 32, totalBytes: 15.4e9, suggest: true, caps: {} },
        { id: "nomic-embed-text", label: "Nomic Embed", purpose: "embed", minRamGb: 8, totalBytes: 3e8, suggest: true, caps: {} },
      ],
    });
    R.llm_list_models = () => ({
      models: ["gemma4-e4b", "gemma4-12b", "gemma4-26b-a4b", "nomic-embed-text", "my-own-model"].map((name) => ({ name, model: name, size: 5e9 })),
    });
    R.llm_chat_stream = (args) => {
      args.onChunk.__deliver({ type: "delta", text: "Ninety days." });
      args.onChunk.__deliver({ type: "done", doneReason: "stop" });
    };
    window.__TEST_MOUNT("QuickQuery", {});
  });
  await page.waitForFunction(
    () => (window.__EVENT_LISTENERS["selection:captured"] || []).length > 0,
  );
});

test("the model is named plainly, with the catalog's name behind it", async ({ page }) => {
  const chip = page.locator("[data-overlay-model]");
  await expect(chip.locator("[data-overlay-model-name]")).toHaveText("Balanced");
  await expect(chip).toHaveAttribute("title", "Gemma 4 12B");
});

test("the list names models plainly and leaves out the search model", async ({ page }) => {
  await page.locator("[data-overlay-model]").click();
  const rows = page.locator("[data-overlay-model-row]");
  await expect(rows).toHaveCount(4);
  await expect(page.locator('[data-overlay-model-row="gemma4-e4b"]')).toContainText("Fast");
  await expect(page.locator('[data-overlay-model-row="gemma4-e4b"]')).toContainText("Gemma 4 E4B");
  await expect(page.locator('[data-overlay-model-row="gemma4-26b-a4b"]')).toContainText("Most capable");
  // A model the catalog does not know keeps its own name.
  await expect(page.locator('[data-overlay-model-row="my-own-model"]')).toContainText("my-own-model");
  await expect(page.locator('[data-overlay-model-row="nomic-embed-text"]')).toHaveCount(0);

  await page.locator('[data-overlay-model-row="gemma4-26b-a4b"]').click();
  await expect(page.locator("[data-overlay-model-name]")).toHaveText("Most capable");
  expect(await page.evaluate(() => localStorage.getItem("ekorbia.overlay.model"))).toBe("gemma4-26b-a4b");
});

test("the key hint is in the bar below the input, in words", async ({ page }) => {
  const hint = page.locator("[data-overlay-hint]");
  await expect(hint).toHaveText("Return to ask · Esc to close");
  // It goes away while a list is open.
  await page.locator("[data-overlay-model]").click();
  await expect(hint).toHaveCount(0);
});

test("the microphone stays at the right edge of the input row in every state", async ({ page }) => {
  const mic = page.locator("[data-voice-mic]");
  // Dictation is macOS only; elsewhere there is no button to place.
  if ((await mic.count()) === 0) return;
  const rightEdge = async () => {
    const b = await mic.boundingBox();
    return Math.round(b.x + b.width);
  };
  const lastInRow = () =>
    mic.evaluate((el) => el.parentElement.lastElementChild === el || el.nextElementSibling === null);

  const idle = await rightEdge();
  expect(await lastInRow()).toBe(true);

  // A list open.
  await page.locator("[data-overlay-model]").click();
  await expect(page.locator("[data-overlay-model-row]").first()).toBeVisible();
  expect(await rightEdge()).toBe(idle);
  await page.locator("[data-overlay-model]").click();

  // An answer on screen.
  await page.locator("input").first().fill("What is the notice period?");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Ninety days.")).toBeVisible();
  expect(await rightEdge()).toBe(idle);
});
