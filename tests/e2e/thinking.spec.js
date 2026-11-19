// Thinking + context window (0.8.0).
//
// Pins:
//   • ReasoningBlock (chat.jsx): a live, clipped, bottom-pinned box while the
//     model thinks; folded to "Thought for N s" once the answer starts; opens
//     on click. Plain text only — reasoning never goes through the HTML path.
//   • Message: the generic waiting dots yield to the live block and come back
//     when a thought ended before any answer text (a tool call in flight).
//   • Compare columns render the same block.
//   • Settings → Backend → engine card: the context-window select and the
//     Thinking switch save immediately through `engine_tuning_set`, redraw
//     from the status Rust returns, and announce it on `ekorbia:engine-tuning`.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

const mountMessage = (page, m) =>
  page.evaluate((m) => window.__TEST_MOUNT("Message", { m }), m);

test.describe("ReasoningBlock in a chat message", () => {
  test("live: shows the thought, replaces the waiting dots", async ({ page }) => {
    await mountMessage(page, {
      id: "a1",
      role: "assistant",
      content: "",
      streaming: true,
      reasoning: "Bat = ball + $1.00. Together $1.10.",
      reasoningLive: true,
      thoughtMs: 0,
    });
    const live = page.locator('[data-reasoning="live"]');
    await expect(live).toBeVisible();
    await expect(live).toContainText("Thinking…");
    await expect(live.locator("[data-reasoning-text]")).toHaveText(
      "Bat = ball + $1.00. Together $1.10.",
    );
    // The block is the sign of life — no second "Thinking…" indicator.
    await expect(page.locator("[data-stream-status]")).toHaveCount(0);
    await expect(page.locator("[data-reasoning-toggle]")).toHaveCount(0);
  });

  test("live: a long thought is clipped to a few lines and pinned to its newest text", async ({ page }) => {
    const long = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: consider the next case.`).join("\n");
    await mountMessage(page, {
      id: "a2",
      role: "assistant",
      content: "",
      streaming: true,
      reasoning: long,
      reasoningLive: true,
    });
    const box = page.locator('[data-reasoning="live"] [data-reasoning-text]');
    await expect(box).toBeVisible();
    const m = await box.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      scrollHeight: el.scrollHeight,
      fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
    }));
    expect(m.height).toBeLessThanOrEqual(80);
    expect(m.scrollHeight).toBeGreaterThan(400);
    expect(m.fromBottom).toBeLessThanOrEqual(1);
  });

  test("folded once the answer starts; opens and closes on click", async ({ page }) => {
    await mountMessage(page, {
      id: "a3",
      role: "assistant",
      content: "The ball costs $0.05.",
      streaming: false,
      reasoning: "Let x be the ball. x + (x + 1) = 1.10, so x = 0.05.",
      reasoningLive: false,
      thoughtMs: 12300,
    });
    const folded = page.locator('[data-reasoning="folded"]');
    await expect(folded).toBeVisible();
    const toggle = page.locator("[data-reasoning-toggle]");
    await expect(toggle).toHaveText(/Thought for 12 s/);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Folded = the thought is not on the page; the answer is.
    await expect(page.locator("[data-reasoning-text]")).toHaveCount(0);
    await expect(page.locator("#test-root")).toContainText("The ball costs $0.05.");

    await toggle.click();
    await expect(page.locator('[data-reasoning="open"]')).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("[data-reasoning-text]")).toHaveText(
      "Let x be the ball. x + (x + 1) = 1.10, so x = 0.05.",
    );

    await toggle.click();
    await expect(page.locator('[data-reasoning="folded"]')).toBeVisible();
    await expect(page.locator("[data-reasoning-text]")).toHaveCount(0);
  });

  test("still streaming the answer: folded line above the growing reply", async ({ page }) => {
    await mountMessage(page, {
      id: "a4",
      role: "assistant",
      content: "The ball",
      streaming: true,
      reasoning: "x = 0.05",
      reasoningLive: false,
      thoughtMs: 4000,
    });
    await expect(page.locator('[data-reasoning="folded"]')).toBeVisible();
    await expect(page.locator("[data-reasoning-toggle]")).toHaveText(/Thought for 4 s/);
    await expect(page.locator('[data-reasoning="live"]')).toHaveCount(0);
    await expect(page.locator("#test-root")).toContainText("The ball");
  });

  test("thought ended with no answer yet (tool call in flight): folded line + waiting dots", async ({ page }) => {
    await mountMessage(page, {
      id: "a5",
      role: "assistant",
      content: "",
      streaming: true,
      reasoning: "I should save the file first.",
      reasoningLive: false,
      thoughtMs: 2000,
    });
    await expect(page.locator('[data-reasoning="folded"]')).toBeVisible();
    await expect(page.locator("[data-stream-status]")).toBeVisible();
  });

  test("a stale live flag on a finished message never shows the live box", async ({ page }) => {
    // Stop pressed mid-thought: streaming is over, so the block folds.
    await mountMessage(page, {
      id: "a6",
      role: "assistant",
      content: "",
      streaming: false,
      reasoning: "Half a thought",
      reasoningLive: true,
      thoughtMs: 800,
    });
    await expect(page.locator('[data-reasoning="live"]')).toHaveCount(0);
    await expect(page.locator('[data-reasoning="folded"]')).toBeVisible();
  });

  test("no reasoning, no block — and user messages never get one", async ({ page }) => {
    await mountMessage(page, { id: "a7", role: "assistant", content: "Plain reply.", streaming: false });
    await expect(page.locator("[data-reasoning]")).toHaveCount(0);
    await mountMessage(page, { id: "u1", role: "user", content: "hi", reasoning: "nope", thoughtMs: 1 });
    await expect(page.locator("[data-reasoning]")).toHaveCount(0);
  });

  test("reasoning renders as plain text, never as HTML or markdown", async ({ page }) => {
    const hostile = '<img src=x onerror="window.__PWNED = 1"> **not bold** <script>window.__PWNED = 2</script>';
    await mountMessage(page, {
      id: "a8",
      role: "assistant",
      content: "ok",
      streaming: false,
      reasoning: hostile,
      thoughtMs: 1000,
    });
    await page.locator("[data-reasoning-toggle]").click();
    const text = page.locator("[data-reasoning-text]");
    await expect(text).toHaveText(hostile);
    expect(await text.locator("img, script, strong, b").count()).toBe(0);
    expect(await page.evaluate(() => window.__PWNED)).toBeUndefined();
  });
});

test.describe("ReasoningBlock in compare columns", () => {
  const mountCompare = (page, variants, isStreaming) =>
    page.evaluate(
      ({ variants, isStreaming }) =>
        window.__TEST_MOUNT("CompareChatPane", {
          chat: {
            id: "c1",
            title: "x",
            tabType: "multi-pending",
            models: variants.map((v) => v.model),
            messages: [{ id: "u1", role: "user", content: "go" }, ...variants],
          },
          isStreaming,
        }),
      { variants, isStreaming },
    );

  test("one column thinking live, the other already answered", async ({ page }) => {
    await mountCompare(
      page,
      [
        {
          id: "v-a", role: "assistant", model: "a", variantGroupId: "g1",
          content: "", streaming: true,
          reasoning: "Working through it…", reasoningLive: true, thoughtMs: 0,
        },
        {
          id: "v-b", role: "assistant", model: "b", variantGroupId: "g1",
          content: "Five cents.", streaming: false,
          reasoning: "x = 0.05", reasoningLive: false, thoughtMs: 65000,
        },
      ],
      true,
    );
    const a = page.locator('[data-compare-column][data-model="a"]');
    await expect(a.locator('[data-reasoning="live"]')).toBeVisible();
    await expect(a.locator("[data-reasoning-text]")).toHaveText("Working through it…");

    const b = page.locator('[data-compare-column][data-model="b"]');
    await expect(b.locator('[data-reasoning="folded"]')).toBeVisible();
    await expect(b.locator("[data-reasoning-toggle]")).toHaveText(/Thought for 1 min 5 s/);
    await expect(b).toContainText("Five cents.");
    await b.locator("[data-reasoning-toggle]").click();
    await expect(b.locator("[data-reasoning-text]")).toHaveText("x = 0.05");
  });

  test("a column without reasoning is unchanged", async ({ page }) => {
    await mountCompare(
      page,
      [{ id: "v-a", role: "assistant", model: "a", variantGroupId: "g1", content: "", streaming: true }],
      true,
    );
    const a = page.locator('[data-compare-column][data-model="a"]');
    await expect(a.locator("[data-reasoning]")).toHaveCount(0);
    await expect(a.locator(".typing-dot").first()).toBeVisible();
  });
});

test.describe("Settings → Backend → engine settings", () => {
  // Mirrors the real `engine_status` shape (providers/engine.rs — its Rust
  // test pins these keys) and an `engine_tuning_set` that applies the patch
  // the way Rust does: null = leave alone, returns the new status.
  const installEngine = (page, opts = {}) =>
    page.evaluate((opts) => {
      const status = {
        binaryOk: true,
        binaryPath: "/x/llama-server",
        binaryError: null,
        modelsDir: "/tmp/models",
        modelCount: 2,
        chatCtx: 32768,
        chatCtxChoices: [8192, 16384, 32768, 65536, 131072],
        chatCtxDefault: 32768,
        thinking: false,
      };
      window.__ENGINE_STATUS = status;
      window.__INVOKE_RESPONSES.llm_backend_config_get = () => ({ backend: "engine", baseUrl: null, apiKey: null });
      window.__INVOKE_RESPONSES.engine_status = () => ({ ...window.__ENGINE_STATUS });
      window.__INVOKE_RESPONSES.engine_tuning_set = (args) => {
        if (opts.fail) throw new Error("unsupported context window: 1 tokens");
        if (args.chatCtx != null) window.__ENGINE_STATUS.chatCtx = args.chatCtx;
        if (args.thinking != null) window.__ENGINE_STATUS.thinking = args.thinking;
        return { ...window.__ENGINE_STATUS };
      };
      window.__TUNING_EVENTS = [];
      window.addEventListener("ekorbia:engine-tuning", (e) => window.__TUNING_EVENTS.push(e.detail));
      window.__TEST_MOUNT("BackendSettings", {});
    }, opts);

  test("lists the windows Rust offers, marks the default, shows the current one", async ({ page }) => {
    await installEngine(page);
    const select = page.locator("[data-engine-ctx]");
    await expect(select).toBeVisible();
    await expect(select).toHaveValue("32768");
    await expect(select.locator("option")).toHaveText(["8K", "16K", "32K (default)", "64K", "128K"]);
    const sw = page.locator("[data-engine-thinking]");
    await expect(sw).toHaveAttribute("role", "switch");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    // The hints say what actually happens.
    await expect(page.locator("[data-engine-tuning]")).toContainText("the model reloads once");
    await expect(page.locator("[data-engine-tuning]")).toContainText("overlay and Watches always answer directly");
  });

  test("picking a window saves it, redraws from Rust's answer, and announces it", async ({ page }) => {
    await installEngine(page);
    await page.locator("[data-engine-ctx]").selectOption("65536");
    await expect(page.locator("[data-engine-ctx]")).toHaveValue("65536");
    const call = await page.evaluate(() => window.__INVOKE_FIND("engine_tuning_set").args);
    // Only the window is sent; Thinking is explicitly left alone.
    expect(call).toEqual({ chatCtx: 65536, thinking: null });
    const events = await page.evaluate(() => window.__TUNING_EVENTS);
    expect(events).toHaveLength(1);
    expect(events[0].chatCtx).toBe(65536);
    expect(events[0].thinking).toBe(false);
  });

  test("the Thinking switch saves on click and leaves the window alone", async ({ page }) => {
    await installEngine(page);
    const sw = page.locator("[data-engine-thinking]");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    let calls = await page.evaluate(() =>
      window.__INVOKES.filter((c) => c.cmd === "engine_tuning_set").map((c) => c.args),
    );
    expect(calls).toEqual([{ chatCtx: null, thinking: true }]);
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    calls = await page.evaluate(() =>
      window.__INVOKES.filter((c) => c.cmd === "engine_tuning_set").map((c) => c.args),
    );
    expect(calls[1]).toEqual({ chatCtx: null, thinking: false });
    expect(await page.evaluate(() => window.__TUNING_EVENTS.map((e) => e.thinking))).toEqual([true, false]);
  });

  test("a refused change shows the reason and keeps the old value", async ({ page }) => {
    await installEngine(page, { fail: true });
    await page.locator("[data-engine-ctx]").selectOption("8192");
    await expect(page.locator("[data-engine-tuning-error]")).toContainText("unsupported context window");
    await expect(page.locator("[data-engine-ctx]")).toHaveValue("32768");
    expect(await page.evaluate(() => window.__TUNING_EVENTS.length)).toBe(0);
  });

  test("an engine status without the window list hides the settings instead of guessing", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.llm_backend_config_get = () => ({ backend: "engine", baseUrl: null, apiKey: null });
      window.__INVOKE_RESPONSES.engine_status = () => ({
        binaryOk: true, binaryPath: "/x/llama-server", binaryError: null,
        modelsDir: "/tmp/models", modelCount: 1, chatCtx: 32768,
      });
      window.__TEST_MOUNT("BackendSettings", {});
    });
    await expect(page.locator("[data-backend-engine-binary]")).toBeVisible();
    await expect(page.locator("[data-engine-tuning]")).toHaveCount(0);
  });
});
