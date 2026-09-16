# Issue #115 controller verification

Status: verification plan only. The proposed controller API is intentionally
not fixed here. All executable checks remain unchecked until the spec is
acknowledged and implementation exists.

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
delivery, and monotonic phase timestamps. Do not use a paid model, network,
real campaign, coordinator prompt, or wall-clock polling. B's terminal callback
is the only trigger that may make C runnable.

## Verification matrix

| # | Criterion | Deterministic proof | Required evidence |
|---|---|---|---|
| 1 | Pinned authority and preflight | Supply valid, missing, changed, revoked, oversized, and incompatible controller/adapter registrations. | `[ ]` Pinned definition/runtime/capability digests are required; malformed or incompatible configuration fails specifically; no unsandboxed fallback or model turn is introduced. |
| 2 | Closed executable protocol | Feed malformed, oversized, truncated, duplicate, and out-of-order JSON requests/responses. | `[ ]` Versioned boundary validation rejects safely; bounded diagnostics are retained; child prose/stdout cannot synthesize control events; no partial action execution follows invalid output. |
| 3 | Single-writer event delivery | Enqueue repeated advisory capacity wakeups, unique terminal facts, repeated facts, stale plans, and unchanged plans. | `[ ]` Native callbacks only enqueue; one writer reconstructs facts from durable sources; advisory wakeups coalesce; unique terminal/action facts survive repetition/out-of-order delivery; unchanged-plan attempts escalate after the bounded limit; no polling/no-op loop. |
| 4 | A/B/C scheduling and capacity | Accept A and B independently, hold A, complete B, and inspect C before releasing A; then fill accepted capacity with a bulk batch. | `[ ]` Start trace is `A, B, C`; A remains active when C starts; coordinator/model-turn count is zero; at most two native children run; accepted queued/failed/cancelled children consume lifetime allowance; preparation delay is reported separately. |
| 5 | Identity, intent, admission, receipts | Repeat an action with the same identity and canonical request, reuse it with changed arguments, and race controller receipt delivery with native acceptance. | `[ ]` Same request returns the original status/receipt; changed request conflicts before new work; plan/state/cursor/intents commit together; native acceptance is durable before queue admission; receipt preserves action/activation/causal revision and exact bindings without fabricated SDK provenance. |
| 6 | Failure, cancel, finish, and cleanup | Fail one child, cancel queued and active children selectively, finish with pending work, and terminate during adapter/native cleanup. | `[ ]` Unrelated work continues; targeted cancellation affects only named work; finish waits for owned work before ordinary end intent; cleanup/persistence uncertainty poisons admission; controller failure escalates with evidence and never becomes an automatic model turn. |
| 7 | Recovery and authoritative metrics | Replay every crashpoint below, including missed notifications and resumed activation. | `[ ]` Resume uses the pinned definition and owner epoch; no accepted task or adapter is relaunched; known terminals/accounting remain exactly once; uncertain effects block; metrics use durable records as authority and expose all required latency/capacity fields. |
| 8 | Generic example and migration contract | Run a no-paid-model example that prepares packets, delegates synthetic work, validates results, records receipts, and finishes; compare documented manual model orchestration steps. | `[ ]` Example resolves through rebuilt `dist/bin/conduct.js`; repository-owned selection/order/gates remain explicit; migration guidance identifies replaced model turns and retained policy decisions; focused proof is complete, while the full suite remains a separate integration gate in `plan.md`. |

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
| Planner execution-start present; terminal missing | Read-only process ownership unresolved | `[ ]` Block resume until cleanup/repair is verified; then reinvoke the same input only if no decision committed. |
| Before durable plan/intent commit | No committed intent | `[ ]` Redelivery is safe only after proving no host effect; no action is reconstructed from an uncommitted planner response. |
| Intent committed; preparation/capture may have run; no native acceptance or adapter start | Intent exists; effects require evidence | `[ ]` Reconcile preparation/staging evidence; do not claim rollback or “no effect” without proof; do not automatically dispatch the intent. |
| Intent committed; native acceptance append present; controller receipt missing | Native acceptance is authoritative | `[ ]` Derive the receipt from the accepted submission and bindings; never resubmit or reset allowance. |
| Adapter execution-start durable record present; no terminal/publication | Adapter may be live or have partial effects | `[ ]` Reconcile original ownership and private staging; mark uncertain and block continuation when unresolved. |
| Native start durable; terminal missing | Child may be live or interrupted | `[ ]` Apply existing ownership/reconciliation rules; never infer exit from a missing terminal. |
| Immutable publication verified; receipt missing | Output is authoritative by manifest | `[ ]` Recover the same output reference after cleanup verification; publish no duplicate and account once. |
| Terminal/receipt appended; notification missing or repeated | Durable terminal known | `[ ]` Replay the original fact/identity; notification loss or duplication changes no result, receipt, or usage. |
| Ambiguous persistence or cleanup | Authority unresolved | `[ ]` Poison admission, preserve bounded evidence, and require explicit repair; do not replay uncertain effects. |

## Required latency and authority fields

The deterministic fixture must report these exact issue metrics separately:

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

- [ ] Multiple independent submissions fill multiple free slots, with one shared
  accepted-child allowance that survives activation changes.
- [ ] Every response kind atomically consumes its exact input page; native facts
  appended during planning remain pending, without invalidating the decision CAS.
- [ ] Inline durable request bytes reproduce action fingerprints after a crash;
  duplicate IDs within one plan fail before any effect.
- [ ] Cross-lane actions are independent; same-lane last-slot contention is FIFO;
  finite decision/action/outstanding-intent budgets bound synthetic receipt loops.
- [ ] Closed activation callbacks cannot publish/admit; owned cleanup terminals
  remain appendable during closing, before ownership transfers.
- [ ] Finish uses a reversible gate; typed machine-rejection and guard-retry facts
  permit a new decision; unsupported steering cannot silently defer finish.
- [ ] The run cost cap while the planner runs or waits forces host closure via
  a typed host-only signal before seam validation and a reducer-fed end without
  a fabricated planner capture, preserving abort/cleanup-failure precedence.
- [ ] Repair records resolve original ownership without mutating receipts or
  asserting success; the old poisoned activation never reopens.
- [ ] Revocation blocks new execution without substituting current configuration;
  mixed legacy/controller scopes and transcript consumers preserve provenance.

Focused scheduling acceptance uses deterministic fixtures. `pnpm typecheck`, build,
tests, lint, formatting, audit, and the rebuilt CLI/example check are later
integration gates described by the implementation plan; none is claimed as run
by this document.
