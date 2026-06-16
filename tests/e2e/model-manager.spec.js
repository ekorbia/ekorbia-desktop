// In-app model manager smokes (ModelManagerPanel / ModelManagerModal in
// ui/model-manager.jsx).
//
// Covers the mount-level contracts:
//   1. Installed list renders names + parameter size + on-disk size from
//      the mocked ollama_tags shape.
//   2. Delete shows the ConfirmDialog and records an `ollama_delete`
//      invoke on confirm.
//   3. Pull drives a Channel-streamed progress bar (chunks delivered via
//      the mock Channel's __deliver) and records `ollama_pull`.
//   4. Cancel records `ollama_pull_cancel` with the pull's request id.
//   5. Empty installed list shows curated suggestions.
//
// The end-to-end pull (real Ollama, real bytes) is manual-verification
// territory — these specs pin the IPC contract and the UI wiring.

const { test, expect } = require("@playwright/test");

const TAGS_TWO_MODELS = {
  models: [
    {
      name: "gemma4:e4b",
      size: 9_600_000_000,
      details: { parameter_size: "4.5B", quantization_level: "Q4_K_M" },
    },
    {
      name: "nomic-embed-text",
      size: 274_000_000,
      details: { parameter_size: "137M", quantization_level: "F16" },
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test.describe("ModelManagerPanel", () => {
  test("renders installed models with sizes; active model badged", async ({ page }) => {
    await page.evaluate((tags) => {
      window.__INVOKE_RESPONSES.ollama_tags = () => tags;
      window.__TEST_MOUNT("ModelManagerPanel", { activeModel: "gemma4:e4b" });
    }, TAGS_TWO_MODELS);

    const root = page.locator("#test-root");
    await expect(root).toContainText("gemma4:e4b");
    await expect(root).toContainText("9.6 GB on disk");
    await expect(root).toContainText("nomic-embed-text");
    await expect(root).toContainText("274 MB on disk");
    await expect(root).toContainText("active");
  });

  test("delete flows through ConfirmDialog and records ollama_delete", async ({ page }) => {
    await page.evaluate((tags) => {
      window.__INVOKE_RESPONSES.ollama_tags = () => tags;
      window.__TEST_MOUNT("ModelManagerPanel", { activeModel: "gemma4:e4b" });
    }, TAGS_TWO_MODELS);

    await expect(page.locator("#test-root")).toContainText("nomic-embed-text");
    // Second Delete button belongs to nomic-embed-text (list is sorted
    // alphabetically: gemma4:e4b first).
    await page.locator("#test-root button", { hasText: "Delete" }).nth(1).click();

    // ConfirmDialog appears with the model name in its title.
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toContainText("Delete nomic-embed-text?");
    await dialog.locator("button", { hasText: "Delete" }).click();

    await page.waitForFunction(() =>
      window.__INVOKE_FIND("ollama_delete", (a) => a.model === "nomic-embed-text")
    );
  });

  test("pull streams progress chunks into the bar and records ollama_pull", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.ollama_tags = () => ({ models: [] });
      // Keep the pull pending so the Downloading row stays mounted; stash
      // the channel + resolver so the spec can drive it.
      window.__INVOKE_RESPONSES.ollama_pull = (args) => {
        window.__PULL_CHANNEL = args.onProgress;
        return new Promise((res) => { window.__PULL_RESOLVE = res; });
      };
      window.__TEST_MOUNT("ModelManagerPanel", { activeModel: null });
    });

    // Type a model name and pull.
    await page.locator('#test-root input[placeholder*="model name"]').fill("gemma4:e2b");
    await page.locator("#test-root button", { hasText: "Pull" }).first().click();

    await page.waitForFunction(() =>
      window.__INVOKE_FIND("ollama_pull", (a) => a.model === "gemma4:e2b")
    );

    // Drive two layers of progress through the mock Channel.
    await page.evaluate(() => {
      window.__PULL_CHANNEL.__deliver({ status: "pulling aaa", digest: "aaa", total: 1000, completed: 250 });
      window.__PULL_CHANNEL.__deliver({ status: "pulling bbb", digest: "bbb", total: 1000, completed: 250 });
    });
    await expect(page.locator("#test-root")).toContainText("25%");

    // Finish: success line + resolve the invoke promise → row leaves the
    // store and the panel refreshes tags.
    await page.evaluate(() => {
      window.__PULL_CHANNEL.__deliver({ status: "success" });
      window.__PULL_RESOLVE();
    });
    await expect(page.locator("#test-root")).not.toContainText("25%");
  });

  test("cancel records ollama_pull_cancel with the pull's request id", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.ollama_tags = () => ({ models: [] });
      window.__INVOKE_RESPONSES.ollama_pull = (args) => {
        window.__PULL_CHANNEL = args.onProgress;
        return new Promise((res) => { window.__PULL_RESOLVE = res; });
      };
      window.__TEST_MOUNT("ModelManagerPanel", { activeModel: null });
    });

    await page.locator('#test-root input[placeholder*="model name"]').fill("gemma4:e2b");
    await page.locator("#test-root button", { hasText: "Pull" }).first().click();
    await page.waitForFunction(() => window.__INVOKE_FIND("ollama_pull"));

    await page.locator("#test-root button", { hasText: "Cancel" }).click();

    // The cancel must target the SAME namespaced request id the pull used.
    const ids = await page.evaluate(() => {
      const pull = window.__INVOKE_FIND("ollama_pull");
      const cancel = window.__INVOKE_FIND("ollama_pull_cancel");
      return {
        pullId: pull && pull.args.requestId,
        cancelId: cancel && cancel.args.requestId,
      };
    });
    expect(ids.cancelId).toBe(ids.pullId);
    expect(ids.pullId).toMatch(/^pull:gemma4:e2b:/);

    // Unblock the pending invoke so the store cleans up.
    await page.evaluate(() => window.__PULL_RESOLVE());
  });

  test("empty installed list shows curated suggestions", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.ollama_tags = () => ({ models: [] });
      window.__TEST_MOUNT("ModelManagerPanel", { activeModel: null });
    });
    const root = page.locator("#test-root");
    await expect(root).toContainText("No models installed yet");
    await expect(root).toContainText("Suggestions");
    await expect(root).toContainText("gemma4:e4b");
    await expect(root).toContainText("nomic-embed-text");
  });

  test("already-installed models are excluded from the suggestions", async ({ page }) => {
    // The user's complaint: suggestions shouldn't re-offer models you have.
    await page.evaluate((tags) => {
      window.__INVOKE_RESPONSES.ollama_tags = () => tags;
      window.__TEST_MOUNT("ModelManagerPanel", { activeModel: "gemma4:e4b" });
    }, TAGS_TWO_MODELS); // gemma4:e4b + nomic-embed-text installed

    // Wait for the installed list (so suggestions have recomputed).
    await expect(page.locator("#test-root")).toContainText("on disk");

    const suggested = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-model-suggestion]")).map(
        (el) => el.getAttribute("data-model-suggestion")
      )
    );
    // Both installed models must be absent from suggestions...
    expect(suggested).not.toContain("gemma4:e4b");
    expect(suggested).not.toContain("nomic-embed-text");
    // ...while a curated model the user lacks is still offered.
    expect(suggested).toContain("granite4.1:8b");
  });

  test("download box has an offline type-ahead datalist (curated + installed)", async ({ page }) => {
    await page.evaluate((tags) => {
      window.__INVOKE_RESPONSES.ollama_tags = () => tags;
      window.__TEST_MOUNT("ModelManagerPanel", { activeModel: "gemma4:e4b" });
    }, TAGS_TWO_MODELS);

    await expect(page.locator("#test-root")).toContainText("on disk");

    // Input is wired to the datalist...
    await expect(page.locator('#test-root input[list="ek-model-list"]')).toHaveCount(1);
    const options = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#ek-model-list option")).map((o) => o.value)
    );
    // ...which unions curated names with the user's installed names.
    expect(options).toContain("granite4.1:8b"); // curated, not installed
    expect(options).toContain("gemma4:e4b"); // installed (pull-to-update)
  });
});

test.describe("ModelManagerModal", () => {
  test("mounts at zIndex 9999 and closes via the ✕ button", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.ollama_tags = () => ({ models: [] });
      window.__TEST_MOUNT("ModelManagerModal", { open: true, activeModel: null });
    });
    const zIndex = await page
      .locator("#test-root > div")
      .first()
      .evaluate((el) => window.getComputedStyle(el).zIndex);
    expect(zIndex).toBe("9999");

    await page.locator('button[aria-label="Close"]').click();
    await page.waitForFunction(() => (window.__TEST_CALLS.onClose || 0) >= 1);
  });
});
