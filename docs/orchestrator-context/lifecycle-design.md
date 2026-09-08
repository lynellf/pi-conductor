# Context lifecycle implementation decisions

This refines the acknowledged #87 contract without changing its scope. The pure
FSM and checkpoint schema remain unchanged. The context coordinator uses the
existing host-owned record log, run lease and physical-session adapters.

## Ownership and identity

The current run ID and designated orchestrator role scope all context records.
Each physical model attempt receives a fresh logical `role_session_id`; that ID
also identifies the context invocation, avoiding a second redundant identifier.
Existing `executionVisitIndex` remains the delegation-allowance identity across
model retries/fallbacks. A context epoch changes only on initial creation or an
explicit idle reset. Compaction settings are captured once before first execution
and reused across epochs and resume.

A new physical session is created for each attempt. When history exists, public
SessionManager APIs branch from an exact committed tip into a new host-owned
session file. Never mutate the source file or select a session by recency. The
new session uses the current prompt, model, thinking level, tools and policy.
History restoration must not execute old tools or emit old machine events.

## Minimal durable records

Names may follow existing repository naming conventions during implementation.
All records carry schema version, run ID, role, epoch and timestamp as applicable.

- Epoch: initial/reset reason, identity, pinned effective compaction settings.
  A reset explicitly supersedes the preceding epoch, including any unresolved
  context invocation. An empty epoch is valid even across process restart.
- Invocation selection: logical role-session ID, actual physical conversation/file,
  model attempt, and selected prior boundary (or explicit empty source). Persist
  before returning a spawned context-enabled session to the loop.
- Initial seed delivery: role-session ID, unique delivery ID, current seed hash,
  and actual delivered session/history identity. Record once after the initial
  prompt settles. Inner end-guard/rejection prompts remain in the same invocation.
- Committed boundary: role-session ID, exact physical conversation/file and SDK
  history tip plus content integrity hash. Only this record authorizes restoration.
- Compaction observation: role-session/request identity, outcome, before/after
  history reference and actual new usage or explicit unavailable-usage diagnosis.
  Historical usage never enters the invocation meter again.
- Compaction start: persist request identity and the preceding history tip before
  starting provider work. A start without an outcome is an unknown charge across
  terminal records and reset epochs. RPC children await the parent's durable ACK
  before issuing the request, and await outcome persistence before settlement.

Pure validation/query helpers reject malformed identities, invalid ordering,
duplicate conflicting deliveries, cross-run references and missing expected
boundaries. Host helpers validate actual session files and complete tool exchanges.
A file's uncommitted tail cannot replace the selected committed tip.

## Lifecycle ordering

1. Ensure a durable empty epoch exists before the first role can prompt. A failure
   during run creation before any lifecycle/context invocation exists may complete
   epoch initialization on resume; an executed run missing its epoch is corrupt.
2. Select/create the physical context, apply current authority, and persist the
   invocation-selection marker before the loop can persist `session_started`.
3. Prompt through the existing adapter; meter only new assistant and compaction
   traffic. Initial seed delivery is recorded once. Compaction errors must not be
   swallowed by an extension hook and fall through to unmetered native compaction.
4. Existing child settlement, accepted transition, artifact collection and terminal
   lifecycle records retain their order. End-guard retries do not end the context
   invocation or commit intermediate reusable boundaries.
5. Capture a valid exact history tip after tool/delegation settlement, before
   disposing the physical SDK/RPC session. Append the reusable boundary only after
   terminal persistence and confirmed disposal. Unknown process/tool cleanup or a
   failed append leaves the invocation unresolved and cannot authorize restoration.
6. A settled model-error attempt may commit a usable, fully paired history tip;
   fallback retains it and the spent logical-visit allowance. Invalid or ambiguous
   history produces an actionable error instead of silently dropping tool history.

Crash after a terminal checkpoint but before boundary append remains detectable:
the unresolved invocation marker prevents the generic resume path from treating
the run as safe merely because `active_role_session` is already null.

## Resume and reset

Acquire the existing run lease and run existing tool/end-guard/delegation recovery
checks first. Normal resume validates context provenance before generic crash
reconciliation can hide an unresolved orchestrator invocation. Restore only the
current epoch's committed boundary; a valid empty epoch starts from current run
memory. Historical absence of the context policy means `none`, including logs
without a manifest snapshot; current YAML must not retroactively enable retention.

An explicit reset is authorized by the idle lease, not by a null active-session
field: a stale active checkpoint can come from a crash. After cleanup is proven,
reconcile the crash and append the new empty epoch before host execution. Reset
may supersede a missing/corrupt context boundary, but cannot certify unresolved
tools or processes as safe. Reset while a worker is current affects the next
orchestrator invocation and preserves FSM state, visits, costs and child allowance.

## Accounting and validation

Shared sessions already meter live events rather than scanning old messages.
RPC session statistics include imported historical messages, so context-enabled
RPC sessions must isolate new invocation usage and add separately metered
compaction exactly once. Successful and failed summary requests both count;
missing usage is diagnosed explicitly and never represented as known zero.

Validate with real temporary session files, real public SDK hooks and package-local
RPC processes driven by deterministic providers. No paid provider calls or private
SDK access are required. Independent review has examined the lifecycle ordering;
the SDK/RPC metering proof remains the gate before adapter integration.

## Integration refinements

The public SDK/RPC compaction proof is now verified. Seed delivery belongs in a
retained-session prompt wrapper so it records the exact prompt, including any
host-added artifact section, and naturally covers inner retries without enlarging
the turn classifier. The loop owns the capture/dispose/commit sequence through an
optional retained-context capability on the role session. That capability uses
the existing durable boundary-reference type rather than a second identity shape.

Compaction usage enters the live invocation accumulator and its terminal usage.
An observation without a matching terminal also contributes its known usage to
persisted accounting, preserving charges across a crash. Budget readers that add
live invocation usage must exclude those same live invocations from this orphaned
observation total. Inspection, which has no live accumulator, includes them.
Unavailable usage remains an explicit diagnosis across terminal records and reset
epochs; resetting conversation history cannot establish an unknown charge.

Pinned settings must not write caller-owned Pi configuration. The ordinary RPC
CLI has no option for supplying an in-memory compaction-settings snapshot. A
context-enabled child may therefore use a small compiled bootstrap built from
the public runtime factory and `runRpcMode`, with the same trusted machine-tool
configuration and current model authority. Validate real child protocol/tool
parity before selecting this path; ordinary sessions retain their existing driver.

For retained RPC invocations, `agent_end` is not a settlement barrier: Pi emits it
before post-turn auto-compaction finishes. Wait for public `agent_settled` instead.
A trusted child extension can report the exact public session-manager tip from
its `agent_settled` hook before that event reaches the parent. Meter observations
must reach the parent before it captures terminal usage. The production parent
already subscribes to live assistant events; the RPC adapter's separate cumulative
statistics API also needs an imported-history baseline when retention is enabled.
