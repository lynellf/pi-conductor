# Phase 2 — The pure reducer

> Sub-plan of `docs/orchestrator-fsm-plan.md`. Read the main plan first for Overview,
> Architecture Decisions, Risks, Open Questions, and whole-plan Verification. Source
> spec: `docs/orchestrator-fsm-spec.md` (§7, §11.2, §11.3, §12).
>
> **Scope:** `reduce` for the uniform hub-and-spoke table + visit-cap guards, pure and
> deterministic given `(checkpoint, event, def, meta)`. Blocked by Checkpoint A.

## Tasks

- [ ] **Task 5: Targets helpers — declared vs available (§7.2, §7.4)**
  - Description: Two pure helpers, split so cap-awareness is explicit:
    `declaredTargets(state, def): { handoff: Role[]; end: boolean }` — the uniform
    table ignoring caps: from orchestrator → all declared workers + `end:true`; from
    worker → `[orchestrator]`, `end:false`; from `done` → empty, `end:false`.
    `availableTargets(checkpoint, def): { handoff: Role[]; end: boolean }` — same, but
    removes workers whose `visit_count[W] >= max_visits[W]` from `handoff` (cap-aware).
    Both pure, no mutation.
  - Acceptance: `declaredTargets` returns the full declared set for
    orchestrator/worker/done across 3 manifests (1 worker, 3 workers, the §8 example).
    `availableTargets` returns the same sets when no caps are hit, and drops a worker
    once `visit_count[W] == max_visits[W]`; when all workers are capped,
    `availableTargets` returns `{ handoff: [], end: true }` from the orchestrator.
  - Verification: Table-driven unit tests for both helpers.
  - Dependencies: Task 4
  - Files: `src/core/targets.ts`, `tests/core/targets.test.ts`
  - Scope: S

- [ ] **Task 6: `reduce` — accepted transitions (§7.2, §12)**
  - Description: Implement `reduce(checkpoint, event, def, meta): TransitionResult` for
    the **accepted** path only: orchestrator→worker `handoff` (guard `visit_count[W] <
    max_visits[W]` read from `def.max_visits`, effect `visit_count[W] += 1`),
    orchestrator `end`→`done`, worker `handoff`→orchestrator. Returns new checkpoint +
    `TransitionAccepted` record. Immutable: returns a new `Checkpoint`, never mutates
    input. The declared-role set and caps come from `def`, not ambient config.
    **`meta.role` is asserted equal to `checkpoint.current_role`** (§12) — mismatch
    throws/rejects rather than trusting the host. Also implement `createInitialCheckpoint`
    (signature from Task 2) here.
  - Acceptance: Every legal transition in §7.2 produces a correct `accepted` result
    with right `effect[]` and `guard` strings; `visit_count` increments only on
    orchestrator→worker; `done` is terminal and `end` from orchestrator reaches it.
  - Verification: Property-ish table tests over (state × event × def).
  - Dependencies: Task 5
  - Files: `src/core/reduce.ts`, `tests/core/reduce-accepted.test.ts`
  - Scope: M

- [ ] **Task 7: `reduce` — rejections (§7.3, §11.3)**
  - Description: Extend `reduce` to return `rejected` for every other `(state, event)`
    pair with the correct `reason`: `illegal_event` (worker→worker, `end` from worker,
    any from `done`, undeclared target), `guard_failed` (visit cap, checked against
    `def.max_visits`). The reducer returns **only** `illegal_event` / `guard_failed`
    (§11.3): contract breaches (`schema_invalid`/`extra_emission`/`no_emission`) are
    `session_failed` lifecycle events, never `transition_rejected` — the session is
    dead and there is no legal target to retry toward. Those values remain on the
    `RejectReason` union for vocabulary sharing but the reducer never returns them;
    they are exercised in Phase 3 Task 10 / Phase 5 as `session_failed.failure_reason`.
    Record `legal_targets` for retry guidance (cap-aware).
  - Acceptance: Every example in §7.3 maps to the right `reason`. `legal_targets`
    matches `availableTargets(checkpoint, def)` at rejection time (cap-aware, so a
    capped worker does not appear as a retry suggestion). Visit-cap rejection carries
    the failing guard string. The reducer never returns a breach reason.
  - Verification: Table-driven tests enumerating all illegal pairs for 2 defs.
  - Dependencies: Task 6
  - Files: `src/core/reduce.ts`, `tests/core/reduce-rejected.test.ts`
  - Scope: M

- [ ] **Task 8: Visit-cap guard edge cases (§7.4)**
  - Description: Focused tests for cycle safety: `orchestrator→W→orch→W…` until
    `visit_count[W] == max_visits[W]` then rejection; all-workers-capped → only `end`
    (and `session_failed` escalation, out of core) remains legal; cap is per-worker
    not global (§9.2 default). Confirm the guard reads `def.max_visits`, not ad-hoc
    code.
  - Acceptance: A run that exhausts one worker's cap still allows other workers;
    exhausting all yields `availableTargets` = `{ handoff: [], end: true }` from the
    orchestrator, and the reducer rejects further handoffs with `guard_failed`.
  - Verification: A multi-step scenario test driving the reducer through a capped
    sequence.
  - Dependencies: Task 7
  - Files: `tests/core/reduce-visit-cap.test.ts`
  - Scope: S

## Checkpoint B — reducer verified
- [ ] Every legal transition + every rejection reason from §7.3 is covered by a test
- [ ] Reducer is pure: same `(checkpoint, event, def, meta)` always yields identical
      result **modulo `meta.ts`** (the only non-deterministic field, which flows into
      `record.ts`). The determinism test fixes `ts` or asserts equality of
      `state`/`effect`/`reason`/`legal_targets` while ignoring `ts`.
- [ ] `meta.role === checkpoint.current_role` is asserted inside `reduce` (§12); a
      mismatch is rejected/thrown, not silently trusted
- [ ] `pnpm typecheck && pnpm build && pnpm test` green
- [ ] Review with human before lifecycle/cost work
