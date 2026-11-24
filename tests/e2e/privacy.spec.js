// The offline lock and the privacy record, in the REAL app (helpers/app.js).
//
// Rust owns the lock and the record (src-tauri/src/net.rs, unit-tested
// there). These tests cover what the app does with them: the line at the
// foot of every screen states the position in force and opens the record,
// and Settings has a Privacy pane between Shortcuts and Advanced.

const { test, expect } = require("@playwright/test");
const { openApp, openWorkspace } = require("./helpers/app");

// Rust's side, in the page: a lock, and an event when it moves.
function seedPrivacy() {
  const R = window.__INVOKE_RESPONSES;
  window.__LOCK = { locked: false, lockedSince: null };
  const status = () => ({
    locked: window.__LOCK.locked,
    lockedSince: window.__LOCK.lockedSince,
    summary: { made: 0, refused: 0, chatsSent: 0, documentsSent: 0, hosts: [] },
  });
  R.privacy_status = () => status();
  R.privacy_log = () => [];
  R.privacy_set_lock = (a) => {
    window.__LOCK = { locked: !!a.on, lockedSince: a.on ? Math.floor(Date.now() / 1000) : null };
    window.__TAURI__.event.emit("privacy:changed");
    return status();
  };
}

test("the status line opens Settings on Privacy", async ({ page }) => {
  await openApp(page, seedPrivacy);
  const line = page.locator("[data-status-line]");
  await expect(line).toHaveText("Chats stay on this Mac");
  await expect(line).toHaveAttribute("data-status-kind", "local");
  await line.click();
  await expect(page.locator("[data-privacy-settings]")).toBeVisible();
  await expect(page.locator('[data-settings-tab="privacy"]')).toBeVisible();
});

test("Privacy sits between Shortcuts and Advanced", async ({ page }) => {
  await openApp(page, seedPrivacy);
  await page.locator("[data-status-line]").click();
  const order = await page
    .locator("[data-settings-tab]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-settings-tab")));
  expect(order[order.length - 1]).toBe("advanced");
  expect(order[order.length - 2]).toBe("privacy");
});

test("turning the lock on changes the line at the foot, here and in a workspace", async ({ page }) => {
  await openApp(page, seedPrivacy);
  await page.locator("[data-status-line]").click();
  await page.getByRole("switch", { name: "Offline lock" }).click();
  await expect(page.locator("[data-privacy-settings]")).toHaveAttribute("data-locked", "true");

  const line = page.locator("[data-status-line]");
  await expect(line).toHaveText("Offline lock on");
  await expect(line).toHaveAttribute("data-status-kind", "locked");

  // Close Settings; the line says the same inside a workspace.
  await page.locator("[data-settings-nav]").locator("xpath=../..").getByRole("button").first().click();
  await openWorkspace(page, null);
  await expect(page.locator("[data-status-line]")).toHaveText("Offline lock on");
});

test("a lock already on at launch is stated from the start", async ({ page }) => {
  await openApp(page, () => {
    const R = window.__INVOKE_RESPONSES;
    R.privacy_status = () => ({
      locked: true,
      lockedSince: 1,
      summary: { made: 0, refused: 0, chatsSent: 0, documentsSent: 0, hosts: [] },
    });
    R.privacy_log = () => [];
  });
  await expect(page.locator("[data-status-line]")).toHaveText("Offline lock on");
});
