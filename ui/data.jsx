// data.jsx — sample data and constants

// ── Prompt visual vocabulary ──────────────────────────────────────────────────
// Centralised here (rather than inside App) so PromptLibrary, createPrompt,
// and the icon picker all draw from the same lists.

// 5 colored Favorite tags — the classic five-tag set used by apps like
// Apple Reminders / Things / GitHub labels. Stored on each prompt as
// `favorite: 'amber' | 'blue' | 'green' | 'purple' | 'red' | null`.
//
// Hexes match "the five Ekorbia favorite dots" on ekorbia.com (the brand
// set), so the app and the site read as one product. Ids are the stable
// stored values — 'red' keeps its id even though the brand hex is pink.
// Yellow and teal were dropped in v1 — at dot scale they blurred into
// amber and blue respectively. Existing prompts that still reference
// 'yellow' or 'teal' silently fall back to "no favorite" on load
// (FAVORITE_COLORS.find → undefined → null), no migration needed.
'use strict';
const FAVORITE_COLORS = [
  { id: 'amber',  color: '#f0934a' },
  { id: 'blue',   color: '#5fb0ff' },
  { id: 'green',  color: '#7dd17a' },
  { id: 'purple', color: '#c281f5' },
  { id: 'red',    color: '#f17ba0' },
];

// Hot-path lookups: every Composer/WatchRow/PromptLibrary render previously
// did `FAVORITE_COLORS.find(c => c.id === fav)` and `MODELS.find(m => m.id
// === id)`. These maps move that to O(1) and read more idiomatically as
// `FAVORITE_COLOR_MAP[fav]?.color`. Built once at script load — the source
// arrays remain canonical (these are derived views).
const FAVORITE_COLOR_MAP = Object.fromEntries(
  FAVORITE_COLORS.map((c) => [c.id, c]),
);

const MODELS = [
  { id: 'gemma4:26b', name: 'Gemma 4', size: '26B', quant: 'Q4_K_M', ram: '18 GB', tps: 32, status: 'loaded', color: '#7dd17a' },
  { id: 'llama-3.3-70b', name: 'Llama 3.3', size: '70B', quant: 'Q4_K_M', ram: '40 GB', tps: 14, status: 'idle', color: '#f0934a' },
  { id: 'qwen-2.5-32b', name: 'Qwen 2.5', size: '32B', quant: 'Q5_K_M', ram: '22 GB', tps: 28, status: 'idle', color: '#5fb0ff' },
  { id: 'gemma-3-12b', name: 'Gemma 3', size: '12B', quant: 'Q6_K', ram: '9 GB', tps: 62, status: 'idle', color: '#7dd17a' },
  { id: 'phi-4-14b', name: 'Phi-4', size: '14B', quant: 'Q4_K_M', ram: '8 GB', tps: 58, status: 'idle', color: '#c281f5' },
  { id: 'deepseek-r1-7b', name: 'DeepSeek R1', size: '7B', quant: 'Q5_K_M', ram: '5 GB', tps: 88, status: 'idle', color: '#e8ca6a' },
  { id: 'mistral-7b', name: 'Mistral', size: '7B', quant: 'Q4_K_M', ram: '4 GB', tps: 96, status: 'idle', color: '#6cc7d1' },
];

const MODELS_BY_ID = Object.fromEntries(MODELS.map((m) => [m.id, m]));

Object.assign(window, { MODELS, MODELS_BY_ID, FAVORITE_COLORS, FAVORITE_COLOR_MAP });
