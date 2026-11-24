// Mount smoke for the restructured SettingsModal tab layout.
//
// The modal was reorganised (2026-07) from 7 tabs to 6: the three hotkey
// captures moved out of General into a dedicated Hotkeys tab, and the old
// Prompts / Memory / Attachments tabs merged into one "Files" tab. This
// guards that the modal still renders, the new tab set is present, and the
// Hotkeys tab shows its content — the kind of render-time regression a bare
// component file-load can't catch on its own.
//
// SettingsModal starts closed and opens on an `__activate_edit_mode` window
// message (the host protocol main.jsx uses), so the test posts that after
// mounting. Platform gating is honoured: Voice + Hotkeys are hidden on Linux
// (WebKit there reports a linux UA), so those assertions read window.IS_LINUX.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test("settings: panes are listed down the left, technical settings under Advanced", async ({ page }) => {
  await page.evaluate(() => {
    // THEMES lives in main.jsx, which the component fixture doesn't load
    // (it mounts individual components, not the whole app). The theme
    // <select> maps over it, so stub a minimal one — same shim idea as the
    // fixture's mocked window.__TAURI__.
    window.THEMES = {
      one_dark: { label: "Midnight" },
      one_light: { label: "Daylight" },
    };
    // The Advanced pane mounts the attachment settings, which ask Rust
    // which search model is installed.
    window.__INVOKE_RESPONSES.llm_embed_model_check = () => ({
      model: "nomic-embed-text",
      installed: true,
    });
    window.__TEST_MOUNT("SettingsModal", {
      tweaks: { theme: "one_dark", showDetails: false },
      setTweak: () => {},
      chatCount: 0,
    });
  });
  // Open it in a SEPARATE evaluate: the modal attaches its `message`
  // listener in a useEffect, which only runs after the mount commit. A second
  // round-trip flushes effects first. Dispatch a real MessageEvent so it's
  // delivered synchronously (no postMessage task-queue latency).
  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "__activate_edit_mode" } }),
    );
  });

  const root = page.locator("#test-root");
  const nav = root.locator("[data-settings-nav]");

  // Platform-invariant panes are always present, in this order.
  for (const label of ["General", "Models", "Templates", "Advanced"]) {
    await expect(nav.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  // The tabs that named how the app is built are gone from the list.
  for (const label of ["Backend", "Files", "Prompts", "Memory", "Attachments", "Voice", "Hotkeys"]) {
    await expect(nav.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  }

  // General no longer carries layout switches.
  await expect(root.getByText("Show status bar")).toHaveCount(0);
  await expect(root.getByText("Show technical details")).toHaveCount(0);

  // Advanced holds what used to be Backend, Models and Files.
  await nav.getByRole("button", { name: "Advanced", exact: true }).click();
  const body = root.locator("[data-settings-body]");
  for (const label of ["Engine and servers", "Every model", "Memory file", "Attachments", "Show technical details"]) {
    await expect(body.getByText(label, { exact: true })).toBeVisible();
  }
  // The templates folder moved to the Templates pane with the templates.
  await expect(body.getByText("Prompts folder", { exact: true })).toHaveCount(0);

  // Templates sits between Models and Dictation and opens its pane.
  await nav.getByRole("button", { name: "Templates", exact: true }).click();
  await expect(root.locator("[data-templates-settings]")).toBeVisible();
  const order = await nav.locator("[data-settings-tab]").evaluateAll((els) => els.map((e) => e.getAttribute("data-settings-tab")));
  expect(order.indexOf("templates")).toBe(order.indexOf("models") + 1);

  // Models opens the plain-names pane, which links on to Advanced.
  await nav.getByRole("button", { name: "Models", exact: true }).click();
  await expect(root.locator("[data-models-settings]")).toBeVisible();

  // Shortcuts is macOS+Windows (Quick Query); hidden on Linux. Where present,
  // opening it shows the reset affordance. Dictation is macOS only.
  const isLinux = await page.evaluate(() => !!window.IS_LINUX);
  if (!isLinux) {
    const shortcuts = nav.getByRole("button", { name: "Shortcuts", exact: true });
    await expect(shortcuts).toBeVisible();
    await shortcuts.click();
    await expect(root.getByRole("button", { name: "Reset to defaults" })).toBeVisible();
  }
  const isMac = await page.evaluate(() => !!window.IS_MAC);
  if (isMac) {
    await expect(nav.getByRole("button", { name: "Dictation", exact: true })).toBeVisible();
  }
});

// REGRESSION: the pane's box has a fixed height. As a flex column it
// squeezed the model manager (which allows it), and the manager's rows
// spilled over "Prompts folder", "Memory file" and "Attachments".
test("settings: Advanced with a long model list — no section is squeezed or overlapped", async ({ page }) => {
  await page.evaluate(() => {
    window.THEMES = { one_dark: { label: "Midnight" }, one_light: { label: "Daylight" } };
    const R = window.__INVOKE_RESPONSES;
    R.llm_embed_model_check = () => ({ model: "nomic-embed-text", installed: true });
    R.llm_backend_config_get = () => ({ backend: "engine", baseUrl: null, apiKey: null });
    R.system_profile = () => ({ totalRamBytes: 36 * 1024 * 1024 * 1024, platform: "macos", arch: "aarch64" });
    const ids = ["gemma4-e2b", "gemma4-e4b", "gemma4-12b", "gemma4-26b-a4b", "qwen3.5-9b", "qwen3.8-27b"];
    R.engine_catalog = () => ({
      version: 1,
      models: ids.map((id, i) => ({
        id, label: id.toUpperCase(), purpose: "chat", minRamGb: 8 + i * 4, totalBytes: (4 + i * 3) * 1e9,
        suggest: true, recommended: id === "gemma4-12b", caps: { vision: true, tools: true },
        description: "A sentence describing what this model is good at, long enough to wrap onto a second line.",
      })),
    });
    R.llm_list_models = () => ({
      models: ids.slice(0, 4).concat("nomic-embed-text").map((name) => ({ name, model: name, size: 5e9 })),
    });
    window.__TEST_MOUNT("SettingsModal", {
      tweaks: { theme: "one_dark", showDetails: false },
      setTweak: () => {},
      chatCount: 0,
    });
  });
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "__activate_edit_mode" } }));
  });
  const root = page.locator("#test-root");
  await root.locator('[data-settings-tab="advanced"]').click();
  const body = root.locator("[data-settings-body]");
  await expect(body.locator("[data-model-manager]")).toBeVisible();
  await expect(body.getByText("gemma4-26b-a4b").first()).toBeVisible();

  const layout = await body.evaluate((el) => {
    const kids = [...el.children].map((k) => {
      const r = k.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, squeezed: k.scrollHeight - k.clientHeight };
    });
    return { kids, scrolls: el.scrollHeight > el.clientHeight };
  });
  // The pane itself scrolls; nothing inside it is cut short…
  expect(layout.scrolls).toBe(true);
  for (const k of layout.kids) expect(k.squeezed).toBeLessThanOrEqual(1);
  // …and each block starts at or below the end of the one before it.
  for (let i = 1; i < layout.kids.length; i++) {
    expect(layout.kids[i].top).toBeGreaterThanOrEqual(layout.kids[i - 1].bottom - 0.5);
  }
});

// Settings can be opened straight onto a pane, and on Templates straight
// onto one template (the "Manage templates…" row, the corner menu).
test("settings: a request can name the pane, and a template to open in it", async ({ page }) => {
  await page.evaluate(() => {
    window.THEMES = { one_dark: { label: "Midnight" }, one_light: { label: "Daylight" } };
    window.__TEST_MOUNT("SettingsModal", {
      tweaks: { theme: "one_dark", showDetails: false },
      setTweak: () => {},
      chatCount: 0,
      templates: [
        { id: "file-note", name: "File note", description: "Notes into a note for the file", hint: "", body: "x", tags: [], favorite: "star" },
      ],
    });
  });
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "__activate_edit_mode", tab: "templates" } }));
  });
  const root = page.locator("#test-root");
  await expect(root.locator("[data-templates-settings]")).toBeVisible();
  await expect(root.locator('[data-template-row][data-template-id="file-note"]')).toBeVisible();
  await expect(root.locator("[data-template-editor]")).toHaveCount(0);

  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "__activate_edit_mode", tab: "templates", template: "file-note" } }));
  });
  await expect(root.locator("[data-template-editor]")).toHaveAttribute("data-template-id", "file-note");

  // A plain request leaves the pane where it was.
  await page.locator("[data-template-cancel]").click();
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "__activate_edit_mode" } }));
  });
  await expect(root.locator("[data-templates-settings]")).toBeVisible();
});
