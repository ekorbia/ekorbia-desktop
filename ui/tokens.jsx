// tokens.jsx -- React hook destructure + design tokens (T).
// Loads before all other UI component scripts; T is referenced everywhere.

const { useState, useEffect, useRef, useMemo, Fragment } = React;

// ─── Tokens ─────────────────────────────────────────────────
const T = {
  // Backgrounds (deepest → highest) — chat pane darkest, panels lighter for separation
  bg0: "#0a0a0c", // chat pane (deepest)
  bg1: "#15151a", // sidebar / panels
  bg2: "#1c1c22", // input/card
  bg3: "#272730", // hover
  bg4: "#33333d", // selected
  // Borders — visible against dark panels
  border: "#2e2e38",
  borderStrong: "#3d3d48",
  // Text
  fg: "#e6e3dc",
  fg1: "#b8b4ab",
  fg2: "#8a877e",
  fg3: "#5e5c54",
  // Accents — Zed-like saturated but earthy
  amber: "#d48a50",
  blue: "#7ea7d8",
  green: "#9bbf83",
  purple: "#c89bd0",
  yellow: "#d8c97e",
  teal: "#83b4bf",
  red: "#d87e7e",
  // Mono font
  mono: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
  sans: '"Inter", system-ui, sans-serif',
  serif: '"Instrument Serif", Georgia, serif',
};

// ─── Space color palette ────────────────────────────────────
//
// Maps `spaces.color` palette keys (canonical strings stored in the DB)
// to hex values pulled from `T`. Both the create modal's swatch grid and
// the sidebar's Space-row color dot read from this map so a Space tinted
// `"amber"` renders the same conceptual color whichever screen surfaces
// it. Adding a new palette entry requires only adding it here — the
// modal grid and sidebar dot both iterate Object.keys(SPACE_COLORS).
//
// Order matters: it's the order swatches appear in the create modal.
// Earthy → cool → cool-cool → warm → warm-cool → warm-warm → red mirrors
// the rough hue wheel for predictable visual scanning.
const SPACE_COLORS = {
  amber:  T.amber,
  yellow: T.yellow,
  green:  T.green,
  teal:   T.teal,
  blue:   T.blue,
  purple: T.purple,
  red:    T.red,
};

// Resolve a Space's color key (possibly null, possibly unknown after a
// future palette purge) to a renderable hex. `null` or unknown keys fall
// through to the muted fg2 so the row still reads as a Space.
function spaceColorHex(key) {
  if (!key) return T.fg2;
  return SPACE_COLORS[key] || T.fg2;
}

// Expose globally — no bundler, components reference SPACE_COLORS and
// spaceColorHex directly without import.
window.SPACE_COLORS = SPACE_COLORS;
window.spaceColorHex = spaceColorHex;
