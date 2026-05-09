#!/usr/bin/env bash
# Run every test suite in the project:
#
#   1. Rust  — `cargo test --lib` from src-tauri/
#      Sandbox path-traversal, FTS5 sanitizer, prompt parsing, embeddings
#      chunker, FK-cascade regression, schema smoke. ~0.01s, 64 tests.
#
#   2. UI    — scripts/run-ui-tests.sh
#      Node tests for utils.js helpers (40), Playwright component smokes
#      via WebKit (25) including the Phase 6 Rules-of-Hooks regression
#      and two XSS-safety tests. ~21s total.
#
# We deliberately run both suites even when one fails (instead of
# short-circuiting on the first error) so a CI log shows the full damage
# in one run. The exit code is nonzero if EITHER suite failed.
#
# Usage:  ./scripts/run-all-tests.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

rust_status=0
ui_status=0

echo "════════════════════════════════════════════════════════════════════════"
echo " Rust tests (cargo test --lib)"
echo "════════════════════════════════════════════════════════════════════════"
( cd src-tauri && cargo test --lib ) || rust_status=$?
echo

echo "════════════════════════════════════════════════════════════════════════"
echo " UI tests (Node + Playwright)"
echo "════════════════════════════════════════════════════════════════════════"
./scripts/run-ui-tests.sh || ui_status=$?
echo

# ── Combined summary ───────────────────────────────────────────────────────
# Print BOTH results so a failed run shows what passed alongside what
# didn't. Easier than scrolling back through scroll-buffer's worth of
# Playwright output.

echo "════════════════════════════════════════════════════════════════════════"
echo " Summary"
echo "════════════════════════════════════════════════════════════════════════"
if [ $rust_status -eq 0 ]; then
  echo "  Rust : PASS"
else
  echo "  Rust : FAIL (exit $rust_status)"
fi
if [ $ui_status -eq 0 ]; then
  echo "  UI   : PASS"
else
  echo "  UI   : FAIL (exit $ui_status)"
fi

if [ $rust_status -ne 0 ] || [ $ui_status -ne 0 ]; then
  exit 1
fi
echo
echo "All tests passed."
