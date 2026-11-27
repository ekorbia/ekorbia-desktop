// Mounts the REAL <App /> for specs whose subject is App's own plumbing
// (which screen is showing, which chat is in front, an in-flight reply) —
// things the component fixture cannot reach. It serves ui/index.html
// exactly as shipped, with the Tauri mock and a seed injected ahead of its
// scripts, so there is no second copy of the script list to drift.

const { expect } = require("@playwright/test");

// Runs in the page before any app script. Seeds the mock so the first-run
// gates stay closed (engine backend, onboarding done, a chat + an embed
// model installed) and gives `llm_chat_stream` the shape of a real stream:
// it delivers one delta and then stays open until it is cancelled.
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
  R.llm_loaded_models = () => ({ models: [] });
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
      { id: "gemma4-12b", label: "Gemma 4 12B", purpose: "chat", recommended: true, suggest: true, minRamGb: 16, caps: { vision: true, tools: true }, totalBytes: 7e9, installed: true },
      { id: "nomic-embed-text", label: "Nomic Embed", purpose: "embed", recommended: false, suggest: true, minRamGb: 8, caps: { vision: false, tools: false }, totalBytes: 3e8, installed: true },
    ],
  });
  R.space_list = () => [];
  R.space_attachments_list = () => [];
  R.space_prompts_list = () => [];
  R.db_load_chats = () => [];
  R.db_load_messages = () => [];
  R.db_upsert_chat = () => undefined;
  R.db_upsert_message = () => undefined;
  R.search_chats = () => [];

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

// Open the app. `extraSeed` is an optional function run in the page after
// seedBackend (override `window.__INVOKE_RESPONSES` entries there). The
// app opens on Home; resolves once Home is on screen and App is listening
// for window events.
async function openApp(page, extraSeed) {
  const extra = extraSeed ? `\n<script>(${extraSeed.toString()})();</script>` : "";
  await page.route("**/ui/index.html", async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace(
      "<head>",
      `<head>\n<script src="/tests/e2e/fixtures/mock-tauri.js"></script>\n<script>(${seedBackend.toString()})();</script>${extra}`,
    );
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
  });
  await page.goto("/ui/index.html");
  await expect(page.locator("[data-home]")).toBeVisible();
  // An emit before App's effect has subscribed would be lost — wait for it.
  await page.waitForFunction(
    () => (window.__EVENT_LISTENERS["main:hidden"] || []).length > 0,
  );
}

// From Home into a workspace (a Space id, or null for General).
async function openWorkspace(page, spaceId) {
  const card = spaceId
    ? page.locator(`[data-workspace-card][data-space-id="${spaceId}"]`)
    : page.locator("[data-workspace-card][data-general]");
  await card.click();
  await expect(page.locator("[data-composer-input]")).toBeVisible();
}

// Type a message and wait for the seeded reply to start arriving.
async function send(page, text) {
  const box = page.locator("[data-composer-input]");
  await box.fill(text);
  await box.press("Enter");
  await expect(page.getByText("Partial reply text")).toBeVisible();
}

// New chat ▾ → New private chat.
async function newPrivateChat(page) {
  await page.locator("[data-new-chat-more]").click();
  await page.locator("[data-menu-new-private]").click();
}

module.exports = { seedBackend, openApp, openWorkspace, send, newPrivateChat };
