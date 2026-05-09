#!/usr/bin/env bash
# Build the Ekorbia user guide (mdBook) into docs/book/.
#
#   Source:  docs/src/*.md   + docs/theme/css/ekorbia.css
#   Output:  docs/book/      (gitignored — regenerated each build)
#
# The output directory is what you upload to the ekorbia.dev website.
#
# Usage:
#   ./scripts/build-docs.sh              build once
#   ./scripts/build-docs.sh --open       build + open in browser
#   ./scripts/build-docs.sh --serve      live-reload dev server on :3000
#   ./scripts/build-docs.sh --clean      remove book/ and rebuild fresh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v mdbook >/dev/null 2>&1; then
  echo "Error: mdbook is not installed. Install with:" >&2
  echo "  cargo install mdbook" >&2
  exit 1
fi

case "${1:-build}" in
  --serve)
    # Live-reload server. Edits to docs/src/*.md trigger an immediate
    # rebuild + browser refresh. Useful while authoring.
    exec mdbook serve docs --open
    ;;
  --open)
    mdbook build docs
    # Default browser open. mdBook itself doesn't have a --open on `build`,
    # so we open the index after the build completes.
    open "docs/book/index.html"
    ;;
  --clean)
    rm -rf docs/book
    mdbook build docs
    ;;
  build | "")
    mdbook build docs
    ;;
  *)
    echo "Unknown option: $1" >&2
    echo "Usage: $0 [build|--open|--serve|--clean]" >&2
    exit 2
    ;;
esac

echo
echo "Docs built at: docs/book/index.html"
