# Implementation plan: issue #124 host-owned reviewer decisions and incomplete-review recovery

Authority: issue #124, `docs/archive/orchestrator-fsm-spec.md` §§3, 5, 7, 11, 12, and
`docs/decisions/ADR-004-host-owned-review-gates.md`.

## Outcome

A review-gated phase terminates through two host-captured terminal tools —
`approve({ reason })` and `request_changes({ reason })` — instead of a
model-authored FSM-routing handoff. Routing, phase identity, and revision identity
are host-owned and pinned at run start. A reviewer session that ends without a
decision is a durable `review_incomplete` state with deterministic phase-owner
recovery. Approvals fail closed when the reviewed revision changes or cannot be
verified.

## Scope and invariants

- Review gates are opt-in manifest data (`review_gates`); legacy runs keep the
  existing machine-event path unchanged.
- Every state change still goes through the pure reducer. Review routing is a
  synthetic host-authored `handoff` (reviewer → orchestrator → phase owner),
  never a checkpoint mutation.
- The append-only run log is authoritative. A `review_route_pending` intent is
  durable before the multi-snapshot reducer bridge; a `review_route` marker is
  durable after it, so a crash at any point resumes without duplicate routing.
- Seam and persistence boundaries are closed: bounded non-empty reasons,
  `additionalProperties: false`, identity fields tied to the exact gate, phase,
  reviewer session, and reviewed revision.
- No pi imports in `src/core`, `src/manifest`, `src/seam`, `src/cost`, or
  `src/persistence` (grep guard). All review logic lives in `src/host` except
  the pure TypeBox seam contract and append-only record definitions.

## Dependency graph

```text
TypeBox seam schema (approve/request_changes)
  -> record definitions + runtime validation (persistence)
    -> manifest gate parsing + static validation
      -> capture classification + repair guidance (host)
        -> terminal tools on the reviewer session (host)
          -> completion + routing through reduce (host)
            -> crash recovery for the pending route (host)
              -> start/run/resume wiring (api, spawn, loop, stub host)
```

## Task list

### Phase 1 — contracts

- [x] **Task 1: Closed TypeBox schemas.** `approve`/`request_changes` accept
  exactly one bounded non-empty `reason` (`minLength: 1`, `maxLength: 4096`,
  `\S`, `additionalProperties: false`). No target role, phase, revision, status,
  or evidence field is model-supplied. (`src/seam/review.ts`)
- [x] **Task 2: Append-only review records.** `review_gate_pinned`,
  `review_decision`, `review_incomplete`, `review_route_pending`,
  `review_route`, `review_approval_invalidated` with canonical creators,
  bounded fields, and a runtime `assertReviewRecord` for JSONL rehydration.
  (`src/persistence/review.ts`, `src/persistence/review-validation.ts`)
- [x] **Task 3: Manifest gates.** Optional `review_gates` array parsed with a
  closed key set; static validation rejects duplicate ids/phases, undeclared
  reviewer/owner roles, self-owned gates, orchestrator reviewers, and
  self-referential `next_phase`. (`src/manifest/review-gates.ts`)

### Checkpoint: contracts

- [x] Schema and record tests pass; grep guard stays green (no pi imports in
  the core-adjacent layers).

### Phase 2 — reviewer completion surface

- [x] **Task 4: Terminal tools.** `createApproveTool` /
  `createRequestChangesTool` validate against the seam schema, capture into a
  session-local buffer, seal the seam, and terminate. A second call is captured
  as an extra emission, never overwritten. (`src/host/review-tools.ts`)
- [x] **Task 5: Capture classification.** One valid capture → semantic
  decision; zero captures → `no_decision`; two or more → `extra_decision`;
  malformed → `schema_invalid`. Each maps to a durable `review_incomplete`
  with deterministic repair guidance. (`src/host/review.ts`)
- [x] **Task 6: Reviewer tool surface.** In review mode the reviewer session
  receives only `approve` + `request_changes`; the role tool allowlist excludes
  `handoff`/`end` and the `handoff_context` tool is withheld. (`src/host/shared-sdk-role-spawn.ts`)

### Checkpoint: surface

- [x] Tool contract tests cover capture, seal, terminate, duplicate, and
  schema-invalid paths.

### Phase 3 — routing and recovery

- [x] **Task 7: Completion + routing.** `completeReview` persists the outcome
  once, writes the `review_route_pending` intent, reduces the synthetic
  reviewer → orchestrator hop, closes the session through
  `reduceLifecycle(session_ended)`, reduces the orchestrator → phase-owner hop,
  and writes the `review_route` marker. `approve` advances the phase only when
  the configured `next_phase` exists and the current revision still matches.
  (`src/host/review-loop.ts`)
- [x] **Task 8: Revision invalidation.** A changed or unavailable current
  revision converts an approval into a blocked route plus a durable
  `review_approval_invalidated` record; fail-closed, never fail-open.
  (`src/host/review-loop.ts`)
- [x] **Task 9: Crash recovery.** `resumePendingReviewRoute` finishes an
  interrupted bridge from the durable intent, idempotent against the completed
  marker, without synthesizing a lifecycle event for the already-reconciled
  session. Un-routed durable outcomes are replayed instead of re-asking the
  reviewer. (`src/host/review-recovery.ts`, `src/host/review-loop.ts`)

### Checkpoint: recovery

- [x] Resume/replay tests cover a crash at each synthetic hop, duplicate-route
  suppression, and replay of an un-routed decision.

### Phase 4 — public wiring

- [x] **Task 10: Start/resume API.** `startRun` resolves a requested gate
  (manifest `reviewGateId` + `reviewedRevision`, or an explicit `ReviewGateOptions`
  validated against the manifest), pins it in `review_gate_pinned`, and passes
  the gate to the loop. `resumeRun` rehydrates the pin, rejects a conflicting
  override, and accepts a fresh `currentRevision` provider. (`src/host/api.ts`)
- [x] **Task 11: Loop integration.** The loop invokes `resumePendingReviewRoute`
  at the top of each iteration and routes every normal reviewer terminal through
  `completeReview`; host-terminated sessions keep the existing
  `session_failed` precedence, mirroring non-review handoff semantics.
  (`src/host/loop.ts`, `src/host/loop-session-turn.ts`, `src/host/loop-fallback.ts`)
- [x] **Task 12: Stub host + public barrel.** The stub session supports
  `emit_review_decision` steps so integration tests exercise the real tool
  registration; `src/host/index.ts` and `src/index.ts` export the review
  surface. (`src/host/stub-host.ts`, `src/index.ts`)

### Phase 5 — quality gates

- [x] Focused review tests: `tests/host/review-tools.test.ts`,
  `tests/host/review-loop.test.ts`, `tests/host/review-stub.test.ts`,
  `tests/persistence/review.test.ts`.
- [x] `pnpm typecheck` — clean.
- [x] `pnpm build` — emits `dist/` with `.d.ts`.
- [x] `pnpm test` — full suite green (387 files, 4112 tests).
- [x] `pnpm lint` / `pnpm format:check` — clean (Biome, 932 files).
- [x] `pnpm audit` — no high/critical advisories (3 low/moderate in dev-only
  `vitest → vite → esbuild` transitives, pre-existing).

## Acceptance criteria (issue #124)

| Criterion | Where |
| --- | --- |
| Reviewer has no general FSM-routing handoff for terminal review outcomes | `shared-sdk-role-spawn.ts` review-mode tool surface (Task 6) |
| `approve`/`request_changes` use closed TypeBox schemas with a bounded non-empty reason | `src/seam/review.ts` (Task 1) |
| Each decision is append-only, idempotent per reviewer session, tied to the exact revision/gate | `src/persistence/review.ts` + `findUnroutedReviewRecord` replay (Tasks 2, 9) |
| Missing decision produces typed `review_incomplete` + deterministic phase-owner recovery | `classifyReviewCapture` + `completeReview` (Tasks 5, 7) |
| Resume and retry preserve the recorded decision/incomplete state without duplicate routing | `resumePendingReviewRoute` + `review_route` marker + resume pin check (Tasks 9, 10) |
| A changed revision invalidates prior approval and requires fresh review | `review_approval_invalidated` + blocked route (Task 8) |
| Tests cover approval, changes requested, omitted decision, duplicate emission, resume, revision change | Phase 5 focused tests |
| Existing non-review handoff semantics and pure-core boundaries preserved | Full suite green; grep guard; review logic confined to host layer |

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Crash between the two synthetic reducer hops leaves an unowned checkpoint | `review_route_pending` intent is durable before the bridge; `resumePendingReviewRoute` finishes it idempotently. |
| Duplicate routing after resume/retry | `review_route` marker keyed to the exact decision record; replayed outcomes are matched, never re-persisted. |
| Stale approval after the revision moves | Approval routes fail closed unless the host revision provider confirms the pinned revision. |
| Reviewer authors routing identity | The terminal schema has only `reason`; identity, routing, and evidence are host-owned. |
| Legacy runs affected | Review gates are opt-in; absent `review_gates` keeps the machine-event path byte-identical. |

## Deliberately not changing

- The pure core reducer, lifecycle reducer, and manifest static-check surface
  beyond the opt-in `review_gates` section.
- Non-reviewer session semantics (handoff/end, run cost caps, end guard,
  model fallback, delegation settlement) — a host-terminated reviewer session
  still records `session_failed` with the captured usage, exactly as a
  host-terminated handoff-emitting worker does.
- Prose review commentary — the reviewer's normal assistant output remains
  available for detailed findings; the terminal reason is bounded and
  decision-atomic.
- Evidence production — the host caller supplies host-observed evidence
  (pinned revision, command execution ids/outcomes, clean-checkout state) when
  available; the record layer bounds and persists it but never trusts
  model-authored claims.
