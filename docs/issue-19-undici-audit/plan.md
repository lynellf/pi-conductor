# Issue #19: Resolve the production `undici` audit findings

## Decision

Update the development pi SDK graph (`pi-ai`, `pi-coding-agent`, and `pi-tui`)
to `0.80.5`. The published
`@earendil-works/pi-coding-agent@0.80.5` directly depends on patched
`undici@8.5.0`, so no pnpm override is needed. Keep the published pi package
peer ranges as `"*"`; consumers continue to supply their own pi runtime.

## Tasks

- [x] Update the development pi package versions and regenerate the lockfile.
- [x] Update the CI comment to name the patched locked SDK graph.
- [x] Confirm `pnpm why undici` resolves only `8.5.0` and `pnpm audit --prod`
  reports no high or critical findings.
- [x] Run lint, typecheck, build, tests, and the production audit.
- [x] Review the diff for narrow scope and dependency compatibility.
