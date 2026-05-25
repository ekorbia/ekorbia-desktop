// Mount smokes for the Phase 4 multi-model compare-mode UI.
//
// CompareChatPane is now the real pane (replacing the Phase 2 stub):
// header + user-message bubble + N-column grid + composer. These tests
// cover the rendering branches and the key handler wiring; the full
// fan-out send pipeline (handleSendMultiModel) requires the live App
// context and is exercised manually until an integration harness exists.
//
// Two stable contracts these tests pin against future refactors:
//
//   1. The grid renders exactly one column per declared model — no
//      dedup, no reordering hidden behind state.
//
//   2. The Keep button is gated on "stream finished AND content
//      non-empty". An errored variant (incomplete + no content) is
//      explicitly NOT pickable, since it'd transition the chat to a
//      single-from-multi state with empty canonical content.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
  // Phase 5 added a /api/tags fetch inside CompareChatPane's mount
  // effect to detect uninstalled models. In the test harness no Ollama
  // is running on localhost:11434, AND the synthetic model names tests
  // use ("a", "b", "alpha") aren't real models anyway. We mock the
  // fetch globally here to return EVERY model name any test uses, so
  // by default the missing-banner doesn't fire. Tests that DO want to
  // exercise the missing-banner path override window.fetch per-test
  // before calling __TEST_MOUNT — that wins because their override is
  // set after this beforeEach finishes.
  await page.evaluate(() => {
    const allKnown = [
      "a", "b", "c",
      "alpha", "beta", "gamma",
      "gemma4:26b", "llama3:70b", "qwen2.5:32b",
      "gemma4:latest", "gemma4:e2b", "granite4.1:8b",
      "qwen3.5:4b", "qwen3.5:latest", "qwen3.6:27b",
    ];
    window.fetch = (url) => {
      if (typeof url === "string" && url.includes("/api/tags")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            models: allKnown.map((name) => ({ name })),
          }),
        });
      }
      return Promise.reject(new Error("unexpected fetch in test: " + url));
    };
  });
});

test.describe("CompareChatPane (Phase 4)", () => {
  test("empty state shows the model count + composer is enabled", async ({
    page,
  }) => {
    // No user message yet — the pane should show the empty-state hint
    // and the composer's Send button should be enabled once text is
    // typed.
    await page.evaluate(() =>
      window.__TEST_MOUNT("CompareChatPane", {
        chat: {
          id: "c1",
          title: "Compare adventure",
          tabType: "multi-pending",
          models: ["gemma4:26b", "llama3:70b", "qwen2.5:32b"],
          messages: [],
        },
        isStreaming: false,
      }),
    );

    await expect(page.locator("[data-compare-empty]")).toBeVisible();
    await expect(page.locator("#test-root")).toContainText(
      "Ready to compare 3 models",
    );

    // Send button starts disabled (empty textarea) — type then it lights up.
    const send = page.locator("[data-compare-send]");
    await expect(send).toBeDisabled();
    await page.locator("[data-compare-composer] textarea").fill("Hello!");
    await expect(send).toBeEnabled();
  });

  test("with messages, renders one column per declared model", async ({
    page,
  }) => {
    const chat = {
      id: "c1",
      title: "Compare",
      tabType: "multi-pending",
      models: ["a", "b", "c"],
      messages: [
        { id: "u1", role: "user", content: "go" },
        {
          id: "v-a",
          role: "assistant",
          model: "a",
          content: "from a",
          variantGroupId: "g1",
          streaming: false,
        },
        {
          id: "v-b",
          role: "assistant",
          model: "b",
          content: "from b",
          variantGroupId: "g1",
          streaming: false,
        },
        {
          id: "v-c",
          role: "assistant",
          model: "c",
          content: "from c",
          variantGroupId: "g1",
          streaming: false,
        },
      ],
    };
    await page.evaluate((c) =>
      window.__TEST_MOUNT("CompareChatPane", { chat: c, isStreaming: false }),
      chat,
    );

    // One column per declared model — assert by count AND by content so
    // a re-ordering bug doesn't silently pass.
    await expect(page.locator("[data-compare-column]")).toHaveCount(3);
    await expect(page.locator('[data-model="a"]')).toContainText("from a");
    await expect(page.locator('[data-model="b"]')).toContainText("from b");
    await expect(page.locator('[data-model="c"]')).toContainText("from c");
    // The user message bubble renders ONCE above the grid (not per
    // column) — verify the body contains "go" and the role chip "You".
    await expect(page.locator("#test-root")).toContainText("You");
    await expect(page.locator("#test-root")).toContainText("go");
  });

  test("Keep button is enabled on a finished non-empty variant", async ({
    page,
  }) => {
    await page.evaluate(() =>
      window.__TEST_MOUNT("CompareChatPane", {
        chat: {
          id: "c1",
          title: "x",
          tabType: "multi-pending",
          models: ["a"],
          messages: [
            { id: "u1", role: "user", content: "go" },
            {
              id: "v-a",
              role: "assistant",
              model: "a",
              content: "ok",
              variantGroupId: "g1",
              streaming: false,
            },
          ],
        },
        isStreaming: false,
      }),
    );
    const keep = page.locator('[data-model="a"] [data-keep]');
    await expect(keep).toBeEnabled();
    await keep.click();
    await expect
      .poll(() => page.evaluate(() => window.__TEST_CALLS.onKeep || 0))
      .toBeGreaterThan(0);
  });

  test("Keep button is disabled on a streaming variant", async ({ page }) => {
    await page.evaluate(() =>
      window.__TEST_MOUNT("CompareChatPane", {
        chat: {
          id: "c1",
          title: "x",
          tabType: "multi-pending",
          models: ["a"],
          messages: [
            { id: "u1", role: "user", content: "go" },
            {
              id: "v-a",
              role: "assistant",
              model: "a",
              content: "half",
              variantGroupId: "g1",
              streaming: true,
            },
          ],
        },
        // The whole pane is in streaming state too — used to decide
        // composer-lock + Stop-all visibility.
        isStreaming: true,
      }),
    );
    // While the column is streaming, the footer (which holds Keep) is
    // hidden entirely. The data-keep selector should match zero elements.
    await expect(page.locator('[data-model="a"] [data-keep]')).toHaveCount(0);
    // Per-column Stop button is visible in the column header.
    await expect(page.locator('[data-model="a"] [data-stop-column]')).toBeVisible();
  });

  test("Keep button is disabled on a finished EMPTY variant", async ({
    page,
  }) => {
    // The "errored stream that produced no text" case. The footer DOES
    // render (streaming finished), but Keep is disabled because there's
    // nothing to keep.
    await page.evaluate(() =>
      window.__TEST_MOUNT("CompareChatPane", {
        chat: {
          id: "c1",
          title: "x",
          tabType: "multi-pending",
          models: ["a"],
          messages: [
            { id: "u1", role: "user", content: "go" },
            {
              id: "v-a",
              role: "assistant",
              model: "a",
              content: "",
              incomplete: true,
              variantGroupId: "g1",
              streaming: false,
            },
          ],
        },
        isStreaming: false,
      }),
    );
    await expect(page.locator('[data-model="a"] [data-keep]')).toBeDisabled();
  });

  test("Stop all button appears only while streaming and calls onStopAll", async ({
    page,
  }) => {
    await page.evaluate(() =>
      window.__TEST_MOUNT("CompareChatPane", {
        chat: {
          id: "c1",
          title: "x",
          tabType: "multi-pending",
          models: ["a", "b"],
          messages: [
            { id: "u1", role: "user", content: "go" },
            {
              id: "v-a",
              role: "assistant",
              model: "a",
              content: "",
              variantGroupId: "g1",
              streaming: true,
            },
            {
              id: "v-b",
              role: "assistant",
              model: "b",
              content: "",
              variantGroupId: "g1",
              streaming: true,
            },
          ],
        },
        isStreaming: true,
      }),
    );
    const stopAll = page.locator("[data-stop-all]");
    await expect(stopAll).toBeVisible();
    await stopAll.click();
    await expect
      .poll(() => page.evaluate(() => window.__TEST_CALLS.onStopAll || 0))
      .toBeGreaterThan(0);
  });

  test("Composer is locked once a user message exists, even when finished", async ({
    page,
  }) => {
    // Compare-mode v1 is one-shot per chat. After the first send (so a
    // user message exists), the composer prompts the user to pick a
    // winner instead of accepting follow-up input. This pins that.
    await page.evaluate(() =>
      window.__TEST_MOUNT("CompareChatPane", {
        chat: {
          id: "c1",
          title: "x",
          tabType: "multi-pending",
          models: ["a", "b"],
          messages: [
            { id: "u1", role: "user", content: "go" },
            {
              id: "v-a",
              role: "assistant",
              model: "a",
              content: "done",
              variantGroupId: "g1",
              streaming: false,
            },
            {
              id: "v-b",
              role: "assistant",
              model: "b",
              content: "done",
              variantGroupId: "g1",
              streaming: false,
            },
          ],
        },
        isStreaming: false,
      }),
    );
    await expect(page.locator("[data-compare-composer] textarea")).toBeDisabled();
    await expect(page.locator("#test-root")).toContainText(
      "Pick a winner above",
    );
  });

  test("REGRESSION: pane mounts without throwing on minimal chat shape", async ({
    page,
  }) => {
    // The render fast-paths through useMemo + Maps — protect against a
    // Rules-of-Hooks regression by re-rendering across a prop transition
    // that changes the messages array shape.
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.evaluate(() => {
      window.__TEST_MOUNT("CompareChatPane", {
        chat: {
          id: "c1",
          title: "x",
          tabType: "multi-pending",
          models: ["a"],
          messages: [],
        },
        isStreaming: false,
      });
      // Re-render with a user message + a streaming variant to force
      // every memo to re-evaluate.
      window.__TEST_RERENDER("CompareChatPane", {
        chat: {
          id: "c1",
          title: "x",
          tabType: "multi-pending",
          models: ["a"],
          messages: [
            { id: "u1", role: "user", content: "go" },
            {
              id: "v-a",
              role: "assistant",
              model: "a",
              content: "",
              variantGroupId: "g1",
              streaming: true,
            },
          ],
        },
        isStreaming: true,
      });
    });
    await expect(page.locator("[data-compare-column]")).toHaveCount(1);
    expect(pageErrors).toEqual([]);
  });
});

test.describe("Phase 5: missing-model banner", () => {
  // The banner depends on a /api/tags fetch — in the test harness no
  // server runs on localhost:11434, so the fetch fails and `missing`
  // resolves to [] (fail-open path). To assert the BANNER UI we need to
  // override fetch and return a controlled list. The mock-tauri fixture
  // already intercepts window.__TAURI__, but window.fetch is real here.
  // We patch it locally per-test.

  test("renders banner when a chat model is not in /api/tags", async ({
    page,
  }) => {
    await page.evaluate(() => {
      // Override fetch to return a fixed tags list that's MISSING one of
      // the chat's models. Restore happens at unmount; tests are isolated
      // per page, so leaking is harmless.
      window.fetch = (url) => {
        if (typeof url === "string" && url.includes("/api/tags")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ models: [{ name: "alpha" }, { name: "beta" }] }),
          });
        }
        return Promise.reject(new Error("unexpected fetch"));
      };
      window.__TEST_MOUNT("CompareChatPane", {
        chat: {
          id: "c1",
          title: "x",
          tabType: "multi-pending",
          // gamma is NOT in the mocked tags list → banner should fire
          models: ["alpha", "beta", "gamma"],
          messages: [],
        },
        isStreaming: false,
      });
    });
    const banner = page.locator("[data-compare-missing-banner]");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("1 model is no longer installed");
    await expect(banner.locator('[data-missing-model="gamma"]')).toBeVisible();
    // Composer hint text changes to flag the missing-models lock.
    await expect(page.locator("#test-root")).toContainText(
      "install the missing models above",
    );
    // Composer is disabled because of the missing models.
    await expect(
      page.locator("[data-compare-composer] textarea"),
    ).toBeDisabled();
  });

  test("does NOT render banner when every chat model is present", async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.fetch = (url) => {
        if (typeof url === "string" && url.includes("/api/tags")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                models: [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
              }),
          });
        }
        return Promise.reject(new Error("unexpected fetch"));
      };
      window.__TEST_MOUNT("CompareChatPane", {
        chat: {
          id: "c1",
          title: "x",
          tabType: "multi-pending",
          models: ["alpha", "beta"],
          messages: [],
        },
        isStreaming: false,
      });
    });
    // Poll once for the async effect to settle, then assert absence.
    await page.waitForTimeout(150);
    await expect(
      page.locator("[data-compare-missing-banner]"),
    ).toHaveCount(0);
  });
});

test.describe("Phase 5: alternatives disclosure (in ChatPane Message)", () => {
  // The disclosure lives in the Message component (chat.jsx) and only
  // fires when m.alternatives is non-empty. main.jsx is the producer
  // of that shape via the pre-process at the ChatPane call site; this
  // test exercises the consumer side directly.

  test("renders collapsed disclosure when alternatives exist", async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.__TEST_MOUNT("Message", {
        m: {
          id: "v-a",
          role: "assistant",
          model: "alpha",
          content: "Picked answer",
          isPicked: 1,
          variantGroupId: "g1",
          alternatives: [
            { id: "v-b", model: "beta", content: "Beta's answer" },
            { id: "v-c", model: "gamma", content: "Gamma's answer" },
          ],
        },
      });
    });
    const toggle = page.locator("[data-alternatives-toggle]");
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText("2 alternatives");
    await expect(toggle).toContainText("beta, gamma");
    // Panel is collapsed by default — no cards rendered yet.
    await expect(page.locator("[data-alternative]")).toHaveCount(0);
  });

  test("click expands disclosure to show each alternative's content", async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.__TEST_MOUNT("Message", {
        m: {
          id: "v-a",
          role: "assistant",
          model: "alpha",
          content: "Picked",
          isPicked: 1,
          variantGroupId: "g1",
          alternatives: [
            { id: "v-b", model: "beta", content: "Beta wrote this" },
            { id: "v-c", model: "gamma", content: "Gamma wrote this" },
          ],
        },
      });
    });
    await page.locator("[data-alternatives-toggle]").click();
    await expect(page.locator("[data-alternative]")).toHaveCount(2);
    await expect(page.locator('[data-alt-model="beta"]')).toContainText(
      "Beta wrote this",
    );
    await expect(page.locator('[data-alt-model="gamma"]')).toContainText(
      "Gamma wrote this",
    );
  });

  test("no disclosure on single-mode messages (no alternatives)", async ({
    page,
  }) => {
    // The common case — a regular assistant message with no variant
    // history. Must NOT render the toggle.
    await page.evaluate(() => {
      window.__TEST_MOUNT("Message", {
        m: {
          id: "m1",
          role: "assistant",
          model: "alpha",
          content: "Hi",
        },
      });
    });
    await expect(page.locator("[data-alternatives-toggle]")).toHaveCount(0);
  });
});

test.describe("CompareModelPickerModal", () => {
  test("open=false renders nothing", async ({ page }) => {
    await page.evaluate(() => {
      window.__TEST_MOUNT("CompareModelPickerModal", { open: false });
    });
    const innerHtml = await page.evaluate(
      () => document.getElementById("test-root").innerHTML,
    );
    expect(innerHtml).toBe("");
  });

  test("open=true renders the modal heading", async ({ page }) => {
    await page.evaluate(() => {
      window.__TEST_MOUNT("CompareModelPickerModal", { open: true });
    });
    await expect(page.locator("#test-root")).toContainText(
      "New comparison chat",
    );
    const done = page.locator("#test-root button", { hasText: "Done" });
    await expect(done).toBeVisible();
    await expect(done).toBeDisabled();
  });

  test("REGRESSION: open false → true does not throw Rules-of-Hooks", async ({
    page,
  }) => {
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.evaluate(() => {
      window.__TEST_MOUNT("CompareModelPickerModal", { open: false });
    });
    await page.evaluate(() => {
      window.__TEST_RERENDER("CompareModelPickerModal", { open: true });
    });
    await expect(page.locator("#test-root")).toContainText(
      "New comparison chat",
    );
    expect(pageErrors).toEqual([]);
  });
});
