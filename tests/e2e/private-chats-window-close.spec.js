// Private chats end when the window is closed (0.8.0).
//
// On macOS the main window's close button now HIDES the window (lib.rs) —
// the app stays up for the hotkeys and Watches — so the webview, and every
// chat in it, outlives a "close". Private chats must not: Rust emits
// `main:hidden`, and App closes every private tab (main.jsx closePrivateTabs,
// planned by planClosePrivateTabs in utils.js).
//
// Unlike the other specs this one mounts the REAL <App />: the behaviour is
// App's own state plumbing (tabs + chats + the in-flight stream), which the
// component fixture cannot reach. It serves ui/index.html as shipped, with the
// Tauri mock injected ahead of its scripts — no second copy of the script list
// to drift.
//
// Pins:
//   • window closed → every private tab is gone, saved tabs and the front tab
//     stay; with nothing private open it is a no-op.
//   • only private chats open → the app lands on one fresh, empty chat.
//   • a private reply still streaming is cancelled (the right request), and
//     none of its text stays on the page.
//   • a SAVED chat's reply is left to finish.

const { test, expect } = require("@playwright/test");

// Runs in the page before any app script. Seeds the mock so the first-run
// gates stay closed (engine backend, onboarding done, a chat + an embed model
// installed) and gives `llm_chat_stream` the shape of a real stream: it
// delivers one delta and then stays open until it is cancelled.
function seedBackend() {
  const R = window.__INVOKE_RESPONSES;
  const settings = {
    "onboarding.completed": "1",
    llm_backend: "engine",
    "engine.migration_offered": "1",
  };
  R.setting_get = (a) => (a && settings[a.key] != null ? settings[a.key] : null);
  R.llm_backend_config_get = () => ({ backend: "engine", baseUrl: null, apiKey: null });
  R.llm_list_models = () => ({
    models: [
      { name: "gemma4-12b", model: "gemma4-12b", size: 1 },
      { name: "nomic-embed-text", model: "nomic-embed-text", size: 1 },
    ],
  });
  R.llm_capabilities = () => ({ vision: true, tools: false, thinking: false });
  R.engine_status = () => ({
    binaryOk: true, binaryPath: "/x/llama-server", binaryError: null,
    modelsDir: "/tmp/models", modelCount: 2,
    chatCtx: 32768, chatCtxChoices: [8192, 16384, 32768, 65536, 131072],
    chatCtxDefault: 32768, thinking: false,
  });
  // Mirrors the real payload shape: { version, models } (never a bare array).
  R.engine_catalog = () => ({
    version: 1,
    models: [
      { id: "gemma4-12b", label: "Gemma 4 12B", purpose: "chat", recommended: true, suggest: true, minRamGb: 16, caps: { vision: true, tools: true }, totalBytes: 7e9, installed: true, files: [] },
      { id: "nomic-embed-text", label: "Nomic Embed", purpose: "embed", recommended: false, suggest: true, minRamGb: 8, caps: { vision: false, tools: false }, totalBytes: 3e8, installed: true, files: [] },
    ],
  });
  R.space_list = () => [];
  R.db_upsert_chat = () => undefined;
  R.db_upsert_message = () => undefined;

  window.__STREAMS = [];
  const open = {};
  R.llm_chat_stream = (args) => {
    window.__STREAMS.push(args.requestId);
    args.onChunk.__deliver({ type: "delta", text: "Partial reply text" });
    return new Promise((resolve) => { open[args.requestId] = resolve; });
  };
  // Like Rust: a cancel makes the stream's invoke resolve.
  R.llm_chat_stream_cancel = (a) => {
    if (open[a.requestId]) open[a.requestId](undefined);
    return undefined;
  };
}

async function openApp(page) {
  await page.route("**/ui/index.html", async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace(
      "<head>",
      `<head>\n<script src="/tests/e2e/fixtures/mock-tauri.js"></script>\n<script>(${seedBackend.toString()})();</script>`,
    );
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
  });
  await page.goto("/ui/index.html");
  await expect(page.locator("[data-composer-input]")).toBeVisible();
  // An emit before App's effect has subscribed would be lost — wait for it.
  await page.waitForFunction(
    () => (window.__EVENT_LISTENERS["main:hidden"] || []).length > 0,
  );
}

const tabs = (page) => page.locator("[data-tab-id]");
const privateTabs = (page) => page.locator("[data-tab-id][data-tab-private]");
const newPrivateChat = (page) => page.locator('button[title^="Private chat"]').click();
// What Rust does when the main window is closed (hidden).
const closeWindow = (page) =>
  page.evaluate(() => window.__TAURI__.event.emit("main:hidden"));
const cancelled = (page) =>
  page.evaluate(() =>
    window.__INVOKES.filter((c) => c.cmd === "llm_chat_stream_cancel").map((c) => c.args.requestId),
  );

async function send(page, text) {
  const box = page.locator("[data-composer-input]");
  await box.fill(text);
  await box.press("Enter");
  await expect(page.getByText("Partial reply text")).toBeVisible();
}

test("closing the window closes every private chat and keeps the saved tabs", async ({ page }) => {
  await openApp(page);
  const savedId = await tabs(page).first().getAttribute("data-tab-id");
  await newPrivateChat(page);
  await newPrivateChat(page);
  await expect(tabs(page)).toHaveCount(3);
  await expect(privateTabs(page)).toHaveCount(2);

  await closeWindow(page);
  await expect(privateTabs(page)).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
  // The saved tab is the one left, and it is in front.
  await expect(tabs(page).first()).toHaveAttribute("data-tab-id", savedId);
  await expect(tabs(page).first()).toHaveAttribute("data-tab-active", "");

  // Nothing private open: closing the window again changes nothing.
  await closeWindow(page);
  await expect(tabs(page)).toHaveCount(1);
  await expect(tabs(page).first()).toHaveAttribute("data-tab-id", savedId);
  expect(await cancelled(page)).toEqual([]);
});

test("with only private chats open, the app lands on one fresh empty chat", async ({ page }) => {
  await openApp(page);
  await newPrivateChat(page);
  await newPrivateChat(page);
  // Close the one saved tab, leaving only private chats.
  const saved = page.locator("[data-tab-id]:not([data-tab-private])");
  await saved.hover();
  await saved.locator("[data-tab-close]").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(privateTabs(page)).toHaveCount(2);

  await closeWindow(page);
  await expect(tabs(page)).toHaveCount(1);
  await expect(privateTabs(page)).toHaveCount(0);
  await expect(tabs(page).first()).toHaveAttribute("data-tab-active", "");
  // A working composer on an empty chat — not a blank pane, not the old chat.
  await expect(page.locator("[data-composer-input]")).toBeEnabled();
  await expect(page.locator("[data-composer-input]")).toHaveValue("");

  // And private chats still work afterwards.
  await newPrivateChat(page);
  await expect(privateTabs(page)).toHaveCount(1);
});

test("a private reply still streaming is stopped, and none of it stays on the page", async ({ page }) => {
  await openApp(page);
  await newPrivateChat(page);
  await send(page, "a private question");
  const streams = await page.evaluate(() => window.__STREAMS);
  expect(streams).toHaveLength(1);

  await closeWindow(page);
  await expect(privateTabs(page)).toHaveCount(0);
  // The in-flight request — and only it — was cancelled.
  await expect.poll(() => cancelled(page)).toEqual(streams);
  // The send path finalizes into a chat that no longer exists: nothing of
  // the private exchange may resurface.
  await expect(page.getByText("a private question")).toHaveCount(0);
  await expect(page.getByText("Partial reply text")).toHaveCount(0);
  // The app is not stuck "streaming".
  await expect(page.locator("[data-composer-input]")).toBeEnabled();
  await page.locator("[data-composer-input]").fill("next");
  await page.locator("[data-composer-input]").press("Enter");
  await expect.poll(() => page.evaluate(() => window.__STREAMS.length)).toBe(2);
});

test("a saved chat's reply keeps streaming when the window closes", async ({ page }) => {
  await openApp(page);
  const savedId = await tabs(page).first().getAttribute("data-tab-id");
  await send(page, "a saved question");
  // A private chat in another tab; the saved reply streams on behind it.
  await newPrivateChat(page);
  await expect(privateTabs(page)).toHaveCount(1);

  await closeWindow(page);
  await expect(privateTabs(page)).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
  await expect(tabs(page).first()).toHaveAttribute("data-tab-id", savedId);
  // Back on the saved chat, reply intact, and it was NOT cancelled.
  await expect(page.getByText("a saved question").first()).toBeVisible();
  await expect(page.getByText("Partial reply text")).toBeVisible();
  expect(await cancelled(page)).toEqual([]);
});
