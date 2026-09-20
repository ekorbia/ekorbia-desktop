// Selection actions in the quick-query overlay (ui/overlay.jsx QuickQuery).
//
// The selection hotkey has Rust read the clipboard and push it over as a
// `selection:captured` event; the overlay switches into selection mode —
// snippet card plus the built-in verb chips — and runs the chosen instruction
// against the captured text.
//
// This is also the overlay's first component coverage, so a couple of the
// pins below are really "QuickQuery still mounts" guards.
//
// Pins:
//   • A capture event renders the snippet, the character count, and the
//     built-in verbs.
//   • Clicking a verb sends system=instruction + user=selection to
//     llm_chat_stream, and marks that chip active.
//   • A typed instruction runs against the selection instead of being sent
//     as a standalone question (the regression that would make ⌘⇧E a
//     glorified ⌘⇧Space).
//   • Library prompts are NOT offered as chips — the context bar's
//     "+ prompt" is the one way to bring a library prompt in, and an attached
//     prompt rides along ahead of whichever verb runs.
//   • No Translate verb: it can't work without a target language.
//   • ⏎ on an EMPTY input runs the attached prompt by itself — its body once,
//     not doubled as persona + task — and never lights a verb chip, even when
//     the prompt shares a verb's name (the library ships one called
//     "Summarize"). With nothing attached, an empty ⏎ stays a no-op.
//   • An empty clipboard explains itself instead of opening a dead panel.
//   • The capture survives a window focus event — the overlay's focus reset
//     must not wipe the payload Rust just delivered (the ordering hazard
//     documented in src/selection.rs).

const { test, expect } = require("@playwright/test");

const SELECTION = "i dont no if thats corect";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
  // A populated prompt library (so "no library chips" is a real assertion,
  // not an empty-library accident) and a stream that actually produces
  // output — a run with no deltas would leave the result area empty and half
  // these assertions vacuous.
  await page.evaluate(() => {
    window.__INVOKE_RESPONSES.prompts_list = () => [
      { id: "noir", name: "Noir framing", body: "Rewrite as noir.", favorite: "amber", tags: [] },
      { id: "eli5", name: "ELI5", body: "Explain like I am five.", favorite: "purple", tags: [] },
      // Mirrors the built-in the app really ships: same NAME as a verb chip.
      { id: "summarize", name: "Summarize", body: "Summarise in 3-5 bullets.", favorite: null, tags: [] },
    ];
    window.__INVOKE_RESPONSES.llm_chat_stream = (args) => {
      args.onChunk.__deliver({ type: "delta", text: "I don't know if that's correct." });
      args.onChunk.__deliver({ type: "done", doneReason: "stop" });
    };
    window.__TEST_MOUNT("QuickQuery", {});
  });
  // An emit is a one-shot — unlike a locator assertion nothing retries it —
  // so wait until the mount effect has actually subscribed. React 18's
  // concurrent render doesn't guarantee effects have run by the next
  // page.evaluate, and a payload emitted a beat early is simply lost.
  await page.waitForFunction(
    () => (window.__EVENT_LISTENERS["selection:captured"] || []).length > 0,
  );
});

// Deliver a capture the way Rust does, then wait for the panel to paint.
async function capture(page, text, extra) {
  await page.evaluate(
    ({ text, extra }) => {
      window.__TAURI__.event.emit(
        "selection:captured",
        Object.assign({ text, chars: text.length, truncated: false }, extra || {}),
      );
    },
    { text, extra },
  );
  await page.locator("[data-selection-panel]").waitFor();
}

// Attach a library prompt the way the context bar's "+ prompt" does (it
// persists in localStorage), then remount so the overlay picks it up.
async function attachPrompt(page, id) {
  await page.evaluate((id) => {
    localStorage.setItem("ekorbia.overlay.prompt", id);
    window.__TEST_MOUNT("QuickQuery", {});
  }, id);
  await page.waitForFunction(
    () => (window.__EVENT_LISTENERS["selection:captured"] || []).length > 0,
  );
}

test("a capture renders the snippet, its size, and the built-in verbs", async ({ page }) => {
  await capture(page, SELECTION);

  await expect(page.locator("[data-selection-snippet]")).toHaveText(SELECTION);
  await expect(page.locator("[data-selection-panel]")).toContainText(
    `${SELECTION.length} characters`,
  );
  const actions = page.locator("[data-selection-actions]");
  for (const label of ["Summarize", "Rewrite", "Fix grammar", "Explain"]) {
    await expect(actions).toContainText(label);
  }
  // Exactly the four verbs — no Translate (it needs a language a chip can't
  // ask for) and no library prompts (the context bar's "+ prompt" owns that).
  await expect(actions.locator("button")).toHaveCount(4);
  await expect(actions).not.toContainText("Translate");
  await expect(actions).not.toContainText("Noir framing");
});

test("a truncated capture says so, and reports the ORIGINAL length", async ({ page }) => {
  await capture(page, "head … tail", { chars: 41312, truncated: true });
  const panel = page.locator("[data-selection-panel]");
  await expect(panel).toContainText("41,312 characters");
  await expect(panel).toContainText("trimmed to fit");
});

test("clicking a verb sends instruction + selection to the model", async ({ page }) => {
  await capture(page, SELECTION);
  await page.locator('[data-selection-action="grammar"]').click();

  const body = await page.evaluate(() => {
    const call = window.__INVOKE_FIND("llm_chat_stream");
    return call ? call.args.body : null;
  });
  expect(body).toBeTruthy();
  expect(body.messages).toHaveLength(2);
  expect(body.messages[0].role).toBe("system");
  expect(body.messages[0].content).toContain("spelling, grammar, and punctuation");
  // The captured text is the user turn, verbatim — not glued into the
  // instruction, where a model is far likelier to answer about it than
  // to operate on it.
  expect(body.messages[1]).toEqual({ role: "user", content: SELECTION });

  // The result names the verb that produced it, and leads with Copy —
  // a rewrite exists to be pasted back where the text came from.
  await expect(page.locator("[data-ran-action]")).toHaveText("Fix grammar");
  await expect(page.locator("[data-copy-result]")).toHaveText("Copy result");
  // The chips stay put so switching verbs is one click, not two.
  await expect(page.locator('[data-selection-action="rewrite"]')).toBeVisible();
});

test("a typed instruction runs against the selection, not as a bare question", async ({ page }) => {
  await capture(page, SELECTION);
  await page.locator("input").first().fill("translate this into German");
  await page.locator("input").first().press("Enter");

  const body = await page.evaluate(() => {
    const call = window.__INVOKE_FIND("llm_chat_stream");
    return call ? call.args.body : null;
  });
  expect(body.messages[0].content).toBe("translate this into German");
  expect(body.messages[1]).toEqual({ role: "user", content: SELECTION });
  await expect(page.locator("[data-ran-action]")).toHaveText(
    "translate this into German",
  );
});

test("an attached library prompt rides along ahead of the verb", async ({ page }) => {
  // The overlay's own "+ prompt" attachment is how library prompts reach a
  // selection run. It persists in localStorage, so seed it and remount.
  await attachPrompt(page, "noir");
  await capture(page, SELECTION);
  await page.locator('[data-selection-action="rewrite"]').click();

  const body = await page.evaluate(() => {
    const call = window.__INVOKE_FIND("llm_chat_stream");
    return call ? call.args.body : null;
  });
  // Persona first, verb last — the more specific intent is the last thing
  // the model reads.
  expect(body.messages[0].content.startsWith("Rewrite as noir.\n\n")).toBe(true);
  expect(body.messages[0].content).toContain("reads clearly and naturally");
  expect(body.messages[1].content).toBe(SELECTION);
});

test("Enter on an empty input runs the attached prompt by itself", async ({ page }) => {
  await attachPrompt(page, "noir");
  await capture(page, SELECTION);

  const input = page.locator("input").first();
  // The only on-screen cue for this path is the placeholder — pin it.
  await expect(input).toHaveAttribute("placeholder", /runs Noir framing/);
  await input.press("Enter");

  const body = await page.evaluate(() => {
    const call = window.__INVOKE_FIND("llm_chat_stream");
    return call ? call.args.body : null;
  });
  expect(body).toBeTruthy();
  // The prompt body exactly ONCE: it is the instruction here, so it must not
  // also ride along as the persona.
  expect(body.messages[0]).toEqual({ role: "system", content: "Rewrite as noir." });
  expect(body.messages[1]).toEqual({ role: "user", content: SELECTION });
  await expect(page.locator("[data-ran-action]")).toHaveText("Noir framing");
});

test("an attached prompt named like a verb does not light that verb's chip", async ({ page }) => {
  await attachPrompt(page, "summarize");
  await capture(page, SELECTION);
  await page.locator("input").first().press("Enter");

  await expect(page.locator("[data-ran-action]")).toHaveText("Summarize");
  // The library prompt ran — NOT the built-in verb. The chip must stay
  // neutral, or the panel would claim the wrong instruction produced this.
  const sent = await page.evaluate(
    () => window.__INVOKE_FIND("llm_chat_stream").args.body.messages[0].content,
  );
  expect(sent).toBe("Summarise in 3-5 bullets.");
  const chipColor = await page
    .locator('[data-selection-action="summarize"]')
    .evaluate((el) => getComputedStyle(el).color);
  expect(chipColor).not.toContain("240, 147, 74"); // amber = active
});

test("Enter on an empty input with nothing attached stays a no-op", async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem("ekorbia.overlay.prompt"));
  await capture(page, SELECTION);
  await page.locator("input").first().press("Enter");
  // Give a would-be request a beat to fire before asserting it didn't.
  await page.waitForTimeout(200);
  const count = await page.evaluate(() => window.__INVOKE_COUNT("llm_chat_stream"));
  expect(count).toBe(0);
});

test("an empty clipboard explains itself instead of opening a dead panel", async ({ page }) => {
  await page.evaluate(() => window.__TAURI__.event.emit("selection:empty", null));
  const hint = page.locator("[data-selection-empty]");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("clipboard has no text");
  await expect(page.locator("[data-selection-panel]")).toHaveCount(0);
});

test("a window focus after the capture does not wipe it", async ({ page }) => {
  // Rust shows + focuses the overlay, THEN emits — but the OS focus event
  // can land either side of the payload. The overlay's focus reset must
  // leave selection state alone, or the panel would blank out on arrival.
  await capture(page, SELECTION);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("[data-selection-snippet]")).toHaveText(SELECTION);
});
