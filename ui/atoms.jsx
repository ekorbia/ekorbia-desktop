// atoms.jsx -- Small reusable widgets used by every panel.
//   TrafficLights, IconButton, ModelDot, Resizer.
// Depends on: tokens.jsx (T), icons.jsx (I.*).

// ─── Tiny atoms ─────────────────────────────────────────────
'use strict';
// The one on/off switch. `label` names it for assistive tech (the visible
// words sit beside it); `testId` becomes data-toggle. No rest props here:
// Babel's helper for them is a top-level name that a second file cannot
// declare again (see CLAUDE.md).
function EkToggle({ value, onChange, label, testId, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!value}
      aria-label={label}
      data-toggle={testId}
      disabled={disabled}
      onClick={() => !disabled && onChange && onChange(!value)}
      style={{
        position: "relative",
        width: 34,
        height: 20,
        padding: 0,
        borderRadius: 10,
        background: value ? T.fg : T.bg4,
        border: "none",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
        transition: "background 0.12s ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: value ? 16 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: T.bg0,
          boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
          transition: "left 0.12s ease",
        }}
      />
    </button>
  );
}

function TrafficLights({ onRed, onYellow }) {
  const dot = (bg, key, click) => (
    <button
      key={key}
      onClick={click}
      style={{
        width: 12,
        height: 12,
        borderRadius: "50%",
        background: bg,
        border: "none",
        padding: 0,
        cursor: "pointer",
        boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.3)",
      }}
    />
  );
  return (
    <div
      style={{ display: "flex", gap: 8, alignItems: "center", paddingLeft: 4 }}
    >
      {dot("#ff5f57", "r", onRed)}
      {dot("#febc2e", "y", onYellow)}
      {dot("#28c940", "g")}
    </div>
  );
}

function IconButton({
  icon: Ico,
  onClick,
  active,
  title,
  size = 26,
  // Optional brand-family hue for the icon glyph only (label stays neutral).
  // Pass a theme token (e.g. T.purple) so it adapts across light/dark themes.
  tint,
  children,
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: children ? "auto" : size,
        height: size,
        padding: children ? "0 8px" : 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        background: active ? T.bg4 : hover ? T.bg3 : "transparent",
        border: "none",
        borderRadius: 8,
        cursor: "pointer",
        color: active ? T.fg : T.fg2,
        fontFamily: T.sans,
        fontSize: 12.5,
      }}
    >
      {Ico && (
        <span style={{ display: "inline-flex", color: tint || "inherit" }}>
          <Ico size={13} />
        </span>
      )}
      {children}
    </button>
  );
}

// Ekorbia brand mark — the site's gradient diamond (nav mark / favicon),
// drawn inline so it ships no asset and scales crisply. Gradient stops are
// brand constants (deliberately theme-independent); the punch-out core
// reads T.bg0 at render so it matches the page on light themes too.
// Duplicate <defs> ids across instances are harmless — url(#…) resolves
// to the first match and every instance defines identical stops.
function BrandMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="ek-brand-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f0934a" />
          <stop offset="0.6" stopColor="#f17ba0" />
          <stop offset="1" stopColor="#c281f5" />
        </linearGradient>
      </defs>
      <rect
        x="5" y="5" width="22" height="22" rx="4"
        fill="url(#ek-brand-grad)"
        transform="rotate(45 16 16)"
      />
      <rect x="10" y="10" width="12" height="12" rx="2" fill={T.bg0} />
    </svg>
  );
}

function ModelDot({ color, size = 7, glow = true }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        boxShadow: glow ? `0 0 6px ${color}88` : "none",
        display: "inline-block",
      }}
    />
  );
}

function Resizer({ onDrag, side = "right" }) {
  const onPointerDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const onMove = (ev) => onDrag(ev.clientX - startX, ev.clientX);
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        width: 4,
        flexShrink: 0,
        cursor: "col-resize",
        background: "transparent",
        transition: "background 0.15s",
        zIndex: 5,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = T.amber + "60")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    />
  );
}
