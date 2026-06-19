# Phase 2 — The pure reducer

> Sub-plan of `docs/orchestrator-fsm-plan.md`. Read the main plan first for
> Overview, Architecture Decisions, Risks, Open Questions, and whole-plan
> Verification. Source spec: `docs/orchestrator-fsm-spec.md` (§7, §11.2, §11.3,
> §12).
>
> **Scope:** `reduce` for the uniform hub-and-spoke table + visit-cap guards,
> pure and deterministic given `(checkpoint, event, def, meta)`. Blocked by
> Checkpoint A.

## Status & Verification Log

Last reviewed 2026-06-18 by an agent audit against the working tree + git
history (commits `ffb8e33` → `ace090e`). All four tasks are implemented,
committed, and green. The reducer is pure, deterministic modulo `meta.ts`,
and faithful to §7.2/§7.3/§7.4/§11.1–11.3/§12.

Verification re-run at this review
(`pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm format:check`):
all clean. `pnpm test` = 99/99 across 9 files (Phase-2 files: `core/targets`
12, `core/reduce-accepted` 32, `core/reduce-rejected` 22, `core/reduce-visit-cap`
5 — 71 new tests). `pnpm audit` not re-run; carried forward from the Phase-1
log (1 low, dev-only/Windows-only esbuild advisory accepted).

| Task | State | Evidence |
| --- | --- | --- |
| 5 `declaredTargets` / `availableTargets` (§7.2, §7.4) | ✅ Done & committed (`ffb8e33`) | `src/core/targets.ts` — two pure helpers, frozen result objects. `declaredTargets` = uniform table (orch→workers+`end:true`; worker→`[orchestrator]`+`end:false`; `done`→empty+`end:false`). `availableTargets` drops workers whose `visit_count[W] >= max_visits[W]`; short-circuits the worker/done branches (no cap-relevant targets). Tests: `tests/core/targets.test.ts` (12) across 3 manifests (1 worker, 3 workers, §8 example) — cap drop, one-short-of-cap keep, all-capped→`{handoff:[],end:true}`, per-worker independence. |
| 6 `reduce` accepted + `createInitialCheckpoint` (§7.2, §12) | ✅ Done & committed (`3050bc2`) | `src/core/reduce.ts` — `createInitialCheckpoint(def)` (UUID `run_id`, orchestrator entry, zeroed `visit_count`, `active_role_session:null`, frozen). `reduce` dispatches orchestrator/worker/done branches; accepts orch→worker (guard `visit_count[W] < max_visits[W]`, effect `visit_count[W] += 1`), orch `end`→`done`, worker→orch. `meta.role === current_role` asserted up front — mismatch throws typed `ReduceInvariantError` (not a legal rejection). Immutable: fresh frozen `Checkpoint` per call; input never mutated. Tests: `tests/core/reduce-accepted.test.ts` (32) incl. invariant throws, determinism-modulo-`ts`, post-transition `result.checkpoint` shape, snapshot freshness. |
| 7 `reduce` rejections (§7.3, §11.3) | ✅ Done & committed (`6e6fe37`) | Extends `reduce` to return `rejected` for every non-table pair. `illegal_event`: worker→worker, `end` from worker, anything from `done`, undeclared target. `guard_failed`: visit cap (read from `def.max_visits`, incl. 0-cap). Reducer returns ONLY `illegal_event`/`guard_failed`; breach reasons (`schema_invalid`/`extra_emission`/`no_emission`) stay on the union but are never returned (asserted exhaustively). `legal_targets` via `availableTargets` (cap-aware). Tests: `tests/core/reduce-rejected.test.ts` (22) — every §7.3 example, cap-aware `legal_targets`, breach-reason absence, record shape, fresh-snapshot-on-reject. |
| 8 Visit-cap guard edge cases (§7.4) | ✅ Done & committed (`ace090e`) | `tests/core/reduce-visit-cap.test.ts` (5) — per-worker independence (§9.2), all-workers-capped→only `end` legal, boundary (`max_visits-1` accepts, `max_visits` rejects), full multi-cycle orch↔impl/rev→end, guard string reads `def.max_visits` (not hardcoded). Threads `result.checkpoint` end-to-end via a `visit()` helper. |
| Checkpoint B | 🟡 Automated gates green; **human review pending** | All Checkpoint B bullets satisfied non-vacuously. Only the human-review gate remains. |

### Feedback & notes for Phase 3 (not blockers; record for traceability)

These came out of the 2026-06-18 audit. None block Phase 3 once the human-review
gate passes; they are recorded so the next implementer isn't blindsided.

1. **Effect-string-driven mutation is fragile (the one real code smell).** In
   `accept()`, the `visit_count` increment is driven by regex-parsing the
   effect string (`eff.match(/^visit_count\[(.+)\] \+= 1$/)`) rather than an
   explicit field. The effect string is an observability descriptor (§11.2),
   not the source of truth for the mutation; a format drift would silently
   break the increment with no type error. Recommended refactor before the
   pattern gets copied into lifecycle/cost: carry an explicit
   `incrementVisit?: Role` on `AcceptPlan` and derive both the effect string
   and the mutation from it. Highest-value cleanup.
2. **`payload_summary` placeholder is a Phase-3/Phase-4 contract that must be
   tracked.** `reduce` returns `record.payload_summary = { field_names: [] }`
   (and a top-level `suggests_next` populated structurally from the payload);
   the seam is documented to enrich `payload_summary` with real `field_names`
   (and a surfaced `reason`) before persistence. This means the host MUST NOT
   blindly persist `reduce`'s `record` — it must post-process
   `payload_summary`. File a note in the Phase-3 sub-plan / an ADR stating
   explicitly that the seam replaces `payload_summary` on the accepted record
   before persistence, so the Phase-4 host driver doesn't persist a
   placeholder. Also clarify the split: top-level `suggests_next` is the
   reducer's (§8.3 structural pass); `payload_summary.suggests_next` is the
   seam's.
3. **Minor: redundant/weak accumulation test.** `reduce-accepted` → "visits
   accumulate across multiple handoffs to the same worker" pre-bakes
   `visit_count` instead of threading `result.checkpoint`. The real
   accumulation behavior is already proven in `reduce-visit-cap` (which
   threads checkpoints via `visit()`). Consider simplifying it to thread the
   returned checkpoint, or delete it in favor of the visit-cap scenario.
4. **Minor: `reject` normalizes `visit_count` keys.** On rejection the
   checkpoint is rebuilt with `visit_count` re-keyed to exactly `def.workers`
   (dropping extras, adding 0s). Spec says state is "unchanged" on reject
   (§11.1/§12). The normalization is documented and harmless (only workers
   are tracked), but it's technically a content change to the snapshot, not a
   pure passthrough. If strict "unchanged" semantics are wanted, return a
   fresh object preserving the input's `visit_count` reference shape. Low
   priority — current behavior is defensible and documented.
5. **Nits:** (a) No test asserts `result.checkpoint.updated_at === meta.ts`
   (only `record.ts` is checked) — one-liner to add. (b) `reduce` returns a
   `state` field on `TransitionResult` that duplicates `checkpoint.current_role`;
   harmless (matches the §12 signature) but worth noting so a future reader
   doesn't think they must read `state` over the checkpoint.

## Tasks

- [x] **Task 5: Targets helpers — declared vs available (§7.2, §7.4)** _(committed `ffb8e33`)_
  - Description: Two pure helpers, split so cap-awareness is explicit:
    `declaredTargets(state, def): { handoff: Role[]; end: boolean }` — the
    uniform table ignoring caps: from orchestrator → all declared workers +
    `end:true`; from worker → `[orchestrator]`, `end:false`; from `done` →
    empty, `end:false`.
    `availableTargets(checkpoint, def): { handoff: Role[]; end: boolean }` —
    same, but removes workers whose `visit_count[W] >= max_visits[W]` from
    `handoff` (cap-aware). Both pure, no mutation.
  - Acceptance: `declaredTargets` returns the full declared set for
    orchestrator/worker/done across 3 manifests (1 worker, 3 workers, the §8
    example). `availableTargets` returns the same sets when no caps are hit, and
    drops a worker once `visit_count[W] == max_visits[W]`; when all workers are
    capped, `availableTargets` returns `{ handoff: [], end: true }` from the
    orchestrator.
  - Verification: Table-driven unit tests for both helpers.
  - Dependencies: Task 4
  - Files: `src/core/targets.ts`, `tests/core/targets.test.ts`
  - Scope: S

- [x] **Task 6: `reduce` — accepted transitions (§7.2, §12)** _(committed `3050bc2`)_
  - Description: Implement
    `reduce(checkpoint, event, def, meta): TransitionResult` for the
    **accepted** path only: orchestrator→worker `handoff` (guard
    `visit_count[W] <
    max_visits[W]` read from `def.max_visits`, effect
    `visit_count[W] += 1`), orchestrator `end`→`done`, worker
    `handoff`→orchestrator. Returns new checkpoint + `TransitionAccepted`
    record. Immutable: returns a new `Checkpoint`, never mutates input. The
    declared-role set and caps come from `def`, not ambient config.
    **`meta.role` is asserted equal to `checkpoint.current_role`** (§12) —
    mismatch throws/rejects rather than trusting the host. Also implement
    `createInitialCheckpoint` (signature from Task 2) here.
  - Acceptance: Every legal transition in §7.2 produces a correct `accepted`
    result with right `effect[]` and `guard` strings; `visit_count` increments
    only on orchestrator→worker; `done` is terminal and `end` from orchestrator
    reaches it.
  - Verification: Property-ish table tests over (state × event × def).
  - Dependencies: Task 5
  - Files: `src/core/reduce.ts`, `tests/core/reduce-accepted.test.ts`
  - Scope: M

- [x] **Task 7: `reduce` — rejections (§7.3, §11.3)** _(committed `6e6fe37`)_
  - Description: Extend `reduce` to return `rejected` for every other
    `(state, event)` pair with the correct `reason`: `illegal_event`
    (worker→worker, `end` from worker, any from `done`, undeclared target),
    `guard_failed` (visit cap, checked against `def.max_visits`). The reducer
    returns **only** `illegal_event` / `guard_failed` (§11.3): contract breaches
    (`schema_invalid`/`extra_emission`/`no_emission`) are `session_failed`
    lifecycle events, never `transition_rejected` — the session is dead and
    there is no legal target to retry toward. Those values remain on the
    `RejectReason` union for vocabulary sharing but the reducer never returns
    them; they are exercised in Phase 3 Task 10 / Phase 5 as
    `session_failed.failure_reason`. Record `legal_targets` for retry guidance
    (cap-aware).
  - Acceptance: Every example in §7.3 maps to the right `reason`.
    `legal_targets` matches `availableTargets(checkpoint, def)` at rejection
    time (cap-aware, so a capped worker does not appear as a retry suggestion).
    Visit-cap rejection carries the failing guard string. The reducer never
    returns a breach reason.
  - Verification: Table-driven tests enumerating all illegal pairs for 2 defs.
  - Dependencies: Task 6
  - Files: `src/core/reduce.ts`, `tests/core/reduce-rejected.test.ts`
  - Scope: M

- [x] **Task 8: Visit-cap guard edge cases (§7.4)** _(committed `ace090e`)_
  - Description: Focused tests for cycle safety: `orchestrator→W→orch→W…` until
    `visit_count[W] == max_visits[W]` then rejection; all-workers-capped → only
    `end` (and `session_failed` escalation, out of core) remains legal; cap is
    per-worker not global (§9.2 default). Confirm the guard reads
    `def.max_visits`, not ad-hoc code.
  - Acceptance: A run that exhausts one worker's cap still allows other workers;
    exhausting all yields `availableTargets` = `{ handoff: [], end: true }` from
    the orchestrator, and the reducer rejects further handoffs with
    `guard_failed`.
  - Verification: A multi-step scenario test driving the reducer through a
    capped sequence.
  - Dependencies: Task 7
  - Files: `tests/core/reduce-visit-cap.test.ts`
  - Scope: S

## Checkpoint B — reducer verified

- [x] Every legal transition + every rejection reason from §7.3 is covered by a
      test
- [x] Reducer is pure: same `(checkpoint, event, def, meta)` always yields
      identical result **modulo `meta.ts`** (the only non-deterministic field,
      which flows into `record.ts`). The determinism test fixes `ts` or asserts
      equality of `state`/`effect`/`reason`/`legal_targets` while ignoring `ts`.
- [x] `meta.role === checkpoint.current_role` is asserted inside `reduce` (§12);
      a mismatch is rejected/thrown, not silently trusted
- [x] `pnpm typecheck && pnpm build && pnpm test` green _(99/99; 71 new Phase-2 tests)_
- [x] `pnpm lint` + `pnpm format:check` clean
- [x] No pi imports in `src/core` (grep guard, non-vacuous)
- [x] Review with human before lifecycle/cost work _(agent review complete
      2026-06-18; recorded in the Status & Verification Log above; awaits human
      sign-off to open Phase 3)_
