# Host module boundary refactor (issue #85)

Baseline: `54c482f` (`origin/main` at the issue baseline). Scope is behavior-preserving
extraction of the three largest host modules named by issue #85. Public exports,
record schemas, lifecycle ordering, reducer/persistence/spawn ownership, error identity,
and dependency set remain unchanged.

## Inventory

The complete source inventory at baseline is recorded below (physical lines, including
comments and blanks). The initial targets are the three ownership hubs; the remaining
oversized modules are explicit follow-up scope from issue #85.

| Module | Lines | Follow-up |
| --- | ---: | --- |
| `src/host/loop.ts` | 1579 | initial slice |
| `src/host/production-host.ts` | 1286 | initial slice |
| `src/host/api.ts` | 990 | initial slice |
| `src/manifest/validate.ts` | 704 | follow-up |
| `src/manifest/parse.ts` | 629 | follow-up |
| `src/host/rpc/delegate-bridge.ts` | 565 | follow-up |
| `src/host/stub-host.ts` | 559 | follow-up |
| `src/host/rpc/node-role-session.ts` | 540 | follow-up |
| `src/host/workspace/manager.ts` | 531 | follow-up |
| `src/host/host.ts` | 525 | follow-up |
| `src/host/log-file.ts` | 491 | monitor; coherent exception currently below 500 |
| `src/host/shared-sdk-role-spawn.ts` | 488 | monitor; coherent exception currently below 500 |
| `src/host/artifacts/collect.ts` | 478 | monitor; coherent exception currently below 500 |
| `src/host/stats.ts` | 474 | monitor; coherent exception currently below 500 |
| `src/host/execution/supervised-process.ts` | 453 | monitor |
| `src/host/session-event-handler.ts` | 443 | monitor |
| `src/host/execution/tool-execution-controller.ts` | 436 | monitor |
| `src/host/delegation/scheduler.ts` | 433 | monitor |
| `src/persistence/log.ts` | 431 | monitor |
| `src/core/reduce.ts` | 400 | convention boundary |
| `src/host/production-prewalk-dispatch.ts` | 399 | convention boundary |
| `src/host/tools.ts` | 393 | below ceiling |
| `src/host/prewalk-preflight.ts` | 393 | below ceiling |
| `src/bin/conduct.ts` | 393 | below ceiling |

## Responsibilities and dependencies

### `src/host/api.ts`

Public run entry points (`startRun`, `resumeRun`, `listRuns`) own file-log and lease
admission. Start preparation pins the manifest, writes the initial snapshot and seed,
then constructs the host. Resume preparation validates pinned/legacy manifests, guards
unfinished work and end-guard ownership, reconciles crashes, restores trajectory and
artifact state, then constructs the host. `runWithCompletion` owns the live
`RunControl`/`RunHandle` bridge and invokes `runLoop`; resume helpers reconstruct
durable state. Dependencies flow from manifest/persistence/core into this host boundary;
the loop is called only after admission and checkpoint preparation.

Planned boundaries: start/resume preparation helpers, durable resume reconstruction,
and completion wiring. `api.ts` remains the public facade and keeps the lifecycle owner
visible.

### `src/host/production-host.ts`

`ProductionHost` owns the Host seam and run-scoped mutable state. `spawnRole` performs
model fallback admission, prompt resolution, prewalk dispatch, isolated/shared physical
session construction, and delegation callbacks. Trajectory continuation reopens a
persisted SDK conversation with its exact environment. Remaining methods own usage,
terminal state, persistence, run memory, cost, abort/settlement, end guards, and
artifact routing/collection.

Planned boundaries: explicit physical-session spawn helpers and trajectory continuation
helpers receive the required host dependencies as arguments. The class remains the
single lifecycle owner; extracted functions do not reduce/reconcile/persist on their
own and do not introduce a generic framework.

### `src/host/loop.ts`

`runLoop` is the sole reducer + persistence owner for live lifecycle transitions. It
also coordinates model fallback, no-emission recovery, artifact routing, trajectory
selection, delegation settlement, end guards, abort, cost-cap forced close, and visit
indexes. Formatting and small error/record helpers are already below it.

Planned boundaries: extract cohesive per-session attempt/fallback and terminal outcome
helpers with an explicit mutable loop-state contract. The outer loop remains visibly
responsible for reducer calls, checkpoint assignment, durable append ordering, and
spawning decisions. No helper may mutate a checkpoint directly or persist outside the
owner's supplied callback.

## Ordered slices and gates

1. **API boundary.** Extract start/resume preparation and completion wiring. Gate with
   focused API/resume/reconciliation tests, typecheck, build, and lint/format. Commit.
2. **Production host boundary.** Extract physical session construction and trajectory
   continuation. Gate with production-host spawn/trajectory/prewalk tests, typecheck,
   build, and lint/format. Commit.
3. **Loop boundary.** Extract per-attempt and terminal coordination while preserving
   reducer/persistence ordering. Gate with loop, fallback, cost-cap, abort, delegation,
   trajectory, and artifact tests, then typecheck, build, and lint/format. Commit.
4. **Review and final verification.** Inspect each diff for public API/record/order
   changes, run the complete test suite and mandatory checks, and report remaining
   oversized modules as follow-up rather than expanding this change.

## Invariants and risks

- The core remains pi-free; no new dependencies are added.
- `reduce`/`reduceLifecycle` calls, `persistRecord` calls, and child settlement remain
  owned by the loop/host orchestration owner and retain their existing order.
- Explicit helper inputs/outputs avoid ambient mutable state and dependency cycles.
- Extraction risk is highest around closure-captured host state and loop variables;
  focused tests and per-slice commits provide rollback points.
- New helper modules must remain cohesive and below ~400 lines where practical; a
  coherent exception must include a top-of-file explanation and remain below 500.
