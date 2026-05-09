## Summary

<!-- One short paragraph: what does this PR do, and why? -->

## Implementation notes

<!--
Anything reviewers should know to follow the diff:
- Why this approach instead of alternatives?
- Any tricky bits worth flagging?
- New invariants or rules that future patches need to respect?
Skip this section if the change is straightforward.
-->

## Test plan

<!-- Concrete commands you ran. CI runs all the gates too, but local
verification often catches things faster. -->

- [ ] `cd src-tauri && cargo test --lib` passed
- [ ] `cd src-tauri && cargo clippy --lib --all-targets -- -D warnings` clean
- [ ] `./scripts/run-ui-tests.sh` passed (if UI changed)
- [ ] Manually verified in `cargo tauri dev` — _scenario:_ <!-- describe what you clicked through -->

## Architectural invariants

<!-- See CONTRIBUTING.md for the full list. Check the ones that apply
to this PR; delete or strike through the ones that don't. -->

- [ ] No `import`/`export` added to `ui/` (no-bundler rule)
- [ ] DbState mutex not held across any `.await`
- [ ] All model/tool-supplied paths go through `sandbox::resolve_within`
- [ ] No `INSERT OR REPLACE` on tables with FK-cascade children
- [ ] Components used in modals are hoisted to module scope (not defined inside render)
- [ ] Schema additions noted in the PR description (existing dev DBs will reset)

## Linked issues

<!-- "Closes #123" / "Refs #456" — or "None" if standalone. -->
