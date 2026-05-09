// Mount smokes + XSS-safety end-to-end test for MarkdownMessage.
//
// markdown.jsx wires together marked.js, highlight.js, and DOMPurify. The
// pure escapeHtml/escapeAttr helpers are covered by ui/__tests__/utils.test.js
// — what those Node tests can't catch is a regression in marked or DOMPurify
// that lets a payload through. The XSS test below exercises the full
// pipeline against a known-bad input.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test.describe("MarkdownMessage", () => {
  test("renders **bold** as <strong>", async ({ page }) => {
    await page.evaluate(() =>
      window.__TEST_MOUNT("MarkdownMessage", {
        content: "Hello **world**.",
        sources: [],
        searchRegex: null,
      })
    );
    // The rendered output sits inside an .ek-md root div. marked
    // converts **world** to <strong>world</strong>.
    await expect(page.locator(".ek-md strong")).toHaveText("world");
  });

  test("renders fenced code blocks with the .ek-code class", async ({ page }) => {
    await page.evaluate(() =>
      window.__TEST_MOUNT("MarkdownMessage", {
        content: "Some code:\n```js\nconsole.log('hi');\n```",
        sources: [],
        searchRegex: null,
      })
    );
    // The marked-render path wraps fenced blocks in <pre class="ek-code">
    // so the CSS in index.html can style them. addCopyButtons hooks the
    // pre afterward via the useEffect — we don't assert that here
    // (timing-sensitive), just that the wrapper landed.
    await expect(page.locator(".ek-md pre.ek-code")).toBeVisible();
  });

  test("XSS: inline <script> is sanitised, never executes", async ({ page }) => {
    // The crown-jewel test. Assistant message content arrives as a
    // string of model output; if marked + DOMPurify ever let an inline
    // script through, prompt injection becomes XSS. The marker variable
    // must remain undefined and the DOM must not contain a <script>.
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.evaluate(() =>
      window.__TEST_MOUNT("MarkdownMessage", {
        content:
          "Before <script>window.__pwned = 'XSS';</script> after.",
        sources: [],
        searchRegex: null,
      })
    );
    await expect(page.locator(".ek-md")).toBeVisible();

    const result = await page.evaluate(() => ({
      pwned: window.__pwned,
      scriptCount: document.querySelectorAll(".ek-md script").length,
      htmlContainsScriptTag: document
        .querySelector(".ek-md")
        ?.innerHTML.toLowerCase()
        .includes("<script"),
    }));

    expect(result.pwned).toBeUndefined();
    expect(result.scriptCount).toBe(0);
    expect(result.htmlContainsScriptTag).toBe(false);
    expect(pageErrors).toEqual([]);
  });

  test("XSS: javascript: href is stripped", async ({ page }) => {
    // Markdown links can carry a javascript: URL — DOMPurify's allow-list
    // for the href attribute should reject this. Pin the contract.
    await page.evaluate(() =>
      window.__TEST_MOUNT("MarkdownMessage", {
        content: "[click me](javascript:alert(1))",
        sources: [],
        searchRegex: null,
      })
    );
    await expect(page.locator(".ek-md")).toBeVisible();

    const href = await page.evaluate(() => {
      const a = document.querySelector(".ek-md a");
      return a ? a.getAttribute("href") : null;
    });
    // Acceptable outcomes: href is null/empty/missing, or it's been
    // rewritten to something safe. We forbid only the literal
    // "javascript:" prefix surviving.
    if (href !== null && href !== "") {
      expect(href.toLowerCase().startsWith("javascript:")).toBe(false);
    }
  });
});
