#!/usr/bin/env bash
# Run the Ekorbia UI test suite.
#
#   1. Node tests for pure helpers in ui/utils.js. Fast (sub-second),
#      zero deps beyond Node 18+ (uses the built-in node:test runner).
#   2. Playwright tests for component-level smokes — mount each
#      component in an isolated WebKit page, mock window.__TAURI__,
#      assert on rendered DOM + recorded invoke() calls.
#
# Both layers test the UI in isolation from the Rust IPC layer; the
# Rust side is covered separately by `cargo test --lib` in src-tauri/.
#
# Exits non-zero on any failure. Safe to wire into a pre-push hook
# or CI step.
#
# Usage:  ./scripts/run-ui-tests.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── Stage 1: Node tests for pure helpers ───────────────────────────────────

echo "── Node tests (ui/utils.js helpers) ──────────────────────────────────"
# Drop quotes so the shell expands the glob and passes each match as a
# separate argument. Node's --test only learned to expand glob patterns
# itself in v21.0.0; v18/v20 (LTS, what CI runs) treats a quoted glob as
# a literal path and errors with "Could not find". Shell expansion works
# on every Node version that supports --test (v18+).
node --test ui/__tests__/*.test.js
echo

# ── Stage 2: Playwright tests for components ───────────────────────────────

if [ ! -d "node_modules/@playwright/test" ]; then
  echo "Playwright not installed. Run:"
  echo "  npm install && npx playwright install webkit"
  echo "from the repo root, then re-run this script."
  exit 1
fi

echo "── Playwright tests (component smokes via WebKit) ────────────────────"
# Playwright's `webServer` config auto-starts python3 -m http.server 18765
# and waits for it to be reachable before any test runs. No manual server
# management needed.
npx playwright test
