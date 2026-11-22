# Contributing to Ekorbia

Setup and build steps are in the README's [Build from source](README.md#build-from-source) section. This page is the short list of what a patch has to respect.

## Test gates

Run the suite that covers what you touched. CI runs all of them on macOS, and a red run blocks the merge.

| Touched | Run |
|---|---|
| anything under `src-tauri/src/` | `cd src-tauri && cargo fmt && cargo test --lib` |
| anything under `ui/` | `./scripts/run-ui-tests.sh` |
| both, or unsure | `./scripts/run-all-tests.sh` |
| prose only | nothing |

Rust changes must also pass clippy with warnings as errors:

```bash
cd src-tauri && cargo clippy --lib --all-targets -- -D warnings
```

A new pure helper goes in `ui/utils.js` with a `node:test` case. A new component or modal gets at least one Playwright test under `tests/e2e/`.

## Invariants

Each of these has caused a real bug.

- **No bundler.** Files under `ui/` are plain JSX loaded by `text/babel` script tags in `index.html`. No `import` or `export`, and no npm dependency in runtime code. The root `package.json` exists only for Playwright.
- **Never hold the database lock across an `.await`.** `DbState` wraps a `std::sync::Mutex`, which blocks the executor thread. Scope the lock to a block, drop it, then await.
- **Every path from a model or tool call goes through the sandbox.** `sandbox::resolve_within` in `src/files/sandbox.rs` rejects `..`, absolute paths, NUL bytes and symlink escapes. Extend its tests when you add a file-handling tool.
- **Upserts use `INSERT … ON CONFLICT(id) DO UPDATE`.** SQLite runs `INSERT OR REPLACE` as a delete plus an insert, and the delete cascades to child rows.
- **Pipeline-owned columns stay out of form saves.** Columns such as `watches.last_content` and `last_polled_at` belong to the background runner. They are listed above `WATCH_COLUMNS` in `src/watch/mod.rs`.
- **Schema changes are migrations.** Add new columns at the end of `apply_migrations` in `src/db.rs`, using `add_column_if_missing`. A column added only to `SCHEMA` never reaches an existing install.
- **Components live at module scope.** A component defined inside a render function gets a new identity on every render and loses focus on every keystroke.

## What we won't merge

- A bundler on the production UI path. Test tooling is separate.
- A copyleft runtime dependency. CI checks every crate's license against `src-tauri/about.toml`.
- Removal of the SPDX header from a Rust source file.

## Issues and security

Bugs and ideas go in [GitHub Issues](https://github.com/ekorbia/ekorbia-desktop/issues). Report security problems privately, as [SECURITY.md](SECURITY.md) describes.
