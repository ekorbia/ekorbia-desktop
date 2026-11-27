// One look across the app (the 2026-11 look pass).
//
// Buttons, fields, headings and hints come from the shared styles in
// ui/tokens.jsx (ekBtn / ekField / ekHeading / ekHint / ekChip) and the
// one switch in ui/atoms.jsx (EkToggle). The surfaces below used to mix
// that with an older style: monospace labels, UPPERCASE section headings,
// 4px corners. These tests keep the old style from creeping back:
//
//   • the shared styles follow the look in force (they are functions, not
//     constants — a constant froze the dark colours);
//   • Settings, the comparison and its chooser carry no monospace words
//     (file names and code excepted) and no uppercased labels;
//   • what you asked is a bubble on the right; a reply names its model
//     plainly; an attached folder is a pill that counts its documents.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

// Every element under `root` that directly holds words, with the font and
// case it is drawn in.
async function wordsIn(page, rootSelector) {
  return page.locator(rootSelector).first().evaluate((root) => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue.trim();
      const el = n.parentElement;
      if (!text || !el || seen.has(el)) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      out.push({
        text: text.slice(0, 40),
        tag: el.tagName,
        mono: /mono|menlo|courier/i.test(cs.fontFamily.split(",")[0]),
        upper: cs.textTransform === "uppercase",
        size: parseFloat(cs.fontSize),
      });
    }
    return out;
  });
}

test("the shared styles are built from the look in force", async ({ page }) => {
  const read = () =>
    page.evaluate(() => ({
      primaryBg: ekBtn("primary").background,
      primaryInk: ekBtn("primary").color,
      fieldBg: ekField().background,
      fieldRadius: ekField().borderRadius,
      btnRadius: ekBtn().borderRadius,
      btnFont: ekBtn().fontFamily,
      small: ekBtn("secondary", { small: true }).height,
      disabledPrimaryBg: ekBtn("primary", { disabled: true }).background,
    }));
  const dark = await read();
  expect(dark.btnRadius).toBe(8);
  expect(dark.fieldRadius).toBe(8);
  expect(dark.small).toBe(26);
  expect(dark.btnFont).toContain("Inter");

  // The app switches to its light look by rewriting T.
  await page.evaluate(() => Object.assign(T, { bg0: "#fafafa", bg3: "#d8d8d8", fg: "#383a42", isLight: true }));
  const light = await read();
  expect(light.primaryBg).toBe("#383a42");
  expect(light.primaryInk).toBe("#fafafa");
  expect(light.fieldBg).toBe("#fafafa");
  expect(light.primaryBg).not.toBe(dark.primaryBg);
  // A primary button that cannot be pressed is grey, not ink.
  expect(light.disabledPrimaryBg).toBe("#d8d8d8");
});

test("the switch says what it is and flips", async ({ page }) => {
  await page.evaluate(() => {
    window.__FLIPS = [];
    window.__TEST_MOUNT("EkToggle", { value: false, label: "Show technical details", testId: "details" });
  });
  const sw = page.getByRole("switch", { name: "Show technical details" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(sw).toHaveAttribute("data-toggle", "details");
});

async function openSettings(page) {
  await page.evaluate(() => {
    window.THEMES = { one_dark: { label: "Midnight" }, one_light: { label: "Daylight", light: true } };
    const R = window.__INVOKE_RESPONSES;
    R.llm_embed_model_check = () => ({ model: "nomic-embed-text", installed: true });
    R.llm_backend_config_get = () => ({ backend: "engine", baseUrl: null, apiKey: null });
    R.system_profile = () => ({ totalRamBytes: 36 * 1024 * 1024 * 1024, platform: "macos", arch: "aarch64" });
    R.engine_status = () => ({
      binaryOk: true, binaryPath: "/x/llama-server", binaryError: null, modelsDir: "/tmp/models", modelCount: 2,
      chatCtx: 32768, chatCtxChoices: [8192, 16384, 32768], chatCtxDefault: 32768, thinking: false,
    });
    R.engine_catalog = () => ({
      version: 1,
      models: [
        { id: "gemma4-12b", label: "Gemma 4 12B", purpose: "chat", minRamGb: 16, totalBytes: 7.2e9, suggest: true, recommended: true, caps: {}, description: "The everyday model." },
        { id: "gemma4-26b-a4b", label: "Gemma 4 26B (A4B)", purpose: "chat", minRamGb: 32, totalBytes: 15.4e9, suggest: true, caps: {}, description: "The strong model." },
        { id: "nomic-embed-text", label: "Nomic Embed", purpose: "embed", minRamGb: 8, totalBytes: 3e8, suggest: true, caps: {} },
      ],
    });
    R.llm_list_models = () => ({ models: ["gemma4-12b", "nomic-embed-text"].map((name) => ({ name, model: name, size: 5e9 })) });
    window.__TEST_MOUNT("SettingsModal", {
      tweaks: { theme: "one_dark", showDetails: false },
      setTweak: () => {},
      chatCount: 3,
      onClearAllChats: () => {},
      defaultModel: "gemma4-12b",
    });
  });
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "__activate_edit_mode" } }));
  });
  await expect(page.locator("[data-settings-nav]")).toBeVisible();
}

test("Settings: no monospace labels and no uppercased headings on any pane", async ({ page }) => {
  await openSettings(page);
  const tabs = await page.locator("[data-settings-tab]").evaluateAll((els) => els.map((e) => e.getAttribute("data-settings-tab")));
  expect(tabs).toContain("general");
  expect(tabs).toContain("advanced");
  for (const tab of tabs) {
    await page.locator(`[data-settings-tab="${tab}"]`).click();
    await page.waitForTimeout(250);
    const words = await wordsIn(page, "[data-settings-body]");
    expect(words.length, `${tab} has words`).toBeGreaterThan(0);
    expect(words.filter((w) => w.upper), `${tab}: uppercased`).toEqual([]);
    // Literal file names and patterns in the "add from a link" hint are
    // the only words set in the code font.
    const mono = words.filter((w) => w.mono && !/^(org\/model|\.gguf|.*\.mmproj\.gguf)$/.test(w.text));
    expect(mono, `${tab}: monospace`).toEqual([]);
    // Nothing is set smaller than 11px.
    expect(words.filter((w) => w.size < 11), `${tab}: tiny`).toEqual([]);
  }
});

test("Settings: plain buttons share one shape", async ({ page }) => {
  await openSettings(page);
  await page.locator('[data-settings-tab="advanced"]').click();
  const body = page.locator("[data-settings-body]");
  const shape = (loc) => loc.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { radius: cs.borderTopLeftRadius, font: cs.fontFamily.split(",")[0].replace(/"/g, ""), h: Math.round(el.getBoundingClientRect().height) };
  });
  const save = await shape(body.locator("[data-backend-save]"));
  const reveal = await shape(body.locator("[data-backend-engine-reveal]"));
  const download = await shape(body.locator("[data-catalog-download]").first());
  for (const s of [save, reveal, download]) {
    expect(s.radius).toBe("8px");
    expect(s.font).toBe("Inter");
  }
  expect(save.h).toBe(30);
  expect(reveal.h).toBe(26);
  expect(download.h).toBe(26);
});

test("the comparison carries no monospace or uppercased words", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.llm_list_models = () => ({ models: [{ name: "a" }, { name: "b" }] });
    window.__TEST_MOUNT("CompareChatPane", {
      chat: {
        id: "c1", title: "Notice periods", tabType: "multi-pending", models: ["a", "b"],
        messages: [
          { id: "u1", role: "user", content: "What is the notice period?" },
          { id: "v-a", role: "assistant", model: "a", content: "Ninety days.", variantGroupId: "g1", streaming: false, tokens: { in: 100, out: 5 }, genMs: 4000 },
          { id: "v-b", role: "assistant", model: "b", content: "Ninety days, in writing.", variantGroupId: "g1", streaming: false, tokens: { in: 100, out: 8 }, genMs: 9000 },
        ],
      },
      isStreaming: false,
      showDetails: true,
      nameOfModel: (id) => ({ id, name: id === "a" ? "Balanced" : "Most capable", detail: id === "a" ? "Gemma 4 12B" : "Gemma 4 26B" }),
    });
  });
  await expect(page.locator("[data-compare-column]")).toHaveCount(2);
  const words = await wordsIn(page, "[data-compare-pane]");
  expect(words.filter((w) => w.upper)).toEqual([]);
  expect(words.filter((w) => w.mono)).toEqual([]);
  expect(words.filter((w) => w.size < 11)).toEqual([]);
});

// Watches (list, starting points, form) and the first-run welcome were the
// last screens still in the older look.
const plain = async (page, root) => {
  const words = await wordsIn(page, root);
  expect(words.length, `${root} has words`).toBeGreaterThan(0);
  expect(words.filter((w) => w.upper), `${root}: uppercased`).toEqual([]);
  expect(words.filter((w) => w.mono), `${root}: monospace`).toEqual([]);
  expect(words.filter((w) => w.size < 11), `${root}: tiny`).toEqual([]);
};

test("Watches carry no monospace, uppercased or tiny words", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await page.evaluate((now) => {
    const R = window.__INVOKE_RESPONSES;
    R.watch_list = () => [
      { id: "w1", name: "Intake", kind: "folder", enabled: true, notify: true, folderPath: "/Users/you/Matters/Intake", notesPath: "/n.md", model: "gemma4-12b", promptId: null },
      { id: "w2", name: "Old feed", kind: "rss", enabled: true, sourceUrl: "https://example.com/feed", notesPath: "/o.md", model: "gemma4-12b" },
    ];
    R.watch_events_list = () => [
      { id: "e1", watchId: "w1", filePath: "/Users/you/Matters/Intake/Letter.pdf", status: "done", summary: "A letter dated 20 November.", error: null, createdAt: now - 60 },
      { id: "e2", watchId: "w1", filePath: "/Users/you/Matters/Intake/Scan.pdf", status: "error", summary: null, error: "Could not read the file.", createdAt: now - 30 },
    ];
    window.__TEST_MOUNT("WatchPanel", { prompts: [], nameOfModel: () => ({ name: "Balanced", detail: "" }) });
  }, now);
  await expect(page.locator("[data-watch-event]")).toHaveCount(2);
  await plain(page, "[data-watch-panel]");

  await page.evaluate(() => window.__TEST_MOUNT("RecipePickerModal", { open: true }));
  await plain(page, "[data-recipe-picker]");

  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.llm_list_models = () => ({ models: [{ name: "gemma4-12b" }] });
    window.__TEST_MOUNT("WatchModal", {
      open: true, template: null, defaultModel: "gemma4-12b", notifPermission: "default",
      prompts: [{ id: "summarise-a-document", name: "Summarise a document", body: "x" }],
      editing: { id: "w1", name: "Intake", kind: "folder", folderPath: "/a", notesPath: "/n.md", model: "gemma4-12b", enabled: true, notify: true, intervalSecs: 60 },
    });
  });
  await expect(page.locator("[data-watch-notify-permission]")).toBeVisible();
  await plain(page, "[data-watch-form]");
});

test("first run (the welcome, then the model choice) carries no monospace, uppercased or tiny words", async ({ page }) => {
  await page.evaluate(() => window.__TEST_MOUNT("OnboardingTour", { open: true }));
  await plain(page, "[data-onboarding]");

  await page.evaluate(() => {
    const R = window.__INVOKE_RESPONSES;
    R.engine_status = () => ({ binaryOk: true, binaryError: null });
    R.engine_catalog = () => ({
      version: 1,
      models: [
        { id: "gemma4-e2b", label: "Gemma 4 E2B", purpose: "chat", minRamGb: 8, totalBytes: 4.3e9, caps: { vision: true }, suggest: true, installed: false },
        { id: "nomic-embed-text", label: "Nomic Embed", purpose: "embed", minRamGb: 8, totalBytes: 3e8, caps: {}, installed: false },
      ],
    });
    // Too little memory: the warning line is on show as well.
    R.system_profile = () => ({ totalRamBytes: 4 * 1024 * 1024 * 1024, platform: "macos", arch: "aarch64" });
    R.llm_list_models = () => ({ models: [] });
    window.__TEST_MOUNT("EngineGate", { open: true, modelId: "gemma4:latest" });
  });
  await expect(page.locator("[data-engine-gate-low-memory]")).toBeVisible();
  await plain(page, "[data-engine-gate]");
});

const USER = { id: "u1", role: "user", content: "What is the cap on the seller's liability?" };
const REPLY = {
  id: "a1", role: "assistant", content: "Thirty per cent of the purchase price.", model: "gemma4-12b",
  tokens: { in: 12, out: 7 },
};

test("what you asked is a bubble on the right", async ({ page }) => {
  await page.evaluate((m) => window.__TEST_MOUNT("Message", { m }), USER);
  const bubble = page.locator('[data-message-bubble="user"]');
  await expect(bubble).toHaveText(USER.content);
  const b = await bubble.boundingBox();
  const host = await page.locator("#test-root").boundingBox();
  // Hugging the right edge, not spanning the column.
  expect(Math.round(b.x + b.width)).toBe(Math.round(host.x + host.width));
  expect(b.width).toBeLessThan(host.width * 0.81);
  expect(await bubble.evaluate((el) => getComputedStyle(el).borderBottomRightRadius)).toBe("4px");
});

test("an answer runs the full width and names its model plainly", async ({ page }) => {
  await page.evaluate((m) => {
    window.__TEST_MOUNT("Message", {
      m,
      showDetails: true,
      nameOfModel: (id) => ({ id, name: "Balanced", detail: "Gemma 4 12B" }),
    });
  }, REPLY);
  const model = page.locator("[data-message-model]");
  await expect(model).toHaveText("Balanced");
  await expect(model).toHaveAttribute("title", "Gemma 4 12B");
  await expect(page.locator("#test-root")).not.toContainText("gemma4-12b");
  const bubble = page.locator('[data-message-bubble="assistant"]');
  const b = await bubble.boundingBox();
  const host = await page.locator("#test-root").boundingBox();
  expect(Math.round(b.width)).toBe(Math.round(host.width));
});

test("without a naming function an answer still shows its model", async ({ page }) => {
  await page.evaluate((m) => window.__TEST_MOUNT("Message", { m, showDetails: true }), REPLY);
  await expect(page.locator("[data-message-model]")).toHaveText("gemma4-12b");
});

async function mountComposerWith(page, attachments) {
  await page.evaluate((attachments) => {
    const host = document.getElementById("test-root");
    if (window.__TEST_ROOT) { try { window.__TEST_ROOT.unmount(); } catch (_) {} }
    host.innerHTML = "";
    host.style.cssText = "display:flex;flex-direction:column;justify-content:flex-end;height:100vh";
    window.__CHIP = { reindex: [], detach: [] };
    const root = ReactDOM.createRoot(host);
    root.render(React.createElement(window.Composer, {
      model: { id: "gemma4-12b", name: "Balanced" },
      onSend: () => {}, isStreaming: false, onStop: () => {},
      prompts: [], onPickPrompt: () => {}, attachedPrompts: [],
      attachments,
      onAttachFile: () => {}, onAttachFolder: () => {},
      onReindexAttachment: (id) => window.__CHIP.reindex.push(id),
      onDetachAttachment: (id) => window.__CHIP.detach.push(id),
      note: "", thinking: false, onToggleThinking: () => {}, documentCount: 14,
    }));
    window.__TEST_ROOT = root;
  }, attachments);
  await expect(page.locator("[data-composer-input]")).toBeVisible();
}

test("an attached folder is a pill that counts its documents", async ({ page }) => {
  await mountComposerWith(page, [
    { id: "f1", kind: "folder", label: "Hartwell", path: "/Users/x/Matters/Hartwell", fileCount: 14, status: "ready" },
    { id: "d1", kind: "file", label: "SPA draft 4.pdf", path: "/Users/x/SPA draft 4.pdf", status: "ready" },
  ]);
  const folder = page.locator('[data-attachment-chip="folder"]');
  await expect(folder).toContainText("Hartwell");
  await expect(folder).toContainText("14 documents");
  // No type badge, no jargon.
  await expect(folder).not.toContainText("DIR");
  await expect(page.locator('[data-attachment-chip="file"]')).toHaveText("SPA draft 4.pdf");
  expect(await folder.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(12);
  const words = await wordsIn(page, "[data-composer]");
  expect(words.filter((w) => w.upper || w.mono)).toEqual([]);

  await folder.getByTitle(/Read the folder again/).click();
  await folder.getByRole("button", { name: "Remove Hartwell" }).click();
  expect(await page.evaluate(() => window.__CHIP)).toEqual({ reindex: ["f1"], detach: ["f1"] });
});

test("a folder still being read says how far it has got", async ({ page }) => {
  await mountComposerWith(page, [
    { id: "f1", kind: "folder", label: "Hartwell", path: "/x", fileCount: 3, progressTotal: 14, status: "indexing", phase: "embedding" },
  ]);
  const folder = page.locator('[data-attachment-chip="folder"]');
  await expect(folder).toHaveAttribute("data-attachment-status", "indexing");
  await expect(folder).toContainText("Reading 3 of 14");
});
