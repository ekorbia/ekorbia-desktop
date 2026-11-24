// Private chats end when the window is closed (0.8.0).
//
// On macOS the main window's close button HIDES the window (lib.rs) — the
// app stays up for the hotkeys and Watches — so the webview, and every
// chat in it, outlives a "close". Private chats must not: Rust emits
// `main:hidden`, and App closes every private chat (main.jsx
// closePrivateTabs, planned by planClosePrivateTabs in utils.js).
//
// This mounts the REAL <App /> (helpers/app.js): the behaviour is App's
// own state plumbing (open chats + the in-flight stream), which the
// component fixture cannot reach.
//
// Pins:
//   • window closed → every private chat is gone and the app stays in the
//     workspace it was in, on a saved or unsent chat; with nothing private
//     open it is a no-op.
//   • a private reply still streaming is cancelled (the right request), and
//     none of its text stays on the page.
//   • a SAVED chat's reply is left to finish.

const { test, expect } = require("@playwright/test");
const { openApp, openWorkspace, send, newPrivateChat } = require("./helpers/app");

const privateRows = (page) => page.locator("[data-open-chat-private]");
// What Rust does when the main window is closed (hidden).
const closeWindow = (page) =>
  page.evaluate(() => window.__TAURI__.event.emit("main:hidden"));
const cancelled = (page) =>
  page.evaluate(() =>
    window.__INVOKES.filter((c) => c.cmd === "llm_chat_stream_cancel").map((c) => c.args.requestId),
  );

test("closing the window ends every private chat and lands on an unsent chat in the same workspace", async ({ page }) => {
  await openApp(page);
  await openWorkspace(page, null);
  await newPrivateChat(page);
  await newPrivateChat(page);
  await expect(privateRows(page)).toHaveCount(2);

  await closeWindow(page);
  await expect(privateRows(page)).toHaveCount(0);
  // Still in General, on its unsent chat: a working, empty message box.
  await expect(page.locator("[data-workspace-name]")).toHaveText("General");
  const open = page.locator("[data-open-chat-id]");
  await expect(open).toHaveCount(1);
  await expect(open.first()).toHaveAttribute("data-active", "true");
  await expect(page.locator("[data-composer-input]")).toBeEnabled();
  await expect(page.locator("[data-composer-input]")).toHaveValue("");

  // Nothing private open: closing the window again changes nothing.
  await closeWindow(page);
  await expect(open).toHaveCount(1);
  expect(await cancelled(page)).toEqual([]);

  // And private chats still work afterwards.
  await newPrivateChat(page);
  await expect(privateRows(page)).toHaveCount(1);
});

test("a private reply still streaming is stopped, and none of it stays on the page", async ({ page }) => {
  await openApp(page);
  await openWorkspace(page, null);
  await newPrivateChat(page);
  await send(page, "a private question");
  const streams = await page.evaluate(() => window.__STREAMS);
  expect(streams).toHaveLength(1);

  await closeWindow(page);
  await expect(privateRows(page)).toHaveCount(0);
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
  await openWorkspace(page, null);
  await send(page, "a saved question");
  // A private chat in front; the saved reply streams on behind it.
  await newPrivateChat(page);
  await expect(privateRows(page)).toHaveCount(1);
  // (Its title stays in the sidebar; the conversation itself is behind.)
  const savedMessage = page.locator('[id^="ek-msg-"]', { hasText: "a saved question" });
  await expect(savedMessage).toHaveCount(0);

  await closeWindow(page);
  await expect(privateRows(page)).toHaveCount(0);
  // Back on the saved chat, reply intact, and it was NOT cancelled.
  await expect(savedMessage).toBeVisible();
  await expect(page.locator('[id^="ek-msg-"]', { hasText: "Partial reply text" })).toBeVisible();
  expect(await cancelled(page)).toEqual([]);
});

test("ending a private chat by hand drops it and stays in the workspace", async ({ page }) => {
  await openApp(page);
  await openWorkspace(page, null);
  await newPrivateChat(page);
  await send(page, "something off the record");
  await page.locator("[data-open-chat-private] [data-end-private]").click();
  await expect(privateRows(page)).toHaveCount(0);
  await expect(page.getByText("something off the record")).toHaveCount(0);
  await expect(page.locator("[data-workspace-name]")).toHaveText("General");
  // Its reply was stopped, so the next message can be sent.
  await expect.poll(() => cancelled(page)).toHaveLength(1);
  await expect(page.locator("[data-composer-input]")).toBeEnabled();
  await page.locator("[data-composer-input]").fill("next");
  await page.locator("[data-composer-input]").press("Enter");
  await expect.poll(() => page.evaluate(() => window.__STREAMS.length)).toBe(2);
});
