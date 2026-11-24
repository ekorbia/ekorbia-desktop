// The quick-question panel (ui/overlay.jsx QuickQuery): what its top two
// rows show, which model answers, and which look it wears.
//
//   • It answers with the app's default model and has no chooser of its
//     own — one place to choose a model, as in the main window.
//   • It follows the app's look (light or dark). Its window never mounts
//     the app, so it reads the saved choice itself.
//   • The microphone is the last thing in the input row in every state.
//     It used to sit left of a key hint that came and went, so it jumped
//     sideways when a list opened or an answer arrived.
//   • The key hint sits at the right end of the bar below, in words.

const { test, expect } = require("@playwright/test");

// `before` runs in the page ahead of the mount (set saved choices there).
async function mountPanel(page, before) {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
  if (before) await page.evaluate(before);
  await page.evaluate(() => {
    const R = window.__INVOKE_RESPONSES;
    if (!window.__MODELS) window.__MODELS = ["gemma4-e4b", "gemma4-12b", "gemma4-26b-a4b", "nomic-embed-text"];
    R.llm_list_models = () => ({
      models: window.__MODELS.map((name) => ({ name, model: name, size: 5e9 })),
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
}

const sentModels = (page) =>
  page.evaluate(() => window.__INVOKES.filter((i) => i.cmd === "llm_chat_stream").map((i) => i.args.body.model));

async function ask(page, text) {
  await page.locator("[data-quick-panel] input").first().fill(text);
  await page.keyboard.press("Enter");
  await expect(page.getByText("Ninety days.")).toBeVisible();
}

test("it answers with the app's default model and offers no chooser", async ({ page }) => {
  await mountPanel(page, () => {
    localStorage.setItem("ekorbia.main.model", "gemma4-26b-a4b");
    // A choice an older version kept for this panel alone is ignored.
    localStorage.setItem("ekorbia.overlay.model", "gemma4-e4b");
  });
  const panel = page.locator("[data-quick-panel]");
  await expect(panel).not.toContainText("gemma4");
  await expect(panel.locator("[data-overlay-model]")).toHaveCount(0);
  await ask(page, "What is the notice period?");
  expect(await sentModels(page)).toEqual(["gemma4-26b-a4b"]);
});

test("a new default applies the next time the panel comes forward", async ({ page }) => {
  await mountPanel(page, () => localStorage.setItem("ekorbia.main.model", "gemma4-12b"));
  await page.evaluate(() => {
    localStorage.setItem("ekorbia.main.model", "gemma4-e4b");
    window.dispatchEvent(new Event("focus"));
  });
  await ask(page, "What is the notice period?");
  expect(await sentModels(page)).toEqual(["gemma4-e4b"]);
});

test("a default that is not installed falls back to an installed chat model", async ({ page }) => {
  await mountPanel(page, () => {
    localStorage.setItem("ekorbia.main.model", "removed-model");
    // The search model is listed first; it must not be the fallback.
    window.__MODELS = ["nomic-embed-text", "gemma4-12b"];
  });
  await ask(page, "What is the notice period?");
  expect(await sentModels(page)).toEqual(["gemma4-12b"]);
});

test("it wears the app's look: light when the app is light, dark when it is dark", async ({ page }) => {
  const ink = () =>
    page.locator("[data-quick-panel] input").first().evaluate((el) => getComputedStyle(el).color);

  await mountPanel(page, () => {
    window.THEMES = { one_dark: { label: "Midnight" }, one_light: { label: "Daylight", light: true } };
    localStorage.setItem("ekorbia.tweaks", JSON.stringify({ theme: "one_light" }));
  });
  const panel = page.locator("[data-quick-panel]");
  await expect(panel).toHaveAttribute("data-quick-look", "light");
  // Dark words on a light ground.
  expect(await ink()).toBe("rgb(36, 38, 43)");

  // The look is changed in the app; the panel picks it up when it next
  // comes forward.
  await page.evaluate(() => {
    localStorage.setItem("ekorbia.tweaks", JSON.stringify({ theme: "one_dark" }));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(panel).toHaveAttribute("data-quick-look", "dark");
  expect(await ink()).toBe("rgb(227, 230, 236)");
});

test("with no saved look it is dark, like the app", async ({ page }) => {
  await mountPanel(page, () => localStorage.removeItem("ekorbia.tweaks"));
  await expect(page.locator("[data-quick-panel]")).toHaveAttribute("data-quick-look", "dark");
});

test("the key hint is in the bar below the input, in words", async ({ page }) => {
  await mountPanel(page);
  const hint = page.locator("[data-overlay-hint]");
  await expect(hint).toHaveText("Return to ask · Esc to close");
  // It goes away while the template list is open.
  await page.getByRole("button", { name: "+ template" }).click();
  await expect(hint).toHaveCount(0);
});

test("the microphone stays at the right edge of the input row in every state", async ({ page }) => {
  await mountPanel(page);
  const mic = page.locator("[data-voice-mic]");
  // Dictation is macOS only; elsewhere there is no button to place.
  if ((await mic.count()) === 0) return;
  const rightEdge = async () => {
    const b = await mic.boundingBox();
    return Math.round(b.x + b.width);
  };
  const idle = await rightEdge();
  expect(await mic.evaluate((el) => el.nextElementSibling === null)).toBe(true);

  // A list open.
  await page.getByRole("button", { name: "+ template" }).click();
  await expect(page.getByPlaceholder("Search templates…")).toBeVisible();
  expect(await rightEdge()).toBe(idle);
  await page.keyboard.press("Escape");

  // An answer on screen.
  await ask(page, "What is the notice period?");
  expect(await rightEdge()).toBe(idle);
});

// ── Templates in the panel ───────────────────────────────────────────────

async function mountWithTemplates(page) {
  await mountPanel(page, () => {
    window.__INVOKE_RESPONSES.prompts_list = () => [
      { id: "translate", name: "Translate", description: "Into the language you name", hint: "Name the language, then paste the text", body: "Translate it.", tags: [], favorite: null },
      { id: "file-note", name: "File note", description: "Rough or dictated notes into a note for the file", hint: "Dictate or paste your notes", body: "Make a file note.", tags: [], favorite: "star" },
      { id: "old", name: "Board paper", description: "", hint: "", body: "Board paper.", tags: [], favorite: "red" },
    ];
  });
}

test("+ template lists templates starred first, with descriptions; search covers both", async ({ page }) => {
  await mountWithTemplates(page);
  await page.getByRole("button", { name: "+ template" }).click();
  const rows = page.locator("[data-overlay-template-option]");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-overlay-template-option", "old");
  await expect(rows.nth(1)).toHaveAttribute("data-overlay-template-option", "file-note");
  await expect(rows.nth(1)).toContainText("Rough or dictated notes into a note for the file");
  await page.getByPlaceholder("Search templates…").fill("language");
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute("data-overlay-template-option", "translate");
});

test("a chosen template shows as a plain chip and its hint becomes the placeholder", async ({ page }) => {
  await mountWithTemplates(page);
  const input = page.locator("[data-quick-panel] input").first();
  await expect(input).toHaveAttribute("placeholder", "Ask anything…");
  await page.getByRole("button", { name: "+ template" }).click();
  await page.locator('[data-overlay-template-option="file-note"]').click();
  await expect(page.locator('[data-overlay-template="file-note"]')).toHaveText("File note");
  await expect(input).toHaveAttribute("placeholder", "Dictate or paste your notes");
  // The template's instructions lead the request.
  await ask(page, "Met the client at 3pm.");
  const body = await page.evaluate(() => window.__INVOKES.filter((i) => i.cmd === "llm_chat_stream")[0].args.body);
  expect(body.messages[0]).toEqual({ role: "system", content: "Make a file note." });
  // Removing it restores the usual words.
  await page.getByRole("button", { name: "Remove File note" }).click();
  await expect(page.locator("[data-overlay-template]")).toHaveCount(0);
});

test("templates are re-read when the panel comes forward", async ({ page }) => {
  await mountWithTemplates(page);
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.prompts_list = () => [
      { id: "minutes", name: "Meeting minutes", description: "Decisions and actions", hint: "", body: "Minutes.", tags: [], favorite: null },
    ];
    window.dispatchEvent(new Event("focus"));
  });
  await page.getByRole("button", { name: "+ template" }).click();
  await expect(page.locator("[data-overlay-template-option]")).toHaveCount(1);
  await expect(page.locator('[data-overlay-template-option="minutes"]')).toBeVisible();
});
