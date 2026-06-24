# Plan: Track Default Conductor Fixture

## Overview

The CI failure is caused by test fixture files that exist locally but are ignored and untracked because of the repository-wide `.pi/` ignore rule. The smallest safe fix is to keep the current loader and test behavior, then narrowly unignore and track only the default-conductor fixture files.

## Task 1: Add a narrow `.gitignore` exception

**Description:** Preserve the broad `.pi/` ignore rule for runtime/local state, but allow the committed test fixture under `tests/fixtures/default-conductor/.pi/`.

**Acceptance criteria:**
- [x] `.gitignore` still ignores general `.pi/` directories.
- [x] `.gitignore` includes exceptions for:
  - `tests/fixtures/default-conductor/.pi/`
  - `tests/fixtures/default-conductor/.pi/conductor.yaml`
  - `tests/fixtures/default-conductor/.pi/roles/`
  - `tests/fixtures/default-conductor/.pi/roles/*.md`

**Verification:**
- [x] `git check-ignore -v tests/fixtures/default-conductor/.pi/conductor.yaml tests/fixtures/default-conductor/.pi/roles/orchestrator.md tests/fixtures/default-conductor/.pi/roles/worker.md` does not report those paths as ignored.

**Dependencies:** None.

**Files likely touched:**
- `.gitignore`

**Estimated scope:** XS.

## Task 2: Track the existing fixture files

**Description:** Add the already-existing fixture contents to git so clean CI checkouts include the default manifest and prompts.

**Acceptance criteria:**
- [x] Git tracks the three fixture files:
  - `tests/fixtures/default-conductor/.pi/conductor.yaml`
  - `tests/fixtures/default-conductor/.pi/roles/orchestrator.md`
  - `tests/fixtures/default-conductor/.pi/roles/worker.md`
- [x] No source loader or manifest semantics change; the test suite only gains the narrow ignore-regression check requested by CI.

**Verification:**
- [x] `git ls-files tests/fixtures/default-conductor/.pi` lists the three fixture files.
- [x] `pnpm test tests/host/defaults.test.ts` passes.

**Dependencies:** Task 1.

**Files likely touched:**
- `tests/fixtures/default-conductor/.pi/conductor.yaml`
- `tests/fixtures/default-conductor/.pi/roles/orchestrator.md`
- `tests/fixtures/default-conductor/.pi/roles/worker.md`

**Estimated scope:** XS.

## Final Checkpoint

- [x] `pnpm test` passes.
- [x] Confirm no unrelated files changed besides `.gitignore`, this plan/spec, and the three fixture files.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Accidentally unignore all `.pi/` runtime data | Medium | Use path-specific exceptions only. |
| Fixing by changing loader paths instead | Medium | Do not touch `src/host/defaults.ts`; current behavior already passes when files exist. |

## Open Questions

None for this CI fix.

## Summary of changed

Implemented the narrow `.gitignore` exception, added the CI regression/negative-control test, and tracked the shipped default-conductor fixture files without changing loader semantics.
