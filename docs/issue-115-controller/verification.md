# Issue #115 controller verification

Status: All acceptance proofs and final integration gates pass. The full suite
passes 3,045 tests across 298 files; the real sandbox checks pass eight tests.

Evidence must preserve the existing host-only single writer and durable-log
boundaries in `src/host/delegation/scheduler.ts`, `src/host/record-emitter.ts`,
`src/host/run-control.ts`, and `src/host/role-session-contract.ts`.

## Deterministic fixture

For pump tests use an in-memory protocol source, append-only record sink, and three
synthetic native children:

- A starts and waits on latch `a`.
- B starts and waits on latch `b`.
- C is eligible only after the verified durable terminal event for B.

Use native running capacity two and accepted-child capacity at least three.
Record durable plan/intent, native acceptance/start/terminal records, action
receipts, start order, terminal order, accepted/running counts, notification
delivery, and monotonic phase timestamps. The native A/B/C scheduling proof and the
fake-clock phase-metrics proof use separate fixtures. Do not use a paid model, network,
real campaign, coordinator prompt, or wall-clock polling. B's terminal callback
is the only trigger that may make C runnable.

## Verification matrix

| # | Criterion | Deterministic proof | Required evidence |
|---|---|---|---|
| 1 | Pinned authority and preflight | Supply valid, missing, changed, revoked, oversized, and incompatible controller/adapter registrations. | `[x]` Pinned definition/runtime/capability digests are required; malformed or incompatible configuration fails specifically; no unsandboxed fallback or model turn is introduced. |
| 2 | Closed executable protocol | Feed malformed, oversized, truncated, duplicate, and out-of-order JSON requests/responses. | `[x]` Versioned boundary validation rejects safely; bounded diagnostics are retained; child prose/stdout cannot synthesize control events; no partial action execution follows invalid output. |
| 3 | Single-writer event delivery | Enqueue repeated advisory capacity wakeups, unique terminal facts, repeated facts, stale plans, and unchanged plans. | `[x]` Native callbacks only enqueue; one writer reconstructs facts from durable sources; advisory wakeups coalesce; unique terminal/action facts survive repetition/out-of-order delivery; unchanged-plan attempts escalate after the bounded limit; no polling/no-op loop. |
| 4 | A/B/C scheduling and capacity | Accept A and B independently, hold A, complete B, and inspect C before releasing A; then fill accepted capacity with a bulk batch. | `[x]` Start trace is `A, B, C`; A remains active when C starts; coordinator/model-turn count is zero; at most two native children run; accepted queued/failed/cancelled children consume lifetime allowance; preparation delay is reported separately. |
| 5 | Identity, intent, admission, receipts | Repeat an action with the same identity and canonical request, reuse it with changed arguments, and race controller receipt delivery with native acceptance. | `[x]` Same request returns the original status/receipt; changed request conflicts before new work; plan/state/cursor/intents commit together; native acceptance is durable before queue admission; receipt preserves action/activation/causal revision and exact bindings without fabricated SDK provenance. |
| 6 | Failure, cancel, finish, and cleanup | Fail one child, cancel queued and active children selectively, finish with pending work, and terminate during adapter/native cleanup. | `[x]` Unrelated work continues; targeted cancellation affects only named work; finish waits for owned work before ordinary end intent; cleanup/persistence uncertainty poisons admission; controller failure escalates with evidence and never becomes an automatic model turn. |
| 7 | Recovery and authoritative metrics | Replay every crashpoint below, including missed notifications and resumed activation. | `[x]` Resume uses the pinned definition and owner epoch; no accepted task or adapter is relaunched; known terminals/accounting remain exactly once; uncertain effects block; metrics use durable records as authority and expose all required latency/capacity fields. |
| 8 | Generic example and migration contract | Run a no-paid-model example that prepares packets, delegates synthetic work, validates results, records receipts, and finishes; compare documented manual model orchestration steps. | `[x]` Example resolves through rebuilt `dist/bin/conduct.js`; repository-owned selection/order/gates remain explicit; migration guidance identifies replaced model turns and retained policy decisions; focused proof is complete, while the full suite remains a separate integration gate in `plan.md`. |

### A–C focused evidence

- `[x]` Authority, protocol, and provenance boundaries are covered by
  `tests/host/controller-host-approval.test.ts`,
  `tests/host/executable-controller-host.test.ts`,
  `tests/persistence/controller-records.test.ts`, and
  `tests/persistence/tool-execution.test.ts`. These exercise protected approval
  loading, revocation, strict controller records, canonical request identity,
  and schema-v2 executable origins without SDK tool-call fields.
- `[x]` Native durable admission and stable scope behavior are covered by
  `tests/persistence/delegation-task.test.ts`,
  `tests/host/controller-action-dispatcher.test.ts`, and
  `tests/host/production-controller-session.test.ts`. These cover durable
  accepted arguments, action receipts, controller admission construction, and
  the activation-owned session boundary.
- `[x]` Crash/cleanup and chronology gates are covered by
  `tests/host/controller-recovery.test.ts`,
  `tests/host/controller-adapter-recovery.test.ts`,
  `tests/host/tool-execution-controller-lifecycle.test.ts`,
  `tests/host/tool-execution-controller.test.ts`, and
  `tests/host/log-file.test.ts`. These cover no-replay recovery planning,
  uncertain execution cleanup, append ordering, private durable controller-log
  writes, and closed admission.

### Real executable example evidence

- `bubblewrap-controller-example.real.ts` passes through the rebuilt CLI and
  production host with an approved runtime and synthetic native worker. It
  verifies preparation, immutable `host_artifact` context, native completion,
  validation publication, exact read receipt, and ordinary `done` termination.
  The two provider requests belong to the native worker, not the controller.
- Seven additional real Bubblewrap preflight and command-runner checks pass,
  including confinement, literal argv/JSON stdin, ambient-descriptor stripping,
  timeout cleanup, and cancellation before release.
- The smoke test exposed and verified fixes for fresh external log directories
  and two adapters sharing one executable. Adapter approval lookup now binds
  the exact adapter identity; the planner branch also requires planner origin.

### Metrics evidence

- `controller-metrics.test.ts`, `controller-metrics-replay.test.ts`, and
  `controller-metrics-resume.test.ts` prove all seven phase names, durable source
  identities, exact execution-bound runtime capture, lifetime capacity, bounded
  samples, and unknown durations across activations. The resume proof retains
  earlier history while replacing matching replay samples with live monotonic
  observations and preserves unknown cross-restart idle intervals.
- `controller-status.test.ts` covers bounded controller status, zero coordinator
  model turns, final-snapshot retention, and unchanged legacy status behavior.
  Independent review found no remaining metrics correctness blocker.

### Scheduling, decision, and recovery evidence

- `controller-role-session.test.ts` exercises the real native scheduler with A
  held while B completes and C starts, plus unchanged/stale planner limits,
  facts arriving during planning, and waiting/running cost-cap termination.
  `controller-decision-kinds.test.ts` proves plan, wait, finish, and escalate
  atomically consume the exact page and persist state before dispatch.
- `controller-action-dispatcher.test.ts`, `delegation-scheduler-review.test.ts`,
  and `delegation-scheduler.test.ts` cover independent action lanes, native FIFO,
  shared capacity, retained lifetime allowance, cancellation, duplicate work,
  and ambiguous terminal appends. `controller-activation-fence.test.ts` covers
  reversible finish and permanent closure against late callbacks.
- `controller-protocol-codec.test.ts`, `controller-event-page.test.ts`, and
  `controller-records.test.ts` cover malformed/oversized protocol data, exact
  cursors, duplicate IDs, request fingerprints, chronology, and finite budgets.
  `controller-api-lifecycle.test.ts` covers bounded failure evidence and no
  provider fallback. `controller-cap-override.test.ts` proves lowering a cap
  wakes a waiting controller without a new planner emission.
- `controller-recovery.test.ts` covers a planner crash before its first decision,
  accepted native work, interrupted preparation, missing/repeated notification,
  and explicit repair without replay. `controller-adapter-recovery.test.ts` and
  `controller-artifact-store.test.ts` cover partial adapter effects, immutable
  publication recovery, binding corruption, and cleanup requirements.
- `controller-log-durability.test.ts` verifies directory durability when an
  existing ordinary run log receives its first controller record. Controller
  API, production-session, lifecycle, and reconciliation tests retain legacy
  provenance and route closure through the existing host loop.

## Crashpoints and effect classification

The durable plan/intent commit precedes every action effect. Planner processes
may already have run; their unknown ownership still blocks resume until cleanup
is proved, after which uncommitted input may be reinvoked. After intent commit, native
preparation or capture work may already have occurred even when no native child
was accepted; recovery must inspect authoritative evidence and cannot claim “no
effect” merely because acceptance is absent. Native and adapter execution require
a durable execution-start record before dispatch.

| Crash boundary | Known state | Recovery requirement |
|---|---|---|
| Planner execution-start present; terminal missing | Read-only process ownership unresolved | `[x]` Block resume until cleanup/repair is verified; then reinvoke the same input only if no decision committed. |
| Before durable plan/intent commit | No committed intent | `[x]` Redelivery is safe only after proving no host effect; no action is reconstructed from an uncommitted planner response. |
| Intent committed; preparation/capture may have run; no native acceptance or adapter start | Intent exists; effects require evidence | `[x]` Reconcile preparation/staging evidence; do not claim rollback or “no effect” without proof; do not automatically dispatch the intent. |
| Intent committed; native acceptance append present; controller receipt missing | Native acceptance is authoritative | `[x]` Derive the receipt from the accepted submission and bindings; never resubmit or reset allowance. |
| Adapter execution-start durable record present; no terminal/publication | Adapter may be live or have partial effects | `[x]` Reconcile original ownership and private staging; mark uncertain and block continuation when unresolved. |
| Native start durable; terminal missing | Child may be live or interrupted | `[x]` Apply existing ownership/reconciliation rules; never infer exit from a missing terminal. |
| Immutable publication verified; receipt missing | Output is authoritative by manifest | `[x]` Recover the same output reference after cleanup verification; publish no duplicate and account once. |
| Terminal/receipt appended; notification missing or repeated | Durable terminal known | `[x]` Replay the original fact/identity; notification loss or duplication changes no result, receipt, or usage. |
| Ambiguous persistence or cleanup | Authority unresolved | `[x]` Poison admission, preserve bounded evidence, and require explicit repair; do not replay uncertain effects. |

## Required latency and authority fields

The deterministic metric fixtures report these exact issue metrics separately:

- `child-terminal-to-controller-start`
- `controller-duration`
- `controller-result-to-native-acceptance`
- `acceptance-to-child-start`
- idle-capacity intervals
- coordinator model-turn count, which must be zero in controller mode

Also expose adapter/preparation/runtime-capture time, accepted capacity,
running capacity, and restart-boundary/unknown duration where clocks cannot be
joined. Notification timing is observability only; durable acceptance,
execution-start, terminal, publication, and receipt records are authoritative.
An idle slot with no eligible repository task is not automatically harness
delay. Native scheduler preparation delay remains distinct from running-slot
occupancy.

The executable example must additionally run a real approved sandboxed planner
and local adapter through JSON stdin/stdout. Verify runtime identity, private
staging publication, the new immutable-artifact native context source, validation
receipts and finish through the rebuilt CLI. Synthetic native workers are allowed;
an in-memory planner alone does not satisfy this integration proof.

Additional contract checks:

- [x] Multiple independent submissions fill multiple free slots, with one shared
  accepted-child allowance that survives activation changes.
- [x] Every response kind atomically consumes its exact input page; native facts
  appended during planning remain pending, without invalidating the decision CAS.
- [x] Inline durable request bytes reproduce action fingerprints after a crash;
  duplicate IDs within one plan fail before any effect.
- [x] Cross-lane actions are independent; same-lane last-slot contention is FIFO;
  finite decision/action/outstanding-intent budgets bound synthetic receipt loops.
- [x] Closed activation callbacks cannot publish/admit; owned cleanup terminals
  remain appendable during closing, before ownership transfers.
- [x] Finish uses a reversible gate; typed machine-rejection and guard-retry facts
  permit a new decision; unsupported steering cannot silently defer finish.
- [x] The run cost cap while the planner runs or waits forces host closure via
  a typed host-only signal before seam validation and a reducer-fed end without
  a fabricated planner capture, preserving abort/cleanup-failure precedence.
- [x] Repair records resolve original ownership without mutating receipts or
  asserting success; the old poisoned activation never reopens.
- [x] Revocation blocks new execution without substituting current configuration;
  mixed legacy/controller scopes and transcript consumers preserve provenance.

Focused scheduling acceptance uses deterministic fixtures. `pnpm typecheck`, build,
tests, lint, formatting, audit, and the rebuilt CLI/example check are later
integration gates described by the implementation plan; their completed results
are recorded there.

### Integration-test isolation

The first final full-suite run passed 3,041 tests and exposed four test-harness
failures: three executable-host tests reused previously cached real dependencies
in the shared Vitest process, and the unchanged restart-recovery integration
exceeded its default five-second deadline. The executable-host fixture now
reloads its subject against local mocks and clears those mocks afterward; the
combined sandbox/host/production fixture batch passes (13 tests). Recovery passed
independently in 4.47 seconds, so its three disk-backed SDK initializations now
have an explicit 15-second test deadline. No production timeout was changed.
The complete suite then passed all 3,045 tests across 298 files on frozen source.
