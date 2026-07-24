// FilesPanel content preview + deleted-file handling (ui/files.jsx).
//
// chat_files_list now returns a per-file `preview` (one-line snippet read from
// disk) and `missing` (file no longer on disk). Present files show the preview
// line + Open/Reveal; missing files show a "deleted from disk" tag and a
// Remove action (which calls chat_file_remove) instead of dead Open/Reveal.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test("file rows show a content preview and flag deleted files", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.chat_output_dir = () => "/tmp/out";
    window.__INVOKE_RESPONSES.chat_files_list = () => [
      { id: "f1", chatId: "c1", messageId: "m1", relPath: "report.md",
        bytes: 120, savedAt: 1000, source: "tool", version: 1,
        preview: "# Q3 report first line", missing: false },
      { id: "f2", chatId: "c1", messageId: "m2", relPath: "gone.txt",
        bytes: 40, savedAt: 900, source: "tool", version: 1,
        preview: null, missing: true },
    ];
    window.__TEST_MOUNT("FilesPanel", { chatId: "c1", width: 320 });
  });

  const root = page.locator("#test-root");
  // Present file: name + preview line + an Open action.
  await expect(root.getByText("report.md")).toBeVisible();
  await expect(root.getByText("# Q3 report first line")).toBeVisible();
  await expect(root.getByRole("button", { name: "Open", exact: true })).toBeVisible();
  // Missing file: deleted tag + Remove (Open/Reveal are gone for it).
  await expect(root.getByText("deleted from disk")).toBeVisible();
  await expect(root.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
});

test("Remove calls chat_file_remove for the deleted file", async ({ page }) => {
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.chat_output_dir = () => "/tmp/out";
    window.__INVOKE_RESPONSES.chat_files_list = () => [
      { id: "f2", chatId: "c1", messageId: null, relPath: "gone.txt",
        bytes: 40, savedAt: 900, source: "tool", version: 1,
        preview: null, missing: true },
    ];
    window.__TEST_MOUNT("FilesPanel", { chatId: "c1", width: 320 });
  });

  const root = page.locator("#test-root");
  await root.getByRole("button", { name: "Remove", exact: true }).click();
  await page.waitForFunction(() =>
    (window.__INVOKES || []).some(
      (c) => c.cmd === "chat_file_remove" && c.args && c.args.fileId === "f2",
    ),
  );
});
