# Phase 3 — Lifecycle, seam, and pure cost helpers

> Sub-plan of `docs/orchestrator-fsm-plan.md`. Read the main plan first for Overview,
> Architecture Decisions, Risks, Open Questions, and whole-plan Verification. Source
> spec: `docs/orchestrator-fsm-spec.md` (§3, §8.4, §11.1, §11.3, §11.4, §11.6, §11.7,
> §12).
>
> **Scope:** Seam schema + `validateEmission`, `reduceLifecycle`, pure usage roll-up +
> cap predicates, in-memory `RecordLog`, run-memory builder, two-reducer composition
> test. Blocked by Checkpoint B. Completes spec §15 step 2 (the pure core).

## Tasks

- [x] **Task 9: Seam schema (TypeBox) + contract-breach reasons (§3, §11.3)**
  - Description: TypeBox schemas for `handoff`/`end` payloads (the *same* schemas the
    host will pass to `defineTool`/`customTools` in Phase 4 — single source of truth)
    and a `validateEmission()` that enforces contract rules (1)–(3) of §3: exactly one
    machine event, payload matches schema. Maps breaches to `schema_invalid` /
    `extra_emission` / `no_emission` — these are the `session_failed.failure_reason`
    values the host records (§11.3), *not* `transition_rejected` reasons. Expose so the
    host calls this *before* deciding reduce-vs-lifecycle: a breach yields
    `session_failed` and `reduce` is never called. The reducer itself stays trusting of
    pre-validated input and consumes `MachineEvent` with `payload: unknown` (§12). The
    TypeBox-derived type (`Static<typeof handoffSchema>`) is the *host's* typed view of
    the payload for seeding the next session; it is intentionally not the reducer's
    input type, so the reducer cannot gain a content dependency.
  - Acceptance: Each breach type has a failing-then-passing test. A well-formed
    single emission is accepted; two events → `extra_emission`; missing `target_role`
    → `schema_invalid`; empty session output → `no_emission`.
  - Verification: `pnpm test -- validate-emission` (28 tests, all green)
  - Dependencies: Task 7
  - Files: `src/seam/schema.ts`, `src/seam/validate-emission.ts`,
    `tests/seam/validate-emission.test.ts`
  - Scope: M
  - Status: Complete. TypeBox schemas serve dual purpose: `defineTool` param
    schemas (Phase 4 host use) AND seam contract for `validateEmission`.
    `additionalProperties: true` honors §5.1 ("plus role-defined fields").
    Precedence: `extra_emission` > `schema_invalid` > `no_emission`. The reducer
    remains `payload: unknown` (§12 verbatim).

- [x] **Task 10: `reduceLifecycle` (§11.4)**
  - Description: Pure lifecycle reducer per §12 signature
    `reduceLifecycle(checkpoint, lifecycle, def, meta)`. `session_started` sets
    `active_role_session` to `{ id, role, session_file }` and requires
    `meta.role === checkpoint.current_role` with no existing active session.
    `session_ended`/`session_failed` validate `meta.sessionId` + `meta.role` against
    `active_role_session`, then clear it and record the lifecycle event with `usage`
    (captured on **both** terminals), `visit_index`, `model`, `parent_session`,
    `failure_reason`. Terminal lifecycle events do **not** require
    `meta.role === checkpoint.current_role`, because the canonical accepted path calls
    `reduce` first and may already have moved `current_role` to the next role (§12.1).
    Does not change `current_role` on model retry (§8.2). Returns new checkpoint +
    record.
  - Acceptance: A started→ended and started→failed sequence both leave
    `active_role_session == null` and produce correct records; a terminal lifecycle
    with the wrong `sessionId` or role is rejected/thrown; `usage` present on both
    terminals; `visit_index` reconstructable from records alone; model-retry does not
    advance `current_role`.
  - Verification: 30 scenario tests + reconciliation test (sum of `usage.cost`
    across both terminal types equals a hand-supplied total).
  - Dependencies: Task 7
  - Files: `src/core/reduce-lifecycle.ts`, `tests/core/reduce-lifecycle.test.ts`
  - Scope: M
  - Status: Complete. **Phase 3 deviation (documented):** §12's sketched meta
    omits three fields the §11.4 record shape requires: `usage?`, `visit_index`,
    `parent_session`. The reducer cannot derive these from a single checkpoint
    (it has no record history; §12 purity), so the host supplies them. `usage`
    is required on terminals (otherwise reconciliation breaks §11.6);
    `visit_index` / `parent_session` flow from the host's record log.
    Documented in `ReduceLifecycleMeta` JSDoc in `src/core/types.ts`.
    The reducer is the single-source-of-truth plumb: it never computes
    visit_index (it can't, without records) and never inspects usage content
    (seam/§3).

- [x] **Task 11: Pure usage roll-up + cap predicates (§11.6, §11.7)**
  - Description: Pure functions over a list of persisted records:
    `rollup(records, runId, orchestratorRole): { perRun, perRole, perModel, orchestratorOverhead }`,
    and cap-evaluation predicates `sessionCapExceeded(invocationUsage, cap)` (shared
    across fallbacks — no `cap × len(models)` loophole) and `runCapExceeded(rollup,
    cap)`. Cache caveat: expose raw `cache_read`/`cache_write` per session; do **not**
    synthesize a per-run cache-hit rate (§11.6).
  - Acceptance: Roll-up on a fabricated multi-session record set matches hand-computed
    totals per dimension; orchestrator cost isolated as overhead; shared-across-
    fallbacks predicate correctly rejects the multiplier loophole in a test;
    no per-run cache-hit-rate field exists.
  - Verification: 10 rollup tests + 12 cap tests, all green. Hand-computed totals
    match across perRun/perRole/perModel/orchestratorOverhead; cap boundary
    (`cost >= cap`) at $5 / $5 = rejected; multiplier-loophole test pins that the
    predicate does NOT scale by `len(fallbacks)`.
  - Dependencies: Task 10
  - Files: `src/cost/rollup.ts`, `src/cost/caps.ts`, `tests/cost/rollup.test.ts`,
    `tests/cost/caps.test.ts`
  - Scope: M
  - Status: Complete. **Phase 3 design note:** rollup takes
    `(records, runId, orchestratorRole)` — the orchestrator role name is needed
    for §11.6 overhead isolation and is supplied by the host (it knows the
    manifest). System-default model (null) maps to `SYSTEM_DEFAULT_MODEL_KEY`
    (`"<system-default>"`) so a real model id never collides. Both predicates
    use `cost >= cap` (hard stop, matching the reducer's `visit_count >= cap`
    convention).

- [ ] **Task 12: `RecordLog` interface (in-memory) + run-memory builder (§8.4, §11.1)**
  - Description: A `RecordLog` interface + in-memory impl used by core unit tests. The
    real persistence is host-owned in the SDK driver (Phase 4): the host appends
    immutable records to its own log and reconstructs the live checkpoint by reading
    the latest snapshot for the run from its `run_id`-keyed append-only log — never SDK
    branch scoping, never a raw scan of the whole tree, and never an event-sourced
    replay (snapshots are full; §11.1). No custom adapter in the core. Also export the
    run-memory artifact **shape** (§8.4) as a type + a pure
    `buildRunMemory(checkpoint, records, def): RunMemory` so the host's per-turn
    orchestrator seeder has a deterministic builder. No I/O.
  - Acceptance: `buildRunMemory` produces all §8.4 fields (`visit_history`,
    `run_cost_to_date`, `remaining_budget`, `per_role_cost`,
    `next_candidates` = workers not visit-capped **and** with run budget remaining
    (`remaining_budget > 0`). `next_candidates` cost-exclusion keys off the **run
    budget**, not lifetime worker spend — `max_session_cost_usd` is per-invocation and
    shared across model fallbacks (§11.7), so it cannot gate candidacy across visits.
    `open_concerns` is absent (dropped for v1, §8.4). Tested with a scenario where the
    run budget is exhausted (no candidates) and one where a worker is visit-capped
    (drops out while others remain).
  - Verification: Scenario test building memory mid-run after 2 visits + a cost-capped
    worker case.
  - Dependencies: Task 11
  - Files: `src/persistence/log.ts`, `src/core/run-memory.ts`,
    `tests/core/run-memory.test.ts`
  - Scope: M

- [ ] **Task 12.5: Two-reducer composition (reduce + reduceLifecycle, in call order)**
  - Description: A scenario test driving both reducers in the real call order the SDK
    host will use after an accepted handoff: `reduce` first, then
    `session_ended` for the previous role's active session, then `session_started` for
    the next freshly-created session (§12.1). Asserts the checkpoint is consistent
    across both writers (no `active_role_session`/`current_role` fight), including the
    important case where terminal lifecycle clears role A's active session after
    `current_role` has already moved to B. Also asserts that model-retry
    (`session_failed` then `session_started` for the same role with a fresh session id,
    without an intervening accepted transition) leaves `current_role` unchanged.
  - Acceptance: A 3-step `orch→W(ended)→orch(started)` sequence yields a single
    consistent checkpoint lineage; terminal lifecycle validates against active session
    identity rather than `current_role`; a model-retry sequence does not advance role.
  - Verification: Scenario test (this is the seam bug that survives all unit tests;
    pinned before the host is built).
  - Dependencies: Task 10, Task 12
  - Files: `tests/core/reducer-composition.test.ts`
  - Scope: S

## Checkpoint C — core complete
- [ ] Spec §15 step 2 fully delivered: reducer + uniform table + manifest checks, with
      unit tests for every legal transition, every rejection reason, the visit-cap
      guard, manifest validation, and the shared-across-fallbacks cap rule
- [ ] `pnpm typecheck && pnpm build && pnpm test` green; coverage threshold set
- [ ] Public API matches §12 signatures exactly, including the `def` param (export
      audit)
- [ ] Review with human; **this is the gate before SDK host driver work**
