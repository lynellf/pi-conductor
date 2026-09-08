# Host module boundary refactor (issue #85)

Baseline: `54c482f` (`origin/main`). This is behavior-preserving extraction of the
three initial host targets. Public exports, record schemas, lifecycle ordering,
reducer/persistence/spawn ownership, error identity, and dependencies remain unchanged.

## Complete oversized-module inventory

| Module | Lines | Scope |
| --- | ---: | --- |
| `src/host/loop.ts` | 1579 | initial slice; loop agent |
| `src/host/production-host.ts` | 1286 | initial slice |
| `src/host/api.ts` | 990 | initial slice |
| `src/manifest/validate.ts` | 704 | follow-up |
| `src/manifest/parse.ts` | 629 | follow-up |
| `src/host/rpc/delegate-bridge.ts` | 565 | follow-up |
| `src/host/stub-host.ts` | 559 | follow-up |
| `src/host/rpc/node-role-session.ts` | 540 | follow-up |
| `src/host/workspace/manager.ts` | 531 | follow-up |
| `src/host/host.ts` | 525 | follow-up |
| `src/host/log-file.ts` | 491 | monitor |
| `src/host/shared-sdk-role-spawn.ts` | 488 | monitor |
| `src/host/artifacts/collect.ts` | 478 | monitor |
| `src/host/stats.ts` | 474 | monitor |
| `src/host/execution/supervised-process.ts` | 453 | monitor |
| `src/host/session-event-handler.ts` | 443 | monitor |
| `src/host/execution/tool-execution-controller.ts` | 436 | monitor |
| `src/host/delegation/scheduler.ts` | 433 | monitor |
| `src/persistence/log.ts` | 431 | monitor |
| `src/core/reduce.ts` | 400 | convention boundary |

Remaining modules are tracked by follow-up issue #88, deferred from this initial slice.

## Responsibilities and dependency plan

`api.ts` owns public start/resume/list entry points, file-log/lease admission, pinned
manifest validation, crash reconciliation, trajectory/artifact resume state, and the
`RunHandle`/`RunControl` bridge into `runLoop`. Extracted resume-state and completion
helpers receive explicit records, definitions, logs, hosts, and leases; the API facade
remains the visible lifecycle owner.

`production-host.ts` owns the Host seam and run-scoped state. Its major boundaries are
model/prompt/prewalk admission, isolated/shared physical session construction,
trajectory continuation, delegation callbacks, and terminal/abort/artifact operations.
Extracted functions receive host state and callbacks explicitly; they do not reduce or
persist independently.

`loop.ts` is the sole live reducer/checkpoint/persistence owner and coordinates spawn,
fallback, recovery, artifacts, trajectory, delegation settlement, end guards, abort,
and cost caps. Its extraction is assigned to a separate agent; helpers may only act
through explicit owner callbacks.

## Ordered slices and gates

1. **API boundary**
   - [x] Inventory and dependency plan recorded.
   - [x] Resume reconstruction and completion wiring extracted.
   - [x] Public API and recovery exports preserved.
   - [x] Strict typecheck passes.
   - [x] Focused API/resume/trajectory/delegation tests pass (27 tests); strict typecheck and Biome pass.
2. **Production host boundary**
   - [x] Physical session construction, trajectory continuation, and accepted transport extracted into cohesive modules.
   - [x] Host options, run-scoped state, artifact routing, delegation, and terminal control extracted with explicit contexts; `production-host.ts` is 440 lines and every extracted helper is below 400 lines.
   - [x] Focused production-host snapshot/trajectory/preflight/spawn tests pass (37 tests); strict production-host typecheck and Biome pass.
   - [x] Fallback marker state is synchronized in `finally`, preserving escalation consumption when spawn fails before returning a session.
3. **Loop boundary**
   - [x] Per-attempt and terminal coordination extracted with owner callbacks.
   - [x] Focused loop/fallback/cap/abort/delegation/trajectory/artifact tests pass.
   - [x] Typecheck, build, and lint/format pass.
4. **Review and final verification**
   - [x] Independent review completed.
   - [x] Full suite and mandatory checks pass.
   - [x] Remaining oversized modules have explicit follow-up notes.

## Invariants and risks

- Core modules remain pi-free; no dependencies are added.
- Reducer calls, durable appends, child settlement, and spawn ordering retain their
  existing owner and order.
- Helpers use explicit inputs/outputs and remain cohesive below ~400 lines where
  practical; any coherent exception stays below 500 with a top-file explanation.
- Closure-captured host and loop state is the primary extraction risk; each slice gets
  focused tests and an atomic rollback commit.

## Completed verification

Integrated with delegation-mode PR #89 (`origin/main` at `b5d156f`). Final initial
target sizes are `api.ts` 496, `production-host.ts` 440, and `loop.ts` 383 lines.
The 476-line turn helper keeps its coherent prompt/retry boundary together. All
source modules in this change stay below 500 lines; those above 400 explain the
exception at the top of the file.

Independent API, production-host, and loop reviews found no remaining behavioral
regressions. Review fixed fallback-marker copy-back on rejected spawning and added
a regression test. The full suite exposed an extension fixture's factory mock
leaking between files; its teardown now unregisters the mock.

Final verification on 2026-09-08: 2,106 tests across 182 files passed, including
the grep guards. Strict typecheck, build, lint, formatting, and the production
dependency audit passed. No dependency or lockfile changes were required. The
remaining inventory is deferred to #88.
