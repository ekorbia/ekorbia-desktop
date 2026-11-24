// Settings → Privacy (ui/privacy.jsx PrivacySettings).
//
// The pane shows what Rust's network gate (src-tauri/src/net.rs) recorded:
// the offline lock, one headline saying what has left this Mac, and the
// list of connections. It writes nothing itself except the lock, through
// `privacy_set_lock`, and asks Rust to save the report.
//
// What it must never do is overstate: the foot says what the list cannot
// see, and that sentence is pinned here.

const { test, expect } = require("@playwright/test");

// 22 Nov 2026 14:20 and nearby, as unix seconds in the machine's own zone.
const at = (d, h, m) => Math.floor(new Date(2026, 10, d, h, m).getTime() / 1000);

const ROWS = [
  { day: "2026-11-23", purpose: "model_download", detail: "gemma4-e4b", host: "huggingface.co", result: "refused", count: 1, bytes: 0, firstAt: at(23, 9, 12), lastAt: at(23, 9, 12) },
  { day: "2026-11-22", purpose: "dictation_model", detail: "base.en", host: "huggingface.co", result: "done", count: 1, bytes: 142000000, firstAt: at(22, 14, 11), lastAt: at(22, 14, 11) },
  { day: "2026-11-22", purpose: "model_download", detail: "gemma4-12b", host: "huggingface.co", result: "verified", count: 2, bytes: 7200000000, firstAt: at(22, 13, 58), lastAt: at(22, 13, 58) },
];

async function mountPane(page, opts = {}) {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
  await page.evaluate(
    ({ rows, opts }) => {
      const R = window.__INVOKE_RESPONSES;
      window.__P = {
        locked: !!opts.locked,
        lockedSince: opts.locked ? opts.lockedSince : null,
        summary: opts.summary || { made: 3, refused: 1, chatsSent: 0, documentsSent: 0, hosts: ["huggingface.co"] },
        rows: opts.rows || rows,
      };
      const status = () => ({ locked: window.__P.locked, lockedSince: window.__P.lockedSince, summary: window.__P.summary });
      R.privacy_status = () => status();
      R.privacy_log = () => window.__P.rows;
      R.privacy_set_lock = (a) => {
        if (opts.lockFails) throw new Error("database is locked");
        window.__P.locked = !!a.on;
        window.__P.lockedSince = a.on ? opts.lockedSince || 1 : null;
        return status();
      };
      R.privacy_report_save = () => {
        if (opts.saveFails) throw new Error("disk full");
        return undefined;
      };
      window.__TAURI__.dialog = { save: async () => (opts.cancelSave ? null : "/Users/you/Desktop/report.html") };
      const host = document.getElementById("test-root");
      if (window.__TEST_ROOT) { try { window.__TEST_ROOT.unmount(); } catch (_) {} }
      host.innerHTML = "";
      host.style.cssText = "padding:20px;max-width:560px";
      const root = ReactDOM.createRoot(host);
      root.render(
        React.createElement(window.PrivacySettings, {
          backendKind: opts.backendKind || "engine",
          baseUrl: opts.baseUrl || null,
          nameOfModel: (id) => ({ id, name: { "gemma4-e4b": "Fast", "gemma4-12b": "Balanced" }[id] || id, detail: "" }),
          modelLabels: { "gemma4-12b": "Balanced · Gemma 4 12B" },
        }),
      );
      window.__TEST_ROOT = root;
    },
    { rows: ROWS, opts },
  );
  await expect(page.locator("[data-privacy-settings]")).toBeVisible();
  await expect(page.locator("[data-privacy-counts]")).not.toHaveText("");
}

const invoked = (page, cmd) =>
  page.evaluate((cmd) => window.__INVOKES.filter((i) => i.cmd === cmd).map((i) => i.args), cmd);

test("with the lock off it says so, and nothing has left this Mac", async ({ page }) => {
  await mountPane(page);
  const pane = page.locator("[data-privacy-settings]");
  await expect(pane).toHaveAttribute("data-locked", "false");
  await expect(pane.locator("[data-privacy-lock-state]")).toContainText("Off.");
  await expect(pane.getByRole("switch", { name: "Offline lock" })).toHaveAttribute("aria-checked", "false");
  await expect(pane.locator("[data-privacy-headline]")).toHaveText(
    "Chats, documents and dictation sent off this Mac: none",
  );
  await expect(pane.locator("[data-privacy-counts]")).toHaveText("3 made, 1 refused");
});

test("the list says what each connection was for, where, when and how it ended", async ({ page }) => {
  await mountPane(page);
  const rows = page.locator("[data-privacy-row]");
  await expect(rows).toHaveCount(3);
  // A download names its model plainly, not by its id.
  await expect(rows.nth(0).locator("[data-privacy-row-title]")).toHaveText("Model download: Fast");
  await expect(rows.nth(0).locator("[data-privacy-row-where]")).toHaveText("huggingface.co · 23 Nov, 09:12");
  await expect(rows.nth(0).locator("[data-privacy-row-result]")).toHaveText("Refused");
  await expect(rows.nth(1).locator("[data-privacy-row-title]")).toHaveText("Dictation model: base.en, 142 MB");
  await expect(rows.nth(1).locator("[data-privacy-row-result]")).toHaveText("Done");
  await expect(rows.nth(2).locator("[data-privacy-row-title]")).toHaveText("Model download: Balanced, 7.2 GB · 2 connections");
  await expect(rows.nth(2).locator("[data-privacy-row-result]")).toHaveText("Verified");
  // Nothing is shown in the raw vocabulary of the record.
  await expect(page.locator("[data-privacy-settings]")).not.toContainText("model_download");
  await expect(page.locator("[data-privacy-settings]")).not.toContainText("gemma4-e4b");
});

test("turning the lock on tells Rust and says since when", async ({ page }) => {
  await mountPane(page, { lockedSince: at(22, 14, 20) });
  await page.getByRole("switch", { name: "Offline lock" }).click();
  expect(await invoked(page, "privacy_set_lock")).toEqual([{ on: true }]);
  const pane = page.locator("[data-privacy-settings]");
  await expect(pane).toHaveAttribute("data-locked", "true");
  await expect(pane.locator("[data-privacy-lock-state]")).toHaveText(
    "On since 22 Nov, 14:20. Ekorbia refuses every connection until you turn this off.",
  );
  await page.getByRole("switch", { name: "Offline lock" }).click();
  expect(await invoked(page, "privacy_set_lock")).toEqual([{ on: true }, { on: false }]);
  await expect(pane).toHaveAttribute("data-locked", "false");
});

test("if the lock cannot be changed, the switch stays where it was and says why", async ({ page }) => {
  await mountPane(page, { lockFails: true });
  await page.getByRole("switch", { name: "Offline lock" }).click();
  await expect(page.locator("[data-privacy-note]")).toContainText("Could not change the lock");
  await expect(page.getByRole("switch", { name: "Offline lock" })).toHaveAttribute("aria-checked", "false");
});

test("chats sent to a server on another machine are counted, not hidden", async ({ page }) => {
  await mountPane(page, {
    backendKind: "openai",
    baseUrl: "http://office-mac.local:8080",
    summary: { made: 45, refused: 0, chatsSent: 42, documentsSent: 3, hosts: ["office-mac.local"] },
    rows: [
      { day: "2026-11-23", purpose: "chat", detail: "", host: "office-mac.local", result: "done", count: 42, bytes: 0, firstAt: at(23, 9, 0), lastAt: at(23, 17, 30) },
      { day: "2026-11-23", purpose: "documents", detail: "", host: "office-mac.local", result: "done", count: 3, bytes: 0, firstAt: at(23, 9, 0), lastAt: at(23, 9, 5) },
    ],
  });
  await expect(page.locator("[data-privacy-sent-off]")).toHaveText("42 chats, 3 document-search requests; no dictation");
  await expect(page.locator("[data-privacy-row-title]").first()).toHaveText("Chat sent to a server · 42 connections");
});

test("with the lock on and chats set to another machine, it warns they will be refused", async ({ page }) => {
  await mountPane(page, { locked: true, lockedSince: at(22, 14, 20), backendKind: "openai", baseUrl: "http://office-mac.local:8080" });
  await expect(page.locator("[data-privacy-lock-server]")).toContainText("will be refused while the lock is on");
  // Not shown when chats are answered on this Mac.
  await mountPane(page, { locked: true, lockedSince: at(22, 14, 20) });
  await expect(page.locator("[data-privacy-lock-server]")).toHaveCount(0);
});

test("the foot says what the list cannot see", async ({ page }) => {
  await mountPane(page);
  const foot = page.locator("[data-privacy-limits]");
  await expect(foot).toHaveText("This lists what Ekorbia did. It cannot see other apps or macOS.");
  // With Ollama answering, its own downloads are named as outside the list.
  await mountPane(page, { backendKind: "ollama" });
  await expect(page.locator("[data-privacy-ollama-note]")).toContainText("Ollama is a separate app and downloads models on its own");
});

test("with nothing recorded it says so", async ({ page }) => {
  await mountPane(page, { rows: [], summary: { made: 0, refused: 0, chatsSent: 0, documentsSent: 0, hosts: [] } });
  await expect(page.locator("[data-privacy-counts]")).toHaveText("None yet");
  await expect(page.locator("[data-privacy-empty]")).toHaveText("Ekorbia has not connected to anything other than this Mac.");
});

test("Save report… asks where, then has Rust write it with the plain names", async ({ page }) => {
  await mountPane(page);
  await page.locator("[data-privacy-save-report]").click();
  await expect(page.locator("[data-privacy-note]")).toHaveText("Saved to /Users/you/Desktop/report.html");
  expect(await invoked(page, "privacy_report_save")).toEqual([
    {
      path: "/Users/you/Desktop/report.html",
      labels: { "gemma4-12b": "Balanced · Gemma 4 12B" },
      answersWith: "The built-in engine, on this Mac",
    },
  ]);
});

test("cancelling the save dialog writes nothing; a failed save says why", async ({ page }) => {
  await mountPane(page, { cancelSave: true });
  await page.locator("[data-privacy-save-report]").click();
  expect(await invoked(page, "privacy_report_save")).toEqual([]);
  await expect(page.locator("[data-privacy-note]")).toHaveCount(0);

  await mountPane(page, { saveFails: true });
  await page.locator("[data-privacy-save-report]").click();
  await expect(page.locator("[data-privacy-note]")).toContainText("Could not save the report");
});

test("the report says where chats are answered", async ({ page }) => {
  const words = (kind, url) => page.evaluate(([k, u]) => privacyAnswersWith(k, u), [kind, url]);
  await mountPane(page);
  expect(await words("engine", null)).toBe("The built-in engine, on this Mac");
  expect(await words("ollama", null)).toBe("Ollama, on this Mac");
  expect(await words("openai", "http://127.0.0.1:1234")).toBe("A server on this Mac");
  expect(await words("openai", "http://office-mac.local:8080")).toBe("A server on another machine: office-mac.local");
});

test("it re-reads when Rust says the record changed", async ({ page }) => {
  await mountPane(page);
  await expect(page.locator("[data-privacy-row]")).toHaveCount(3);
  await page.evaluate((row) => {
    window.__P.rows = [row].concat(window.__P.rows);
    window.__P.summary = { made: 4, refused: 1, chatsSent: 0, documentsSent: 0, hosts: ["huggingface.co"] };
    window.__TAURI__.event.emit("privacy:changed");
  }, { day: "2026-11-23", purpose: "model_lookup", detail: "", host: "huggingface.co", result: "done", count: 1, bytes: 0, firstAt: at(23, 10, 0), lastAt: at(23, 10, 0) });
  await expect(page.locator("[data-privacy-row]")).toHaveCount(4);
  await expect(page.locator("[data-privacy-counts]")).toHaveText("4 made, 1 refused");
  await expect(page.locator("[data-privacy-row-title]").first()).toHaveText("Looking up a model's files");
});
