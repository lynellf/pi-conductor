# Durable repository controller (#115)

Status: implemented and verified. The overseer approved this scope and requested
Terra/Luna/Sol implementation without further approval prompts. See the plan and
verification evidence for completed gates.

Authority: the FSM spec §§8, 11, and 12 remains authoritative. This proposal adds
an opt-in host driver and versioned persistence contracts; it does not introduce
another reducer owner. See [verification](verification.md) for acceptance evidence
and [implementation outline](plan.md) for the completed sequence.

## 1. Objective and scope decisions

A repository-owned executable should react to verified native child results,
fill available capacity, and run approved preparation/validation/bookkeeping
without a coordinator model turn. Repository code owns task selection, ordering,
semantic gates, and delivery policy. The host owns admission, identities,
persistence, execution authority, cleanup, and accounting.

Approved first-version decisions:

- Controller mode replaces the orchestrator model invocation. It supports a
  coordinator-only FSM with native delegated agents, including discovery,
  implementation, review, and exception-handling profiles. It does not introduce
  simultaneous model/controller admission ownership.
- Use a fixed-argv, sandboxed JSON executable protocol. Require an approved,
  immutable runtime bundle for the controller and each executable adapter.
  Unsupported hosts fail preflight; there is no unsandboxed fallback.
- Implement actual local adapters: repository-supplied preparation and validation
  executables may write only private action staging; the host publishes immutable
  outputs and durable bookkeeping receipts. Native delegation still provisions
  and supervises children. Canonical checkout mutation, Git promotion, and
  external writes are outside v1.
- Preserve existing end guards, costs, concurrency, cleanup, and resume gates.
  Unknown effects block automatic replay. Controller failures escalate with
  evidence; they do not silently become model turns.

These scope choices are implemented with the evidence recorded in the companion
verification document. Model-driven runs and blocking/nonblocking `delegate`
remain unchanged.

## 2. Configuration, identity, and authority

Add an optional top-level `controller` manifest object, with protocol version 1,
controller ID, registered runtime ID, fixed executable/argv, declared adapters,
and bounded execution limits. The immutable manifest snapshot pins this object.
Each adapter declares an ID, runtime ID, fixed executable/argv, input/output
schema identifiers/digests from the approved registry, and either `read_only` or
`private_staging` capability. No repository
configuration, child result, or controller response can grant approval.

Host preflight resolves those requests against operator-approved runtime and
capability registrations. Pin the approval identity, complete prepared runtime
inventory digest, executable digest, protocol version, and effective capability
digest in a durable controller-definition record before activation. Copy and
verify the complete dependency inventory using existing prepared-runtime
machinery; hashing only a mutable entry script is insufficient. Resume requires
the same pinned definition and available approved bundle. It must reject missing,
changed, or revoked authority instead of rereading current YAML as a replacement.

Controller mode rejects FSM workers, worker-dependent end-request policies,
orchestrator model/fallback/retry/context-retention settings, and an SDK
orchestrator tool list. Native child profiles, existing first-entry child model
selection, delegation limits, and ordinary end guards remain supported.
Validation must identify the
specific incompatible field. Do not require a fictitious orchestrator model to
pass existing validation.

`controller.delegation` supplies allowed profiles, accepted-child allowance,
parallelism, and context-artifact limits directly to shared native admission. It
does not require an SDK `delegate` tool. Controller submissions always use
nonblocking scheduler semantics; the legacy tool keeps its existing mode switch.
Operator approval removal or an explicit host revocation blocks new execution
in addition to checking the pinned authority; it cannot substitute a new bundle.

Keep three identities distinct:

1. Pinned controller definition: run ID, controller ID, definition digest.
2. Physical activation: a new host-owned activation ID and owner epoch on resume.
3. Logical action: `(run ID, controller ID, definition digest, action ID)`, stable
   across activations. Restarting cannot reset deduplication or child allowance.

The run lease and owner epoch fence all admission and adapter publication. Late
callbacks from a closed activation cannot append successful receipts or admit
work. Close and await owned execution before transferring ownership.

The stable native logical-parent key is the run/controller/definition tuple;
derive controller submission IDs from that key plus action ID. Activation ID is
provenance only. Replay filters by origin and stable logical parent, not merely
role name; mixed historical scopes must not import one another's tasks.

## 3. Executable protocol

Each planner invocation consumes one UTF-8 JSON request on stdin and emits exactly
one JSON response on stdout. Stderr is bounded diagnostic evidence. There is no
shell expansion, dynamic executable selection, network, credentials, or mutable
canonical checkout mount. The planner sees its read-only runtime and authorized
immutable input artifacts; it cannot create delegated agents itself.

Validate closed, versioned TypeBox schemas at both boundaries. Protocol v1 hard
ceilings: 1 MiB input/output JSON, depth 32, 1–64 actions per plan, 128 events per
page, 128-byte action IDs, 4 KiB diagnostics, and 64 KiB controller state. Default
planner deadline is 30 seconds; host-approved configuration may lower limits or
raise the deadline to at most 120 seconds. Adapter limits are separately pinned,
with the existing execution-policy deadline and cleanup rules as upper bounds.
Oversized or malformed output produces a typed failure, never partial execution.

The request contains protocol/definition/activation identity, a monotone
`state_revision`, durable event cursor, bounded event page, capacity snapshot,
previous controller state, and authorized artifact/receipt references. Native
running slots and lifetime accepted-child allowance are separate fields. Include
pending operations and a page cursor; never silently truncate state into a false
empty-work signal. Large task inputs and results use host-issued artifact refs.

Events cover startup, resume after reconciliation, verified child terminals,
capacity changes, completed actions, and rejected finish attempts. Every event
identifies its authoritative durable source. Child stdout and model prose are
data, never executable commands or synthesized control events.

The response binds the observed revision and event cursor, returns bounded opaque
controller state, and chooses either a plan of typed actions, `wait`, `finish`, or
`escalate`. Action types are:

| Action | Host behavior |
| --- | --- |
| `delegate` | Submit existing native delegation arguments through shared admission; return exact accepted arguments/bindings and child IDs. |
| `adapter` | Execute one declared local adapter with authorized immutable input refs and private staging if approved; validate and publish its result. |
| `read` | Read a bounded page/range of authorized receipts or artifact content by opaque ref; return a durable bounded result. |
| `cancel` | Cancel named owned native children through existing cancellation and cleanup paths. |

Actions in a plan cannot reference not-yet-produced outputs. Express dependencies
by consuming the durable action-completed event in a subsequent invocation.
`wait` consumes its event page and sleeps until new authoritative input arrives.
`finish` carries an ordinary seam-valid end payload. `escalate` requires a typed
reason, nonempty explanation, and evidence refs. It records an operator-visible
failure and closes owned work; there is no automatic model fallback. A repository
can instead explicitly delegate a judgment task before choosing to escalate.

## 4. Single writer, event delivery, and action admission

One host controller pump owns mutable controller state and action decisions.
Native callbacks enqueue wakeups only. Source facts retain their validated log
ordinal and record digest; notification delivery is not authority. Input pages
identify an exact durable high-water cursor. `state_revision` counts committed
controller decisions only, not concurrent native facts. New facts arriving while
a planner runs remain unconsumed for the next page, rather than invalidating
every in-flight response. Recheck live capacity and terminal gates at effects.
All response kinds, including wait/finish/escalate, atomically commit state,
consumed cursor, and decision revision. A crash before that commit redelivers
facts; a crash after it reconstructs the committed decision.

Coalesce advisory capacity wakeups; retain all unique terminal/action facts even
if delivered simultaneously, repeatedly, or out of order. Drain on event arrival
and while unconsumed pages remain. Do not poll or rerun `wait` against unchanged
state. Repeated unchanged/stale plans have a bounded three-attempt limit per
unchanged input before escalation; fresh authoritative input resets that limit.
Unrelated child failure is ordinary input unless ownership/cleanup is uncertain.
Also pin finite per-run decision/action budgets (default 10,000 each) and an
outstanding-intent ceiling (default 64). Exhaustion escalates; resume does not
reset budgets. This bounds loops that manufacture fresh IDs or read receipts.

Before a decision commit, compare its expected decision revision and input cursor
to the delivered snapshot. Reject stale responses without executing new actions.
Reject duplicate action IDs within one response before committing it. An already
known action
ID with the same canonical request returns the original receipt/status; reuse
with changed arguments is a conflict. The canonical request fingerprint includes
action kind, arguments and refs, and pinned controller/adapter authority. The
first causal revision is retained as provenance, not changed on redelivery.

Commit the controller state, consumed cursor, ordered action intents, and each
action's original revision in one append-only plan record. Include bounded
canonical action request bytes inline in that private record, sufficient to
recompute fingerprints without current YAML or mutable files. Validate referenced
immutable inputs before commit. Derived request refs address those durable bytes;
they never point to an object that will only be created later. This commits intent,
not acceptance or success. A plan is not a transaction over its effects: each
action has an independent receipt, and failure of one does not claim rollback of
earlier actions. At every effect boundary recheck ownership, shutdown, cost,
capability, and native admission gates. Already committed action intents do not
become stale merely because a sibling child later completes.

Adapters and native preparation run asynchronously outside the state writer.
All controller-origin records, including native and executable start/terminal
records, use the host's serialized append boundary with owner-epoch validation.
While settling, the owning epoch may append all authoritative terminal evidence
for already-started/accepted operations, including successful outcomes racing
closure. Permanent closure forbids new admission, publication and controller
success receipts. After epoch replacement, only recovery under the new owner
may materialize old outcomes. Validate ownership
immediately before every append, publication and admission, not just on entry.
Outcomes reenter the writer as events; they cannot block observation of
unrelated completions. Bound outstanding adapter operations separately from
native children (default one, approved maximum four). Pending intents use FIFO
per execution lane. Actions within a plan must be independent: list order is
FIFO within a lane, not cross-lane completion order. Dependent cancellation,
preparation or dispatch must await a receipt in a later decision. Native submissions
retain their existing serialized preparation/admission queue. Report that queue's
delay separately; do not promise that adding the controller removes runtime
capture or preparation cost.

## 5. Reuse native execution and preserve real provenance

Extract a typed host admission service below `delegate`'s tool rendering. Both
the existing tool and controller call the same scheduler, preparation, sandbox
verification, child spawning, cancellation, artifact, and result machinery.
`maxParallel` caps running children across submissions; `maxChildren` counts all
accepted children, including queued, failed, and cancelled children. Scope the
controller allowance to its stable logical identity across resume activations.

Introduce a discriminated durable admission origin: existing SDK tool call or
controller action. Preserve legacy schema-v1 interpretation and identities;
controller acceptance uses a new schema version with real action/activation
provenance and no fabricated `tool_call_id`. Validate mixed historical logs.
Native acceptance remains durable before children enter the runnable queue.

Executable planner/adapter ownership also needs an explicit controller-operation
origin. Existing `ToolExecutionController` assumes an SDK tool call; reuse its
supervision, sandbox lifecycle, deadline, and cleanup primitives after extracting
or generalizing that identity boundary. Do not pass an action ID off as an SDK
call. Operator reconciliation must understand both origins.

A controller-backed `RoleSession` keeps the current run loop as the only owner of
`reduce` and lifecycle changes. Its `prompt` promise represents the driver
lifetime, not a model turn. Persist a real host audit file with explicit
`session_origin: controller`, activation ID, no Pi conversation ID, and zero
model usage. Add closed origin metadata to the RoleSession contract and lifecycle
enrichment, retaining `role_session_id` even without `conversation_id` (null for
controllers). Audit consumers must not parse that file as an SDK transcript.
Controller sessions have zero retries and bypass model resolution/fallback;
controller failure uses a host terminal failure, not another provider attempt.

`finish` sets a reversible `finish_pending` gate, distinct from permanent scheduler
`close()`, and waits for all owned actions/children to
settle before writing one ordinary capture-buffer end intent. The existing seam,
reducer, and end guard decide whether it ends the run. A typed loop-to-session
notification identifies either the durable machine rejection or the guard-finished
retry record. Only then clear `finish_pending` and react with a new decision,
subject to the no-progress bound and existing guard budget. Do not parse formatted
retry prompts to infer these events. Model steering/follow-up is explicitly
unsupported in controller mode, so operator guidance cannot silently defer finish;
abort remains supported. Abort, cost-cap close, and
unconfirmed cleanup are permanent closure, never rejection-based reopening.

Native usage that exhausts the run cost cap must wake and permanently seal the
controller without invoking its planner. Add a host-only typed RoleSession
termination signal, consumed by the loop before seam validation or ordinary
prompt-failure classification. The host latches `run_cost_cap`, cancels any
running planner, and resolves the driver lifetime after known settlement. The
loop verifies owned cleanup, synthesizes `{ type: "end", authority:
"run_cost_cap" }` with its ordinary cap payload, and feeds it through `reduce`,
reusing the existing lifecycle/checkpoint ordering. It requires no capture and
must never attribute the end to repository executable output. Preserve existing
operator-abort and cleanup-failure precedence. Test both an active planner and
dormant `wait`. Other child/delegation limits retain their own policy behavior;
they must not be mislabeled as run-cost authority.

## 6. Receipts, artifacts, local adapters, and recovery

Persist action intent before any effect. A receipt has schema version, logical
action ID, activation/causal revision, request digest and private request ref,
operation kind, outcome, child/execution IDs, authorized result refs, bounded
diagnostic code/reason, and phase timestamps. Distinguish `pending`, `accepted`,
`rejected`, `completed`, `failed`, `interrupted`, and `uncertain`; rejection must
not imply that an earlier preparation effect was undone.

The durable native submission is the acceptance authority. A crash between its
append and the controller receipt is repaired by deriving the receipt from that
submission, without resubmission. Preserve both original request and exact
accepted argument/artifact bindings as immutable private artifacts. Provide
structured `getAction`, `getAcceptedSubmission`, and paged `getEvents` host APIs
and protocol `read` access. A formatted tool message or transcript scan is not
an adequate retrieval contract.

Local adapters implement repository-owned preparation/validation code in pinned
fixed executables. Read-only adapters get only authorized immutable inputs.
Staging adapters get a private per-action writable directory, never the canonical
checkout, run logs, credentials, sibling staging, or other run storage. Output
publication validates declared schema, digest, size and path containment and
rejects escaping symlinks. Host-issued immutable output refs become native task
inputs through a new explicit context-artifact source and host resolver; current
Git-file context artifacts cannot resolve private staging. Bind each ref to run,
definition, producing action/source record, digest, size, type and allowed
consumers. Requests cannot choose host paths or exceed read byte/range limits.
Recording
an accepted packet or validation receipt is a real durable host operation; no
model is needed to import it into controller state.

Write a durable execution-start record before invoking any adapter process.
Successful process cleanup does not by itself prove output validity or successful
publication. Use an atomic same-filesystem publish into immutable action-owned
storage with a content manifest bound to run/definition/action/request digest,
output schema and capability. Fsync files and manifest, fsync staging directory,
rename, then fsync the destination parent before the receipt; reject an existing
destination whose manifest differs. Verify the same bindings on recovery. Only
publish its ref in a successful receipt after validation and durable publication.
Failed or uncertain staging is retained privately for inspection, not promoted.
Public status contains IDs/digests/bounded diagnostics, not private payloads or
absolute host paths; detailed evidence remains access-controlled local data.
Retain staging with the owning run until explicit operator removal; no automatic
deletion of unresolved evidence. Start/finish evidence also covers native private
preparation and runtime capture before acceptance. Missing acceptance alone
cannot prove that preparation had no effects.

On resume acquire the run lease, reconcile existing executable ownership and
native children, reconstruct action receipts/cursors, then activate the pinned
controller and emit `resume`. Existing native reconciliation interrupts accepted
unfinished children; it never reattaches or relaunches them. Stable accepted-child
allowance and action identities survive the new activation.

| Crash boundary | Recovery rule |
| --- | --- |
| Planner start, no terminal | Block until original ownership/cleanup is resolved; then the same input may be reinvoked if no decision was committed. |
| Before durable plan/intent | No action effect is permitted; planner input may be redelivered after planner cleanup. |
| Intent, no native acceptance | Inspect preparation/capture start and terminal evidence; mark interrupted only with known cleanup/no effect, otherwise uncertain. Never automatically dispatch a committed intent on resume. |
| Native acceptance, missing receipt | Derive receipt from acceptance and reconciled child evidence; never submit again. |
| Adapter start, no terminal/publication evidence | Mark uncertain and block continuation until original ownership/partial effects are reconciled. |
| Verified immutable publication, missing receipt | Recover the same output ref from its authoritative manifest after cleanup verification. |
| Terminal/receipt, missing wakeup | Replay the durable fact with the original identity; no duplicate accounting. |
| Ambiguous persistence or cleanup | Poison admission; preserve evidence and require explicit repair. |

Extend the existing operator reconciliation path to controller operations,
showing operation/action IDs, failing operation/code, and safe ownership evidence.
Cleanup attestation alone cannot declare an adapter successful. After verified
cleanup, an unpublished interrupted operation remains failed/interrupted; an
operator can authorize a fresh action through resumed repository policy. External
writes are rejected by v1 preflight, not classified as safely replayable.

A strict append-only repair record binds original start, run, definition,
action (if any), operation and activation, with authoritative cleanup evidence
and operator attestation. It resolves ownership only; it cannot mutate receipts
or assert adapter success. Verified publication recovery is a separate outcome.
Resume remains blocked until timeline validation resolves every uncertain owner
and partial effect. A new activation then receives the durable repair/resume facts;
the poisoned prior activation never reopens. Planner replay after confirmed
cleanup is safe because the planner has no action-effect authority. Timeline
validation forbids deriving native acceptance from intent alone.

## 7. Observability and acceptance

Record child-terminal-to-controller-start, controller duration,
controller-result-to-native-acceptance, and acceptance-to-child-start separately.
Also expose adapter/preparation/runtime-capture time, accepted/running capacity,
idle-capacity intervals, and coordinator model-turn count (zero in controller
mode). On a single live host use monotonic durations; across restart report a
restart boundary/unknown duration rather than subtracting unrelated clocks.
Capacity idle with no eligible repository task is not necessarily harness delay.

The decisive test starts A and B, holds A, completes B, and proves C starts from
B's verified result before A is released with no coordinator inference. Cover
multiple free slots, duplicate/out-of-order notifications, stale plans, exact
binding retrieval, failure isolation, ownership cleanup, and every recovery row.
Include a generic executable example that prepares packets, delegates synthetic
work, validates results, records receipts, and finishes. Document migration from
manual model orchestration and which policy decisions remain repository-owned.
No paid model or external campaign is needed for acceptance.

## 8. Implementation conventions and verification commands

Use existing strict TypeScript, named exports, TypeBox `Static<>` types, and
Biome. For example, a typed internal result uses a closed discriminant rather
than a success boolean paired with optional unrelated fields:

```ts
type PlanAdmission =
  | { readonly kind: "committed"; readonly planId: string }
  | { readonly kind: "stale"; readonly currentRevision: number };
```

Place pure schemas/timeline validation in `src/persistence/` and manifest
validation in `src/manifest/`; host I/O, controller pump, runner and adapters in
small modules under `src/host/controller/`. Native execution stays in existing
host delegation/execution modules. Public exports come through `src/index.ts`.
Use focused Vitest files under `tests/`, an example under `examples/controller/`,
and this spec plus user guidance under `docs/`. No new dependency is anticipated.

Implementation gates: `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`,
`pnpm format:check`, and `pnpm audit`. Run targeted Vitest files as each contract
lands, then the complete gates once integrated. Verify the linked `conduct`
resolves this checkout's rebuilt `dist/bin/conduct.js`; run the deterministic
example through that entry point without a paid provider.

Always preserve append-before-effect, authoritative evidence, native admission,
and the host-only I/O boundary. Obtain acknowledgment before implementing this
new spec or expanding it to external writes/shared controller-model ownership.
Never grant authority from controller output, fabricate SDK provenance, replay
uncertain effects, modify original campaign logs, or claim unrun acceptance tests.
