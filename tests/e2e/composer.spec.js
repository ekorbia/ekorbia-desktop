// Interaction smokes for the Composer component (Ring 2 — D3).
//
// The Composer's contract is small:
//   • Enter (without Shift)        → calls onSend(text); clears the textarea
//   • Shift+Enter                  → inserts newline; does NOT send
//   • empty/whitespace-only text   → no onSend even on Enter
//   • isStreaming=true             → no onSend even on Enter
//
// We mount with only the props the textarea path needs. Everything else
// (model picker, attachments, prompts) is exercised by the mount itself —
// if any required dependency is missing the component throws during render.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

// Mount Composer with onSend recording calls onto window.__SEND_CALLS, since
// Playwright's evaluate boundary can't carry a JS function across.
async function mountComposerWithSendSpy(page) {
  await page.evaluate(() => {
    window.__SEND_CALLS = [];
    // Mount path: stash the spy on window, mount with a stub that
    // forwards to the spy. We can't pass functions through evaluate, but
    // we CAN install one on the page and reference it from inside the
    // mount.
    const onSendSpy = (text) => window.__SEND_CALLS.push(text);
    // Re-derive the mount logic locally because we need a real function.
    const Component = window.Composer;
    const host = document.getElementById("test-root");
    if (window.__TEST_ROOT) {
      try { window.__TEST_ROOT.unmount(); } catch (_) {}
    }
    host.innerHTML = "";
    const root = ReactDOM.createRoot(host);
    root.render(
      React.createElement(Component, {
        // Composer expects an object shape, not a bare id string. See
        // main.jsx where `tabModel` is `MODELS.find(...)` (or a synthesised
        // { id, name, color } fallback).
        model: { id: "llama3:latest", name: "llama3", color: "#9bbf83" },
        onModelChange: () => undefined,
        onSend: onSendSpy,
        isStreaming: false,
        onStop: () => undefined,
        // Prompt slash-command picker — empty library here keeps the
        // picker's mount path exercised without needing real data for
        // these textarea-focused assertions. Dedicated slash-picker
        // smokes live in composer-prompt-picker.spec.js.
        prompts: [],
        onPickPrompt: () => undefined,
        attachedPrompts: [],
        onDetachPrompt: () => undefined,
        attachments: [],
        onAttachFile: () => undefined,
        onAttachFolder: () => undefined,
        onDetachAttachment: () => undefined,
        onReindexAttachment: () => undefined,
        modelHasVision: false,
        modelHasTools: false,
        ephemeral: false,
      })
    );
    window.__TEST_ROOT = root;
  });
}

test.describe("Composer", () => {
  test("Enter sends typed text via onSend", async ({ page }) => {
    await mountComposerWithSendSpy(page);
    const ta = page.locator("#test-root textarea");
    await expect(ta).toBeVisible();
    await ta.fill("Hello world");
    await ta.press("Enter");

    const sent = await page.evaluate(() => window.__SEND_CALLS);
    expect(sent).toEqual(["Hello world"]);
    // Textarea should clear after send.
    await expect(ta).toHaveValue("");
  });

  test("Shift+Enter inserts newline, does NOT send", async ({ page }) => {
    await mountComposerWithSendSpy(page);
    const ta = page.locator("#test-root textarea");
    await ta.fill("line one");
    await ta.press("Shift+Enter");
    await ta.type("line two");

    const sent = await page.evaluate(() => window.__SEND_CALLS);
    expect(sent).toEqual([]);
    const value = await ta.inputValue();
    expect(value).toBe("line one\nline two");
  });

  test("empty / whitespace-only text does not send", async ({ page }) => {
    await mountComposerWithSendSpy(page);
    const ta = page.locator("#test-root textarea");
    await ta.press("Enter");
    await ta.fill("   ");
    await ta.press("Enter");

    const sent = await page.evaluate(() => window.__SEND_CALLS);
    expect(sent).toEqual([]);
  });

  test("isStreaming=true blocks Enter", async ({ page }) => {
    // Override the mount with isStreaming=true. We re-derive instead of
    // calling the helper because the helper hardcodes false.
    await page.evaluate(() => {
      window.__SEND_CALLS = [];
      const onSendSpy = (text) => window.__SEND_CALLS.push(text);
      const host = document.getElementById("test-root");
      if (window.__TEST_ROOT) {
        try { window.__TEST_ROOT.unmount(); } catch (_) {}
      }
      host.innerHTML = "";
      const root = ReactDOM.createRoot(host);
      root.render(
        React.createElement(window.Composer, {
          // Composer expects an object shape, not a bare id string. See
        // main.jsx where `tabModel` is `MODELS.find(...)` (or a synthesised
        // { id, name, color } fallback).
        model: { id: "llama3:latest", name: "llama3", color: "#9bbf83" },
          onModelChange: () => undefined,
          onSend: onSendSpy,
          isStreaming: true,
          onStop: () => undefined,
          attachedPrompts: [],
          attachments: [],
        })
      );
      window.__TEST_ROOT = root;
    });
    const ta = page.locator("#test-root textarea");
    await expect(ta).toBeVisible();
    await ta.fill("would be sent if not streaming");
    await ta.press("Enter");

    const sent = await page.evaluate(() => window.__SEND_CALLS);
    expect(sent).toEqual([]);
  });
});
