# Release plan — v0.20.0

## Goal

Release the merged Issue #63 trajectory-handoff feature.

## Decisions

- Release version: `0.20.0` (minor, because trajectory handoffs are an opt-in public capability).
- The trajectory runtime remains exactly `@earendil-works/pi-coding-agent@0.80.6`, the version proven by the feasibility spike and enforced at runtime.
- The proposed Pi 0.84.3 migration is deferred: Pi's public extension context exposes `ModelRegistry`, while its documented SDK session API requires `ModelRuntime`. Reaching the registry's private runtime would violate the Issue #63 public-SDK contract.
- Do not publish to npm without separate authorization.

## Task list

### 1. Verify the release baseline

- [x] Run the Issue #63 feasibility spike and project quality gates.
- [x] Confirm `pnpm audit --prod` reports no high or critical advisories.

### 2. Prepare release metadata

- [x] Bump `package.json` to `0.20.0`.
- [x] Add a dated `CHANGELOG.md` entry for Issue #63 and the deferred Pi migration.
- [x] Re-run build, lint, format check, full tests, and audit.

### 3. Ship after merge

- [ ] Open and merge the release PR.
- [ ] Create and push annotated tag `v0.20.0` at the merged release commit.
- [ ] Create a GitHub release from that tag.
