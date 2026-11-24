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

// ── Templates in the message box ─────────────────────────────────────────
//
// A template is chosen from the picker above (typing `/`), from the list
// beside "Use a template" in the + menu (the starred ones), or from a card
// on a new chat. While one is on, the box shows its hint.

const LIBRARY = [
  { id: "translate", name: "Translate", description: "Into the language you name", hint: "Name the language, then paste the text", favorite: null },
  { id: "file-note", name: "File note", description: "Rough or dictated notes into a note for the file", hint: "Dictate or paste your notes", favorite: "star" },
  { id: "summarise", name: "Summarise a document", description: "The main points, grouped by section", hint: "Attach a document or paste the text", favorite: "star" },
  { id: "house-style", name: "House style", description: "Our spelling, tone and sign-off", hint: "", favorite: null },
];

async function mountBox(page, opts = {}) {
  await page.evaluate(
    ({ library, opts }) => {
      window.__B = { picked: [], manage: 0 };
      const host = document.getElementById("test-root");
      if (window.__TEST_ROOT) { try { window.__TEST_ROOT.unmount(); } catch (_) {} }
      host.innerHTML = "";
      host.style.cssText = "display:flex;flex-direction:column;justify-content:flex-end;height:100vh";
      const root = ReactDOM.createRoot(host);
      const byId = Object.fromEntries(library.map((t) => [t.id, t]));
      const render = (extra) =>
        root.render(
          React.createElement(window.Composer, Object.assign({
            model: { id: "gemma4-12b", name: "Balanced" },
            onSend: () => undefined, isStreaming: false, onStop: () => undefined,
            prompts: library,
            onPickPrompt: (p) => window.__B.picked.push(p.id),
            attachedPrompts: (opts.attached || []).map((id) => byId[id]),
            lockedPromptSlugs: new Set(opts.locked || []),
            onDetachPrompt: () => undefined,
            attachments: [], onAttachFile: () => undefined, onAttachFolder: () => undefined,
            onManageTemplates: () => { window.__B.manage += 1; },
            documentCount: opts.documentCount || 0,
          }, extra || {})),
        );
      window.__RENDER = render;
      render();
      window.__TEST_ROOT = root;
    },
    { library: opts.library || LIBRARY, opts },
  );
  await expect(page.locator("[data-composer-input]")).toBeVisible();
}

test.describe("Templates in the message box", () => {
  test("the picker lists starred templates first, each with its description", async ({ page }) => {
    await mountBox(page);
    const ta = page.locator("[data-composer-input]");
    await ta.focus();
    await ta.press("/");
    const rows = page.locator("[data-prompt-picker] [data-template-option]");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toHaveAttribute("data-template-option", "file-note");
    await expect(rows.nth(1)).toHaveAttribute("data-template-option", "summarise");
    await expect(rows.nth(2)).toHaveAttribute("data-template-option", "house-style");
    await expect(rows.nth(0)).toContainText("Rough or dictated notes into a note for the file");
  });

  test("typing after the slash also searches descriptions", async ({ page }) => {
    await mountBox(page);
    const ta = page.locator("[data-composer-input]");
    await ta.focus();
    await ta.press("/");
    await ta.type("spelling");
    const rows = page.locator("[data-prompt-picker] [data-template-option]");
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute("data-template-option", "house-style");
  });

  test("the picker ends with a way to manage templates", async ({ page }) => {
    await mountBox(page);
    const ta = page.locator("[data-composer-input]");
    await ta.focus();
    await ta.press("/");
    await page.locator("[data-template-manage]").click();
    expect(await page.evaluate(() => window.__B.manage)).toBe(1);
  });

  test("a signal from outside opens the picker (the 'All templates' link)", async ({ page }) => {
    await mountBox(page);
    await expect(page.locator("[data-prompt-picker]")).toHaveCount(0);
    await page.evaluate(() => window.__RENDER({ openPickerSignal: 1 }));
    await expect(page.locator("[data-prompt-picker]")).toBeVisible();
  });

  test("the box shows the hint of the template that is on", async ({ page }) => {
    await mountBox(page);
    await expect(page.locator("[data-composer-input]")).toHaveAttribute("placeholder", "Ask anything");
    await mountBox(page, { attached: ["file-note"] });
    await expect(page.locator("[data-composer-input]")).toHaveAttribute("placeholder", "Dictate or paste your notes");
    // It wins over the documents line.
    await mountBox(page, { attached: ["file-note"], documentCount: 14 });
    await expect(page.locator("[data-composer-input]")).toHaveAttribute("placeholder", "Dictate or paste your notes");
  });

  test("a template without a hint, or one the workspace keeps always on, leaves the usual words", async ({ page }) => {
    await mountBox(page, { attached: ["house-style"], documentCount: 14 });
    await expect(page.locator("[data-composer-input]")).toHaveAttribute("placeholder", "Ask about the 14 documents attached");
    await mountBox(page, { attached: ["translate"], locked: ["translate"] });
    await expect(page.locator("[data-composer-input]")).toHaveAttribute("placeholder", "Ask anything");
  });

  test("the chip is plain: no colour from an old favourite", async ({ page }) => {
    await mountBox(page, {
      library: [{ id: "old", name: "Board paper", description: "", hint: "", favorite: "red" }],
      attached: ["old"],
    });
    const chip = page.locator('[data-attached-prompt-chip="old"]');
    await expect(chip).toHaveText("Board paper");
    const plain = await page.evaluate(() => ekChip("plain").background);
    expect(await chip.evaluate((el) => el.style.background)).toBe(
      await page.evaluate((c) => { const d = document.createElement("div"); d.style.background = c; return d.style.background; }, plain),
    );
  });

  test("+ → Use a template lists the starred ones; choosing one turns it on", async ({ page }) => {
    await mountBox(page, { attached: ["summarise"] });
    await page.locator("[data-composer-plus]").click();
    await expect(page.locator("[data-plus-template-list]")).toHaveCount(0);
    await page.locator("[data-plus-template]").click();
    const list = page.locator("[data-plus-template-list]");
    await expect(list).toBeVisible();
    const items = list.locator("[data-plus-template-item]");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveText("File note");
    // The one already on is ticked.
    await expect(items.nth(1)).toHaveAttribute("aria-checked", "true");
    await expect(items.nth(0)).toHaveAttribute("aria-checked", "false");
    await items.nth(0).click();
    expect(await page.evaluate(() => window.__B.picked)).toEqual(["file-note"]);
    // Both menus close.
    await expect(page.locator("[data-composer-plus-menu]")).toHaveCount(0);
  });

  test("+ → Use a template → All templates… opens the picker", async ({ page }) => {
    await mountBox(page);
    await page.locator("[data-composer-plus]").click();
    await page.locator("[data-plus-template]").click();
    await page.locator("[data-plus-template-all]").click();
    await expect(page.locator("[data-prompt-picker]")).toBeVisible();
    await expect(page.locator("[data-composer-plus-menu]")).toHaveCount(0);
  });

  test("one the workspace keeps always on cannot be turned off from the + menu", async ({ page }) => {
    await mountBox(page, { attached: ["file-note"], locked: ["file-note"] });
    await page.locator("[data-composer-plus]").click();
    await page.locator("[data-plus-template]").click();
    await page.locator('[data-plus-template-item="file-note"]').click();
    expect(await page.evaluate(() => window.__B.picked)).toEqual([]);
  });

  test("with nothing starred, Use a template goes straight to the picker", async ({ page }) => {
    await mountBox(page, { library: LIBRARY.map((t) => ({ ...t, favorite: null })) });
    await page.locator("[data-composer-plus]").click();
    await page.locator("[data-plus-template]").click();
    await expect(page.locator("[data-plus-template-list]")).toHaveCount(0);
    await expect(page.locator("[data-prompt-picker]")).toBeVisible();
  });
});
