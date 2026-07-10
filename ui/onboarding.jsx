// onboarding.jsx -- First-launch tour (Phase 6).
//
// A 5-slide guided introduction that fires the first time the app opens.
// The completion flag lives in the SQLite `app_settings` table under the key
// `onboarding.completed`:
//   • absent / empty string  → tour is shown
//   • any other value (we write "1") → tour stays hidden until the user
//     explicitly re-opens it from Settings → General → Help
//
// The component is opened either by:
//   1. main.jsx's first-launch effect (setting_get returns null/empty)
//   2. window.ekOpenOnboarding() — exposed from main.jsx so the Settings
//      modal can call it from its "Show tour again" button
//
// We deliberately keep onboarding pure-UI: it doesn't touch attachments,
// prompts, or the chat list. The "Get started" CTA simply closes the modal —
// the user's next click on the (now visible) main UI is the real first
// interaction. Auto-focusing the composer or opening a sample chat would be
// helpful but adds coupling to App-level state we don't need here.
//
// Hoisted to module scope (function declaration) so it's available on
// window for main.jsx's render. Same hoisting pattern as every other JSX
// component in this codebase — see CLAUDE.md.

// Total number of slides. Kept as a top-level constant so the keyboard
// effect can reference it without depending on the inline `slides` array
// (which is rebuilt every render with JSX inside, blowing up effect deps
// and forcing a re-binding on every prop change).
const ONBOARDING_SLIDE_COUNT = 5;

// Rules-of-Hooks reminder: every hook in this component MUST be called
// unconditionally on every render. The early-return for `!open` lives
// AFTER all the useState / useEffect calls. An early return before a
// hook changes the hook count when `open` flips, which React detects
// as "rendered more hooks" and refuses to render.
function OnboardingTour({ open, onClose }) {
  const [idx, setIdx] = useState(0);

  // Reset to the first slide every time the modal is freshly opened.
  // Without this, "Show tour again" from Settings would resume on whatever
  // slide the user closed on previously — surprising and not what users
  // who hit "show again" expect.
  useEffect(() => {
    if (open) setIdx(0);
  }, [open]);

  // Keyboard navigation. Effect body short-circuits when closed so no
  // listener is attached — but the hook itself runs on every render so
  // the call order stays stable across open/close transitions.
  //
  // We capture `idx` in deps (rather than reading it inside via setIdx
  // callback) because the last-slide-Enter branch needs the current
  // index to decide between "advance" and "finish". Re-binding on each
  // step is fine — the listener add/remove is cheap.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        if (idx === ONBOARDING_SLIDE_COUNT - 1) onClose();
        else setIdx((i) => Math.min(ONBOARDING_SLIDE_COUNT - 1, i + 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, idx, onClose]);

  if (!open) return null;

  // Pull the user's actual configured hotkeys (or the defaults if they
  // haven't customised) so the chips on slide 2 always reflect what will
  // actually fire. formatHotkey lives in settings.jsx; we share script
  // scope via index.html's load order so the function is on window.
  let overlayHk = HOTKEY_DEFAULT;
  let shotHk = SCREENSHOT_HOTKEY_DEFAULT;
  try {
    overlayHk = localStorage.getItem(HOTKEY_LS_KEY) || HOTKEY_DEFAULT;
    shotHk = localStorage.getItem(SCREENSHOT_HOTKEY_LS_KEY) || SCREENSHOT_HOTKEY_DEFAULT;
  } catch {}

  // Slide definitions. Each slide is { title, body } where body is a JSX
  // fragment. Keeping them inline (rather than separate components) makes
  // it cheap to reorder and avoids prop drilling.
  const slides = [
    {
      title: "Welcome to Ekorbia",
      body: (
        <>
          <div style={{ display: "flex", justifyContent: "center", margin: "8px 0 18px" }}>
            <div
              style={{
                width: 56, height: 56,
                borderRadius: 14,
                background: `linear-gradient(135deg, ${T.amber}33, ${T.amber}11)`,
                border: `1px solid ${T.amber}55`,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: T.amber,
              }}
            >
              <I.Sparkle size={28} />
            </div>
          </div>
          <p style={{ margin: "0 0 10px", fontSize: 13.5, lineHeight: 1.55, color: T.fg }}>
            A local AI desktop that runs entirely on your computer.
          </p>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: T.fg2 }}>
            Your conversations, your files, your models — nothing leaves your
            machine. Ekorbia talks to{" "}
            <span style={{ fontFamily: T.mono, color: T.fg1 }}>ollama</span>{" "}
            running on localhost, and that's the only network call it ever makes.
          </p>
        </>
      ),
    },
    {
      // Per-platform hotkey slide:
      //   • macOS   → both Quick Query and Screenshot rows
      //   • Windows → Quick Query only (screenshot pipeline deferred to W3)
      //   • Linux   → neither hotkey is wired up; the slide reframes around
      //              what IS available and points users to the macOS roadmap.
      title: IS_LINUX
        ? "What's in this build"
        : (IS_MAC ? "Two hotkeys to learn" : "One hotkey to learn"),
      body: (
        <>
          {!IS_LINUX && (
            <HotkeyRow
              keys={overlayHk}
              label="Quick Query"
              hint="Spotlight-style overlay from anywhere. Ask a fast question and either dismiss it or send the conversation to the main window."
            />
          )}
          {IS_MAC && (
            <HotkeyRow
              keys={shotHk}
              label="Screenshot to Ekorbia"
              hint="Drag to select a region (or Space for a window). The capture lands in a new chat with a vision-capable model so you can ask about what you grabbed."
            />
          )}
          {IS_LINUX && (
            <p style={{ margin: "0 0 10px", fontSize: 12.5, color: T.fg2, lineHeight: 1.55 }}>
              Chat, attachments + folder RAG, watches, prompts, the memory
              file, and the file-saving tool are all wired up. The
              Spotlight-style Quick Query overlay and one-keystroke
              screenshot capture are macOS-only in this release — Linux
              support is on the roadmap.
            </p>
          )}
          {!IS_LINUX && (
            <p style={{ marginTop: 14, marginBottom: 0, fontSize: 11.5, color: T.fg3, lineHeight: 1.55 }}>
              {IS_MAC ? "Both are rebindable in " : "Rebindable in "}
              <span style={{ fontFamily: T.mono, color: T.fg2 }}>Settings → General</span>.
            </p>
          )}
        </>
      ),
    },
    {
      title: "Bring your own context",
      body: (
        <>
          <FeatureRow
            icon={<I.Attach size={16} />}
            title="Attachments"
            text="Drop files, folders, PDFs, or images into the composer. Large items get chunked and embedded locally so the model can search them."
          />
          <FeatureRow
            icon={<I.Lock size={16} />}
            title="Private chat"
            text="Click the lock beside 'New chat' for an ephemeral session — nothing gets persisted to the DB. Useful for quick scratch work or sensitive prompts."
          />
          <FeatureRow
            icon={<I.File size={16} />}
            title="Memory file"
            text="A single markdown file the model sees on every send. Put facts about you, preferences, style notes — anything you'd otherwise re-type. Edit it from Settings → Memory."
          />
        </>
      ),
    },
    {
      title: "Make it yours",
      body: (
        <>
          <FeatureRow
            icon={<I.Library size={16} />}
            title="Prompts library"
            text="Reusable instructions stored as plain .md files. Attach one or many to any chat to shape the model's behaviour. Built-ins ship with the app; add your own in the Prompts panel."
          />
          <FeatureRow
            icon={<I.Eye size={16} />}
            title="Watches"
            text="Tell Ekorbia to monitor a folder, RSS feed, or URL and summarise what changes. The bell glyph turns on OS notifications for any watch."
          />
          <FeatureRow
            icon={<I.Settings size={16} />}
            title="Themes & tweaks"
            text="Five themes (Atom-style + Ayu), adjustable density, and a status bar that surfaces model warmup. All under the gear icon top-right."
          />
        </>
      ),
    },
    {
      // New in 0.4: Spaces. The "+ New Space" affordance lives at the top
      // of the sidebar — discoverable on first launch, but the concept
      // deserves a dedicated slide so users understand what they're for.
      title: "Group related chats into Spaces",
      body: (
        <>
          <FeatureRow
            icon={<I.Folder size={16} />}
            title="What's a Space?"
            text="A named workspace that bundles a system prompt, a default model, optional pinned files and folders, optional pinned prompts, and an optional memory file. New chats inside a Space inherit all of it automatically."
          />
          <FeatureRow
            icon={<I.Plus size={16} />}
            title="Create one from the sidebar"
            text='Click "+ New Space" at the top. Name it ("Novel", "Therapy notes", "Q4 plans"), pick a color, save. Right-click any Space row for "Edit settings…" to fill in the system prompt, default model, pinned attachments, and pinned prompts.'
          />
          <FeatureRow
            icon={<I.File size={16} />}
            title="Filter without forgetting"
            text='Click a Space to filter the chat list to just that workspace; click "All chats" at the top to see everything. Your active Space sticks across launches so you land back where you left off.'
          />
        </>
      ),
    },
    {
      title: "You're ready",
      body: (
        <>
          <div style={{ display: "flex", justifyContent: "center", margin: "8px 0 18px" }}>
            <div
              style={{
                width: 56, height: 56,
                borderRadius: 14,
                background: `linear-gradient(135deg, ${T.green}33, ${T.green}11)`,
                border: `1px solid ${T.green}55`,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: T.green,
              }}
            >
              <I.Check size={26} />
            </div>
          </div>
          <p style={{ margin: "0 0 10px", fontSize: 13.5, lineHeight: 1.55, color: T.fg }}>
            Press{" "}
            <Kbd>{formatHotkey(overlayHk)}</Kbd>{" "}
            anywhere, or click{" "}
            <span style={{ fontFamily: T.mono, color: T.fg1 }}>+ New chat</span>{" "}
            in the sidebar.
          </p>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: T.fg2 }}>
            You can revisit this tour any time from{" "}
            <span style={{ fontFamily: T.mono, color: T.fg1 }}>
              Settings → General → Help
            </span>.
          </p>
          <p style={{ margin: "12px 0 0", fontSize: 11, lineHeight: 1.55, color: T.fg3 }}>
            No model yet? No problem — when you close this tour, Ekorbia will
            offer to download one sized for your machine, no terminal needed.
            You can always manage models later from{" "}
            <span style={{ fontFamily: T.mono, color: T.fg2 }}>Settings → Models</span>.
          </p>
        </>
      ),
    },
  ];

  const isLast = idx === slides.length - 1;
  const isFirst = idx === 0;
  const current = slides[idx];

  // Compile-time guard: keep the constant in sync with the array length.
  // If a future edit adds/removes a slide without updating the constant,
  // the keyboard handler's last-slide branch would misfire. The dev
  // console warning here is loud enough to catch in normal testing.
  if (slides.length !== ONBOARDING_SLIDE_COUNT && typeof console !== "undefined") {
    console.warn(
      `OnboardingTour: slide count (${slides.length}) differs from ONBOARDING_SLIDE_COUNT (${ONBOARDING_SLIDE_COUNT}). Update the constant.`,
    );
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed", inset: 0, zIndex: 9990,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(3px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          minHeight: 360,
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 12,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          overflow: "hidden",
          display: "flex", flexDirection: "column",
        }}
      >
        {/* Header — tiny brand chip on the left, Skip link on the right. */}
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <I.Sparkle size={13} style={{ color: T.amber }} />
            <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.fg3, letterSpacing: 0.5, textTransform: "uppercase" }}>
              Getting started
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: T.fg3,
              fontFamily: T.mono,
              fontSize: 11,
              padding: "4px 6px",
              borderRadius: 4,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = T.fg2)}
            onMouseLeave={(e) => (e.currentTarget.style.color = T.fg3)}
            title="Skip the tour (Esc)"
          >
            Skip
          </button>
        </div>

        {/* Body — fixed height so the dots/buttons don't jump between slides. */}
        <div
          key={idx}
          style={{
            flex: 1,
            padding: "20px 22px 6px",
            display: "flex", flexDirection: "column",
            minHeight: 240,
          }}
        >
          <div
            style={{
              fontFamily: T.serif,
              fontSize: 20,
              color: T.fg,
              marginBottom: 12,
              lineHeight: 1.25,
            }}
          >
            {current.title}
          </div>
          <div style={{ fontFamily: T.sans, color: T.fg1, flex: 1 }}>
            {current.body}
          </div>
        </div>

        {/* Footer — dots indicator + Back/Next/Get started. */}
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 16px",
            borderTop: `1px solid ${T.border}`,
            background: T.bg2,
          }}
        >
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {slides.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                aria-label={`Go to slide ${i + 1}`}
                style={{
                  width: i === idx ? 18 : 6,
                  height: 6,
                  borderRadius: 999,
                  background: i === idx ? T.amber : T.bg4,
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  transition: "width 0.15s, background 0.15s",
                }}
              />
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <OnboardingBtn
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={isFirst}
              variant="ghost"
            >
              Back
            </OnboardingBtn>
            {isLast ? (
              <OnboardingBtn onClick={onClose} variant="primary">
                Get started
              </OnboardingBtn>
            ) : (
              <OnboardingBtn
                onClick={() => setIdx((i) => Math.min(slides.length - 1, i + 1))}
                variant="primary"
              >
                Next
              </OnboardingBtn>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Pill key-cap chip; renders one or many modifiers + a final key. Used both
// inside HotkeyRow and inline in the "you're ready" slide.
function Kbd({ children }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 7px",
        margin: "0 2px",
        fontFamily: T.mono,
        fontSize: 11,
        color: T.fg,
        background: T.bg3,
        border: `1px solid ${T.borderStrong}`,
        borderBottom: `2px solid ${T.borderStrong}`,
        borderRadius: 5,
        verticalAlign: "baseline",
        lineHeight: 1.4,
      }}
    >
      {children}
    </span>
  );
}

// Slide-2 row: chip + label + hint paragraph. The chip uses formatHotkey so
// "Super+Shift+Space" renders as ⌘⇧Space matching what shows in Settings.
function HotkeyRow({ keys, label, hint }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        marginBottom: 14,
      }}
    >
      <div style={{ flexShrink: 0, paddingTop: 1, minWidth: 86 }}>
        <Kbd>{formatHotkey(keys)}</Kbd>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, color: T.fg, fontWeight: 600, marginBottom: 2 }}>
          {label}
        </div>
        <div style={{ fontSize: 11.5, color: T.fg2, lineHeight: 1.5 }}>
          {hint}
        </div>
      </div>
    </div>
  );
}

// Slide-3/4 row: icon tile + title + short body. Icon sits in a faint amber
// square that picks up the brand colour without dominating the slide.
function FeatureRow({ icon, title, text }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        marginBottom: 12,
      }}
    >
      <div
        style={{
          flexShrink: 0,
          width: 28, height: 28,
          borderRadius: 6,
          background: `${T.amber}18`,
          border: `1px solid ${T.amber}33`,
          color: T.amber,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, paddingTop: 1 }}>
        <div style={{ fontSize: 12.5, color: T.fg, fontWeight: 600, marginBottom: 2 }}>
          {title}
        </div>
        <div style={{ fontSize: 11.5, color: T.fg2, lineHeight: 1.5 }}>
          {text}
        </div>
      </div>
    </div>
  );
}

// Small button used in the footer. Two visual variants — primary (filled
// amber) and ghost (bordered, text-only). Disabled state matches the rest
// of Settings: dimmer text, non-interactive cursor.
function OnboardingBtn({ children, onClick, disabled, variant = "primary" }) {
  const [hover, setHover] = useState(false);
  const isPrimary = variant === "primary";
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={!!disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 26,
        padding: "0 12px",
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: T.sans,
        fontSize: 12,
        fontWeight: isPrimary ? 600 : 500,
        opacity: disabled ? 0.45 : 1,
        background: isPrimary
          ? hover && !disabled ? `${T.amber}` : `${T.amber}dd`
          : hover && !disabled ? T.bg3 : "transparent",
        color: isPrimary ? T.bg0 : T.fg1,
        border: isPrimary
          ? `1px solid ${T.amber}`
          : `1px solid ${T.border}`,
        transition: "background 0.12s, color 0.12s",
      }}
    >
      {children}
    </button>
  );
}
