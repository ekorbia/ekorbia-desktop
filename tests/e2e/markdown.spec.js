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

// A reply is untrusted text. A document the model read can tell it to answer
// with an image whose URL carries something private; if the webview fetches
// that image, the data has left the Mac. These pin the reply cleaner
// (neutraliseRemoteContent + REPLY_FORBID_* in markdown.jsx). The page's
// content-security policy, the second lock, is pinned in offline-boot.spec.js.
test.describe("MarkdownMessage: a reply loads nothing remote", () => {
  const HOST = "collector.example";

  // Records every request that tries to leave localhost, and refuses it.
  async function watchExternal(page) {
    const attempts = [];
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
        return route.continue();
      }
      attempts.push(url.href);
      return route.abort();
    });
    return attempts;
  }

  const mount = (page, content) =>
    page.evaluate(
      (c) => window.__TEST_MOUNT("MarkdownMessage", { content: c, sources: [], searchRegex: null }),
      content,
    );

  test("a remote image becomes a link and is never fetched", async ({ page }) => {
    const attempts = await watchExternal(page);
    const url = `https://${HOST}/pixel.png?d=client-name`;
    await mount(page, `Here is the chart: ![Q3 chart](${url})`);

    const link = page.locator(".ek-md a.ek-remote-image");
    await expect(link).toHaveText("Q3 chart");
    await expect(link).toHaveAttribute("href", url);
    await expect(page.locator(".ek-md img")).toHaveCount(0);
    // Give a fetch every chance to start before declaring none did.
    await page.waitForTimeout(300);
    expect(attempts).toEqual([]);
  });

  test("an image with no alt text shows its address; a non-web source is plain text", async ({ page }) => {
    await mount(page, `![](//${HOST}/a.png) and <img src="/ui/vendor/x.png" alt="local file">`);
    const items = page.locator(".ek-md .ek-remote-image");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveText(`https://${HOST}/a.png`);
    await expect(items.nth(0)).toHaveAttribute("href", `https://${HOST}/a.png`);
    // Not a web address: no link at all, so nothing can follow it.
    expect(await items.nth(1).evaluate((n) => n.tagName)).toBe("SPAN");
    await expect(items.nth(1)).toHaveText("local file");
    await expect(page.locator(".ek-md img")).toHaveCount(0);
  });

  test("an image whose bytes are in the reply is still shown", async ({ page }) => {
    const dot =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    await mount(page, `![dot](${dot})`);
    await expect(page.locator(".ek-md img")).toHaveCount(1);
    await expect(page.locator(".ek-md img")).toHaveAttribute("src", dot);
  });

  test("raw HTML that could load or post something is stripped", async ({ page }) => {
    const attempts = await watchExternal(page);
    await mount(
      page,
      [
        `<p style="background:url(https://${HOST}/a.png);position:fixed;inset:0">styled</p>`,
        `<img src="https://${HOST}/b.png" srcset="https://${HOST}/c.png 2x" alt="pic">`,
        `<form action="https://${HOST}/post"><input name="q" value="secret"><input type="image" src="https://${HOST}/d.png"></form>`,
        `<video src="https://${HOST}/e.mp4" poster="https://${HOST}/f.png"></video>`,
        `<audio src="https://${HOST}/g.mp3"></audio>`,
        `<picture><source srcset="https://${HOST}/h.png"></picture>`,
        `<table background="https://${HOST}/i.png"><tr><td>cell</td></tr></table>`,
        `<svg width="10" height="10"><image href="https://${HOST}/j.png" width="10" height="10"></image></svg>`,
        `<style>.ek-md { background: url(https://${HOST}/k.png) }</style>`,
      ].join("\n\n"),
    );

    const md = page.locator(".ek-md");
    await expect(md).toContainText("styled");
    await expect(md).toContainText("cell");
    await expect(
      md.locator("img, video, audio, source, picture, form, input, style, [style], [srcset], [background], [poster]"),
    ).toHaveCount(0);
    // The only trace of the host is the link the <img> turned into.
    const hrefs = await md.evaluate((root) =>
      Array.from(root.querySelectorAll("*")).flatMap((el) =>
        Array.from(el.attributes)
          .filter((a) => a.value.includes("collector.example"))
          .map((a) => `${el.tagName.toLowerCase()}[${a.name}]`),
      ),
    );
    expect(hrefs.sort()).toEqual(["a[href]", "a[title]"]);
    await page.waitForTimeout(300);
    expect(attempts).toEqual([]);
  });

  test("task-list checkboxes survive, disabled", async ({ page }) => {
    await mount(page, "- [x] signed\n- [ ] countersigned");
    const boxes = page.locator('.ek-md input[type="checkbox"]');
    await expect(boxes).toHaveCount(2);
    await expect(boxes.nth(0)).toBeChecked();
    await expect(boxes.nth(1)).not.toBeChecked();
    await expect(boxes.nth(0)).toBeDisabled();
  });

  test("a table keeps its column alignment", async ({ page }) => {
    await mount(page, "| Item | Amount |\n|:-----|-------:|\n| Rent | 86,000 |");
    await expect(page.locator(".ek-md td").nth(1)).toHaveAttribute("align", "right");
  });

  test("a link opens in the browser and never navigates the app window", async ({ page }) => {
    await page.evaluate(() => {
      window.__OPENED = [];
      window.__TAURI__.shell = { open: (u) => { window.__OPENED.push(u); } };
    });
    await mount(
      page,
      "[the site](https://example.org/page) · [a local path](/ui/index.html) · [a note](#note)",
    );
    const before = page.url();

    await page.locator(".ek-md a", { hasText: "the site" }).click();
    expect(await page.evaluate(() => window.__OPENED)).toEqual(["https://example.org/page"]);

    // Not a web address: followed nowhere, neither by the browser nor here.
    await page.locator(".ek-md a", { hasText: "a local path" }).click();
    expect(await page.evaluate(() => window.__OPENED)).toEqual(["https://example.org/page"]);
    expect(page.url()).toBe(before);

    // An in-page anchor is left to the page.
    await page.locator(".ek-md a", { hasText: "a note" }).click();
    expect(page.url()).toBe(before + "#note");
    expect(await page.evaluate(() => window.__OPENED)).toEqual(["https://example.org/page"]);
  });
});

