# Phase 1 — Foundation: Trivial Completion Note

**Work slug:** issue-17-delegation
**Phase:** 1 of 3
**Mode:** Planned implementation
**Spec acknowledged:** yes (handoff `spec_acknowledged`)

## Current request

Implement Phase 1 of issue #17 (Bounded Sub-Agent Delegation): the host-agnostic
foundation — manifest types/parse/validate, seam TypeBox schemas, new PersistedRecord
variants, and cost rollup extension.

## Outcome

Phase 1 landed all 7 tasks. Every acceptance criterion from
`docs/issue-17-delegation/phase-1-foundation.md` is satisfied.

## Files changed

| File | Change |
|------|--------|
| `src/manifest/types.ts` | Added `DelegationPolicy` interface + `RoleConfig.delegation?` field |
| `src/manifest/parse.ts` | Extended `parseRoleConfig` with delegation block; added `parseDelegationPolicy`, `toPositiveFiniteInt`, `toPositiveFiniteNumber`, `toLiteral`, `toWorkspaceModeArray` helpers |
| `src/manifest/validate.ts` | Added 4 new `ManifestErrorCode` values; added delegation cross-check + policy shape validation |
| `src/seam/schema.ts` | Added `delegateInputSchema`, `reportResultInputSchema` + typed views (`DelegateInput`, `ReportResultInput`) |
| `src/persistence/log.ts` | Added `SubagentStartedRecord`, `SubagentCompletedRecord`, `SubagentFailedRecord`; extended `PersistedRecord` union |
| `src/cost/rollup.ts` | Extended `rollup` to read subagent terminals; added `perSubagent` view to `RunRollup` |
| `src/index.ts` | Re-exported new types and schemas |
| `tests/manifest/parse.test.ts` | Extended with `describe("parseManifest with delegation block")` (13 new cases) |
| `tests/manifest/validate.test.ts` | Extended with `describe("validateManifest with delegation policy")` (10 new cases, incl. delegation-duplicate-workspace-mode) |
| `tests/seam/delegation-schema.test.ts` | New — 28 TypeBox round-trip tests for both schemas |
| `tests/persistence/log.test.ts` | Extended with `describe("InMemoryRecordLog with subagent records")` (6 new cases) |
| `tests/cost/rollup.test.ts` | Extended with `describe("rollup: includes child terminal usage")` (10 new cases) |
| `tests/extension/status*.test.ts` (3 files) | Added `perSubagent: {}` to existing `costRollup` fixtures (API addition) |

## Verification evidence

```text
pnpm typecheck        ✅ clean (no TS errors)
pnpm build            ✅ clean (dist/ regenerated)
pnpm test             ✅ 861 tests pass (64 files)
  tests/seam/delegation-schema.test.ts  28 tests green
  tests/manifest/parse.test.ts          21 tests green
  tests/manifest/validate.test.ts         30 tests green (+2 for delegation-duplicate-workspace-mode)
  tests/persistence/log.test.ts           23 tests green (+6)
  tests/cost/rollup.test.ts              20 tests green (+10)
  tests/grep-guard.test.ts                 4 tests green
pnpm lint             ✅ clean (biome check)
pnpm format:check    ✅ clean (biome format)
pnpm audit           ⚠️  8 pre-existing advisories in undici (transitive,
                          not introduced by these changes)
```

## Key design decisions made

1. **`worktree_path` and `branch` are `string | null`** — not `?: string`. Matches
   the spec §9 semantics ("null for read_only mode, present for worktree mode")
   and avoids `exactOptionalPropertyTypes` conflicts in test helpers.
2. **`base_commit: string | null`** is required (non-optional) in all three
   subagent record types — the spec marks it as always present (the cleanliness
   check resolves it, or it's null if the base commit is not yet established).
3. **`max_depth` is the literal `1`** — the `toLiteral` coercion helper narrows
   the type to the literal `1` in the parsed output.
4. **`Value` from `typebox` is at `typebox/value`** — not directly on the
   `typebox` package root (verified at runtime; the existing seam tests use
   the same pattern).
5. **No `pi` imports in Phase 1 surfaces** — grep guard passes; all new code
   lives in `src/core`, `src/manifest`, `src/seam`, `src/cost`, `src/persistence`
   (host-agnostic).

## Remediation: REQUEST-CHANGES from reviewer

Two issues were flagged after the initial Phase 1 review:

### Issue 1: missing required delegation validation branch

The `delegation-duplicate-workspace-mode` error code was defined in `validate.ts`
(Task 1.3) but never actually emitted — `toWorkspaceModeArray` in `parse.ts`
was catching duplicates at the structural coercion layer and throwing a generic
`ManifestParseError`. This made the typed `delegation-duplicate-workspace-mode`
code unreachable and the corresponding test case absent.

**Fix:**
- Removed duplicate detection from `toWorkspaceModeArray` in `src/manifest/parse.ts`.
  The coercion helper now allows duplicates through to the semantic layer.
- Added duplicate detection to the `hasDelegation` branch in `src/manifest/validate.ts`
  using a `Set` size comparison; emits `delegation-duplicate-workspace-mode` as a
  **separate** error (not bundled into `delegation-invalid-policy`) so the typed
  code is unambiguously testable per the Task 1.6 acceptance criterion.
- Added two test cases to `tests/manifest/validate.test.ts`:
  - `delegation-duplicate-workspace-mode: workspace_modes with a duplicate emits
    the typed code`
  - `delegation-duplicate-workspace-mode: message includes the duplicate value`

### Issue 2: completion bookkeeping unticked

The `workspace_modes with a duplicate → delegation-duplicate-workspace-mode`
acceptance checkbox in Task 1.6 and all checkpoint boxes in
`phase-1-foundation.md` were unticked. Both are now ticked.

## Phase 2 readiness

Phase 2's implementer can build immediately. The types, schemas, and records
are in place. Phase 2 adds the host delegation manager, child SDK sessions,
worktree lifecycle, and the `delegate`/`report_result` tools.
