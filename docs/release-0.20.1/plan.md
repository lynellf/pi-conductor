# Release plan — v0.20.1

## Goal

Release the merged Issue #68 telemetry and Issue #70 test-isolation fixes.

## Decisions

- Release version: `0.20.1` (patch): both changes preserve the existing public production contract.
- Do not publish to npm without separate authorization.

## Task list

### 1. Verify the release baseline

- [x] Run project quality gates and the full test suite.
- [x] Confirm `pnpm audit --prod` has no high or critical advisories.

### 2. Prepare release metadata

- [x] Bump `package.json` to `0.20.1`.
- [x] Add a dated `CHANGELOG.md` entry for Issues #68 and #70.

### 3. Ship

- [x] Commit and push release metadata to `main`.
- [x] Create and push annotated tag `v0.20.1` at the release commit.
- [x] Create a Forgejo release from that tag.
