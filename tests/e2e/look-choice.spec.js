// The look: Light, Dark, or Match system (the REAL app — helpers/app.js).
//
// There were six themes. Two looks remain, light is the default, and a
// theme saved by an older version maps to the nearer of the two
// (normalizeLook / resolveLook in ui/utils.js, unit-tested there).

const { test, expect } = require("@playwright/test");
const { openApp } = require("./helpers/app");

const ground = (page) =>
  page.locator("[data-home]").evaluate((el) => getComputedStyle(el).backgroundColor);
const isLight = (rgb) => {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return r + g + b > 600;
};

async function openGeneral(page) {
  await page.locator("[data-more-menu-button]").click();
  await page.locator("[data-more-settings]").click();
  await page.locator('[data-settings-tab="general"]').click();
  await expect(page.locator("[data-look-select]")).toBeVisible();
}

test("a new install starts in the light look", async ({ page }) => {
  await openApp(page);
  expect(isLight(await ground(page))).toBe(true);
});

test("Settings offers Light, Dark and Match system, and nothing else", async ({ page }) => {
  await openApp(page);
  await openGeneral(page);
  const select = page.locator("[data-look-select]");
  await expect(select).toHaveValue("one_light");
  expect(await select.locator("option").allTextContents()).toEqual(["Light", "Dark", "Match system"]);
});

test("choosing Dark redraws the app and is remembered", async ({ page }) => {
  await openApp(page);
  await openGeneral(page);
  await page.locator("[data-look-select]").selectOption("one_dark");
  await expect.poll(async () => isLight(await ground(page))).toBe(false);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ekorbia.tweaks")).theme)).toBe("one_dark");
});

test("a dark theme from an older version opens dark and shows as Dark", async ({ page }) => {
  await openApp(page, () => localStorage.setItem("ekorbia.tweaks", JSON.stringify({ theme: "ayu_mirage" })));
  expect(isLight(await ground(page))).toBe(false);
  await openGeneral(page);
  await expect(page.locator("[data-look-select]")).toHaveValue("one_dark");
});

test("a light theme from an older version opens light", async ({ page }) => {
  await openApp(page, () => localStorage.setItem("ekorbia.tweaks", JSON.stringify({ theme: "ayu_light" })));
  expect(isLight(await ground(page))).toBe(true);
});

test("Match system follows macOS", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page, () => localStorage.setItem("ekorbia.tweaks", JSON.stringify({ theme: "system" })));
  expect(isLight(await ground(page))).toBe(false);
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(async () => isLight(await ground(page))).toBe(true);
});
