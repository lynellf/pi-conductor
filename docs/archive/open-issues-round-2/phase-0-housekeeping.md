# Phase 0 — Close already-resolved issues #5 and #6

**Source:** [`../plan.md`](../plan.md) §"What this plan implements"
tier-table; this phase precedes Phases 1 and 2.

**Branch / PR:** none — no code change. Two `gh issue close` actions.

**Goal:** bring the open-issues list in line with reality. Issues #5 and
#6 were implemented in commits `9b1f354` and `44a4397` respectively; the
issues were never closed. The plan-time triage produces two comments
that link to the existing implementation, then closes both as
`completed`.

## Task 0.1 — Close #5 with a pointer to `docs/record-emitter-spec.md`

**Description:** Post a comment on issue #5 citing the consolidation
commit (`9b1f354`) and pointing at the canonical spec file, then close
as `not_planned`-style completion (the work is done, not abandoned).

**Acceptance criteria:**

- [ ] `gh issue view 5 --repo lynellf/pi-conductor --json state` returns
      `"state": "CLOSED"`.
- [ ] `gh api repos/lynellf/pi-conductor/issues/5/comments` shows the
      posted comment as the most recent comment.
- [ ] The comment body cites:
  - the spec file path (`docs/record-emitter-spec.md`)
  - the consolidation commit (`9b1f354`)
  - the archived implementation plan
    (`docs/archive/issues-5-and-6/phase-1-record-emitter-spec.md`).
- [ ] The comment does **not** claim new work was done; it acknowledges
      that this issue was resolved on `main` and is being closed now.

**Verification:**

- [ ] `gh issue view 5 --repo lynellf/pi-conductor --json state,stateReason`
      returns `state: CLOSED`, `stateReason: COMPLETED` (or equivalent
      admin-set reason).
- [ ] The post-#5 `#6` and `#8` open-issues list shows 2 closed, 2 open
      (the 2 open being #8 and #9, addressed by Phases 1 and 2).

**Dependencies:** None.

**Files likely touched:** None — `gh` CLI only.

**Estimated scope:** XS (two commands).

## Task 0.2 — Close #6 with a pointer to `checkModelProvidersRegistered`

**Description:** Post a comment on issue #6 citing the implementation
in `src/host/manifest.ts`, the wiring commit (`44a4397`), and the
archived implementation plan; close as `completed`.

**Acceptance criteria:**

- [ ] `gh issue view 6 --repo lynellf/pi-conductor --json state` returns
      `"state": "CLOSED"`.
- [ ] `gh api repos/lynellf/pi-conductor/issues/6/comments` shows the
      posted comment as the most recent comment.
- [ ] The comment body cites:
  - the implementation site (`src/host/manifest.ts:checkModelProvidersRegistered`)
  - the wiring commit (`44a4397`)
  - the warning code (`unregistered-provider`)
  - the archived implementation plan
    (`docs/archive/issues-5-and-6/phase-2-provider-preflight.md`).
- [ ] Manual-verify deferred work from the archive ("Run `/conduct` in
      a real pi session with an unregistered provider") is **not** a
      block on closing — the implementation is in; manual verification
      is best-effort and tracked separately if needed.

**Verification:**

- [ ] `gh issue view 6 --repo lynellf/pi-conductor --json state,stateReason`
      returns `state: CLOSED`.
- [ ] No further `unregistered-provider` issue filed about the same gap.

**Dependencies:** None.

**Files likely touched:** None — `gh` CLI only.

**Estimated scope:** XS (two commands).

## Checkpoint: end of Phase 0

- [ ] Issues #5 and #6 are `CLOSED` on `lynellf/pi-conductor`.
- [ ] Open-issue list now shows only #8 and #9.
- [ ] No `pnpm` commands run (no code change).

## Suggested `gh` invocations (for reference)

```bash
gh issue comment 5 --repo lynellf/pi-conductor --body '…'
gh issue close 5 --repo lynellf/pi-conductor --reason completed

gh issue comment 6 --repo lynellf/pi-conductor --body '…'
gh issue close 6 --repo lynellf/pi-conductor --reason completed
```

The exact comment bodies are at the implementer's discretion; see
"Acceptance criteria" for the required citations.

## Plan-sufficiency note

This phase is dispatchable in a single, short session (XS scope per
task). It does not need a reviewer pass before Phases 1 and 2 begin.
