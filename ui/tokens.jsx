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

// ─── Shared control styles ──────────────────────────────────
// One look for every button, field, heading, hint and chip in the app.
// Functions, not constants: T changes with the look (light / dark), so a
// style has to be built at render time — a module-level object would
// freeze the dark defaults.
//
//   ekBtn(kind, opts)   kind: "secondary" (outlined, the default),
//                       "primary" (solid — one per dialog), "quiet" (no
//                       outline), "danger" (red words, outlined).
//                       opts: { disabled, small }
//   ekField(extra)      a text input, select or textarea
//   ekHeading(extra)    the title over a group of settings
//   ekLabel(extra)      the name of one setting
//   ekHint(extra)       the sentence under a setting
//   ekKbd(extra)        a key or key combination
//   ekChip(tone)        a small pill. tone: "plain" | "accent"
function ekBtn(kind, opts) {
  const o = opts || {};
  const st = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: o.small ? 26 : 30,
    padding: o.small ? "0 10px" : "0 12px",
    boxSizing: "border-box",
    borderRadius: 8,
    border: `1px solid ${T.isLight ? T.border : T.borderStrong}`,
    background: T.isLight ? T.bg0 : T.bg2,
    color: T.fg,
    fontFamily: T.sans,
    fontSize: o.small ? 12 : 13,
    fontWeight: 500,
    lineHeight: 1,
    whiteSpace: "nowrap",
    flexShrink: 0,
    cursor: o.disabled ? "default" : "pointer",
    opacity: o.disabled ? 0.5 : 1,
  };
  if (kind === "primary") {
    st.background = o.disabled ? T.bg3 : T.fg;
    st.border = `1px solid ${o.disabled ? T.border : T.fg}`;
    st.color = o.disabled ? T.fg2 : T.bg0;
    st.fontWeight = 600;
    st.opacity = 1;
  } else if (kind === "quiet") {
    st.background = "transparent";
    st.border = "1px solid transparent";
    st.color = T.fg1;
    st.fontWeight = 400;
  } else if (kind === "danger") {
    st.background = "transparent";
    st.color = T.red;
  }
  return st;
}

function ekField(extra) {
  return Object.assign(
    {
      width: "100%",
      boxSizing: "border-box",
      padding: "7px 10px",
      background: T.bg0,
      border: `1px solid ${T.isLight ? T.border : T.borderStrong}`,
      borderRadius: 8,
      color: T.fg,
      fontFamily: T.sans,
      fontSize: 13,
      lineHeight: 1.4,
      outline: "none",
    },
    extra || {},
  );
}

function ekHeading(extra) {
  return Object.assign(
    { fontFamily: T.sans, fontSize: 12.5, fontWeight: 600, color: T.fg },
    extra || {},
  );
}

function ekLabel(extra) {
  return Object.assign({ fontFamily: T.sans, fontSize: 13, color: T.fg }, extra || {});
}

function ekHint(extra) {
  return Object.assign(
    { fontFamily: T.sans, fontSize: 12, lineHeight: 1.5, color: T.fg2 },
    extra || {},
  );
}

function ekKbd(extra) {
  return Object.assign(
    {
      display: "inline-block",
      fontFamily: T.sans,
      fontSize: 11.5,
      lineHeight: 1.5,
      color: T.fg1,
      background: T.bg0,
      border: `1px solid ${T.isLight ? T.border : T.borderStrong}`,
      borderRadius: 5,
      padding: "0 6px",
      whiteSpace: "nowrap",
    },
    extra || {},
  );
}

function ekChip(tone) {
  const accent = tone === "accent";
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 24,
    padding: "0 9px",
    boxSizing: "border-box",
    borderRadius: 999,
    border: `1px solid ${accent ? "transparent" : T.border}`,
    background: accent ? `${T.amber}22` : T.bg2,
    color: accent ? T.amber : T.fg1,
    fontFamily: T.sans,
    fontSize: 12,
    fontWeight: 500,
    whiteSpace: "nowrap",
  };
}
window.ekBtn = ekBtn;
window.ekField = ekField;
window.ekHeading = ekHeading;
window.ekLabel = ekLabel;
window.ekHint = ekHint;
window.ekKbd = ekKbd;
window.ekChip = ekChip;
