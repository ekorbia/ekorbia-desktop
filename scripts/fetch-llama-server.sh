#!/usr/bin/env bash
# Build the bundled inference engine (llama.cpp's `llama-server`) from a
# PINNED source release and install it where the app + bundler expect it:
#
#     src-tauri/binaries/llama-server-<target-triple>
#
# This is a BUILD-MACHINE step, never a user step: dev machines run it
# once (dev.sh checks), and the release workflow's macOS job runs it
# before `cargo tauri build`, which copies the binary INTO the .app via
# tauri.macos.conf.json's externalBin. End users just download the DMG —
# the engine is inside Ekorbia.app/Contents/MacOS/. The output is
# gitignored (15 MB binaries don't belong in git history); the source
# pin + sha256 below are what make independent builds reproducible.
#
# Why build from source instead of downloading the official release
# binaries: ggml-org's macOS release zips are DYNAMIC — llama-server
# links ~10 sibling dylibs (libllama, libggml-metal, libmtmd, …), which
# breaks Tauri's externalBin model (single self-contained file) and
# makes later code-signing a many-file affair. A `BUILD_SHARED_LIBS=OFF`
# build produces ONE ~15 MB binary linking only system frameworks.
#
# Flags worth knowing (see the cmake invocation):
#   GGML_NATIVE=OFF   — no -march=native; binary runs on any Apple-
#                       Silicon Mac, not just the build machine.
#   LLAMA_CURL=OFF    — no libcurl model-downloader; Ekorbia owns
#                       downloads (Phase 3 catalog) and fewer deps win.
#   LLAMA_OPENSSL=OFF — CRITICAL. With OpenSSL auto-detected the binary
#                       links /opt/homebrew/opt/openssl@3/… — a
#                       machine-local path that fails to load on Macs
#                       without Homebrew. We serve loopback HTTP only.
#   Metal shader      — embedded in the binary by default (no .metal
#                       sidecar file needed at runtime).
#
# The portability gate at the end fails the script if the produced
# binary links anything outside /usr/lib + /System — so the OpenSSL
# class of regression can't silently come back on a bump.
#
# Usage:
#   ./scripts/fetch-llama-server.sh            # build if missing
#   ./scripts/fetch-llama-server.sh --force    # rebuild even if present
#
# Bumping the pin: update LLAMA_TAG + SRC_SHA256 (shasum -a 256 of the
# new source tarball), run with --force, run the app's engine smoke
# (chat + tools + embed), and note the bump in CHANGELOG.md.

set -euo pipefail

LLAMA_TAG="b10067"
SRC_SHA256="4fba62c6e7474bdf0ffd459e2e3b3544cf3d9789f6f618637882146e35b704ba"
SRC_URL="https://github.com/ggml-org/llama.cpp/archive/refs/tags/${LLAMA_TAG}.tar.gz"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${REPO_ROOT}/src-tauri/binaries"
# Scratch space lives inside the already-gitignored cargo target dir.
WORK_DIR="${REPO_ROOT}/src-tauri/target/llama-server-src"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"

# Target triple for the Tauri externalBin naming convention
# (binaries/llama-server-<triple>; the bundler strips the suffix when it
# copies the sidecar next to the app executable).
if command -v rustc >/dev/null 2>&1; then
  TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
else
  case "$(uname -sm)" in
    "Darwin arm64") TRIPLE="aarch64-apple-darwin" ;;
    "Darwin x86_64") TRIPLE="x86_64-apple-darwin" ;;
    *) echo "error: can't derive target triple (install rustup)"; exit 1 ;;
  esac
fi
OUT="${BIN_DIR}/llama-server-${TRIPLE}"

if [[ -x "$OUT" && "${1:-}" != "--force" ]]; then
  echo "already present: $OUT ($(du -h "$OUT" | cut -f1)) — use --force to rebuild"
  exit 0
fi

command -v cmake >/dev/null 2>&1 || {
  echo "error: cmake is required (brew install cmake)"; exit 1;
}

mkdir -p "$WORK_DIR" "$BIN_DIR"
TARBALL="${WORK_DIR}/llama-${LLAMA_TAG}.tar.gz"

if [[ ! -f "$TARBALL" ]]; then
  echo "▸ downloading llama.cpp ${LLAMA_TAG} source…"
  curl -fL --retry 3 -o "$TARBALL" "$SRC_URL"
fi

echo "▸ verifying sha256…"
echo "${SRC_SHA256}  ${TARBALL}" | shasum -a 256 -c - >/dev/null || {
  echo "error: source tarball sha256 mismatch — refusing to build."
  echo "       (delete ${TARBALL} to re-download, or update the pin)"
  exit 1
}

SRC="${WORK_DIR}/llama.cpp-${LLAMA_TAG}"
if [[ ! -d "$SRC" ]]; then
  echo "▸ extracting…"
  tar xzf "$TARBALL" -C "$WORK_DIR"
fi

echo "▸ configuring (static, Metal, no curl / no openssl)…"
cmake -S "$SRC" -B "${SRC}/build" \
  -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_NATIVE=OFF \
  -DLLAMA_CURL=OFF \
  -DLLAMA_OPENSSL=OFF \
  -DLLAMA_BUILD_NUMBER="${LLAMA_TAG#b}" \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_TOOLS=ON \
  > "${WORK_DIR}/configure.log" 2>&1 || {
    echo "error: cmake configure failed — see ${WORK_DIR}/configure.log"; exit 1;
  }

echo "▸ building llama-server (-j${JOBS}, a few minutes on first run)…"
cmake --build "${SRC}/build" --target llama-server -j "$JOBS" \
  > "${WORK_DIR}/build.log" 2>&1 || {
    echo "error: build failed — see ${WORK_DIR}/build.log"; exit 1;
  }

BUILT="${SRC}/build/bin/llama-server"
[[ -x "$BUILT" ]] || { echo "error: build produced no binary at $BUILT"; exit 1; }

# ── Portability gate ──────────────────────────────────────────────────
# The binary must link ONLY OS-provided libraries (/usr/lib + /System
# frameworks). Anything under /opt or /usr/local is a machine-local
# Homebrew/MacPorts path that will fail to load on user machines — the
# exact regression LLAMA_OPENSSL=OFF exists to prevent.
if command -v otool >/dev/null 2>&1; then
  BAD_LINKS="$(otool -L "$BUILT" | tail -n +2 | awk '{print $1}' \
    | grep -E '^/(opt|usr/local)/' || true)"
  if [[ -n "$BAD_LINKS" ]]; then
    echo "error: binary links non-system libraries (not portable):"
    echo "$BAD_LINKS"
    exit 1
  fi
fi

cp "$BUILT" "$OUT"
chmod +x "$OUT"

echo "✓ installed $OUT ($(du -h "$OUT" | cut -f1))"
"$OUT" --version 2>&1 | head -2 | sed 's/^/  /'
