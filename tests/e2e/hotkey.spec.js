// Interaction smokes for the HotkeyCapture component (Ring 2 — D3).
//
// HotkeyCapture is a click-to-record button. Pressing the button enters
// recording mode (button text flips to "Press shortcut…"). The next
// non-bare-modifier keydown gets converted to a spec string via
// hotkeyFromEvent (covered by node:test utils.test.js) and passed to
// onChange. Escape during recording calls onCancel instead.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

async function mountWithSpies(page, initialValue) {
  // Same shape as the Composer mount: install real spy functions in the
  // page, mount the component referencing them. Playwright's evaluate
  // boundary can't carry functions across.
  await page.evaluate(
    ({ initialValue }) => {
      window.__CHANGE_CALLS = [];
      window.__CANCEL_CALLS = 0;
      const onChange = (spec) => window.__CHANGE_CALLS.push(spec);
      const onCancel = () => window.__CANCEL_CALLS++;
      const host = document.getElementById("test-root");
      if (window.__TEST_ROOT) {
        try { window.__TEST_ROOT.unmount(); } catch (_) {}
      }
      host.innerHTML = "";
      const root = ReactDOM.createRoot(host);
      root.render(
        React.createElement(window.HotkeyCapture, {
          value: initialValue,
          onChange,
          onCancel,
        })
      );
      window.__TEST_ROOT = root;
    },
    { initialValue }
  );
}

test.describe("HotkeyCapture", () => {
  test("idle button shows formatted current value", async ({ page }) => {
    await mountWithSpies(page, "Super+Shift+Space");
    // formatHotkey maps Super+Shift+Space → ⌘⇧Space; that's what the
    // button label shows. (The character class assertion is forgiving
    // because Playwright's WebKit normalises some Unicode in selectors.)
    await expect(page.locator("#test-root button")).toContainText("Space");
    await expect(page.locator("#test-root button")).toContainText("⌘");
  });

  test("clicking enters recording mode", async ({ page }) => {
    await mountWithSpies(page, "Super+Shift+Space");
    await page.locator("#test-root button").click();
    await expect(page.locator("#test-root button")).toContainText("Press shortcut");
  });

  test("recording: ⌘⇧A → onChange('Super+Shift+KeyA')", async ({ page }) => {
    await mountWithSpies(page, "Not set");
    await page.locator("#test-root button").click();
    await expect(page.locator("#test-root button")).toContainText("Press shortcut");

    // Playwright's keyboard.press("Meta+Shift+KeyA") drives a real
    // composite keydown. HotkeyCapture's keydown handler is attached at
    // capture phase on window, so it'll see the event before any other
    // listener.
    await page.keyboard.press("Meta+Shift+KeyA");

    await expect.poll(() =>
      page.evaluate(() => window.__CHANGE_CALLS)
    ).toEqual(["Super+Shift+KeyA"]);

    // Recording mode should clear after a successful capture.
    await expect(page.locator("#test-root button")).not.toContainText("Press shortcut");
  });

  test("recording: bare letter (no modifier) keeps listening", async ({ page }) => {
    await mountWithSpies(page, "Not set");
    await page.locator("#test-root button").click();
    await page.keyboard.press("KeyA");

    // hotkeyFromEvent returns null for a bare key — recording should
    // continue, no onChange fired.
    const changes = await page.evaluate(() => window.__CHANGE_CALLS);
    expect(changes).toEqual([]);
    await expect(page.locator("#test-root button")).toContainText("Press shortcut");
  });

  test("recording: Escape calls onCancel and exits recording", async ({ page }) => {
    await mountWithSpies(page, "Not set");
    await page.locator("#test-root button").click();
    await expect(page.locator("#test-root button")).toContainText("Press shortcut");

    await page.keyboard.press("Escape");

    await expect.poll(() =>
      page.evaluate(() => window.__CANCEL_CALLS)
    ).toBe(1);
    // onChange should NOT have fired on cancel.
    const changes = await page.evaluate(() => window.__CHANGE_CALLS);
    expect(changes).toEqual([]);
  });
});
