# Issue #68 — bounded structured role-turn telemetry

**Status:** Actionable draft — implementation may proceed without a separate overseer acknowledgement.

## 1. Objective, evidence, and scope

Add an additive `role_turn` producer record for the readable content of each
completed assistant message in a conductor role session. The record lets an
analytics or observability consumer answer, in durable order, *which role said
what readable text or readable thinking in which logical invocation and Pi
conversation*, without treating Pi's session JSONL as analytics payload.

### Evidence used for this draft

- `AGENTS.md` and `docs/archive/orchestrator-fsm-spec.md`, especially the
  single-active-role, pure reducer, snapshot-append, lifecycle, cost, and
  resume invariants.
- `docs/record-emitter-spec.md`: `Host.persistRecord` is the append-and-notify
  seam; notification is best-effort and strictly follows durable append.
- `docs/issue-63-trajectory-handoffs/spec.md`: a logical role invocation is
  distinct from a physical Pi conversation; trajectory successors share a
  conversation/file but receive a distinct logical role-session identity.
- Current `src/host/session-event-handler.ts`, `display-sink.ts`, persistence
  union/materializer, `FileRecordLog`, `ProductionHost`, `StubHost`, shared
  SDK spawn, isolated RPC spawn, `RoleSession`, loop, resume, and their focused
  display, fallback, trajectory, persistence, emitter, shared, and isolated
  spawn tests.

The provided unauthenticated Forgejo issue API lookup previously returned HTTP
404, and no authenticated/local cached Issue #68 body was available in this
checkout. Therefore the task statement (“Persist bounded structured role-turn
telemetry”) and its explicit requirements are the operative issue text for
this draft. This is an explicit assumption for implementation; if the actual
Forgejo body appears later and conflicts with this contract, reconcile it in a
follow-up remediation.

### Existing retained telemetry

There is no retained assistant role-turn content today. `run_context` retains
the accepted original prompt, and `file_mutation` retains successful `write` /
`edit` metadata. Lifecycle, transitions, cost, workspace, child, and
trajectory records have their existing meanings. Pi's per-session JSONL is the
system of record for the full native conversation.

### In scope

- One strict, versioned, append-only `role_turn` record type.
- Bounded extraction of typed assistant `text` and readable, non-redacted
  assistant `thinking` content at `message_end`.
- A host-owned producer state that enforces the limits in §5 and routes each
  record through `Host.persistRecord` in shared SDK, isolated RPC, and stub
  paths.
- Record-log materialization, file-log recognition, record-emitter coverage,
  historical-log compatibility, and focused tests.

### Out of scope

- Changing `reduce`, `reduceLifecycle`, `Checkpoint`, `MachineDefinition`,
  manifest syntax/defaults, the FSM topology/concurrency model, lifecycle
  ordering, cost/cap accounting, handoff semantics, or resume policy.
- Reading, copying, parsing, embedding, hashing, uploading, or summarizing a
  whole Pi JSONL transcript by default. `session_file` remains only an existing
  physical-file identity/pointer.
- Raw tool arguments, raw tool results, tool-call payloads, handoff payloads,
  provider error bodies, stack traces, signatures, or model chain-of-thought
  reconstruction.
- Tool summaries in v1. No concrete v1 consumer need was supplied that would
  justify their retention or the additional intelligibility/safety contract.
  In particular, the display-layer tool summary is **not** reused by this
  telemetry record.
- Delegated subagent turns. A delegated child is not a conductor `RoleSession`;
  its existing child lifecycle/projection contract remains separate. Adding
  child-turn telemetry would require a separately scoped, bounded producer
  contract rather than silently extending parent-role records.

## 2. Terms and invariants

| Term | Meaning in this contract |
| --- | --- |
| **logical role invocation** | One host `RoleSession`, identified by `role_session_id`. It is `RoleSession.sessionId`; it may equal the native conversation ID for a fresh session, but is distinct by meaning. |
| **physical conversation** | The Pi conversation identity, `conversation_id`. It is `RoleSession.conversationId` when supplied; otherwise the child/native `RoleSession.sessionId`. It is required on every new `role_turn`. |
| **physical session file** | The non-empty `RoleSession.sessionFile` string, copied verbatim as `session_file`. It identifies the Pi JSONL file but does not cause that file to be read or retained in the record. |
| **trajectory continuation** | An Issue #63 accepted handoff that creates a new logical role invocation while retaining the same `conversation_id` and `session_file`. |
| **assistant turn** | One `AgentSessionEvent` of type `message_end` whose message role is `assistant`. It is not a streamed chunk, a tool event, or a machine handoff. |
| **sequence** | A positive, gap-free sequence among durable `role_turn` records for one `run_id`. It starts at 1, is not a timestamp or JSONL line number, and is the authoritative order when timestamps tie. |

The producer is host-side only. It must not affect the reducer, inspect an
emission capture, alter a prompt, make a routing decision, or invoke a tool.
The FSM remains single-active-role; the run-scoped sequence is therefore
serialized by the existing host loop/persistence ownership, not by a new lock
or concurrency mechanism.

## 3. Versioned record contract

### 3.1 Type shape

The v1 persisted union gains this exact discriminated record. Names are
snake_case to match the existing persisted-log convention.

```ts
type RoleTurnBlock =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly original_utf8_bytes: number;
      readonly original_characters: number;
      readonly truncated: boolean;
      readonly truncated_by: readonly RoleTurnLimitScope[];
    }
  | {
      readonly kind: "thinking";
      readonly text: string;
      readonly original_utf8_bytes: number;
      readonly original_characters: number;
      readonly truncated: boolean;
      readonly truncated_by: readonly RoleTurnLimitScope[];
    };

type RoleTurnLimitScope = "block" | "turn" | "session" | "run";

type RoleTurnMeasure = {
  /** UTF-8 bytes, measured as §5.2 specifies. */
  readonly utf8_bytes: number;
  /** Unicode code points, not UTF-16 code units or grapheme clusters. */
  readonly characters: number;
  /** Number of capture-eligible structured blocks. */
  readonly blocks: number;
};

type RoleTurnTelemetryLimits = {
  readonly max_block_utf8_bytes: number;
  readonly max_turn_utf8_bytes: number;
  readonly max_turn_blocks: number;
  readonly max_session_utf8_bytes: number;
  readonly max_session_turns: number;
  readonly max_run_utf8_bytes: number;
  readonly max_run_turns: number;
};

type RoleTurnCapture = {
  /** Full resolved limits used for this record; never inferred from defaults. */
  readonly limits: RoleTurnTelemetryLimits;
  /** Eligible readable input only; it excludes redacted/unsupported blocks. */
  readonly source: RoleTurnMeasure;
  /** What this record actually retains in `blocks`. */
  readonly captured: RoleTurnMeasure;
  /** `source - captured`; `blocks` counts only wholly absent source blocks. */
  readonly omitted: RoleTurnMeasure;
  /** Scopes that actually removed bytes or whole readable blocks in this turn. */
  readonly limit_causes: readonly RoleTurnLimitScope[];
  /** Limits at which the committed record leaves the named counter full. */
  readonly saturated: readonly (
    | "block"
    | "turn"
    | "session_bytes"
    | "session_turns"
    | "run_bytes"
    | "run_turns"
  )[];
};

interface RoleTurnRecord {
  readonly type: "role_turn";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly role: Role;
  /** Host logical invocation identity; required even when it equals conversation_id. */
  readonly role_session_id: string;
  /** Native Pi conversation identity; required even for non-trajectory sessions. */
  readonly conversation_id: string;
  /** Physical Pi session-file identity; a pointer only, never transcript content. */
  readonly session_file: string;
  /** 1-based, run-scoped, durable role_turn order. */
  readonly sequence: number;
  /** Host receipt/persistence-wall-clock time in Unix epoch milliseconds. */
  readonly ts: number;
  /** Ordered, bounded readable content. */
  readonly blocks: readonly RoleTurnBlock[];
  readonly capture: RoleTurnCapture;
}
```

All strings used as identities must be non-empty. `sequence`, `ts`, every
limit, and every metric must be finite, non-negative safe integers, with
`sequence >= 1`; all configured maxima are positive safe integers. The v1
runtime validator must reject unknown top-level, block, capture, limit, and
measure keys so a cast cannot smuggle raw provider/tool data into an append-only
log. It must also reject duplicate or out-of-order values in every ordered
metadata array. Their canonical orders are `block, turn, session, run` for
`truncated_by` / `limit_causes`, and `block, turn, session_bytes,
session_turns, run_bytes, run_turns` for `saturated`.

`ts` is the host clock when it receives the completed assistant message; it is
not a provider timestamp and must not be used to order records. The record has
no model name, provider error text, usage, tool field, raw transcript fragment,
or provider signature. Existing lifecycle records remain the source of model,
usage, and terminal-failure facts.

### 3.2 Identity rules

1. `run_id` is the host run ID and `role` is the role bound to the live
   `RoleSession` event subscription.
2. `role_session_id` is the host role-session identity (`session.sessionId`).
   It identifies the logical invocation, including a same-model retry or
   model-fallback attempt. It is not a visit index.
3. `conversation_id` is `session.conversationId ?? session.sessionId`. This
   makes the physical identity explicit in all three spawn paths, including
   the current isolated RPC adapter that exposes the child-native session ID
   but not a separate `conversationId` property.
4. `session_file` is `session.sessionFile`, not a synthesized lifecycle
   sentinel. A `role_turn` cannot be synthesized for a failed spawn because
   no assistant message and no physical session exist.
5. Fresh sessions commonly have equal logical and physical IDs. That equality
   is not a semantic shortcut for consumers. On a trajectory continuation,
   the successor has a new `role_session_id` but the predecessor's
   `conversation_id` and `session_file`.
6. A run-scoped telemetry ledger initializes `sequence` from the durable v1
   `role_turn` append stream and appends the next value. It must reject
   duplicate, non-positive, or non-contiguous prior v1 sequences as a typed
   telemetry-log error rather than guess an order. It must also reject a reused
   `role_session_id` whose role, conversation, or session file changes across
   records. A historical run with no `role_turn` starts at 1.

## 4. Content selection and privacy contract

### 4.1 Ordered block mapping

For every eligible assistant `message_end`, inspect its structured
`message.content` array in order. Do **not** call the display formatter:
`extractAssistantText` merges text and transforms thinking to Markdown
blockquotes, which would lose this record's typed block structure.

| Source content part | v1 `blocks` result |
| --- | --- |
| `{ type: "text", text: string }` | One `{ kind: "text", text }` candidate in the same relative order. An empty string remains a candidate block. |
| `{ type: "thinking", thinking: non-empty string, redacted: false/absent }` | One `{ kind: "thinking", text: thinking }` candidate in the same relative order. No Markdown quoting, labels, or normalization are applied. |
| Non-redacted thinking with empty/non-string `thinking` | Omit it: it is not readable content. |
| `{ type: "thinking", redacted: true, ... }` | Omit it completely under §4.2. |
| Tool call/use, tool result, image, reasoning-signature, unknown, or malformed part | Omit it; it has no v1 representation or summary. |

The output array preserves the order **among retained typed blocks**. It has no
original content index, placeholder, gap marker, tool marker, or block count
for omitted non-capture types. Adjacent text blocks are not merged.

An assistant message containing no capture-eligible content still emits a
normal `role_turn` (subject only to the record-count limits in §5.4) with
`blocks: []` and zero source/captured/omitted measures. A message whose only
eligible text block is `""` emits that empty text block, with zero byte and
character counts. This distinguishes an explicitly empty text part from a
message with no readable capture-eligible parts without inventing content.

### 4.2 Redacted-thinking absolute exclusion

If `ThinkingContent.redacted` is true, v1 must retain **nothing** derived from
that part. Specifically, it must not retain the thinking text, an empty
thinking placeholder, `redacted`, `thinkingSignature`, a signature hash,
original index, byte/character count, count of redacted blocks, an omission
reason, or any inferred reconstruction. Redacted parts do not contribute to
`source`, `captured`, `omitted`, `limit_causes`, or `saturated`.

This is intentionally stronger than “show an empty redacted block.” A consumer
must be unable to mistake a redacted block for readable thought or infer its
length/signature from a v1 record.

### 4.3 Provider/model failures and retries

- If Pi emits an assistant `message_end` with `stopReason: "error"`, emit the
  bounded `role_turn` from any eligible readable content exactly as for a
  non-error assistant message. Do not retain `errorMessage`, a provider body,
  an exception, a stack, or an error-specific synthetic block. The existing
  handler then retains its current `model_error` classification and the loop
  retains its existing `session_failed` / retry behavior.
- If a provider/model failure produces no assistant `message_end`, emit no
  `role_turn`; do not fabricate an empty turn. The existing terminal lifecycle
  record remains the evidence of that failure.
- A provider-model same-model retry and a model fallback each spawn a fresh
  physical role session under current behavior. Their records have a new
  `role_session_id`, their own session counters, and the next run sequence.
  The existing common `visit_index`, `model_retry`, `model_fallback`, usage,
  and cost semantics do not change. A spawn failure has no physical session or
  assistant end event and therefore creates no synthetic `role_turn`.
- A non-model retry that re-prompts the live session after an emission breach or
  `transition_rejected` is not a new invocation: it retains its existing
  `role_session_id`, conversation/file, and logical-session counters. Each new
  assistant `message_end` from that live session is considered independently.
- A trajectory continuation has a new logical role-session counter but keeps
  its physical conversation/file identity. Resume reconstructs counters from
  durable `role_turn` records and observes only new live `message_end` events;
  it must never reread the Pi JSONL to backfill or duplicate predecessor turns.

## 5. Bounds, measurements, truncation, and counters

### 5.1 Defaults and host-only configuration

V1 is enabled by default. It uses this fully resolved limit set:

| Scope | Default |
| --- | ---: |
| One readable block | 8,192 UTF-8 bytes (8 KiB) |
| One assistant turn | 32,768 UTF-8 bytes (32 KiB) and 64 retained blocks |
| One logical role session | 262,144 UTF-8 bytes (256 KiB) and 128 persisted `role_turn` records |
| One run | 1,048,576 UTF-8 bytes (1 MiB) and 512 persisted `role_turn` records |

The proposed configuration seam is a host-constructor/factory option, not a
manifest field and not a manifest default:

```ts
interface RoleTurnTelemetryOptions {
  readonly enabled?: boolean; // default true
  readonly limits?: Partial<RoleTurnTelemetryLimits>;
}
```

A partial configuration overlays the defaults and is resolved before a host
subscribes to a role session. `enabled: false` produces no new `role_turn`
records and changes no other behavior. Every provided limit must be a positive
safe integer. The resolved configuration must satisfy:

```text
max_block_utf8_bytes <= max_turn_utf8_bytes
max_turn_utf8_bytes <= max_session_utf8_bytes <= max_run_utf8_bytes
max_session_turns <= max_run_turns
max_turn_blocks >= 1
```

Each persisted record repeats the full `capture.limits`, making its retention
bounds self-describing. On resume, if prior v1 telemetry exists, the supplied
resolved limits must exactly equal the prior run's limits; a mismatch is a
named configuration error before any role session is spawned or prompted. This
avoids silently changing a run's retention policy. A historical run, or a run
that has not yet produced a `role_turn`, has no v1 limits to compare and uses
the current explicit/default configuration for its first record.

### 5.2 Measurements

- **Bytes:** `utf8_bytes` is `new TextEncoder().encode(value).byteLength`.
  All byte limits apply to retained readable `text`/`thinking` strings only,
  never JSON framing, metadata, paths, signatures, or omitted redacted data.
- **Characters:** `characters` is the count of Unicode code points
  (`Array.from(value).length`). It is informational only; v1 does not impose a
  separate character limit. It is not UTF-16 `string.length` and not grapheme
  cluster count.
- **Prefixing:** a truncation prefix is the longest original-order sequence of
  whole Unicode code points whose UTF-8 length fits the applicable remaining
  byte allowance. A surrogate pair/code point is never split. No whitespace
  normalization, redaction, Markdown transformation, ellipsis, or synthetic
  truncation text is added.
- **Measures:** `capture.source` counts only candidates permitted by §4.1,
  before limits. `capture.captured` is computed from the serialized `blocks`.
  `capture.omitted.utf8_bytes` and `.characters` equal source minus captured.
  `capture.omitted.blocks` counts source blocks that are wholly absent; a
  retained prefix with `truncated: true` is not a wholly absent block.
  Thus every persisted v1 record must satisfy, independently for bytes,
  characters, and blocks:

  ```text
  source = captured + omitted
  captured.blocks = blocks.length
  ```

  For an untruncated block, its `original_*` measures equal the retained
  string's measures. For a truncated block they are both strictly greater than
  the retained measures. `source.utf8_bytes` and `source.characters` must each
  be at least the sum of the corresponding original measures on retained
  blocks. These rules make the retained representation and its arithmetic
  independently checkable; they do not authorize reconstruction of any omitted
  string.

### 5.3 Deterministic limit application

For each candidate in original order, first apply the retained-block limit,
then calculate four byte allowances: the configured block maximum, remaining
turn bytes, remaining logical-session bytes, and remaining run bytes. The
effective byte allowance is their minimum. This order is also the exact
limit-cause algorithm:

1. A candidate with an empty text value consumes no byte allowance but does
   consume one retained-block slot if it is retained.
2. If the turn has no retained-block slot, omit the candidate (including an
   empty one), add its full measures to `omitted`, and add only `turn` to
   `limit_causes`. Do not evaluate byte allowances for that candidate.
3. Otherwise, for a non-empty candidate whose full byte length is greater than
   the effective allowance, the responsible scopes are every byte scope tied
   for that minimum, in canonical scope order. If at least one complete code
   point fits, retain the longest fitting prefix, set `truncated: true`, set
   that block's `truncated_by` to those scopes, and union them into the record's
   `limit_causes`.
4. If no complete code point fits, omit that whole non-empty candidate, add its
   full measures and one omitted block, and union those same responsible scopes
   into `limit_causes`. Continue with later candidates; a later smaller block
   can fit without changing source order.
5. If the full candidate fits, retain it unchanged with `truncated: false` and
   `truncated_by: []`. A limit that is merely reached is not a cause: a cause
   exists only where bytes or a source block were removed.
6. A full session/run byte budget does not itself suppress the next allowed
   record: it may be emitted with no retained readable bytes and precise
   omission metadata until its record-count quota is reached. Empty candidates
   still retain when a turn-block slot remains, because no readable byte was
   removed.

Therefore `truncated_by` is non-empty if and only if its block is truncated;
`limit_causes` is the sorted, de-duplicated union of actual removals, not a
list of limits that happened to be full. `capture.saturated` is separately the
sorted set of every named post-append boundary that equals its maximum:
`block` when any retained block has exactly `max_block_utf8_bytes`; `turn` when
captured turn bytes or retained turn blocks exactly reaches its maximum;
`session_bytes` / `run_bytes` when their cumulative captured bytes equal their
maximum; and `session_turns` / `run_turns` when the successful append reaches
its record quota. A byte boundary already full before an allowed later
metadata-only record remains present in that later record's `saturated` set.
Saturation alone is not an omission claim.

### 5.4 Record-count counters after a limit is reached

Byte limits bound content, while the following counters prevent unlimited
empty/metadata-only records:

- `session_turns` starts at zero for each `role_session_id`, increments only
  after a successful durable `role_turn` append for that logical invocation,
  and never exceeds 128 (or the configured limit). A new trajectory target or
  fresh retry has a new logical ID and starts at zero even if it shares a
  physical conversation/file.
- `run_turns` starts at zero for the run, increments only after a successful
  durable append, and never exceeds 512 (or the configured limit). It does not
  reset for role changes, retries, trajectory continuations, or resume.
- When a record brings either counter to its maximum, its `saturated` array
  records `session_turns` and/or `run_turns`. That is the durable prospective
  marker that later turns in that scope are intentionally not retained.
- Before constructing a new record, a full `run_turns` counter suppresses all
  future v1 `role_turn` records in that run. A full `session_turns` counter
  suppresses future records only for that logical invocation. No sequence is
  allocated, no byte counter changes, no emitter notification occurs, and no
  synthetic aggregate/update record is appended for suppressed events.

The final allowed record is the only possible durable signal after a
record-count quota becomes full; append-only records cannot be revised later to
report an unbounded suppressed-turn count. Consumers must treat the relevant
`saturated` marker as an explicit coverage boundary, not as proof that no later
assistant activity occurred.

### 5.5 Append, counter, and failure ordering

For an eligible event that is not record-count suppressed, the producer builds
the record with the current next sequence, calls `Host.persistRecord(record)`,
and increments run/session **captured** bytes, run/session turns, and next
sequence **only if that call returns successfully**. Source, omitted, redacted,
and JSON framing bytes never consume a capture counter. A failure to append
leaves the producer counters and sequence unchanged, sends no emitter
notification, and propagates as the existing host persistence failure; it must
not silently drop telemetry.

Because both host implementations perform `log.append(record)` before
`notifyListeners(record)`, a subscriber observes a `role_turn` only after it
is durable. A `message_end` record is appended synchronously during the
existing event handler, before `prompt()` settles and before the loop appends
that turn's terminal lifecycle/transition result. This adds no new ordering for
existing records and does not make the emitter reliable: consumers still use
the JSONL log as the backstop.

## 6. Producer integration contract

`attachSessionEventHandler` gains an optional narrow telemetry callback/context
alongside the existing optional file-mutation callback. The handler must invoke
it exactly once for each eligible assistant `message_end`, after confirming the
message role and before its current early returns for cost-cap or
`stopReason: "error"`. It must not invoke it for `message_start`,
`message_update`, user/tool-result messages, or tool execution events.

The context supplies only trusted host data:

```ts
{
  runId,
  role,
  roleSessionId,
  conversationId,
  sessionFile,
  persist(record: RoleTurnRecord): void,
}
```

A run-owned producer/ledger constructs bounded records and owns sequences and
counter reconstruction. Session event handlers must not each invent a separate
run sequence or directly call `RecordLog.append`. Exactly one telemetry
subscription is active for each live logical invocation; a trajectory
continuation detaches the source subscription before attaching the target one.
The producer never replays native messages, hashes content to deduplicate it,
or reads a session JSONL to synthesize a missing turn.

Required wiring:

1. **Shared SDK production spawn:** pass the producer context for its initial
   role session. In `continueTrajectory`, detach the source listener as today,
   then bind a new context for the new target `role_session_id` while retaining
   the same native `conversation_id`/`session_file`.
2. **Isolated worktree/copy RPC spawn:** pass the same host producer context to
   its existing `attachSessionEventHandler` subscription. Its native child
   session ID supplies the fallback physical conversation identity.
3. **Stub spawn:** pass the same context so deterministic CI paths exercise the
   actual producer and emitter ordering rather than a test-only shortcut.
4. **Host persistence:** both `ProductionHost.persistRecord` and
   `StubHost.persistRecord` remain the sole writer/notify seam. Direct
   `log.append` callers remain outside live-emitter scope exactly as documented
   in `docs/record-emitter-spec.md`.

No telemetry producer may call `reduce`, `reduceLifecycle`, `session.abort`,
`prompt`, `dispose`, `compact`, a handoff tool, or a cost roll-up. It must not
change the current early model-error/cost-cap classification or display sink
behavior.

## 7. Persistence, emitter, historical logs, and resume

1. Add `RoleTurnRecord` to `PersistedRecord`; add `"role_turn"` to the
   file-log recognized discriminants; and validate v1 record shape/limits at
   both in-memory/file materialization and file-read boundaries. The validator
   recomputes retained string measures, checks the §5.2 arithmetic and block
   invariants, exact keys, canonical metadata-array order, positive identities,
   and schema version. Bad v1 data is a typed persistence/telemetry-log error,
   not a loose cast.
2. `role_turn` is append-only and ignored by `latestCheckpoint`,
   `latestRunSeed`, the FSM, run-memory construction, lifecycle reconciliation,
   cost roll-ups, and trajectory selection. It is consumer observability data
   only.
3. Add `role_turn` to the record-emitter contract as another record that every
   host-owned `persistRecord` call can publish after durable append. Preserve
   listener FIFO, fire-and-forget behavior, and throw/rejection isolation.
4. Logs written before this feature lack the new discriminant and remain
   readable with no migration/backfill. On a historical resume, the first live
   captured record has `sequence: 1`; no old Pi JSONL or display history is
   mined to create earlier records.
5. On a v1 resume, rebuild the run/session captured-byte and record-count
   counters from validated durable `role_turn` records in append order; do not
   reuse in-memory counters from a dead host. The rebuild verifies one resolved
   limit set for the run, contiguous sequences, immutable identity per logical
   session, counters no greater than their limits, and the exact prospective
   `saturated` state on each record. A mismatch is a typed telemetry-log or
   configuration error before any role session is spawned or prompted. A
   trajectory reopen does not duplicate historical assistant messages because
   no transcript replay is part of this producer.
6. A record-emitter consumer that misses notifications recovers by walking the
   run log. It must use `(run_id, sequence)` as its v1 role-turn watermark,
   while retaining its existing record-type filtering for all other records.

## 8. Explicit compatibility and preservation requirements

- Existing `run_context` and `file_mutation` producer behavior is unchanged.
- Existing `session_started`, `session_ended`, `session_failed`,
  `model_retry`, `model_fallback`, trajectory, artifact, child, transition,
  checkpoint, cost, and resume records preserve their schemas and order except
  that new `role_turn` records may appear at assistant `message_end` positions.
- The current model-error retry/fallback policy, trajectory no-fresh-fallback
  rule, compaction policy, lifecycle terminal choices, run-cost cap behavior,
  and FSM single-owner rule remain unchanged.
- No default manifest, README, dependency, production behavior unrelated to
  the producer, test fixture default, or raw-transcript retention setting is
  changed by this issue.
- V1 intentionally has no tool-summary schema. A future version may add one
  only after documenting a concrete consumer, a bounded per-summary and
  per-turn/session/run limit, a typed source, and a testable intelligibility
  rule (for example, enough non-sensitive fields for a user to identify the
  operation without tool arguments/results). It must never silently reuse raw
  results or current display strings as a substitute for that contract.

## 9. Test-first acceptance and verification matrix

Implementation must add focused tests before wiring each slice. Existing tests
remain regression tests; no test may be weakened to accommodate telemetry.

| Area | Required focused proof |
| --- | --- |
| Strict persistence contract | A valid v1 record round-trips through `InMemoryRecordLog` and `FileRecordLog`; unknown/missing fields, unsupported schema version, non-canonical metadata arrays, invalid measures/arithmetic/limits, invalid sequence, and extra raw-data keys are rejected before retention/read. Historical records without `role_turn` still read. |
| Ordered block mapping | A real handler `message_end` with text → readable thinking → text persists exactly three typed blocks in that order, without Markdown quoting/merging. Empty message produces `[]`; empty text produces one empty text block; tool/unknown blocks produce no v1 block. |
| Redaction/privacy | Mixed readable and redacted thinking proves readable blocks remain while the persisted JSON contains neither signature, `redacted`, placeholder, original position, inferred size/count, nor hidden content. Raw tool args/results and tool summary strings are absent. |
| Unicode and metadata | A multi-byte/code-point fixture proves UTF-8 measurement, code-point character count, whole-code-point prefix truncation, original block measures, aggregate source/captured/omitted arithmetic, causes, and no synthetic ellipsis. |
| Every bound | Table-driven block, turn-byte, turn-block, session-byte, run-byte, session-turn, and run-turn cases prove default values and a non-default valid configuration. It must prove tied byte-limit causes, block-slot precedence, the final quota record's `saturated`, byte-saturated records' precise omission metadata, and that later count-suppressed events allocate neither sequence nor emitter event. |
| Error/retry | An assistant `message_end` with `stopReason: "error"` yields one bounded record with no error body, followed by the unchanged `session_failed(model_error)`. A failure without assistant end yields none. Same-model retry and fallback get distinct logical/physical fresh identities, reset session counters, and continuous run sequence without changing visit/cost/lifecycle assertions; an in-session machine-emission retry retains its logical/physical identity and session counter. |
| Shared, stub, isolated | Production shared SDK, `StubHost`, and isolated RPC spawn each emit through the same handler/producer/persist seam with run, role, logical ID, physical ID/file, and sequence present. |
| Trajectory and resume | A trajectory chain has distinct `role_session_id`s but shared `conversation_id`/`session_file`, fresh per-logical-session counters, and continuous run sequence. Crash/resume reconstructs counters, identities, `saturated`, next sequence, and pinned limits; it emits only new live turns and neither rereads nor duplicates Pi JSONL history. Fresh historical resume remains unchanged. |
| Durable-before-notify | A `subscribeToRecords` listener sees a `role_turn` only after an equality check finds it in the log. It sees the same object/order exactly once; listener failure remains isolated. Direct `log.append` remains outside emitter scope. |
| Non-regression | Existing display, fallback, cost, lifecycle, resume, trajectory, record-emitter, shared-spawn, isolated-RPC, grep-guard, typecheck, build, lint, format, and audit suites remain green. Assert role-turn records do not alter checkpoint, reducer result, lifecycle fields, cost roll-up, or emitted display events. |

Required implementation verification commands:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm audit
```

## 10. Proposed implementation boundaries

The expected implementation surface is deliberately narrow:

- A new host-owned role-turn producer/ledger module and its focused tests.
- `src/host/session-event-handler.ts` for the one `message_end` callback.
- `src/host/shared-sdk-role-spawn.ts`, `src/host/isolated-role-spawn.ts`, and
  `src/host/stub-host.ts` only to supply the trusted producer context.
- `src/persistence/log.ts`, `src/persistence/record-materialization.ts`, and
  `src/host/log-file.ts` for the additive union, strict validation, and
  recognized JSONL type.
- `docs/record-emitter-spec.md` and its focused tests for the additive emitter
  consequence.

It must not modify the pure core reducer/types, manifest defaults, README,
dependencies, production policy, or unrelated tests. Exact implementation file
selection is left to the implementer within those boundaries.

## 11. Risks and mitigations

| Risk | Required mitigation |
| --- | --- |
| Accidental chain-of-thought/signature retention | §4.2 complete omission; strict schema; redaction fixture scans serialized JSON. |
| Raw tool/transcript retention | §1/§4 exclude tool events/results and JSONL reads; v1 has no tool summaries. |
| Identity collapse across trajectory/retry | Required logical, conversation, and file fields plus trajectory/retry matrix. |
| Unbounded content or empty-turn metadata | Four byte scopes plus turn/session/run block/record quotas and saturation semantics. |
| Timestamp ties or resume duplication | Durable contiguous `sequence`, rebuild from log, and no transcript backfill. |
| Notify-before-append or best-effort loss mistaken as durability | All writes use `Host.persistRecord`; emitter proof verifies append precedes notification; log remains backstop. |
| Lifecycle/cost/FSM drift | Producer has no reducer/lifecycle/cost calls and non-regression tests compare existing behavior. |

## 12. Changed files, assumptions, and implementation readiness

### Changed by this draft

- `docs/issue-68-role-turn-telemetry/spec.md` — new draft specification only.

No production code, tests, manifest defaults, dependencies, or README files
were changed by this draft.

### Assumptions carried into implementation

1. The actual authenticated Forgejo Issue #68 body was unavailable. The task
   statement is sufficient authority for this implementation pass; if the issue
   body appears later and conflicts with this spec, reconcile it through a
   bounded remediation.
2. The privacy decision is to retain only **readable non-redacted** thinking,
   while omitting every redacted-thinking trace/signature/metric and every raw
   tool result/transcript.
3. The enabled-by-default, host-only bounds are 8 KiB block, 32 KiB/64-block
   turn, 256 KiB/128-record logical session, and 1 MiB/512-record run; resume
   rejects mid-run resolved-limit changes before spawning or prompting.
4. Tool summaries are omitted in v1 because no bounded, intelligible consumer
   need has been demonstrated.
5. Record-count saturation behavior: the final allowed record marks the quota
   full, and later turns in that scope produce no additional `role_turn` record
   or mutable suppression total.
6. Accounting and cause rules: source contains only eligible readable blocks;
   `omitted.blocks` counts only whole absent blocks; tied smallest byte
   allowances are all causes; a full turn-block quota takes precedence; and a
   merely reached limit is `saturated`, not an omission cause.
7. Identity and recovery rule: provider model retries/fallbacks receive new
   logical and physical identities, in-session emission retries do not,
   trajectory successors share only physical identity, and resume rejects a
   malformed telemetry stream or changed resolved limits before spawning or
   prompting.

**Implementation may proceed.** These assumptions must be listed in the final
handoff so the overseer can request remediation after reviewing the integrated
result.
