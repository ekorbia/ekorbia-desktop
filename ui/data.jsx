// data.jsx — sample data and constants

// ── Prompt visual vocabulary ──────────────────────────────────────────────────
// Centralised here (rather than inside App) so PromptLibrary, createPrompt,
// and the icon picker all draw from the same lists.

// 5 colored Favorite tags — the classic five-tag set used by apps like
// Apple Reminders / Things / GitHub labels. Stored on each prompt as
// `favorite: 'amber' | 'blue' | 'green' | 'purple' | 'red' | null`.
//
// Tuned slightly more saturated than the v1 palette so the small (8px)
// list-row dots remain identifiable. The picker dots (14px) read fine at
// either saturation. Yellow and teal were dropped — at this scale they
// blurred into amber and blue respectively. Existing prompts that still
// reference 'yellow' or 'teal' silently fall back to "no favorite" on
// load (FAVORITE_COLORS.find → undefined → null), no migration needed.
const FAVORITE_COLORS = [
  { id: 'amber',  color: '#d68240' },
  { id: 'blue',   color: '#6da4e0' },
  { id: 'green',  color: '#8fc270' },
  { id: 'purple', color: '#c787d0' },
  { id: 'red',    color: '#de6e6e' },
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
  { id: 'gemma4:26b', name: 'Gemma 4', size: '26B', quant: 'Q4_K_M', ram: '18 GB', tps: 32, status: 'loaded', color: '#9bbf83' },
  { id: 'llama-3.3-70b', name: 'Llama 3.3', size: '70B', quant: 'Q4_K_M', ram: '40 GB', tps: 14, status: 'idle', color: '#d48a50' },
  { id: 'qwen-2.5-32b', name: 'Qwen 2.5', size: '32B', quant: 'Q5_K_M', ram: '22 GB', tps: 28, status: 'idle', color: '#7ea7d8' },
  { id: 'gemma-3-12b', name: 'Gemma 3', size: '12B', quant: 'Q6_K', ram: '9 GB', tps: 62, status: 'idle', color: '#9bbf83' },
  { id: 'phi-4-14b', name: 'Phi-4', size: '14B', quant: 'Q4_K_M', ram: '8 GB', tps: 58, status: 'idle', color: '#c89bd0' },
  { id: 'deepseek-r1-7b', name: 'DeepSeek R1', size: '7B', quant: 'Q5_K_M', ram: '5 GB', tps: 88, status: 'idle', color: '#d8c97e' },
  { id: 'mistral-7b', name: 'Mistral', size: '7B', quant: 'Q4_K_M', ram: '4 GB', tps: 96, status: 'idle', color: '#83b4bf' },
];

const MODELS_BY_ID = Object.fromEntries(MODELS.map((m) => [m.id, m]));

Object.assign(window, { MODELS, MODELS_BY_ID, FAVORITE_COLORS, FAVORITE_COLOR_MAP });
