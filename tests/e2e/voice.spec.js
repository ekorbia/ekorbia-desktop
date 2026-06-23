// Voice dictation smokes (VoiceMicButton / VoiceModelPanel / VoiceSettings in
// ui/voice.jsx).
//
// Mount-level contracts only — real mic capture + Whisper transcription is
// manual-verification territory (needs a microphone + a downloaded model).
// These pin the IPC wiring and the UI states:
//   1. Mic with a model installed: click → records voice_record_start and
//      enters the recording state with a timer; click again → voice_record_stop
//      and a captured transcript is handed to onInsert.
//   2. Mic with NO model installed: click opens the setup modal.
//   3. VoiceModelPanel lists the catalog, marks base.en recommended, and a
//      Download records voice_model_download + streams progress via Channel.
//   4. VoiceSettings mounts (Settings → Voice tab body).

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

test.describe("VoiceMicButton", () => {
  test("records, transcribes, and inserts the transcript", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.voice_models_installed = () => ["base.en"];
      window.__INVOKE_RESPONSES.voice_record_start = () => undefined;
      window.__INVOKE_RESPONSES.voice_record_stop = () => ({
        text: "hello world",
        captured: true,
        audioSecs: 2,
      });
      window.__voiceText = null;
      window.__TEST_MOUNT("VoiceMicButton", {
        onInsert: (t) => {
          window.__voiceText = t;
        },
      });
    });

    const mic = page.locator("[data-voice-mic]");
    await expect(mic).toHaveAttribute("data-phase", "idle");

    // Click → recording (timer visible).
    await mic.click();
    await expect(mic).toHaveAttribute("data-phase", "recording");
    await expect(mic).toContainText("0:0");

    // Click again → stop + transcribe; transcript handed to onInsert.
    await mic.click();
    await expect(mic).toHaveAttribute("data-phase", "idle");
    await page.waitForFunction(() => window.__voiceText === "hello world");

    const calls = await page.evaluate(() => ({
      start: window.__INVOKE_COUNT("voice_record_start"),
      stop: window.__INVOKE_COUNT("voice_record_stop"),
    }));
    expect(calls.start).toBe(1);
    expect(calls.stop).toBe(1);
  });

  test("no audio captured surfaces a guidance toast, no insert", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.voice_models_installed = () => ["base.en"];
      window.__INVOKE_RESPONSES.voice_record_stop = () => ({
        text: "",
        captured: false,
        audioSecs: 0,
      });
      window.__voiceText = "untouched";
      window.__TEST_MOUNT("VoiceMicButton", {
        onInsert: (t) => {
          window.__voiceText = t;
        },
      });
    });

    const mic = page.locator("[data-voice-mic]");
    await mic.click();
    await expect(mic).toHaveAttribute("data-phase", "recording");
    await mic.click();
    await expect(mic).toHaveAttribute("data-phase", "idle");
    // onInsert must NOT fire when nothing was captured.
    expect(await page.evaluate(() => window.__voiceText)).toBe("untouched");
  });

  test("opens the setup modal when no model is installed", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.voice_models_installed = () => [];
      window.__TEST_MOUNT("VoiceMicButton", {});
    });

    const mic = page.locator("[data-voice-mic]");
    // Let the on-mount install check resolve (hasModel → false).
    await page.waitForTimeout(100);
    await mic.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Set up voice input");
  });

  test("passes the selected language + translate flag to voice_record_stop", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("ekorbia.voice.model", "small");
      localStorage.setItem("ekorbia.voice.lang", "es");
      localStorage.setItem("ekorbia.voice.translate", "1");
      window.__INVOKE_RESPONSES.voice_models_installed = () => ["small"];
      window.__INVOKE_RESPONSES.voice_record_stop = () => ({
        text: "hola",
        captured: true,
        audioSecs: 1,
      });
      window.__TEST_MOUNT("VoiceMicButton", {});
    });

    const mic = page.locator("[data-voice-mic]");
    await mic.click();
    await expect(mic).toHaveAttribute("data-phase", "recording");
    await mic.click();
    await expect(mic).toHaveAttribute("data-phase", "idle");

    const call = await page.evaluate(() => window.__INVOKE_FIND("voice_record_stop"));
    expect(call.args.model).toBe("small");
    expect(call.args.language).toBe("es");
    expect(call.args.translate).toBe(true);
  });
});

test.describe("VoiceModelPanel", () => {
  test("lists catalog, marks recommended, downloads with progress", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.voice_models_installed = () => ["base.en"];
      // Deliver one progress chunk, then stay in-flight so the bar + Cancel
      // render.
      window.__INVOKE_RESPONSES.voice_model_download = (args) => {
        if (args && args.onProgress) args.onProgress.__deliver({ completed: 71, total: 142 });
        return new Promise(() => {});
      };
      window.__TEST_MOUNT("VoiceModelPanel", {});
    });

    const root = page.locator("#test-root");
    await expect(root).toContainText("base.en");
    await expect(root).toContainText("recommended");
    await expect(root).toContainText("tiny.en");
    await expect(root).toContainText("small.en");

    // base.en is installed → shows Remove; tiny.en is not → shows Download.
    const tinyRow = page.locator('[data-voice-model="tiny.en"]');
    await tinyRow.locator("button", { hasText: "Download" }).click();

    await page.waitForFunction(() => window.__INVOKE_FIND("voice_model_download", (a) => a.name === "tiny.en"));
    // Progress chunk (71/142 = 50%) renders + a Cancel control appears.
    await expect(tinyRow).toContainText("50%");
    await expect(tinyRow.locator("button", { hasText: "Cancel" })).toBeVisible();
  });

  test("shows multilingual models + language/translate controls", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.voice_models_installed = () => ["base.en"];
      window.__TEST_MOUNT("VoiceModelPanel", {});
    });
    const root = page.locator("#test-root");
    await expect(root).toContainText("large-v3-turbo");
    await expect(root).toContainText("multilingual");
    await expect(root).toContainText("Translate to English");
    await expect(root.locator("select")).toBeVisible();
  });
});

test.describe("VoiceSettings", () => {
  test("mounts and shows the speech-models section", async ({ page }) => {
    await page.evaluate(() => {
      window.__INVOKE_RESPONSES.voice_models_installed = () => ["base.en"];
      window.__TEST_MOUNT("VoiceSettings", {});
    });
    const root = page.locator("#test-root");
    await expect(root).toContainText("Speech models");
    await expect(root).toContainText("base.en");
  });
});
