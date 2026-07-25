// Bundled engine backend (no-Ollama plan, Phase 2): Settings → Backend
// engine card, model-manager engine view, and the `status` stream
// event's placeholder rendering in Message.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test.describe("BackendSettings — engine card", () => {
  test("selecting the engine shows status, hides endpoint fields", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.engine_status = () => ({
        binaryOk: true,
        binaryPath: "/Applications/Ekorbia.app/Contents/MacOS/llama-server",
        binaryError: null,
        modelsDir: "/Users/me/Library/Application Support/com.ekorbia.desktop/models",
        modelCount: 2,
      });
      window.__TEST_MOUNT("BackendSettings", {});
    });
    await page.locator('[data-backend-option="engine"]').click();
    // No endpoint fields on the engine backend…
    await expect(page.locator("[data-backend-url]")).toHaveCount(0);
    // …but a live engine readout + the models folder.
    await expect(page.locator("[data-backend-engine-binary]")).toContainText(
      "Engine ready (2 models",
    );
    await expect(page.locator("[data-backend-engine-info]")).toContainText(
      "com.ekorbia.desktop/models",
    );
  });

  test("missing engine binary surfaces the fetch-script hint", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.engine_status = () => ({
        binaryOk: false,
        binaryPath: null,
        binaryError:
          "llama-server binary not found (tried: …). Run scripts/fetch-llama-server.sh once to build it.",
        modelsDir: "/tmp/models",
        modelCount: 0,
      });
      window.__TEST_MOUNT("BackendSettings", {});
    });
    await page.locator('[data-backend-option="engine"]').click();
    await expect(page.locator("[data-backend-engine-binary]")).toContainText(
      "fetch-llama-server.sh",
    );
  });

  test("reveal button opens the models folder; save needs no URL", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.engine_status = () => ({
        binaryOk: true,
        binaryPath: "/x/llama-server",
        binaryError: null,
        modelsDir: "/tmp/models",
        modelCount: 0,
      });
      window.__TEST_MOUNT("BackendSettings", {});
    });
    await page.locator('[data-backend-option="engine"]').click();
    await page.locator("[data-backend-engine-reveal]").click();
    await page.waitForFunction(() =>
      window.__INVOKE_FIND("engine_models_dir_reveal", () => true),
    );
    // Saving the engine backend must succeed with no base URL at all.
    await page.locator("[data-backend-save]").click();
    await page.waitForFunction(() =>
      window.__INVOKE_FIND(
        "llm_backend_config_set",
        (a) => a.backendKind === "engine" && !a.baseUrl,
      ),
    );
  });
});

// Shared mocks for the engine-backend model manager (Phase 3 catalog).
const mountEngineManager = (overrides) =>
  `(() => {
    window.__INVOKE_RESPONSES.llm_backend_config_get = () => ({
      backend: "engine", baseUrl: null, apiKey: null,
    });
    window.__INVOKE_RESPONSES.engine_status = () => ({
      binaryOk: true, binaryPath: "/x/llama-server", binaryError: null,
      modelsDir: "/Users/me/models", modelCount: 1,
    });
    window.__INVOKE_RESPONSES.system_profile = () => ({
      totalRamBytes: 16 * 1073741824,
    });
    window.__INVOKE_RESPONSES.engine_catalog = () => ({
      version: 1,
      models: [
        { id: "gemma4-12b", label: "Gemma 4 12B", blurb: "Daily driver",
          purpose: "chat", recommended: true, minRamGb: 16,
          caps: { vision: true, tools: true }, license: "apache-2.0",
          source: "google/x", totalBytes: 7160000000, installed: false,
          files: [] },
        { id: "gemma4-26b-a4b", label: "Gemma 4 26B (A4B)", blurb: "Power option",
          purpose: "chat", recommended: false, minRamGb: 32,
          caps: { vision: true, tools: true }, license: "apache-2.0",
          source: "ggml-org/x", totalBytes: 15430000000, installed: false,
          files: [] },
        { id: "nomic-embed-text", label: "Nomic Embed Text v1.5", blurb: "RAG",
          purpose: "embed", recommended: false, minRamGb: 8,
          caps: { vision: false, tools: false }, license: "apache-2.0",
          source: "nomic-ai/x", totalBytes: 274000000, installed: true,
          files: [] },
      ],
    });
    window.__INVOKE_RESPONSES.llm_list_models = () => ({
      models: [{ name: "nomic-embed-text", model: "nomic-embed-text", size: 274000000 }],
    });
    ${overrides || ""}
    window.__TEST_MOUNT("ModelManagerPanel", { activeModel: "gemma4-12b" });
  })()`;

test.describe("ModelManagerPanel — engine view", () => {
  test("hides Ollama pull box, shows folder hint + discovered ggufs", async ({ page }) => {
    await page.evaluate(mountEngineManager());
    const root = page.locator("#test-root");
    // Discovered models render from the dir scan…
    await expect(root).toContainText("nomic-embed-text");
    // …with the engine hint + reveal instead of the Ollama pull box.
    await expect(page.locator("[data-engine-hint]")).toContainText("models folder");
    await expect(page.locator("[data-engine-reveal]")).toBeVisible();
    await expect(root).not.toContainText("Download a model");
    await expect(root).not.toContainText("ollama.com/library");
  });

  test("catalog renders states: download, installed, RAM warning, chips", async ({ page }) => {
    await page.evaluate(mountEngineManager());
    const root = page.locator("#test-root");
    await expect(root).toContainText("Model catalog");
    // The recommended model that fits 16 GB leads as the hero pick.
    await expect(page.locator('[data-catalog-download="gemma4-12b"]')).toBeVisible();
    await expect(page.locator('[data-catalog-model="gemma4-12b"]')).toContainText("best for your Mac");
    // 32 GB model on a 16 GB machine → amber RAM warning (still downloadable).
    const big = page.locator('[data-catalog-model="gemma4-26b-a4b"]');
    await expect(big.locator("[data-catalog-ram-warning]")).toContainText("32 GB");
    await expect(page.locator('[data-catalog-download="gemma4-26b-a4b"]')).toBeVisible();
    // Installed embed model → ✓ + embeddings chip, no Download button.
    const nomic = page.locator('[data-catalog-model="nomic-embed-text"]');
    await expect(nomic.locator("[data-catalog-installed]")).toContainText("installed");
    await expect(nomic).toContainText("embeddings");
    await expect(page.locator('[data-catalog-download="nomic-embed-text"]')).toHaveCount(0);
  });

  test("catalog Download invokes engine_download with the model id", async ({ page }) => {
    await page.evaluate(
      mountEngineManager(`
        window.__INVOKE_RESPONSES.engine_download = () => null;
      `),
    );
    await page.locator('[data-catalog-download="gemma4-12b"]').click();
    await page.waitForFunction(() =>
      window.__INVOKE_FIND(
        "engine_download",
        (a) => a.modelId === "gemma4-12b" && /^dl:gemma4-12b:/.test(a.requestId),
      ),
    );
  });

  test("add-from-link derives a name + rewrites blob→resolve for engine_download_custom", async ({ page }) => {
    await page.evaluate(
      mountEngineManager(`
        window.__INVOKE_RESPONSES.engine_download_custom = () => null;
      `),
    );
    // One field now: paste a Hugging Face *page* (blob) URL — no invented name.
    await page.locator("[data-custom-gguf-url]").fill(
      "https://huggingface.co/org/repo/blob/main/My-Model.gguf",
    );
    // The status line previews the name we derived from the file.
    await expect(page.locator("[data-custom-gguf-status]")).toContainText("my-model");
    await page.locator("[data-custom-gguf-download]").click();
    await page.waitForFunction(() =>
      window.__INVOKE_FIND(
        "engine_download_custom",
        (a) =>
          a.name === "my-model" &&
          a.url === "https://huggingface.co/org/repo/resolve/main/My-Model.gguf",
      ),
    );
  });

  test("Delete on an engine model invokes engine_model_delete", async ({ page }) => {
    await page.evaluate(
      mountEngineManager(`
        window.__INVOKE_RESPONSES.engine_model_delete = () => null;
      `),
    );
    await page.locator("button", { hasText: "Delete" }).first().click();
    // ConfirmDialog → engine-specific copy → confirm.
    await expect(page.locator("#test-root")).toContainText("models folder");
    await page.locator("button", { hasText: /^Delete$/ }).last().click();
    await page.waitForFunction(() =>
      window.__INVOKE_FIND("engine_model_delete", (a) => a.name === "nomic-embed-text"),
    );
  });
});

// A catalog big enough to exercise fit-first ranking + the fold (6 chat + 1
// embed). RAM stays 16 GB via mountEngineManager's system_profile mock.
const BIG_CATALOG = `
  window.__INVOKE_RESPONSES.engine_catalog = () => ({
    version: 1,
    models: [
      { id: "gemma4-e2b", label: "Gemma 4 E2B", blurb: "Small", purpose: "chat", recommended: false, minRamGb: 8, caps:{vision:true,tools:true}, license:"apache-2.0", source:"x", totalBytes: 3300000000, installed:false, files:[] },
      { id: "gemma4-e4b", label: "Gemma 4 E4B", blurb: "Sweet spot", purpose: "chat", recommended: false, minRamGb: 8, caps:{vision:true,tools:true}, license:"apache-2.0", source:"x", totalBytes: 6100000000, installed:false, files:[] },
      { id: "gemma4-12b", label: "Gemma 4 12B", blurb: "Daily driver", purpose: "chat", recommended: true, minRamGb: 16, caps:{vision:true,tools:true}, license:"apache-2.0", source:"x", totalBytes: 7200000000, installed:false, files:[] },
      { id: "gemma4-26b-a4b", label: "Gemma 4 26B", blurb: "Power option", purpose: "chat", recommended: false, minRamGb: 32, caps:{vision:true,tools:true}, license:"apache-2.0", source:"x", totalBytes: 15400000000, installed:false, files:[] },
      { id: "qwen3-9b", label: "Qwen 3.5 9B", blurb: "Reasoning", purpose: "chat", recommended: false, minRamGb: 16, caps:{vision:true,tools:true}, license:"apache-2.0", source:"x", totalBytes: 6600000000, installed:false, files:[] },
      { id: "llama3-3b", label: "Llama 3.2 3B", blurb: "Tiny fallback", purpose: "chat", recommended: false, minRamGb: 8, caps:{vision:false,tools:true}, license:"llama", source:"x", totalBytes: 2000000000, installed:false, files:[] },
      { id: "nomic-embed-text", label: "Nomic Embed Text v1.5", blurb: "RAG", purpose: "embed", recommended: false, minRamGb: 8, caps:{vision:false,tools:false}, license:"apache-2.0", source:"x", totalBytes: 274000000, installed:true, files:[] },
    ],
  });
`;

const catalogDownloadIds = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-catalog-download]")).map((el) =>
      el.getAttribute("data-catalog-download"),
    ),
  );

test.describe("ModelManagerPanel — engine catalog layout (fit-first, foldable)", () => {
  test("leads with the best pick for this Mac; folds the long tail", async ({ page }) => {
    await page.evaluate(mountEngineManager(BIG_CATALOG));
    await expect(page.locator("#test-root")).toContainText("Model catalog");

    // Hero = the recommended model that fits 16 GB, badged.
    const hero = page.locator('[data-catalog-model="gemma4-12b"]');
    await expect(hero.locator("[data-catalog-hero]")).toContainText("best for your Mac");

    // Ranked fit-first: hero, then fitting by size desc; only 4 rows show.
    expect(await catalogDownloadIds(page)).toEqual([
      "gemma4-12b", "qwen3-9b", "gemma4-e4b", "gemma4-e2b",
    ]);
    // llama + 26b are folded; the oversized one is flagged in the hint.
    await expect(page.locator("[data-catalog-showmore]")).toContainText("Show 2 more");
    await expect(page.locator("[data-catalog-showmore]")).toContainText("need");
  });

  test("Show more reveals the rest; the oversized model carries a RAM warning", async ({ page }) => {
    await page.evaluate(mountEngineManager(BIG_CATALOG));
    await expect(page.locator('[data-catalog-download="llama3-3b"]')).toHaveCount(0);

    await page.locator("[data-catalog-showmore]").click();

    await expect(page.locator('[data-catalog-download="llama3-3b"]')).toBeVisible();
    const big = page.locator('[data-catalog-model="gemma4-26b-a4b"]');
    await expect(big.locator("[data-catalog-ram-warning]")).toContainText("32 GB");
  });

  test("filter narrows the list and drops the fold", async ({ page }) => {
    await page.evaluate(mountEngineManager(BIG_CATALOG));
    await page.locator("[data-catalog-filter]").fill("llama");

    expect(await catalogDownloadIds(page)).toEqual(["llama3-3b"]);
    await expect(page.locator("[data-catalog-showmore]")).toHaveCount(0);
  });

  test("embeddings sit in their own section, out of the chat ranking", async ({ page }) => {
    await page.evaluate(mountEngineManager(BIG_CATALOG));
    await expect(page.locator("#test-root")).toContainText("Embeddings");
    const nomic = page.locator('[data-catalog-model="nomic-embed-text"]');
    await expect(nomic).toContainText("embeddings");
    await expect(nomic.locator("[data-catalog-installed]")).toContainText("installed");
    // The embed model never appears among the downloadable chat rows.
    expect(await catalogDownloadIds(page)).not.toContain("nomic-embed-text");
  });
});

// A repo listing as engine_hf_repo_files returns it: size-sorted .gguf model
// files (each with an lfs sha256, or "" when unverified) + a paired mmproj.
const HF_LISTING = {
  repo: "Qwen/Qwen3.5-4B-Instruct-GGUF",
  files: [
    { path: "Qwen3.5-4B-Q3_K_M.gguf", size: 2100000000, sha256: "" },
    { path: "Qwen3.5-4B-Q4_K_M.gguf", size: 2700000000, sha256: "a".repeat(64) },
    { path: "Qwen3.5-4B-Q8_0.gguf", size: 5000000000, sha256: "b".repeat(64) },
  ],
  mmproj: { path: "mmproj-F16.gguf", size: 600000000, sha256: "c".repeat(64) },
};

test.describe("ModelManagerPanel — Hugging Face repo picker (#3)", () => {
  test("pasting org/model flips Add→Browse and lists quants with verified + vision badges", async ({ page }) => {
    await page.evaluate(
      mountEngineManager(`
        window.__INVOKE_RESPONSES.engine_hf_repo_files = () => (${JSON.stringify(HF_LISTING)});
      `),
    );
    await page.locator("[data-custom-gguf-url]").fill("Qwen/Qwen3.5-4B-Instruct-GGUF");
    // A repo ref → the button browses, and the hint explains verification.
    await expect(page.locator("[data-custom-gguf-download]")).toHaveText("Browse");
    await expect(page.locator("[data-custom-gguf-status]")).toContainText("checksum-verified");

    await page.locator("[data-custom-gguf-download]").click();

    const results = page.locator("[data-hf-results]");
    await expect(results).toBeVisible();
    await expect(results).toContainText("3 models · vision");
    await expect(results).toContainText("Q4_K_M");
    await expect(results).toContainText("Q8_0");

    // The balanced default is badged, hash-verified, and vision-tagged.
    const rec = page.locator('[data-hf-file="Qwen3.5-4B-Q4_K_M.gguf"]');
    await expect(rec).toContainText("recommended");
    await expect(rec.locator("[data-hf-verified]")).toBeVisible();
    await expect(rec.locator("[data-hf-vision]")).toBeVisible();
    // The file with no published hash shows no verified shield.
    await expect(
      page.locator('[data-hf-file="Qwen3.5-4B-Q3_K_M.gguf"] [data-hf-verified]'),
    ).toHaveCount(0);
  });

  test("downloading a quant invokes engine_download_hf with repo + file + derived name", async ({ page }) => {
    await page.evaluate(
      mountEngineManager(`
        window.__INVOKE_RESPONSES.engine_hf_repo_files = () => (${JSON.stringify(HF_LISTING)});
        window.__INVOKE_RESPONSES.engine_download_hf = () => null;
      `),
    );
    await page.locator("[data-custom-gguf-url]").fill(
      "https://huggingface.co/Qwen/Qwen3.5-4B-Instruct-GGUF/tree/main",
    );
    await page.locator("[data-custom-gguf-download]").click();
    await page.locator('[data-hf-download="Qwen3.5-4B-Q4_K_M.gguf"]').click();

    await page.waitForFunction(() =>
      window.__INVOKE_FIND(
        "engine_download_hf",
        (a) =>
          a.repo === "Qwen/Qwen3.5-4B-Instruct-GGUF" &&
          a.file === "Qwen3.5-4B-Q4_K_M.gguf" &&
          a.name === "qwen3.5-4b-q4_k_m" &&
          /^dl:qwen3\.5-4b-q4_k_m:/.test(a.requestId),
      ),
    );
  });

  test("the ✕ dismisses the repo results", async ({ page }) => {
    await page.evaluate(
      mountEngineManager(`
        window.__INVOKE_RESPONSES.engine_hf_repo_files = () => (${JSON.stringify(HF_LISTING)});
      `),
    );
    await page.locator("[data-custom-gguf-url]").fill("Qwen/Qwen3.5-4B-Instruct-GGUF");
    await page.locator("[data-custom-gguf-download]").click();
    await expect(page.locator("[data-hf-results]")).toBeVisible();
    await page.locator("[data-hf-close]").click();
    await expect(page.locator("[data-hf-results]")).toHaveCount(0);
  });

  test("a repo that can't be read surfaces the error", async ({ page }) => {
    await page.evaluate(
      mountEngineManager(`
        window.__INVOKE_RESPONSES.engine_hf_repo_files = () => {
          throw new Error("No repo named a/b on Hugging Face (or it's private).");
        };
      `),
    );
    await page.locator("[data-custom-gguf-url]").fill("a/b");
    await page.locator("[data-custom-gguf-download]").click();
    await expect(page.locator("[data-hf-results]")).toContainText("No repo named");
  });
});

test.describe("Message — engine status placeholder", () => {
  test("statusText renders while streaming with no content", async ({ page }) => {
    await page.evaluate(() => {
      window.__TEST_MOUNT("Message", {
        m: {
          id: "a1",
          role: "assistant",
          content: "",
          streaming: true,
          statusText: "loading gemma-3-4b…",
        },
      });
    });
    await expect(page.locator("[data-stream-status]")).toContainText(
      "loading gemma-3-4b…",
    );
  });

  test("statusText is suppressed once content arrives", async ({ page }) => {
    await page.evaluate(() => {
      window.__TEST_MOUNT("Message", {
        m: {
          id: "a2",
          role: "assistant",
          content: "First tokens",
          streaming: true,
          statusText: "should not show",
        },
      });
    });
    await expect(page.locator("[data-stream-status]")).toHaveCount(0);
    await expect(page.locator("#test-root")).toContainText("First tokens");
  });

  test("generic Thinking label shows while streaming with no engine status", async ({ page }) => {
    await page.evaluate(() => {
      window.__TEST_MOUNT("Message", {
        m: { id: "a3", role: "assistant", content: "", streaming: true },
      });
    });
    // No statusText → the rotating reassurance label, starting at "Thinking…".
    await expect(page.locator("[data-stream-status]")).toContainText("Thinking");
  });
});
