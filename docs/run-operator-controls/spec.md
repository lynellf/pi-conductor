# Spec: Run Operator Controls

Status: Accepted — overseer acknowledged 2026-07-18
Date: 2026-07-18
Idea source: [`docs/ideas/run-operator-controls.md`](../ideas/run-operator-controls.md)

## 1. Objective

Add operator controls that let a human or library consumer guide a live conductor run
and retrieve its latest completed role response without bypassing the FSM.

The feature has two equal surfaces:

1. The public `RunHandle` library API.
2. The pi extension commands that adapt that API to the TUI.

Success means an operator can steer an active role, queue a follow-up that survives a
role handoff, and copy the latest completed role response while the reducer remains the
sole authority for `handoff` / `end` transitions.

## 2. Confirmed Product Decisions

- Expose both steering modes: `steer` and `followUp`.
- Undelivered operator guidance follows the newly active role across a handoff.
- Copy selects the latest completed assistant response and excludes tool summaries.
- The copied response uses the same text extraction as the TUI. It therefore includes
  readable, currently displayed reasoning blocks and direct assistant text; redacted
  reasoning and tool-call blocks remain excluded.
- `RunHandle` exposes portable steering and response-retrieval capabilities.
- Clipboard access remains an extension/UI adapter concern, not a `RunHandle` method.
- MVP state is in-process. Pending guidance and latest-response state are not recovered
  after a process restart.

## 3. Source-Checked SDK Contract

Detected versions:

- `pi-conductor`: `0.10.0`
- `@earendil-works/pi-coding-agent`: `0.80.6`

The installed SDK and official source establish these behaviors:

- `AgentSession.steer(text)` queues a user message for delivery after the current
  assistant turn finishes its tool calls and before the next model call.
- `AgentSession.followUp(text)` queues a continuation after the agent otherwise stops.
- `AgentSession.clearQueue()` returns and clears remaining `steering` and `followUp`
  strings.
- `message_end` is the complete-message event already used by conductor to extract and
  display assistant text.
- `copyToClipboard(text)` is exported by the package for extension/UI use.

Official source references:

- Agent session prompting and queues:
  https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts
- Clipboard adapter:
  https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/utils/clipboard.ts

### 3.1 Deliberate `followUp` adaptation

Conductor MUST NOT forward `RunHandle.followUp()` directly to
`AgentSession.followUp()`. Native pi follow-up continues the same SDK session after it
would otherwise stop. A conductor role session is different: its first valid
`handoff` / `end` emission seals that role session and is its exit intent. Continuing
that same session can produce work after sealing or a second machine emission.

Conductor follow-up therefore means: retain the message in the run-owned mailbox until
the current role session settles, then provide it to the next role session before that
role's first model call. If the pending transition is `end`, the loop defers committing
that `end`, resets the same orchestrator session's capture/seal state, and re-prompts it
with the queued operator guidance. A user message accepted before the terminal commit
must not be silently lost.

## 4. Public API Contract

The feature is additive.

```ts
export interface RunResponse {
  readonly runId: string;
  readonly role: Role;
  readonly sessionId: string;
  readonly text: string;
  readonly completedAt: number;
}

export type RunControlErrorCode =
  | "empty_message"
  | "run_terminal"
  | "steering_unavailable";

export class RunControlError extends Error {
  readonly code: RunControlErrorCode;
}

export class RunHandle {
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  latestResponse(): RunResponse | null;
}
```

### 4.1 Input and error semantics

- `steer` and `followUp` reject text whose `trim()` is empty with
  `RunControlError("empty_message")`. Non-empty text is preserved byte-for-byte as the
  operator-authored payload.
- A call made after the run control closes throws
  `RunControlError("run_terminal")`.
- `steer` throws `RunControlError("steering_unavailable")` only when a live,
  unsealed role session is active but its host does not implement the optional steering
  capability. When no session is active during a live transition boundary, `steer`
  queues for the next active role instead.
- `latestResponse()` is a synchronous snapshot query. It returns `null` before the
  first non-empty completed assistant response and never throws because a response is
  absent.
- `RunHandle` does not expose a delivery receipt or target role. The eventual role is
  race-sensitive and exposing it would turn an implementation detail into a public
  compatibility promise.

### 4.2 Naming

- TypeScript uses SDK-consistent camel case: `followUp`.
- The slash command remains lowercase: `/conduct:followup`.

## 5. Host Architecture

### 5.1 Run-owned control object

Create one run control object per `startRun` / `resumeRun`. It owns only in-process host
state:

- Whether the control is open or terminal.
- The active role session used for abort and active steering.
- A monotonically ordered mailbox of operator-guidance envelopes.
- Active-session steering envelopes that may still need to be reclaimed at sealing.
- The latest `RunResponse` snapshot.
- The existing pending-abort state currently implemented inline in `api.ts`.

The control object does not import or call the reducer, write the run record log, select
roles, or spawn sessions. The loop remains the sole owner of reduce, persistence, and
spawning.

Guidance envelopes are internal and ordered:

```ts
interface OperatorGuidance {
  readonly id: number;
  readonly mode: "steer" | "followUp";
  readonly text: string;
}
```

### 5.2 Active `steer`

When a live, unsealed session is accepting guidance:

1. Record the internal guidance envelope.
2. Format it as an operator-guidance user message whose prefix prevents a leading `/`
   in user text from being interpreted as an SDK extension command or prompt template.
3. Delegate to the optional `RoleSession.steer` capability.
4. Keep enough envelope identity to reclaim the message if it remains in the SDK queue
   when the session seals.

If there is no addressable session, retain the original envelope in the run mailbox.

### 5.3 Follow-up

`followUp` always appends to the run mailbox. It never delegates directly to the SDK's
same-session follow-up queue. The next prompt boundary drains pending guidance in
monotonic envelope order and appends one structured operator-guidance block to that
prompt's existing seed.

The guidance formatter must preserve each original `text` field and include its mode.
It must not modify the handoff payload or run-memory object; it composes an additional
host-owned context block after the normal seed.

### 5.4 Sealing and handoff races

Extend the host-side session seam with an additive seal subscription. Production and
stub role-session wrappers expose optional capabilities:

```ts
interface RoleSession {
  steer?(text: string): Promise<void>;
  clearQueue?(): { steering: string[]; followUp: string[] };
  isSealed?(): boolean;
  subscribeSealed?(listener: () => void): () => void;
}
```

On the first valid machine emission, the existing `SessionSeam.seal()` call synchronously
notifies seal subscribers. The run control then:

1. Marks that session non-addressable for new steering.
2. Calls `clearQueue()` when available.
3. Matches still-queued conductor steering messages back to their internal envelopes.
4. Returns those undelivered envelopes to the run mailbox without changing their
   original order.

Messages already consumed by the active role are not replayed. Messages received after
sealing queue directly for the next active role. Seal notification does not alter the
capture buffer or machine state.

The loop releases the exact active-session reference rather than clearing an unqualified
global slot, preventing stale cleanup from releasing a newer session.

### 5.5 Prompt and terminal boundaries

Before each `session.prompt(seed)` call, the loop drains the current mailbox and appends
the formatted operator-guidance block to `seed`.

After a prompt settles:

- A valid `handoff` proceeds normally; guidance queued during the completed prompt is
  still in the mailbox and reaches the newly active role.
- A rejected transition or same-session recovery re-prompts the current role and drains
  the mailbox into that recovery prompt.
- A session failure leaves mailbox contents intact for the fallback/recovery role.
- A valid `end` with no pending guidance proceeds normally.
- A valid `end` with pending guidance is not reduced. The loop resets the capture buffer
  and seal flag, reopens the same orchestrator session for guidance, and re-prompts it.
  This is not an FSM transition and writes no transition record for the deferred `end`.

The run control closes in the loop completion wrapper on success, session failure,
abort, or thrown error. After closure, public steering methods throw `run_terminal`.

### 5.6 Latest response capture

The run control subscribes to each active `RoleSession` event stream. On a successful
assistant `message_end`:

1. Reuse `extractAssistantText(message)`.
2. Ignore empty extracted text and model-error messages.
3. Replace the latest snapshot with `runId`, `role`, `sessionId`, extracted `text`, and
   the message timestamp (falling back to `Date.now()` only when absent).

Tool execution events never update the snapshot. Because capture happens at
`message_end`, `latestResponse()` updates during a long-lived role session rather than
waiting for `prompt()` to resolve.

Only one response subscription is installed per spawned role session and it is removed
during session release.

## 6. Extension UX

Register three commands:

| Command | Run selection | Result |
| --- | --- | --- |
| `/conduct:steer <message>` | Active running handle only | Calls `handle.steer(message)` and notifies acceptance or a typed error. |
| `/conduct:followup <message>` | Active running handle only | Calls `handle.followUp(message)` and notifies acceptance or a typed error. |
| `/conduct:copy` | Active handle, otherwise most recently started handle in this process | Copies `latestResponse().text` with pi's `copyToClipboard`. |

The extension tracker keeps two explicit slots:

- `activeRun`: cleared at terminal completion as today.
- `mostRecentRun`: updated whenever a non-null handle becomes active and retained when
  `activeRun` clears.

Starting or resuming another run replaces `mostRecentRun`. No run history list is added.

User-visible outcomes:

- Missing command text is a warning with the command's usage.
- No active run for steering/follow-up is an informational notification.
- Accepted guidance is an informational notification naming the run ID and mode, but
  not promising a target role.
- No recent run or no completed response is an informational notification.
- Clipboard success names the response role and run ID.
- Clipboard or typed run-control failure is an error notification.

## 7. Project Structure

Expected implementation surfaces:

```text
src/host/run-control.ts               # Run mailbox, abort bridge, response snapshot, errors
src/host/run-handle.ts                # Public additive methods and response type exports
src/host/api.ts                       # Per-run control construction and completion closure
src/host/loop.ts                      # Prompt-boundary drain and deferred-end behavior
src/host/host.ts                      # Optional RoleSession steering/seal capabilities
src/host/seam.ts                      # Additive seal subscriptions
src/host/production-host.ts           # SDK steer/queue/seal wrapper wiring
src/host/stub-host.ts                 # Stub parity wiring
src/host/index.ts, src/index.ts       # Public exports
src/extension/active-run.ts           # Active + most-recent handle slots
src/extension/commands/steer.ts       # /conduct:steer handler
src/extension/commands/followup.ts    # /conduct:followup handler
src/extension/commands/copy.ts        # /conduct:copy clipboard adapter
extensions/conduct.ts                 # Command registration
tests/host/run-control.test.ts         # Mailbox, validation, sealing, response unit tests
tests/host/loop.test.ts                # Prompt/handoff/end race behavior
tests/host/run-handle.test.ts          # Public delegation and terminal errors
tests/host/production-host-spawn.test.ts # SDK wrapper capabilities
tests/extension/*.test.ts              # Commands, tracker, registration, clipboard behavior
```

`production-host.ts` and `loop.ts` already exceed the current module-size guidance.
Extract the role-session wrapper from `production-host.ts` because this feature changes
that responsibility. Keep new operator-control logic in focused modules and do not grow
the existing oversized loop materially; a wholesale loop decomposition is outside this
feature's scope because its single-owner control flow is one coherent function.

## 8. Code Style

- TypeScript strict; no `any`, casts only at established SDK boundaries.
- Named exports only.
- Public exports receive intent-focused JSDoc and a reference to this spec.
- Keep mutable run-control state in one class; expose immutable snapshots.
- Use discriminated string codes for typed errors.
- Preserve input text; use trimmed text only for empty validation.
- No silent fallbacks.

Representative boundary style:

```ts
export class RunControlError extends Error {
  readonly code: RunControlErrorCode;

  constructor(code: RunControlErrorCode, message: string) {
    super(`RunControlError: ${message}`);
    this.name = "RunControlError";
    this.code = code;
  }
}
```

## 9. Testing Strategy

Use Vitest with deterministic fake sessions and the existing stub provider. No API key
or live model is required.

Unit coverage:

- Empty and terminal input errors.
- Active steer delegation.
- Queueing when no session is active or the session is sealed.
- Reclaiming undelivered SDK steering on seal without replaying consumed steering.
- Guidance ordering across handoffs.
- Follow-up never calls native SDK `followUp`.
- Latest response replacement, tool exclusion, model-error exclusion, and reasoning
  inclusion.
- Response and guidance snapshots are immutable to callers.

Loop/integration coverage:

- Steering reaches the current role before its next model call.
- Follow-up queued during a worker prompt appears in the next orchestrator seed.
- A steer racing a handoff transfers to the next role.
- Pending guidance defers an orchestrator `end` and permits a corrected emission.
- Pending guidance survives model fallback/session failure.
- Abort behavior remains unchanged after moving it into the run control.

Extension coverage:

- All three commands register.
- Usage/no-active/accepted/error notifications are exact and single-fire.
- Copy uses the active handle first, then the most recent terminal handle.
- Copy passes the exact latest response text and never a tool summary.
- Clipboard failure is surfaced without changing run state.

## 10. Commands

Focused tests during implementation:

```bash
pnpm exec vitest run tests/host/run-control.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/host/loop.test.ts tests/host/run-handle.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/host/production-host-spawn.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/extension --maxWorkers=1 --no-file-parallelism
```

Full verification:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
pnpm audit
```

## 11. Boundaries

### Always

- Keep steering in `src/host` / `src/extension`; pure core modules remain untouched.
- Route every actual role transition through `reduce` in the loop.
- Preserve the single-writer rule for persisted run records.
- Treat session sealing as the point after which new guidance cannot target that role.
- Keep `RunHandle` and extension behavior covered by the same underlying run control.
- Tick every completed plan checkbox in the implementation change.

### Ask First

- Persisting operator guidance or responses in the run record log.
- Adding dependencies.
- Changing the manifest, checkpoint, or persisted-record schemas.
- Adding keyboard shortcuts or replacing slash commands with an interactive widget.
- Changing copied-text behavior to omit displayed reasoning.

### Never

- Call `reduce`, persist records, or spawn roles from a steering command or `RunHandle`.
- Deliver new guidance to a sealed role session.
- Use native `AgentSession.followUp()` for conductor follow-up.
- Copy tool summaries as the latest response.
- Put clipboard access in `RunHandle`.
- Use `ctx.newSession()` or `ctx.fork()`.
- Add pi runtime imports to the guarded pure-core directories.

## 12. Success Criteria

- [x] `RunHandle.steer`, `RunHandle.followUp`, and `RunHandle.latestResponse` are public,
      documented, and exported from both host and package barrels.
- [x] Active `steer` uses pi's documented steering queue.
- [x] Conductor `followUp` uses the run mailbox and never the SDK same-session follow-up
      queue.
- [x] Undelivered guidance received before or during a handoff reaches the next active
      role exactly once and in order.
- [x] Guidance accepted before an orchestrator `end` is not lost; the end is deferred
      and the orchestrator receives the guidance.
- [x] Steering cannot mutate FSM state or bypass a legal machine transition.
- [x] `latestResponse()` updates at completed assistant `message_end`, includes readable
      displayed reasoning, and excludes tools and errored/empty responses.
- [x] `/conduct:copy` works during a run and after its completion in the same process.
- [x] Library and extension surfaces share the same run-control state.
- [x] Existing abort, resume, handoff, cost-cap, and sealing tests remain green.
- [x] Focused and full verification commands pass.
- [x] No new source file crosses the repo's module-size ceiling; modified oversized
      legacy modules do not grow materially, and role-session adapter logic is extracted
      from `production-host.ts`.

## 13. Deferred Questions

These are explicitly post-MVP and do not block implementation:

- Should guidance be persisted for crash/restart recovery?
- Should `latestResponse()` reconstruct a prior response from role-session JSONL on
  resume in a new process?
- Should a later API expose run-control delivery events or receipts?
- Should copied text eventually support a direct-answer-only mode that omits reasoning?

## 14. Approval Gate

Per the repository operating model, implementation begins only after the overseer
acknowledges this new spec. After acknowledgement, create the phase plan with
`planning-and-task-breakdown`, then implement it incrementally with tests first.
