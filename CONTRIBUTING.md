# Contributing to Ekorbia

This document covers what you need to know before opening a pull request.
For architectural deep-dives and invariants the codebase relies on, see
[`CLAUDE.md`](CLAUDE.md) — it's written for AI coding assistants but is the
authoritative reference for "why is the code this way?" questions.

## Getting set up

Prerequisites:

- **Rust** stable toolchain (`rustup default stable`)
- **Xcode Command Line Tools** (`xcode-select --install`) — macOS only
- **Node.js 20+** — *only* for the Playwright test runner. The production
  UI is no-bundler and never reads `package.json`. See "No-bundler rule"
  below.
- **Ollama** — install from [ollama.com](https://ollama.com) and pull at
  least one chat model (e.g. `ollama pull llama3.2:3b`) so the app has
  something to talk to on first launch.

To run the app in dev:

```bash
cd src-tauri
cargo tauri dev
```

The first build pulls and compiles ~570 crates; expect 5–10 minutes.
Subsequent rebuilds are incremental and take seconds.

## The three test gates

Every PR must pass the suite that covers what it touches. Don't ship a
red suite.

| Touched | Run |
|---|---|
| any file under `src-tauri/src/` | `cd src-tauri && cargo test --lib` |
| any file under `ui/` (except prose/CSS-only) | `./scripts/run-ui-tests.sh` |
| both, or unsure | `./scripts/run-all-tests.sh` |
| only `*.md` / `docs/` / other prose | no test run required |

Additionally, every Rust PR must pass clippy with warnings as errors:

```bash
cd src-tauri && cargo clippy --lib --all-targets -- -D warnings
```

CI runs all three gates on every PR. Failing CI blocks merge.

If a test fails locally and you believe it's unrelated to your change,
say so in the PR description rather than disabling the test — we can
debug together.

## Architectural invariants

Patches that violate these have bitten us before. The full list lives in
[`CLAUDE.md`](CLAUDE.md); the highlights:

- **No-bundler UI.** Files under `ui/` are plain JSX loaded via
  `text/babel` script tags in `index.html`. Do not add `import`/`export`
  statements; do not introduce npm dependencies for runtime code. The
  `package.json` at repo root exists only for Playwright.
- **DbState lock hygiene.** `DbState(Mutex<Connection>)` is a
  `std::sync::Mutex`. Never hold it across `.await` — it will block the
  Tokio executor thread. Pattern: scope the lock to a block, drop it,
  then await.
- **Sandbox chokepoint.** Every file-system path supplied by a model or
  tool call MUST go through `sandbox::resolve_within(output_dir, path)`
  in `src/files/sandbox.rs`. It rejects `..`, absolute paths, NUL bytes,
  and symlink escapes. Unit tests cover every rejection path — extend
  them if you add a new file-handling tool.
- **Upsert pattern.** Use `INSERT … ON CONFLICT(id) DO UPDATE SET …`,
  never `INSERT OR REPLACE`. SQLite implements OR REPLACE as DELETE +
  INSERT; on a row with FK-cascade children that silently wipes them.
- **Pipeline-owned columns.** Some columns (`watches.last_content`,
  `last_polled_at`, etc.) are owned by the background runner and must
  never appear in a form-save's SET clause. Listed in the comments
  above `WATCH_COLUMNS` in `src/watch/mod.rs`.
- **Component identity in modals.** Defining a React component inside a
  render function causes focus loss on every keystroke (new identity
  each render). Hoist components to module scope.

## Code style

- **Rust**: `cargo fmt` before pushing. `clippy -D warnings` must be
  clean. Add `#[allow(clippy::xxx)]` only with a comment explaining why
  the lint doesn't apply.
- **JSX**: Match the surrounding file's style. Two-space indent, single
  quotes, no semicolons at end of lines for JSX expressions (existing
  files vary slightly; consistency within a file matters more than
  consistency across files).
- **Comments**: Explain *why*, not *what*. The codebase already has
  unusually thorough rationale comments — keep that culture going. If
  you're working around a non-obvious behavior of a dependency or the
  OS, leave a note for the next person.

## Pull request workflow

1. **Fork** `github.com/ekorbia/ekorbia-desktop` and create a branch:
   `git checkout -b your-feature-name`
2. **Make your change.** Run the relevant test gate locally.
3. **Open a PR** against `main` with a description that explains:
   - What problem this solves (or feature this adds)
   - Why this approach, briefly — alternatives considered
   - Test plan (commands you ran, scenarios you exercised manually)
4. **CI must pass.** A failing CI run blocks merge.
5. **Address review feedback** via additional commits rather than
   force-pushing where possible. We squash on merge so commit history
   on the branch doesn't matter much.

For larger changes (new tabs, new IPC surfaces, schema changes), open
an issue first to discuss the approach before sinking time into code.

## Schema changes

Ekorbia currently has no migration system — the `SCHEMA` const in
`src/db.rs` is treated as authoritative, and the dev database is wiped
between schema iterations. If your change requires a column addition or
table change:

- Edit `SCHEMA` directly.
- Update the inline tests in `src/db.rs` that assert column presence.
- Note in your PR description that existing users' dev DBs will be
  reset on next launch.

When the project picks up real users, this policy will change — a
migration block will live in `setup()` after `execute_batch(SCHEMA)`,
and ALTER TABLE statements will live there. Until then, fresh-install
is the rule.

## What we won't merge

- Patches that add an npm/webpack/vite/etc. bundler to the production
  UI path. (Test tooling is separate.)
- Patches that introduce a copyleft (GPL/AGPL) runtime dependency.
- Patches that strip the SPDX header from a source file.
- Patches that re-introduce `INSERT OR REPLACE` on a table with FK
  cascade children.

## Reporting issues

- **Bugs**: open an issue with reproduction steps, expected vs actual
  behavior, OS version, and Ekorbia version.
- **Feature requests**: open an issue. We're happy to discuss.
- **Security vulnerabilities**: see [`SECURITY.md`](SECURITY.md) —
  please use GitHub private security advisories, not the public issue
  tracker.

Thanks again. Looking forward to your PR.
