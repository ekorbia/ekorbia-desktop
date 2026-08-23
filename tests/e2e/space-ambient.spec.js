// Space ambient tinting (ui/chat.jsx ChatPane + ui/shell.jsx Sidebar).
// When a chat lives in a colored Space, the pane's whisper-level ambient
// glows take that Space's color; while a Space filter is active, the
// sidebar rail wears a matching wash at the top. Both resolve through
// spaceAmbientTint (ui/utils.js — guards node-tested there) and expose
// the resolved hex as data-space-tint for these pins.
//
// Pins:
//   • ChatPane in a purple Space → data-space-tint + purple rgb in the
//     computed background; default amber glow gone.
//   • No Space / colorless Space / unknown color key → default ambience
//     (amber glow present, no data-space-tint).
//   • Light theme (T.isLight) → flat background, never a tint.
//   • Sidebar with an active colored Space → data-space-tint + tinted
//     wash; "All chats" (null) → flat bg1.
//
// SPACE_COLORS is frozen at the one_dark accents (tokens.jsx load
// order), so the expected rgb triplets are stable regardless of theme:
// purple #c281f5 → 194, 129, 245 · green #7dd17a → 125, 209, 122 ·
// default amber #f0934a → 240, 147, 74.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const PURPLE_RGB = "194, 129, 245";
const GREEN_RGB = "125, 209, 122";
const AMBER_RGB = "240, 147, 74";

const BASE_CHAT = {
  id: "c1",
  title: "Chapter drafts",
  messages: [
    { id: "u1", role: "user", content: "hello" },
    { id: "a1", role: "assistant", content: "hi there", model: "gemma4:12b" },
  ],
};
const MODEL = { id: "gemma4:12b", name: "Gemma", color: "#7ee787" };

async function paneBackground(page) {
  return page.evaluate(() => {
    const el = document.querySelector("[data-chat-pane]");
    return getComputedStyle(el).backgroundImage;
  });
}

test("chat in a colored Space tints the pane glows", async ({ page }) => {
  await page.evaluate(
    ({ chat, model }) => {
      window.__TEST_MOUNT("ChatPane", {
        chat,
        model,
        space: { id: "s1", name: "Novel", color: "purple" },
      });
    },
    { chat: BASE_CHAT, model: MODEL },
  );
  const pane = page.locator("[data-chat-pane]");
  await expect(pane).toHaveAttribute("data-space-tint", "#c281f5");
  const bg = await paneBackground(page);
  expect(bg).toContain(PURPLE_RGB);
  expect(bg).not.toContain(AMBER_RGB);
});

test("chat with no Space keeps the default amber/blue ambience", async ({ page }) => {
  await page.evaluate(
    ({ chat, model }) => {
      window.__TEST_MOUNT("ChatPane", { chat, model, space: null });
    },
    { chat: BASE_CHAT, model: MODEL },
  );
  const pane = page.locator("[data-chat-pane]");
  await expect(pane).not.toHaveAttribute("data-space-tint", /.+/);
  const bg = await paneBackground(page);
  expect(bg).toContain(AMBER_RGB);
  expect(bg).not.toContain(PURPLE_RGB);
});

test("colorless or unknown-color Spaces fall back to the default ambience", async ({ page }) => {
  await page.evaluate(
    ({ chat, model }) => {
      window.__TEST_MOUNT("ChatPane", {
        chat,
        model,
        space: { id: "s1", name: "Novel", color: null },
      });
    },
    { chat: BASE_CHAT, model: MODEL },
  );
  let bg = await paneBackground(page);
  expect(bg).toContain(AMBER_RGB);

  await page.evaluate(
    ({ chat, model }) => {
      window.__TEST_MOUNT("ChatPane", {
        chat,
        model,
        // A palette key that doesn't exist (e.g. purged in a future
        // palette change) must not smear the fg2 fallback everywhere.
        space: { id: "s1", name: "Novel", color: "magenta" },
      });
    },
    { chat: BASE_CHAT, model: MODEL },
  );
  await expect(page.locator("[data-chat-pane]")).not.toHaveAttribute(
    "data-space-tint",
    /.+/,
  );
  bg = await paneBackground(page);
  expect(bg).toContain(AMBER_RGB);
});

test("light themes stay flat — no tint even in a colored Space", async ({ page }) => {
  await page.evaluate(
    ({ chat, model }) => {
      // T is a global-lexical const (tokens.jsx); flipping isLight here
      // mimics App()'s theme apply for a light palette. beforeEach
      // reloads the fixture, so this never leaks into other tests.
      T.isLight = true;
      window.__TEST_MOUNT("ChatPane", {
        chat,
        model,
        space: { id: "s1", name: "Novel", color: "purple" },
      });
    },
    { chat: BASE_CHAT, model: MODEL },
  );
  const pane = page.locator("[data-chat-pane]");
  await expect(pane).not.toHaveAttribute("data-space-tint", /.+/);
  const bg = await paneBackground(page);
  expect(bg).toBe("none");
});

const SIDEBAR_PROPS = {
  chats: { dateSections: [] },
  spaces: [
    { id: "s1", name: "Novel", color: "green" },
    { id: "s2", name: "Recipes", color: null },
  ],
  activeId: null,
  query: "",
  width: 240,
  messageHits: [],
};

test("sidebar wears the active Space's wash", async ({ page }) => {
  await page.evaluate((props) => {
    window.__TEST_MOUNT("Sidebar", { ...props, activeSpaceId: "s1" });
  }, SIDEBAR_PROPS);
  const rail = page.locator("[data-sidebar]");
  await expect(rail).toHaveAttribute("data-space-tint", "#7dd17a");
  const bg = await page.evaluate(() => {
    const el = document.querySelector("[data-sidebar]");
    return getComputedStyle(el).backgroundImage;
  });
  expect(bg).toContain(GREEN_RGB);
});

test("sidebar is flat on All chats and for colorless active Spaces", async ({ page }) => {
  await page.evaluate((props) => {
    window.__TEST_MOUNT("Sidebar", { ...props, activeSpaceId: null });
  }, SIDEBAR_PROPS);
  const rail = page.locator("[data-sidebar]");
  await expect(rail).not.toHaveAttribute("data-space-tint", /.+/);
  let bg = await page.evaluate(() => {
    const el = document.querySelector("[data-sidebar]");
    return getComputedStyle(el).backgroundImage;
  });
  expect(bg).toBe("none");

  await page.evaluate((props) => {
    window.__TEST_MOUNT("Sidebar", { ...props, activeSpaceId: "s2" });
  }, SIDEBAR_PROPS);
  await expect(rail).not.toHaveAttribute("data-space-tint", /.+/);
  bg = await page.evaluate(() => {
    const el = document.querySelector("[data-sidebar]");
    return getComputedStyle(el).backgroundImage;
  });
  expect(bg).toBe("none");
});
