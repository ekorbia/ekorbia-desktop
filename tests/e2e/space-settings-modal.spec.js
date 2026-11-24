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
          { id: "tone-reframer", name: "Tone reframer", description: "Four versions of a draft", favorite: null },
          { id: "brainstorm", name: "Brainstorm", description: "", favorite: null },
          { id: "summarize", name: "Summarize", description: "The main points", favorite: "star" },
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
  await page.waitForFunction(
    () => document.querySelector("[data-space-template-add]") !== null,
    { timeout: 5000 },
  );
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
  // The template the workspace always uses is listed.
  await expect(page.locator('[data-space-template="tone-reframer"]')).toContainText("Tone reframer");
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

// ── Always use these templates ───────────────────────────────────────────
//
// One list replaced the old picker (two sections, a search box, a lock
// toggle per row and an inline "new prompt" form). Every template listed
// is on in every chat here and cannot be removed inside a chat; templates
// themselves are written in Settings → Templates.

test("templates: the ones the workspace always uses are listed as chips", async ({ page }) => {
  await mountModal(page, {
    responses: {
      space_prompts_list: [
        { id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0, locked: true },
        // Pre-selected but removable in an older version: listed all the same.
        { id: "sp2", spaceId: "s1", promptSlug: "brainstorm", sortIndex: 1, locked: false },
      ],
    },
  });
  const section = page.locator("[data-space-settings-templates]");
  await expect(section).toContainText("Always use these templates");
  await expect(section.locator("[data-space-template]")).toHaveCount(2);
  await expect(section.locator('[data-space-template="tone-reframer"]')).toHaveText("Tone reframer");
  await expect(section.locator('[data-space-template="brainstorm"]')).toHaveText("Brainstorm");
  // The old picker's controls are gone.
  await expect(page.locator("[data-space-settings-prompts-search]")).toHaveCount(0);
  await expect(page.locator("[data-prompt-lock-toggle]")).toHaveCount(0);
  await expect(page.locator("[data-space-new-prompt-open]")).toHaveCount(0);
});

test("templates: Add offers the rest, starred first, and adds the one chosen", async ({ page }) => {
  await mountModal(page, {
    responses: {
      space_prompts_list: [{ id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0, locked: true }],
    },
  });
  await expect(page.locator("[data-space-template-options]")).toHaveCount(0);
  await page.locator("[data-space-template-add]").click();
  const options = page.locator("[data-space-template-option]");
  // Not the one already on; the starred one leads.
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveText("Summarize");
  await expect(options.nth(1)).toHaveText("Brainstorm");
  await options.nth(0).click();
  await expect(page.locator("[data-space-template-options]")).toHaveCount(0);
  await expect(page.locator('[data-space-template="summarize"]')).toBeVisible();
});

test("templates: the × takes one off the list", async ({ page }) => {
  await mountModal(page, {
    responses: {
      space_prompts_list: [{ id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0, locked: true }],
    },
  });
  await page.locator('[data-space-template-remove="tone-reframer"]').click();
  await expect(page.locator("[data-space-template]")).toHaveCount(0);
  // It can be added again.
  await page.locator("[data-space-template-add]").click();
  await expect(page.locator('[data-space-template-option="tone-reframer"]')).toBeVisible();
});

test("templates: with every template on, there is nothing left to add", async ({ page }) => {
  await mountModal(page, {
    promptsLibrary: [{ id: "house-style", name: "House style", description: "", favorite: null }],
    responses: {
      space_prompts_list: [{ id: "sp1", spaceId: "s1", promptSlug: "house-style", sortIndex: 0, locked: true }],
    },
  });
  await expect(page.locator("[data-space-template-add]")).toBeDisabled();
});

test("templates: one whose file has gone still shows, so it can be taken off", async ({ page }) => {
  await mountModal(page, {
    responses: {
      space_prompts_list: [{ id: "sp1", spaceId: "s1", promptSlug: "deleted-one", sortIndex: 0, locked: true }],
    },
  });
  const chip = page.locator('[data-space-template="deleted-one"]');
  await expect(chip).toHaveText("deleted-one");
  await page.locator('[data-space-template-remove="deleted-one"]').click();
  await expect(chip).toHaveCount(0);
});

test("templates: everything on the list is saved as always on", async ({ page }) => {
  await mountModal(page, {
    responses: {
      space_prompts_list: [
        { id: "sp1", spaceId: "s1", promptSlug: "tone-reframer", sortIndex: 0, locked: true },
        { id: "sp2", spaceId: "s1", promptSlug: "brainstorm", sortIndex: 1, locked: false },
      ],
    },
  });
  await page.locator("[data-space-template-add]").click();
  await page.locator('[data-space-template-option="summarize"]').click();
  await page.locator('[data-space-template-remove="tone-reframer"]').click();
  await page.locator("[data-space-settings-save]").click();
  const d = (await page.evaluate(() => window.__SAVE_DRAFTS))[0];
  expect(d.promptSlugs.slice().sort()).toEqual(["brainstorm", "summarize"]);
  // Including the one an older version had left removable.
  expect(d.lockedSlugs.slice().sort()).toEqual(["brainstorm", "summarize"]);
});

test("templates: with none written yet, the dialog says where to write one", async ({ page }) => {
  await mountModal(page, { promptsLibrary: [{ id: "x", name: "X", _virtual: true }] });
  await expect(page.locator("[data-space-settings-templates]")).toContainText("Write one in Settings → Templates");
  await expect(page.locator("[data-space-template-add]")).toBeDisabled();
});

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
  await page.locator("[data-space-template-add]").click();
  await page.locator('[data-space-template-option="brainstorm"]').click(); // add brainstorm
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
  // Everything on the list is always on.
  expect(d.lockedSlugs.slice().sort()).toEqual(["brainstorm", "tone-reframer"]);
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
