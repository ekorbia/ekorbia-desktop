// KaTeX math + Mermaid diagrams in assistant replies (ui/markdown.jsx).
// Math is EXTRACTED before marked runs (utils.js extractMathSegments —
// node-tested) and re-injected as katex.renderToString output after
// DOMPurify; mermaid code blocks swap to SVG in the post-mount effect,
// only on finalized (non-streaming) messages. These smokes pin the
// browser half: real KaTeX + mermaid from ui/vendor, real sanitizer.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

function mountMd(page, content, extra = {}) {
  return page.evaluate(
    ({ c, x }) => {
      window.__TEST_MOUNT("MarkdownMessage", {
        content: c,
        streaming: false,
        ...x,
      });
    },
    { c: content, x: extra },
  );
}

test("inline and display math render as KaTeX", async ({ page }) => {
  await mountMd(
    page,
    "Euler: $e^{i\\pi} + 1 = 0$\n\n$$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$",
  );
  const root = page.locator("#test-root .ek-md");
  await expect(root.locator(".katex")).toHaveCount(2);
  await expect(root.locator(".katex-display")).toHaveCount(1);
  // The raw TeX delimiters are gone from the rendered text. (The TeX
  // SOURCE legitimately remains in KaTeX's hidden MathML <annotation> —
  // that's its copy/accessibility channel — so assert on delimiters,
  // not on TeX commands.)
  await expect(root).not.toContainText("$$");
});

test("underscores in math are not mangled into <em>", async ({ page }) => {
  // Without pre-extraction, marked turns $a_i + b_j$ into emphasis and
  // KaTeX never sees valid TeX. Pin the fix end-to-end.
  await mountMd(page, "sum $a_i + b_j$ end");
  const root = page.locator("#test-root .ek-md");
  await expect(root.locator(".katex")).toHaveCount(1);
  await expect(root.locator("em")).toHaveCount(0);
});

test("math inside code spans and fences stays literal", async ({ page }) => {
  await mountMd(
    page,
    "inline `$x$` and\n```python\nprice = \"$y$\"\n```\nafter",
  );
  const root = page.locator("#test-root .ek-md");
  await expect(root.locator(".katex")).toHaveCount(0);
  await expect(root.locator("code").first()).toContainText("$x$");
  await expect(root.locator("pre.ek-code")).toContainText('price = "$y$"');
});

test("currency amounts stay literal", async ({ page }) => {
  await mountMd(page, "I paid $5 and $10 yesterday.");
  const root = page.locator("#test-root .ek-md");
  await expect(root.locator(".katex")).toHaveCount(0);
  await expect(root).toContainText("$5 and $10");
});

test("KaTeX trust stays off — \\href cannot mint javascript: links", async ({ page }) => {
  await mountMd(page, "try $\\href{javascript:alert(1)}{click}$");
  const root = page.locator("#test-root .ek-md");
  // Math still renders (as the trust-gated fallback), but never as a
  // live javascript: anchor.
  await expect(root.locator('a[href^="javascript"]')).toHaveCount(0);
});

test("mermaid block renders an SVG diagram once finalized", async ({ page }) => {
  await mountMd(
    page,
    "Flow:\n```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```",
  );
  const root = page.locator("#test-root .ek-md");
  // Async render — Playwright auto-retries the visibility check.
  await expect(root.locator(".ek-mermaid svg")).toBeVisible();
  // Node labels are SVG <text> (htmlLabels:false) — read the markup
  // directly rather than via innerText, which skips SVG text in WebKit.
  const svgMarkup = await root.locator(".ek-mermaid svg").innerHTML();
  expect(svgMarkup).toContain("Start");
  expect(svgMarkup).toContain("Finish");
  // The source block was replaced…
  await expect(root.locator('pre.ek-code[data-lang="mermaid"]')).toHaveCount(0);
  // …and the scrub invariants hold: pure SVG, no html labels, no scripts.
  await expect(root.locator(".ek-mermaid foreignObject")).toHaveCount(0);
  await expect(root.locator(".ek-mermaid script")).toHaveCount(0);
});

test("invalid mermaid keeps the source code block", async ({ page }) => {
  await mountMd(
    page,
    "```mermaid\nflowchart LR\n  A --> ->> nonsense(((\n```",
  );
  const root = page.locator("#test-root .ek-md");
  const pre = root.locator('pre.ek-code[data-lang="mermaid"]');
  await expect(pre).toBeVisible();
  await expect(pre).toContainText("nonsense");
  // Give the async path a beat, then confirm no diagram ever appeared.
  await page.waitForTimeout(400);
  await expect(root.locator(".ek-mermaid")).toHaveCount(0);
});

test("streaming renders neither math nor diagrams", async ({ page }) => {
  await mountMd(
    page,
    "partial $a_i$ and\n```mermaid\nflowchart LR\n  A --> B\n```",
    { streaming: true },
  );
  const host = page.locator("#test-root");
  await expect(host.locator(".katex")).toHaveCount(0);
  await expect(host.locator(".ek-mermaid")).toHaveCount(0);
  // The plaintext branch shows the raw source untouched.
  await expect(host).toContainText("$a_i$");
});
