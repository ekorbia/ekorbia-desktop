// Smoke tests for the in-composer slash-command prompt picker.
//
// The picker's contract:
//   • Typing `/` at line start (or after whitespace) opens the popover
//   • Library icon button opens the popover (synthesises a `/`)
//   • Clicking a row in the popover calls onPickPrompt(prompt) and
//     strips the `/query` from the textarea
//   • Esc closes the picker AND strips the slash
//   • Already-attached prompts are hidden from the picker
//
// The picker is a popover that anchors to the composer card; we assert
// on the data-prompt-picker attribute we set in chat.jsx so we don't
// have to know the exact DOM tree shape.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

// Mount Composer with a populated prompt library and a pick spy. The
// prompts shape mirrors what main.jsx sends — { id, name, body, tags,
// favorite, updated }. The picker only needs id + name + favorite.
async function mountWithPrompts(page, opts = {}) {
  await page.evaluate((init) => {
    window.__PICK_CALLS = [];
    const onPickSpy = (p) => window.__PICK_CALLS.push(p);
    const host = document.getElementById("test-root");
    if (window.__TEST_ROOT) {
      try { window.__TEST_ROOT.unmount(); } catch (_) {}
    }
    host.innerHTML = "";
    // Push the Composer to the bottom of the viewport — matches the
    // real layout (Composer is always anchored to the bottom of the
    // chat pane) and gives the popover room to render above instead
    // of being clipped off-screen at y=0.
    host.style.display = "flex";
    host.style.flexDirection = "column";
    host.style.justifyContent = "flex-end";
    const root = ReactDOM.createRoot(host);
    root.render(
      React.createElement(window.Composer, {
        model: { id: "llama3:latest", name: "llama3", color: "#9bbf83" },
        onModelChange: () => undefined,
        onSend: () => undefined,
        isStreaming: false,
        onStop: () => undefined,
        prompts: init.prompts || [
          { id: "alpha", name: "Alpha translator", body: "", tags: [], favorite: null, updated: "now" },
          { id: "beta", name: "Beta rubber duck", body: "", tags: [], favorite: "red", updated: "now" },
          { id: "gamma", name: "Gamma summarizer", body: "", tags: [], favorite: null, updated: "now" },
        ],
        onPickPrompt: onPickSpy,
        attachedPrompts: init.attachedPrompts || [],
        // Functions don't survive page.evaluate serialization, so the
        // test passes locked slugs as a plain string[] and we rebuild
        // the Set on the browser side before handing it to Composer.
        lockedPromptSlugs: new Set(init.lockedPromptSlugs || []),
        onDetachPrompt: () => undefined,
        attachments: [],
        onAttachFile: () => undefined,
        onAttachFolder: () => undefined,
        onDetachAttachment: () => undefined,
        onReindexAttachment: () => undefined,
        modelHasVision: false,
        modelHasTools: false,
        ephemeral: false,
      })
    );
    window.__TEST_ROOT = root;
  }, opts);
}

test.describe("Composer prompt slash picker", () => {
  test("typing `/` at line start opens the picker with all prompts", async ({ page }) => {
    await mountWithPrompts(page);
    const ta = page.locator("#test-root textarea");
    await ta.focus();
    await ta.press("/");
    // Picker should appear (data-prompt-picker attribute on its root div).
    const picker = page.locator("[data-prompt-picker]");
    await expect(picker).toBeVisible();
    // All three prompts visible (none attached).
    await expect(picker.getByText("Alpha translator")).toBeVisible();
    await expect(picker.getByText("Beta rubber duck")).toBeVisible();
    await expect(picker.getByText("Gamma summarizer")).toBeVisible();
  });

  test("typing after the slash filters the list", async ({ page }) => {
    await mountWithPrompts(page);
    const ta = page.locator("#test-root textarea");
    await ta.focus();
    await ta.press("/");
    await ta.type("beta");
    const picker = page.locator("[data-prompt-picker]");
    await expect(picker).toBeVisible();
    await expect(picker.getByText("Beta rubber duck")).toBeVisible();
    await expect(picker.getByText("Alpha translator")).not.toBeVisible();
  });

  test("clicking a row calls onPickPrompt and strips /query from text", async ({ page }) => {
    await mountWithPrompts(page);
    const ta = page.locator("#test-root textarea");
    await ta.focus();
    await ta.press("/");
    await ta.type("gam");
    // Click the row. mousedown is the active handler (see PromptSlashPicker).
    await page.locator("[data-prompt-picker]").getByText("Gamma summarizer").click();
    // Picker closes.
    await expect(page.locator("[data-prompt-picker]")).not.toBeVisible();
    // Pick callback fired with the expected prompt.
    const calls = await page.evaluate(() => window.__PICK_CALLS);
    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe("gamma");
    // Textarea is back to empty — the `/gam` was stripped.
    await expect(ta).toHaveValue("");
  });

  test("Esc closes the picker and strips the slash", async ({ page }) => {
    await mountWithPrompts(page);
    const ta = page.locator("#test-root textarea");
    await ta.focus();
    await ta.press("/");
    await ta.type("xyz");
    await expect(page.locator("[data-prompt-picker]")).toBeVisible();
    await ta.press("Escape");
    await expect(page.locator("[data-prompt-picker]")).not.toBeVisible();
    await expect(ta).toHaveValue("");
  });

  test("already-attached prompts are hidden from the picker", async ({ page }) => {
    await mountWithPrompts(page, {
      attachedPrompts: [
        { id: "beta", name: "Beta rubber duck", favorite: "red" },
      ],
    });
    const ta = page.locator("#test-root textarea");
    await ta.focus();
    await ta.press("/");
    const picker = page.locator("[data-prompt-picker]");
    await expect(picker).toBeVisible();
    await expect(picker.getByText("Alpha translator")).toBeVisible();
    await expect(picker.getByText("Gamma summarizer")).toBeVisible();
    // Beta is attached — hidden from picker (still rendered as a chip
    // above the textarea, but not as a picker row).
    await expect(picker.getByText("Beta rubber duck")).not.toBeVisible();
  });

  // ── Locked pinned prompt chips ────────────────────────────────────────
  // Space-pinned prompts marked `locked=1` in `space_prompts` cannot be
  // detached from a single chat — main.jsx resolves the locked slug set
  // for the active chat's Space and passes it through `lockedPromptSlugs`.
  // The Composer's contract: a chip whose `p.id` (= slug) is in that set
  // has its × button suppressed and a small lock glyph in its place.

  test("locked attached prompt renders a lock glyph and no × button", async ({ page }) => {
    await mountWithPrompts(page, {
      attachedPrompts: [
        { id: "beta", name: "Beta rubber duck", favorite: "red" },
      ],
      lockedPromptSlugs: ["beta"],
    });
    const chip = page.locator('[data-attached-prompt-chip="beta"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-locked", "1");
    // The × button is gone, replaced by the lock glyph. We assert on
    // BOTH so a regression that simply removes the × (without showing
    // the lock) still fails.
    await expect(chip.locator('[data-attached-prompt-detach="beta"]')).toHaveCount(0);
    await expect(chip.locator('[data-attached-prompt-lock="beta"]')).toHaveCount(1);
  });

  test("unlocked attached prompt still has its × detach button", async ({ page }) => {
    await mountWithPrompts(page, {
      attachedPrompts: [
        { id: "alpha", name: "Alpha translator", favorite: null },
      ],
      // No lockedPromptSlugs → empty Set on the prop, chip is unlocked.
    });
    const chip = page.locator('[data-attached-prompt-chip="alpha"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-locked", "0");
    // × present, lock glyph absent — symmetric with the locked case.
    await expect(chip.locator('[data-attached-prompt-detach="alpha"]')).toHaveCount(1);
    await expect(chip.locator('[data-attached-prompt-lock="alpha"]')).toHaveCount(0);
  });
});
