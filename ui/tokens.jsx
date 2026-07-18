// tokens.jsx -- React hook destructure + design tokens (T).
// Loads before all other UI component scripts; T is referenced everywhere.

'use strict';
const { useState, useEffect, useRef, useMemo, Fragment } = React;

// ─── Tokens ─────────────────────────────────────────────────
// Values here are the pre-theme defaults and MUST match THEMES.one_dark in
// main.jsx — App() overwrites them via Object.assign(T, theme) on every
// render, but the overlay window (overlay.jsx) never mounts App, so it
// renders straight off these defaults. The palette mirrors ekorbia.com's
// site tokens (One Dark-inspired slate + the five brand accents) so the
// app looks like its own marketing vignettes.
const T = {
  // Backgrounds (deepest → highest) — chat pane darkest, panels lighter for separation
  bg0: "#0d0f13", // chat pane (deepest)
  bg1: "#14171d", // sidebar / panels
  bg2: "#1c1f26", // input/card
  bg3: "#232730", // hover
  bg4: "#2a2f3a", // selected
  // Borders — visible against dark panels
  border: "#262a33",
  borderStrong: "#2f3540",
  // Text
  fg: "#e3e6ec",
  fg1: "#a5acba",
  fg2: "#6b7384",
  fg3: "#4e5564",
  // Accents — the ekorbia.com brand set (vivid, tinted-fill friendly)
  amber: "#f0934a",
  blue: "#5fb0ff",
  green: "#7dd17a",
  purple: "#c281f5",
  yellow: "#e8ca6a",
  teal: "#6cc7d1",
  red: "#ff8b8b",
  // True when the active theme is a light palette (set by App()'s theme
  // apply). Lets components branch decorative treatments that only work
  // on dark surfaces (ambient tints, glow strength).
  isLight: false,
  // Elevation — matched to the site vignettes. Dark-theme defaults;
  // App() swaps in lighter recipes when a light theme is active.
  shadowSm: "0 8px 22px -6px rgba(0,0,0,0.45)",
  shadowLg: "0 18px 50px -18px rgba(0,0,0,0.55)",
  shadowPop: "0 24px 60px -20px rgba(0,0,0,0.7)",
  insetHi: "inset 0 1px 0 rgba(255,255,255,0.04)",
  // Mono font
  mono: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
  sans: '"Inter", system-ui, sans-serif',
  serif: '"Instrument Serif", Georgia, serif',
};

// Panel-card gradient ("lit from above", per the site vignettes). A
// function, not a string constant, so it re-reads T at call time and
// stays correct after App() theme-swaps the bg tokens.
function panelGrad() {
  return `linear-gradient(180deg, ${T.bg2} 0%, ${T.bg1} 100%)`;
}
window.panelGrad = panelGrad;

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
