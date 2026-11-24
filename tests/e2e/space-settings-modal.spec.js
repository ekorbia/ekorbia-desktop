// Smokes for Phase 5 — SpaceSettingsModal.
//
// What this spec covers:
//   • Modal mounts with pre-filled name / color / system_prompt /
//     defaultModel / memoryPath drawn from the space row.
//   • Pinned prompts + pinned attachments load from the backend
//     (space_prompts_list / space_attachments_list) on open.
//   • Toggling a prompt chip flips its data-selected attribute.
//   • Save dispatches onSave with a draft carrying every editable
//     field + the desired final sets for prompts and attachments.
//   • Cancel closes the modal without dispatching onSave.
//   • Esc dismisses (same as Cancel).
//   • Save is disabled when the name is empty.
//   • Clear button blanks the memory path.
//   • Remove on a pinned attachment row drops it from the draft.
//
// What's NOT covered:
//   • Memory file Edit / Reveal / Browse — these dispatch
//     `space_memory_open` / dialog APIs that need the Tauri runtime.
//     Tested via runtime tour rather than Playwright.
//   • The diff + dispatch logic in main.jsx's `saveSpaceSettings` —
//     that's plain JS that adds/removes against existing rows; it's
//     reviewed by code (the modal's contract is what we test here).

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

// Mount the modal against a recording mock of `getInvoke()` so we can
// supply canned space_prompts_list / space_attachments_list responses
// AND verify which commands the modal triggered.
async function mountModal(page, opts = {}) {
  await page.evaluate((opts) => {
    // Wire __TAURI__.core.invoke to a recording mock keyed by command.
    window.__SETTINGS_INVOKES = [];
    const responses = opts.responses || {};
    // What Rust answers when the notes are saved. A function cannot be
    // passed into the page, so the behaviour is named: "echo" answers with
    // the path it was given, "fail" throws, anything else is the path Rust
    // chose.
    if (opts.notesWrite) {
      responses.space_memory_write = (a) => {
        if (opts.notesWrite === "fail") throw new Error("disk full");
        return opts.notesWrite === "echo" ? a.path : opts.notesWrite;
      };
    }
    const invokeFn = async (cmd, args) => {
      window.__SETTINGS_INVOKES.push({ cmd, args });
      if (typeof responses[cmd] === "function") return responses[cmd](args);
      if (cmd in responses) return responses[cmd];
      return null;
    };
    window.__TAURI__ = window.__TAURI__ || {};
    window.__TAURI__.core = { invoke: invokeFn };

    // onSave spy — modal calls it with a single `draft` arg.
    window.__SAVE_DRAFTS = [];
    window.__CANCELLED = 0;

    const Component = window.SpaceSettingsModal;
    const host = document.getElementById("test-root");
    if (window.__TEST_ROOT) {
      try { window.__TEST_ROOT.unmount(); } catch (_) {}
    }
    host.innerHTML = "";
    const root = ReactDOM.createRoot(host);
    root.render(
      React.createElement(Component, {
        space: opts.space || {
          id: "s1",
          name: "Novel",
          slug: "novel",
          color: "amber",
          // `systemPrompt` was dropped from the SpaceRow shape; the
          // backend no longer returns it. Locked pinned prompts now
          // serve the same job — see CLAUDE.md.
          defaultModel: "gemma4:latest",
          memoryPath: "/Users/me/Documents/Ekorbia/Spaces/novel/memory.md",
          sortIndex: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        promptsLibrary: opts.promptsLibrary || [
          { id: "tone-reframer", name: "Tone reframer" },
          { id: "brainstorm", name: "Brainstorm" },
          { id: "summarize", name: "Summarize" },
        ],
        onCancel: () => { window.__CANCELLED++; },
        onSave: (draft) => { window.__SAVE_DRAFTS.push(draft); },
        documentCount: opts.documentCount || null,
        ...(opts.withDelete ? { onDelete: () => { window.__DELETE_ASKED = (window.__DELETE_ASKED || 0) + 1; } } : {}),
      })
    );
    window.__TEST_ROOT = root;
  }, opts);
  // Wait for the loaded:true branch to render (space_prompts_list +
  // space_attachments_list resolve on mount). We key on whichever
  // backing field exists in this run — the loading skeleton replaces
  // the lists with "loading…" text.
  await expect(page.locator("[data-space-settings-modal]")).toBeVisible();
  await page.waitForFunction(() => {
    const list = document.querySelector("[data-space-settings-prompts-list]");
    const noLib = document.querySelector("[data-space-settings-modal]")?.innerText?.includes("No prompts in your library");
    return list !== null || noLib;
  }, { timeout: 5000 });
}

// ── Render shape ─────────────────────────────────────────────────────────

test("modal: pre-fills name + default model + memory path from space", async ({ page }) => {
  // `system_prompt` was dropped in favour of locked pinned prompts —
  // verify the textarea is gone AND the remaining fields still load.
  await mountModal(page);
  await expect(page.locator("[data-space-settings-name]")).toHaveValue("Novel");
  await expect(page.locator("[data-space-settings-system-prompt]")).toHaveCount(0);
  await expect(page.locator("[data-space-settings-default-model]"))
    .toHaveValue("gemma4:latest");
  await expect(page.locator("[data-space-settings-memory-path]"))
    .toContainText("/novel/memory.md");
});

test("modal: a workspace has no colour picker", async ({ page }) => {
  await mountModal(page);
  await expect(page.locator("[data-space-settings-modal] [data-color-swatch]")).toHaveCount(0);
});

test("modal: fetches pinned prompts + pinned attachments on mount", async ({ page }) => {
  await mountModal(page, {
    responses: {
      space_prompts_list: [
        { id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0 },
      ],
      space_attachments_list: [
        { id: "sa1", spaceId: "s1", kind: "folder", path: "/notes" },
      ],
    },
  });
  // Both backend calls are recorded.
  const invokes = await page.evaluate(() => window.__SETTINGS_INVOKES);
  const cmds = invokes.map((i) => i.cmd).sort();
  expect(cmds).toContain("space_prompts_list");
  expect(cmds).toContain("space_attachments_list");
  // Pinned prompt renders as a selected chip.
  await expect(page.locator('[data-prompt-toggle="tone-reframer"]'))
    .toHaveAttribute("data-selected", "true");
  // Pinned attachment renders as a row.
  await expect(page.locator('[data-space-attachment-row][data-attachment-kind="folder"]'))
    .toContainText("/notes");
});

// ── Default-model dropdown ───────────────────────────────────────────────

test("modal: default-model dropdown is populated from llm_list_models", async ({ page }) => {
  // Replaces the old free-text input — installed Ollama models surface
  // as <option>s. The list is alphabetised; "App default"
  // (value="") is always present at the top.
  await mountModal(page, {
    responses: {
      space_prompts_list: [],
      space_attachments_list: [],
      llm_list_models: { models: [{ name: "llama3:70b" }, { name: "gemma4:latest" }, { name: "qwen2.5:32b" }] },
    },
    // Override the default space row so the saved defaultModel matches
    // one of the installed names — confirms the option renders without
    // the "(not installed)" suffix when the saved pick IS installed.
    space: {
      id: "s1",
      name: "Novel",
      slug: "novel",
      color: "amber",
      systemPrompt: "You are helping me write a novel.",
      defaultModel: "gemma4:latest",
      memoryPath: "/Users/me/Documents/Ekorbia/Spaces/novel/memory.md",
      sortIndex: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  });

  const select = page.locator("[data-space-settings-default-model]");
  // "App default" option exists with empty value.
  await expect(select.locator('option[value=""]')).toHaveText(/App default/);
  // Every installed model gets its own option.
  await expect(select.locator('option[value="llama3:70b"]')).toHaveCount(1);
  await expect(select.locator('option[value="gemma4:latest"]')).toHaveCount(1);
  await expect(select.locator('option[value="qwen2.5:32b"]')).toHaveCount(1);
  // Pre-selected value matches the space row.
  await expect(select).toHaveValue("gemma4:latest");
  // The saved value is NOT marked "(not installed)" because it's
  // present in the live list.
  await expect(select.locator('option[data-model-not-installed]')).toHaveCount(0);
});

test("modal: saved defaultModel that isn't installed renders as '(not installed)'", async ({ page }) => {
  // Guards against silent data loss: if a user uninstalls a model
  // after setting it as the Space's default, the value must be
  // preserved (still selected on the row), and the UI must surface
  // the discrepancy so the user can either keep it (and re-pull) or
  // pick something else.
  await mountModal(page, {
    responses: {
      space_prompts_list: [],
      space_attachments_list: [],
      llm_list_models: { models: [{ name: "llama3:70b" }, { name: "qwen2.5:32b" }] },
    },
    space: {
      id: "s1",
      name: "Novel",
      slug: "novel",
      color: "amber",
      systemPrompt: null,
      defaultModel: "gemma4:latest", // no longer installed
      memoryPath: null,
      sortIndex: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  });

  const select = page.locator("[data-space-settings-default-model]");
  // The saved value is still selected.
  await expect(select).toHaveValue("gemma4:latest");
  // And the option is flagged as not-installed so the UI shows it
  // differently. The label includes "(not installed)" so the user
  // knows why this option is out of place.
  const notInstalled = select.locator('option[data-model-not-installed]');
  await expect(notInstalled).toHaveCount(1);
  // `<option>` value is checked via the attribute — Playwright's
  // `toHaveValue` only applies to form controls (input/textarea/select).
  await expect(notInstalled).toHaveAttribute("value", "gemma4:latest");
  await expect(notInstalled).toContainText("not installed");
});

test("modal: selecting 'App default' clears the saved value on Save", async ({ page }) => {
  // The empty-value option round-trips as null on Save (defaultModel
  // is `.trim() || null` in the modal's handleSave) so the row's
  // memory_path-style stale value isn't held forever.
  await mountModal(page, {
    responses: {
      space_prompts_list: [],
      space_attachments_list: [],
      llm_list_models: { models: [{ name: "llama3:70b" }] },
    },
  });
  await page.locator("[data-space-settings-default-model]").selectOption("");
  await page.locator("[data-space-settings-save]").click();
  const drafts = await page.evaluate(() => window.__SAVE_DRAFTS);
  expect(drafts).toHaveLength(1);
  expect(drafts[0].row.defaultModel).toBeNull();
});

test("modal: picking a different installed model round-trips on Save", async ({ page }) => {
  await mountModal(page, {
    responses: {
      space_prompts_list: [],
      space_attachments_list: [],
      llm_list_models: { models: [{ name: "llama3:70b" }, { name: "gemma4:latest" }] },
    },
  });
  await page.locator("[data-space-settings-default-model]").selectOption("llama3:70b");
  await page.locator("[data-space-settings-save]").click();
  const drafts = await page.evaluate(() => window.__SAVE_DRAFTS);
  expect(drafts).toHaveLength(1);
  expect(drafts[0].row.defaultModel).toBe("llama3:70b");
});

// ── Pinned-prompts picker (Option A: search + section + list) ────────────

test("picker: pinned prompts surface in a 'Pinned' section above 'All prompts'", async ({ page }) => {
  // Currently-pinned prompts float to the top of the list so the user
  // always sees the current state without scrolling. Both sections sort
  // alphabetically within themselves.
  await mountModal(page, {
    responses: {
      // Two pre-pinned slugs; the library has three prompts total.
      space_prompts_list: [
        { id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0 },
        { id: "sp2", spaceId: "s1", promptSlug: "brainstorm", sortIndex: 1 },
      ],
      space_attachments_list: [],
    },
    promptsLibrary: [
      { id: "summarize", name: "Summarize" },
      { id: "tone-reframer", name: "Tone reframer" },
      { id: "brainstorm", name: "Brainstorm" },
    ],
  });

  // The Pinned section header surfaces with the count.
  await expect(page.locator('[data-prompt-section-header="Pinned (2)"]'))
    .toBeVisible();
  // The All-prompts header (no number when Pinned is also present —
  // count would be redundant).
  await expect(page.locator('[data-prompt-section-header="All prompts"]'))
    .toBeVisible();

  // Pinned rows appear before unpinned rows in DOM order.
  const rows = page.locator("[data-prompt-toggle]");
  await expect(rows).toHaveCount(3);
  // Within Pinned, alphabetical: Brainstorm before Tone reframer.
  await expect(rows.nth(0)).toHaveAttribute("data-prompt-toggle", "brainstorm");
  await expect(rows.nth(1)).toHaveAttribute("data-prompt-toggle", "tone-reframer");
  // Then the unpinned: just Summarize.
  await expect(rows.nth(2)).toHaveAttribute("data-prompt-toggle", "summarize");
});

test("picker: typing in the search input filters both sections", async ({ page }) => {
  await mountModal(page, {
    responses: {
      space_prompts_list: [
        { id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0 },
      ],
      space_attachments_list: [],
    },
    promptsLibrary: [
      { id: "summarize", name: "Summarize" },
      { id: "tone-reframer", name: "Tone reframer" },
      { id: "brainstorm", name: "Brainstorm" },
    ],
  });

  await page.locator("[data-space-settings-prompts-search]").fill("tone");
  const rows = page.locator("[data-prompt-toggle]");
  // Only tone-reframer matches.
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-prompt-toggle", "tone-reframer");
});

test("picker: empty search result shows a 'no matches' hint", async ({ page }) => {
  await mountModal(page, {
    responses: { space_prompts_list: [], space_attachments_list: [] },
    promptsLibrary: [
      { id: "summarize", name: "Summarize" },
      { id: "brainstorm", name: "Brainstorm" },
    ],
  });
  await page.locator("[data-space-settings-prompts-search]").fill("zzz");
  await expect(page.locator("[data-prompts-no-matches]")).toBeVisible();
  await expect(page.locator("[data-prompts-no-matches]")).toContainText('No prompts match "zzz"');
});

test("picker: clicking a Pinned row moves it to All prompts on the next tick", async ({ page }) => {
  // The pinned/unpinned split is recomputed on every toggle, so a
  // newly-unpinned row should reflow from the top section into the
  // bottom section without a re-mount.
  await mountModal(page, {
    responses: {
      space_prompts_list: [
        { id: "sp1", spaceId: "s1", promptSlug: "brainstorm", sortIndex: 0 },
      ],
      space_attachments_list: [],
    },
    promptsLibrary: [
      { id: "summarize", name: "Summarize" },
      { id: "brainstorm", name: "Brainstorm" },
    ],
  });

  // Pre-condition: Pinned (1) header + Brainstorm at index 0.
  await expect(page.locator('[data-prompt-section-header^="Pinned"]')).toBeVisible();
  let rows = page.locator("[data-prompt-toggle]");
  await expect(rows.nth(0)).toHaveAttribute("data-prompt-toggle", "brainstorm");
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");

  // Click Brainstorm to unpin.
  await rows.nth(0).click();

  // Pinned section header is gone (count went to 0).
  await expect(page.locator('[data-prompt-section-header^="Pinned"]'))
    .toHaveCount(0);
  // All prompts now contains both — alphabetical: Brainstorm then Summarize.
  rows = page.locator("[data-prompt-toggle]");
  await expect(rows.nth(0)).toHaveAttribute("data-prompt-toggle", "brainstorm");
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "false");
  await expect(rows.nth(1)).toHaveAttribute("data-prompt-toggle", "summarize");
});

// ── Prompt toggling ──────────────────────────────────────────────────────

test("modal: clicking a prompt chip toggles its selected state", async ({ page }) => {
  await mountModal(page, {
    responses: {
      space_prompts_list: [{ id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0 }],
      space_attachments_list: [],
    },
  });
  const toneChip = page.locator('[data-prompt-toggle="tone-reframer"]');
  const brainstormChip = page.locator('[data-prompt-toggle="brainstorm"]');
  // Pre-loaded selected.
  await expect(toneChip).toHaveAttribute("data-selected", "true");
  await expect(brainstormChip).toHaveAttribute("data-selected", "false");
  // Toggle tone OFF, brainstorm ON.
  await toneChip.click();
  await brainstormChip.click();
  await expect(toneChip).toHaveAttribute("data-selected", "false");
  await expect(brainstormChip).toHaveAttribute("data-selected", "true");
});

// ── Locked pinned prompts (Phase 1 of the lock work) ────────────────────

test("modal: locked pin loads with the lock icon in its 'locked' state", async ({ page }) => {
  // A `space_prompts` row with `locked: true` bootstraps the lock-toggle
  // affordance in the locked state. Unlocked pins still get the lock
  // icon but in the muted off-state.
  await mountModal(page, {
    responses: {
      space_prompts_list: [
        { id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0, locked: true },
        { id: "sp2", spaceId: "s1", promptSlug: "brainstorm",    sortIndex: 1, locked: false },
      ],
      space_attachments_list: [],
    },
  });
  await expect(page.locator('[data-prompt-lock-toggle="tone-reframer"]'))
    .toHaveAttribute("data-locked", "true");
  await expect(page.locator('[data-prompt-lock-toggle="brainstorm"]'))
    .toHaveAttribute("data-locked", "false");
});

test("modal: clicking the lock icon flips data-locked without unpinning", async ({ page }) => {
  // Lock toggle is independent of the pin toggle. Clicking it must not
  // remove the slug from the pinned set — only flip locked state.
  await mountModal(page, {
    responses: {
      space_prompts_list: [
        { id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0, locked: false },
      ],
      space_attachments_list: [],
    },
  });
  const lockBtn = page.locator('[data-prompt-lock-toggle="tone-reframer"]');
  const rowBtn = page.locator('[data-prompt-toggle="tone-reframer"]');
  await expect(lockBtn).toHaveAttribute("data-locked", "false");
  await lockBtn.click();
  await expect(lockBtn).toHaveAttribute("data-locked", "true");
  // The row is still pinned.
  await expect(rowBtn).toHaveAttribute("data-selected", "true");
});

test("modal: lock icon is absent on unpinned rows", async ({ page }) => {
  // Locking only makes sense for pinned prompts — unpinned rows must
  // not show the lock affordance at all.
  await mountModal(page, {
    responses: {
      space_prompts_list: [], // nothing pinned
      space_attachments_list: [],
    },
    promptsLibrary: [
      { id: "tone-reframer", name: "Tone reframer" },
      { id: "brainstorm", name: "Brainstorm" },
    ],
  });
  await expect(page.locator('[data-prompt-lock-toggle="tone-reframer"]')).toHaveCount(0);
  await expect(page.locator('[data-prompt-lock-toggle="brainstorm"]')).toHaveCount(0);
});

test("modal: locked state round-trips through onSave as `lockedSlugs`", async ({ page }) => {
  // Lock one pin, save, assert the draft includes it in lockedSlugs.
  // The parent's diff (in saveSpaceSettings) reads this and fires
  // space_prompt_set_locked for any drift.
  await mountModal(page, {
    responses: {
      space_prompts_list: [
        { id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0, locked: false },
        { id: "sp2", spaceId: "s1", promptSlug: "brainstorm",    sortIndex: 1, locked: false },
      ],
      space_attachments_list: [],
    },
  });
  // Lock brainstorm.
  await page.locator('[data-prompt-lock-toggle="brainstorm"]').click();
  await page.locator("[data-space-settings-save]").click();
  const drafts = await page.evaluate(() => window.__SAVE_DRAFTS);
  expect(drafts).toHaveLength(1);
  expect(drafts[0].lockedSlugs).toEqual(["brainstorm"]);
  // promptSlugs still carries both pinned slugs — locked is a flag,
  // not a separate set.
  expect(drafts[0].promptSlugs.sort()).toEqual(["brainstorm", "tone-reframer"]);
});

test("modal: unlocking a saved-locked pin clears it from lockedSlugs", async ({ page }) => {
  await mountModal(page, {
    responses: {
      space_prompts_list: [
        { id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0, locked: true },
      ],
      space_attachments_list: [],
    },
  });
  await expect(page.locator('[data-prompt-lock-toggle="tone-reframer"]'))
    .toHaveAttribute("data-locked", "true");
  await page.locator('[data-prompt-lock-toggle="tone-reframer"]').click();
  await page.locator("[data-space-settings-save]").click();
  const drafts = await page.evaluate(() => window.__SAVE_DRAFTS);
  expect(drafts[0].lockedSlugs).toEqual([]);
  expect(drafts[0].promptSlugs).toEqual(["tone-reframer"]);
});

// ── "+ New prompt for this Space" inline form ────────────────────────────

test("modal: + New prompt button opens an inline form with a defaulted name", async ({ page }) => {
  // Clicking the affordance reveals name + body fields, with the name
  // pre-filled to "{Space name} framing" so the user can hit Save
  // without typing if the default is fine.
  await mountModal(page);
  await page.locator("[data-space-new-prompt-open]").click();
  await expect(page.locator("[data-space-new-prompt-form]")).toBeVisible();
  await expect(page.locator("[data-space-new-prompt-name]"))
    .toHaveValue("Novel framing");
});

test("modal: Cancel closes the inline form without dispatching prompts_save", async ({ page }) => {
  await mountModal(page);
  await page.locator("[data-space-new-prompt-open]").click();
  await page.locator("[data-space-new-prompt-body]").fill("(some body)");
  await page.locator("[data-space-new-prompt-cancel]").click();
  await expect(page.locator("[data-space-new-prompt-form]")).toHaveCount(0);
  // No prompts_save invoke fired.
  const invokes = await page.evaluate(() => window.__SETTINGS_INVOKES);
  expect(invokes.some((i) => i.cmd === "prompts_save")).toBe(false);
});

test("modal: Save & pin invokes prompts_save and auto-locks the new pin", async ({ page }) => {
  // Mock prompts_save to return a synthetic prompt row. The mock's
  // recording invoke layer accepts plain values OR functions — plain
  // values survive the page.evaluate serialisation, functions don't.
  await mountModal(page, {
    responses: {
      space_prompts_list: [],
      space_attachments_list: [],
      prompts_save: {
        id: "novel-framing",
        name: "Novel framing",
        body: "You are helping me write a noir novel.",
        favorite: null,
      },
    },
  });
  await page.locator("[data-space-new-prompt-open]").click();
  await page.locator("[data-space-new-prompt-body]").fill("You are helping me write a noir novel.");
  await page.locator("[data-space-new-prompt-save]").click();
  // Form closes after the save resolves.
  await expect(page.locator("[data-space-new-prompt-form]")).toHaveCount(0);
  // prompts_save was called with the user-supplied name + body.
  const invokes = await page.evaluate(() => window.__SETTINGS_INVOKES);
  const save = invokes.find((i) => i.cmd === "prompts_save");
  expect(save).toBeDefined();
  expect(save.args.name).toBe("Novel framing");
  expect(save.args.body).toBe("You are helping me write a noir novel.");
  // The new slug appears as a pinned row (selected) AND has the lock
  // toggle in the locked state.
  await expect(page.locator('[data-prompt-toggle="novel-framing"]'))
    .toHaveAttribute("data-selected", "true");
  await expect(page.locator('[data-prompt-lock-toggle="novel-framing"]'))
    .toHaveAttribute("data-locked", "true");
  // Saving the modal carries the new slug through as a locked pin.
  await page.locator("[data-space-settings-save]").click();
  const drafts = await page.evaluate(() => window.__SAVE_DRAFTS);
  expect(drafts[0].promptSlugs).toContain("novel-framing");
  expect(drafts[0].lockedSlugs).toContain("novel-framing");
});

test("modal: Save & pin is disabled until name + body are both filled", async ({ page }) => {
  await mountModal(page);
  await page.locator("[data-space-new-prompt-open]").click();
  const save = page.locator("[data-space-new-prompt-save]");
  // Name is pre-filled ("Novel framing") but body is empty.
  await expect(save).toBeDisabled();
  await page.locator("[data-space-new-prompt-body]").fill("body");
  await expect(save).toBeEnabled();
  // Clear the name → disabled again.
  await page.locator("[data-space-new-prompt-name]").fill("");
  await expect(save).toBeDisabled();
});

// ── Save dispatches the draft ────────────────────────────────────────────

test("modal: Save dispatches onSave with the edited draft", async ({ page }) => {
  await mountModal(page, {
    responses: {
      space_prompts_list: [{ id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0, locked: false }],
      space_attachments_list: [{ id: "sa1", spaceId: "s1", kind: "folder", path: "/notes" }],
    },
  });
  // Edit the name + color, toggle prompts, remove the existing pinned
  // attachment. (The system-prompt textarea is gone — replaced by
  // locked pinned prompts.)
  await page.locator("[data-space-settings-name]").fill("Novel Draft");
  await page.locator('[data-prompt-toggle="brainstorm"]').click(); // add brainstorm
  await page.locator('[data-attachment-remove="0"]').click(); // remove /notes

  await page.locator("[data-space-settings-save]").click();

  const drafts = await page.evaluate(() => window.__SAVE_DRAFTS);
  expect(drafts).toHaveLength(1);
  const d = drafts[0];
  expect(d.row.name).toBe("Novel Draft");
  // A colour set before workspaces lost their picker stays on the row.
  expect(d.row.color).toBe("amber");
  // The row payload no longer carries systemPrompt — the field is gone.
  expect(d.row.systemPrompt).toBeUndefined();
  // Memory path round-trips untouched (we didn't edit it).
  expect(d.row.memoryPath).toContain("/novel/memory.md");
  // Prompt set has both tone (kept) and brainstorm (added).
  expect(d.promptSlugs.sort()).toEqual(["brainstorm", "tone-reframer"]);
  // Neither was locked at mount time and we didn't click any lock
  // toggles, so the lockedSlugs payload is empty.
  expect(d.lockedSlugs).toEqual([]);
  // Attachments empty after the remove.
  expect(d.attachments).toEqual([]);
});

test("modal: Save is disabled when the name is blank", async ({ page }) => {
  await mountModal(page);
  await page.locator("[data-space-settings-name]").fill("");
  await expect(page.locator("[data-space-settings-save]")).toBeDisabled();
  await page.locator("[data-space-settings-name]").fill("Renamed");
  await expect(page.locator("[data-space-settings-save]")).toBeEnabled();
});

// ── Cancel / Esc ─────────────────────────────────────────────────────────

test("modal: Cancel closes without dispatching onSave", async ({ page }) => {
  await mountModal(page);
  await page.locator("[data-space-settings-name]").fill("Don't save me");
  await page.locator("[data-space-settings-cancel]").click();
  const drafts = await page.evaluate(() => window.__SAVE_DRAFTS);
  const cancelled = await page.evaluate(() => window.__CANCELLED);
  expect(drafts).toEqual([]);
  expect(cancelled).toBe(1);
});

test("modal: Esc dismisses", async ({ page }) => {
  await mountModal(page);
  await page.keyboard.press("Escape");
  const drafts = await page.evaluate(() => window.__SAVE_DRAFTS);
  const cancelled = await page.evaluate(() => window.__CANCELLED);
  expect(drafts).toEqual([]);
  expect(cancelled).toBe(1);
});

// ── Memory clear ─────────────────────────────────────────────────────────

test("notes: the workspace's notes file is loaded into the box", async ({ page }) => {
  await mountModal(page, {
    responses: { space_memory_read: "We act for the buyer.\nUse British spelling." },
  });
  await expect(page.locator("[data-space-settings-notes]")).toHaveValue("We act for the buyer.\nUse British spelling.");
  // The old path-and-buttons controls are gone.
  await expect(page.locator("[data-space-memory-browse], [data-space-memory-edit], [data-space-memory-clear]")).toHaveCount(0);
  const reads = await page.evaluate(() => window.__SETTINGS_INVOKES.filter((i) => i.cmd === "space_memory_read"));
  expect(reads).toHaveLength(1);
  expect(reads[0].args.path).toContain("/novel/memory.md");
});

test("notes: edited notes are written before the workspace is saved", async ({ page }) => {
  await mountModal(page, {
    responses: { space_memory_read: "Old notes." },
    notesWrite: "echo",
  });
  await page.locator("[data-space-settings-notes]").fill("New notes.");
  await page.locator("[data-space-settings-save]").click();
  await expect.poll(() => page.evaluate(() => window.__SAVE_DRAFTS.length)).toBe(1);
  const writes = await page.evaluate(() => window.__SETTINGS_INVOKES.filter((i) => i.cmd === "space_memory_write").map((i) => i.args));
  expect(writes).toHaveLength(1);
  expect(writes[0].contents).toBe("New notes.");
  expect(writes[0].slug).toBe("novel");
  expect(writes[0].path).toContain("/novel/memory.md");
  const drafts = await page.evaluate(() => window.__SAVE_DRAFTS);
  expect(drafts[0].row.memoryPath).toContain("/novel/memory.md");
});

test("notes: untouched notes are not rewritten", async ({ page }) => {
  await mountModal(page, { responses: { space_memory_read: "Old notes." } });
  await page.locator("[data-space-settings-name]").fill("Renamed");
  await page.locator("[data-space-settings-save]").click();
  await expect.poll(() => page.evaluate(() => window.__SAVE_DRAFTS.length)).toBe(1);
  const writes = await page.evaluate(() => window.__SETTINGS_INVOKES.filter((i) => i.cmd === "space_memory_write"));
  expect(writes).toEqual([]);
});

test("notes: a workspace with no notes file gets one the first time notes are saved", async ({ page }) => {
  await mountModal(page, {
    space: { id: "s9", name: "Fresh", slug: "fresh", color: null, defaultModel: null, memoryPath: null, sortIndex: 0, createdAt: 1, updatedAt: 1 },
    // Rust picks the place and answers with it.
    notesWrite: "/Users/me/Documents/Ekorbia/Spaces/fresh/memory.md",
  });
  // Nothing to read, and no "kept in" line yet.
  await expect(page.locator("[data-space-settings-memory-path]")).toHaveCount(0);
  await page.locator("[data-space-settings-notes]").fill("We act for the seller.");
  await page.locator("[data-space-settings-save]").click();
  await expect.poll(() => page.evaluate(() => window.__SAVE_DRAFTS.length)).toBe(1);
  const invokes = await page.evaluate(() => window.__SETTINGS_INVOKES.map((i) => [i.cmd, i.args && i.args.path, i.args && i.args.slug]));
  expect(invokes.filter((i) => i[0] === "space_memory_read")).toEqual([]);
  expect(invokes.filter((i) => i[0] === "space_memory_write")).toEqual([["space_memory_write", "", "fresh"]]);
  const drafts = await page.evaluate(() => window.__SAVE_DRAFTS);
  expect(drafts[0].row.memoryPath).toBe("/Users/me/Documents/Ekorbia/Spaces/fresh/memory.md");
});

test("notes: leaving them empty on a workspace with no file writes nothing", async ({ page }) => {
  await mountModal(page, {
    space: { id: "s9", name: "Fresh", slug: "fresh", color: null, defaultModel: null, memoryPath: null, sortIndex: 0, createdAt: 1, updatedAt: 1 },
  });
  await page.locator("[data-space-settings-notes]").fill("typed then removed");
  await page.locator("[data-space-settings-notes]").fill("");
  await page.locator("[data-space-settings-save]").click();
  await expect.poll(() => page.evaluate(() => window.__SAVE_DRAFTS.length)).toBe(1);
  const writes = await page.evaluate(() => window.__SETTINGS_INVOKES.filter((i) => i.cmd === "space_memory_write"));
  expect(writes).toEqual([]);
  expect((await page.evaluate(() => window.__SAVE_DRAFTS))[0].row.memoryPath).toBeNull();
});

test("notes: if they cannot be written, the dialog stays open and nothing is saved", async ({ page }) => {
  await mountModal(page, {
    responses: { space_memory_read: "Old notes." },
    notesWrite: "fail",
  });
  await page.locator("[data-space-settings-notes]").fill("New notes.");
  await page.locator("[data-space-settings-save]").click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__SAVE_DRAFTS)).toEqual([]);
  await expect(page.locator("[data-space-settings-modal]")).toBeVisible();
  await expect(page.locator("[data-space-settings-notes]")).toHaveValue("New notes.");
});

test("documents: the dialog says how many documents the pins hold", async ({ page }) => {
  await mountModal(page, { documentCount: { documents: 212, capped: false } });
  await expect(page.locator("[data-space-settings-doc-count]")).toHaveText("212 documents found.");
  await mountModal(page, { documentCount: { documents: 5000, capped: true } });
  await expect(page.locator("[data-space-settings-doc-count]")).toHaveText("More than 5000 documents found.");
  await mountModal(page);
  await expect(page.locator("[data-space-settings-doc-count]")).toHaveCount(0);
});

test("Delete workspace asks the host, and is only offered when the host can delete", async ({ page }) => {
  await mountModal(page);
  await expect(page.locator("[data-space-settings-delete]")).toHaveCount(0);
  await mountModal(page, { withDelete: true });
  await page.locator("[data-space-settings-delete]").click();
  expect(await page.evaluate(() => window.__DELETE_ASKED)).toBe(1);
});
