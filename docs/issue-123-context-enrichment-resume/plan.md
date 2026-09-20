# Implementation plan: issue #123 context-enrichment resume after cleanup reconciliation

Authority: issue #123 and [`docs/host-generated-continuity/spec.md`](../host-generated-continuity/spec.md), especially §§11, 13, and 14.

## Outcome

Allow a v2 host-generated continuity run to resume the same recipient visit after an operator appends a valid cleanup reconciliation. The previously persisted enrichment request must remain replayable and fail closed for malformed or inconsistent durable data.

## Scope and invariants

- The append-only run log remains authoritative; no historical record is deleted, rewritten, or replayed as an executable tool.
- A matching v2 `context_enrichment` terminal defines the enrichment-input boundary at its append position. Candidate observations are reconstructed from the log prefix before that terminal, so later records cannot change the already-persisted request.
- The current full observation ledger remains available to seed materialization. New failure/reconciliation observations are not erased; later recipient visits can rank them under their own terminal/input boundary.
- Existing terminal fingerprint, ordered candidate keys, duplicate checks, and strict record validation remain mandatory.
- No new dependency, schema migration, Pi boundary change, or change to cleanup confirmation semantics.

## Dependency graph

```text
indexed v2 terminal boundary
  -> replay candidate reconstruction in prepare-v2
    -> replay candidate reconstruction in materialize-v2
      -> same-visit resume regression + later-visit visibility regression
```

## Task list

### Phase 1 — reproduce and define the boundary

- [x] **Task 1: Add a failing regression scenario.** Model a completed v2 terminal, a failed role visit with `tool_cleanup_unconfirmed`, an append-only operator cleanup confirmation, and a retry of the same recipient visit. Assert the current implementation fails with `context_enrichment_v2_input_mismatch` before the fix.
- [x] **Task 2: Add indexed terminal lookup.** Preserve the existing strict terminal finder and add an internal/publicly typed way for host replay code to identify the matching terminal’s append index without weakening duplicate or malformed-record rejection.

### Checkpoint: reproduction

- [x] The regression demonstrates the issue before the implementation change.
- [x] Existing v2 replay and malformed/duplicate tests remain unchanged and passing.

### Phase 2 — implement deterministic replay

- [x] **Task 3: Bound `prepare-v2` replay to the persisted terminal.** For an existing recipient/visit terminal, materialize and fingerprint only records before that terminal; otherwise use the live append prefix for a new attempt. Reuse the terminal only after the existing strict assertions pass.
- [x] **Task 4: Bound `materialize-v2` ranking validation to the same terminal.** Recompute replay validation from the persisted prefix while retaining the full current observation ledger for direct/current seed content and future visits.
- [x] **Task 5: Add fail-closed boundary tests.** Cover missing/corrupt candidate materialization and duplicate terminal behavior so boundary replay cannot silently accept an inconsistent record.

### Checkpoint: behavior

- [x] Same recipient visit resumes without a second provider call after cleanup confirmation.
- [x] The resumed seed remains materializable and deterministic.
- [x] A later recipient visit can observe/rank observations appended after the earlier terminal.
- [x] Corrupted, duplicate, and genuinely mismatched terminals still fail closed.

### Phase 3 — quality gates

- [x] Run focused context-enrichment and observation tests.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm build`.
- [x] Run `pnpm lint`, `pnpm format:check`, and `git diff --check`.
- [x] Run the full `pnpm test` suite.
- [x] Run `pnpm audit --prod`.
- [x] Review the diff for correctness, simplicity, architecture, security, performance, and scope discipline.

## Files likely touched

- `src/persistence/context-enrichment-v2-record.ts`
- `src/persistence/context-enrichment-v2.ts`
- `src/host/context-enrichment/prepare-v2.ts`
- `src/host/context-enrichment/materialize-v2.ts`
- `tests/host-generated-continuity/context-enrichment-v2.test.ts`

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Replaying the wrong terminal boundary | Locate the unique `(run_id, recipient_role, recipient_visit)` terminal in canonical append order and retain strict duplicate checks. |
| Silently accepting stale or altered candidates | Recompute the fingerprint and ordered candidate keys from the pre-terminal observations before returning the terminal. |
| Hiding cleanup/failure evidence from future work | Keep full-log observations for seed materialization and ensure a later visit constructs candidates from the current append order. |
| Accidentally changing cleanup recovery | Only consume already-persisted records; do not invoke process inspection, kill, or tool replay. |
| Broad refactoring in a high-risk host path | Add the smallest boundary helper and keep the change limited to v2 enrichment replay plus regression coverage. |

## Deliberately not changing

- Cleanup inspection, operator confirmation validation, and executable-tool recovery.
- v1 continuity/enrichment behavior.
- The v2 record schema and fingerprint inputs.
- Reducer, checkpoint, session-spawn, and Pi SDK boundaries.
