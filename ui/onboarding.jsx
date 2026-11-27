// onboarding.jsx — the first-run welcome: one screen with the four
// shortcuts that work from any app. The model choice follows it (the
// setup gate in overlays.jsx opens when this closes).
//
// It was a six-slide tour; that was cut (Nov 2026) to these two things.
// Shown once: `onboarding.completed` in app_settings is unset until it is
// closed. The shortcuts stay listed, and can be changed, in Settings →
// Shortcuts, so nothing reopens this screen.
//
// Rules of Hooks: every hook runs on every render, and the `!open` return
// comes AFTER them. A return placed between hooks once blanked the app when
// `open` flipped (tests/e2e/onboarding.spec.js pins it).
//
// Depends on: tokens (T, ek* styles), atoms (BrandMark), utils (formatHotkey),
// settings.jsx (the *_HOTKEY_* names — read at render, so load order is fine).

'use strict';

// The four shortcuts as they are set now (a person who reopens the app
// after changing one sees their own keys).
function onboardingShortcuts() {
  const read = (key, fallback) => {
    try {
      return localStorage.getItem(key) || fallback;
    } catch (_) {
      return fallback;
    }
  };
  return [
    {
      id: "question",
      keys: read(HOTKEY_LS_KEY, HOTKEY_DEFAULT),
      title: "Ask a quick question",
      text: "A small panel over whatever you are doing.",
    },
    {
      id: "selection",
      keys: read(SELECTION_HOTKEY_LS_KEY, SELECTION_HOTKEY_DEFAULT),
      title: "Act on copied text",
      text: "Copy text in any app, then summarise, rewrite, fix or explain it.",
    },
    {
      id: "dictation",
      keys: read(VOICE_HOTKEY_LS_KEY, VOICE_HOTKEY_DEFAULT),
      title: "Dictate a question",
      text: "Opens the panel and starts listening.",
    },
    {
      id: "capture",
      keys: read(SCREENSHOT_HOTKEY_LS_KEY, SCREENSHOT_HOTKEY_DEFAULT),
      title: "Ask about part of the screen",
      text: "Drag over an area; it opens in a new chat.",
    },
  ];
}

function OnboardingTour({ open, onClose }) {
  const continueRef = useRef(null);

  // Enter and Escape both continue: there is nothing here to cancel.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => continueRef.current && continueRef.current.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const shortcuts = onboardingShortcuts();

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9990,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(3px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ek-welcome-title"
        data-onboarding
        style={{
          width: 460, maxWidth: "92vw",
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 12,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          padding: "22px 24px 20px",
          display: "flex", flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <BrandMark size={20} />
          <div id="ek-welcome-title" style={{ fontFamily: T.sans, fontSize: 17, fontWeight: 600, color: T.fg }}>
            Welcome to Ekorbia
          </div>
        </div>
        <div style={ekHint({ marginBottom: 16 })}>
          Everything you ask is answered on this Mac. Four shortcuts work from any app:
        </div>

        <div data-onboarding-shortcuts style={{ display: "flex", flexDirection: "column" }}>
          {shortcuts.map((s, i) => (
            <div
              key={s.id}
              data-onboarding-shortcut={s.id}
              style={{
                display: "flex", alignItems: "center", gap: 14,
                padding: "10px 0",
                borderTop: i === 0 ? "none" : `1px solid ${T.border}`,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={ekHeading({ fontSize: 13 })}>{s.title}</div>
                <div style={ekHint()}>{s.text}</div>
              </div>
              <span data-onboarding-keys style={ekKbd({ fontSize: 12.5, padding: "2px 8px", flexShrink: 0 })}>
                {formatHotkey(s.keys)}
              </span>
            </div>
          ))}
        </div>

        <div style={ekHint({ marginTop: 10 })}>You can change these in Settings → Shortcuts.</div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button ref={continueRef} data-onboarding-continue onClick={onClose} style={ekBtn("primary")}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
