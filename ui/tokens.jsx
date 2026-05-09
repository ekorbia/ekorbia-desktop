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
