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

test("settings modal: new 6-tab layout renders", async ({ page }) => {
  await page.evaluate(() => {
    // THEMES lives in main.jsx, which the component fixture doesn't load
    // (it mounts individual components, not the whole app). The theme
    // <select> maps over it, so stub a minimal one — same shim idea as the
    // fixture's mocked window.__TAURI__.
    window.THEMES = {
      one_dark: { label: "Midnight" },
      one_light: { label: "Daylight" },
    };
    window.__TEST_MOUNT("SettingsModal", {
      tweaks: { theme: "one_dark", showStatusBar: true, showDetails: false },
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

  // Platform-invariant tabs are always present, in this order.
  for (const label of ["General", "Backend", "Models", "Files"]) {
    await expect(
      root.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  }

  // The old standalone tabs are gone — their settings live under Files now.
  for (const label of ["Prompts", "Memory", "Attachments"]) {
    await expect(
      root.getByRole("button", { name: label, exact: true }),
    ).toHaveCount(0);
  }

  // Hotkeys is macOS+Windows (Quick Query); hidden on Linux. Where present,
  // opening it shows the reset affordance moved in from General.
  const isLinux = await page.evaluate(() => !!window.IS_LINUX);
  if (!isLinux) {
    const hotkeys = root.getByRole("button", { name: "Hotkeys", exact: true });
    await expect(hotkeys).toBeVisible();
    await hotkeys.click();
    await expect(
      root.getByRole("button", { name: "Reset to defaults" }),
    ).toBeVisible();
  }
});
