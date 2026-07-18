#!/usr/bin/env bash
# Launch the Ekorbia dev app — safe to run from ANY directory.
#
# Why this exists: `cargo tauri dev` is CWD-sensitive. tauri.conf.json's
# `frontendDist: "../ui"` is resolved by the tauri CLI against the
# directory you run FROM, not against the config file. From src-tauri/
# that lands on <repo>/ui (live sources — correct); from the repo root it
# lands on <repo>/../ui, which doesn't exist, and instead of failing loud
# the app falls back to the frontend snapshot embedded at an earlier
# compile — silently running WEEKS-OLD UI. That ghost cost a debugging
# session (see CLAUDE.md "cargo tauri dev is CWD-sensitive").
#
# Usage:  ./scripts/dev.sh   (extra args pass through to `cargo tauri dev`)

set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)/src-tauri"

# macOS: the bundled-engine sidecar (tauri.macos.conf.json externalBin)
# must exist or the tauri CLI aborts with an unhelpful "failed to copy
# external binary" — catch it here with the actual fix. One-time ~5 min
# build. Other platforms don't declare the sidecar (engine backend is
# macOS-first), so they skip this check.
if [[ "$(uname -s)" == "Darwin" ]] && ! ls binaries/llama-server-* >/dev/null 2>&1; then
  echo "error: engine sidecar missing (src-tauri/binaries/llama-server-*)." >&2
  echo "       Run ./scripts/fetch-llama-server.sh once, then retry." >&2
  exit 1
fi

exec cargo tauri dev "$@"
