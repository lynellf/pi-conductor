# Run Operator Controls

Status: Promoted to [`docs/run-operator-controls/spec.md`](../run-operator-controls/spec.md)
Date: 2026-07-18

## Problem Statement

How might we let a human supervising a live conductor run correct its direction and
reuse its latest meaningful response without entering a role session directly or
bypassing the FSM's transition authority?

The primary users are:

- A pi TUI operator watching a run and correcting it while work is in progress.
- A library consumer embedding `pi-conductor` who needs the same run-control
  capabilities without depending on the extension UI.

## Recommended Direction

Add a run-scoped operator-guidance mailbox and a latest-response snapshot. Expose the
portable capabilities on `RunHandle`, then adapt them into extension commands:

| Library surface | TUI surface | Behavior |
| --- | --- | --- |
| `RunHandle.steer(text)` | `/conduct:steer <message>` | Guide the active role at its next model opportunity. |
| `RunHandle.followUp(text)` | `/conduct:followup <message>` | Queue guidance until the current work settles. |
| `RunHandle.latestResponse()` | `/conduct:copy` | Retrieve the latest completed role response; the extension copies its text. |

Guidance is addressed to the run, not to a particular role session. If a message races
a handoff, remains undelivered when a session settles, or arrives while no role session
is addressable, the mailbox carries it forward in FIFO order to the newly active role.
Carried guidance is included in that role's initial context so it is visible before the
role's first model call.

This remains a host/session concern. Steering does not emit `handoff` or `end`, call the
reducer, mutate a checkpoint, select a role, or unseal a role that has already declared
its exit intent. This preserves the authority and boundary model in
[`docs/archive/orchestrator-fsm-spec.md`](../archive/orchestrator-fsm-spec.md), especially
sections 2, 3, 12, and 14.

`RunHandle` should expose response retrieval rather than an OS clipboard operation.
Clipboard access is environment-specific and would make headless or server-side library
usage fragile. The extension can use pi's clipboard helper on the returned text, while
other library consumers can send the same response to their own UI, API, or clipboard
adapter.

The initial public shape should stay small and additive:

```ts
interface RunResponse {
  readonly runId: string;
  readonly role: Role;
  readonly sessionId: string;
  readonly text: string;
  readonly completedAt: number;
}

class RunHandle {
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  latestResponse(): RunResponse | null;
}
```

Empty guidance and attempts to steer a terminal run should fail with typed errors.
The methods should not silently discard input or promise which role will consume a
message before the handoff race has settled.

### Alternatives Considered

- **Direct session pass-through:** Smallest implementation, but a message can be lost
  or delivered to a sealed session during a handoff. It also exposes session timing as
  a public contract. Rejected because it does not satisfy follow-the-active-role
  semantics.
- **Durable mailbox in the run record log:** Could recover pending guidance across a
  process crash, but introduces persistence and reconciliation work and must respect
  the loop's single-writer rule. Defer until live-run behavior proves valuable.
- **TUI-only response cache:** Makes `/conduct:copy` easy, but leaves library consumers
  without parity and creates two sources of truth. Rejected in favor of a response
  snapshot shared with `RunHandle`.

## Key Assumptions to Validate

- [x] Operators expect `steer` to affect the active role before its next model call.
      Validate with an integration test that steers a role between tool/model turns.
- [x] Operators expect undelivered `steer` and `followUp` messages to follow a handoff
      instead of failing or remaining attached to the old role. Validate with
      deterministic before-, during-, and after-handoff race tests.
- [x] FIFO ordering is sufficient when several guidance messages queue during a role
      transition. Validate with a multi-message handoff test.
- [x] "Latest response" means the newest completed assistant-text response from any
      role in the run, excluding tool summaries. Validate the exact copied bytes in an
      extension integration test.
- [x] The current rendered reasoning should remain part of copied response text.
      Validate with a small operator trial before locking this into the public contract.
- [x] In-process retention through run completion provides enough initial value; crash
      and restart recovery are not required for the first release.

## MVP Scope

- Add `steer`, `followUp`, and `latestResponse` to `RunHandle` as additive APIs.
- Introduce a run-owned guidance controller that serializes delivery against active
  session changes and preserves undelivered messages in FIFO order.
- Mark a settled or sealed role session non-addressable before transition processing,
  so guidance received at the boundary queues for the next active role.
- Deliver active-role steering through pi's steering mechanism and carry any
  still-undelivered guidance into the next role's initial context.
- Capture the latest completed assistant text at `message_end`; do not treat tool-call
  or tool-result display events as responses.
- Retain the latest response on the handle after terminal completion for the lifetime
  of the process and handle.
- Register `/conduct:steer`, `/conduct:followup`, and `/conduct:copy` in the extension.
- Keep a reference to the most recently started run so `/conduct:copy` works after the
  run leaves the active slot in the same process.
- Use pi's clipboard helper only in the extension command and notify the user of
  success or a typed failure.
- Add deterministic unit and integration coverage for delivery timing, handoff races,
  FIFO ordering, terminal errors, response selection, and library/TUI parity.

## Not Doing (and Why)

- **Direct FSM steering or role selection** — operator guidance changes role behavior,
  not machine state; role transitions remain legal only through `handoff` and `end`.
- **Cross-process mailbox recovery** — valuable, but requires a durable record and
  reconciliation design that should follow validation of the live-run behavior.
- **Historical response picker** — the immediate job is copying the latest response,
  not browsing a transcript.
- **Tool-summary copying** — tool activity is observability metadata, not the requested
  session response.
- **Clipboard methods on `RunHandle`** — clipboard ownership belongs to the consuming
  UI or application environment.
- **Keyboard shortcuts or interactive steering widgets** — slash commands provide the
  smallest testable surface; shortcuts can be added after command semantics stabilize.
- **New reducer events or checkpoint fields** — steering remains invisible to the pure
  machine contract.
- **A public delivery-receipt protocol** — returning mutable session-target details
  would expose race-sensitive implementation behavior. The initial API only confirms
  acceptance or throws a typed error.

## Open Questions

- Should copied text include displayed reasoning, or only direct assistant text? The
  initial assumption is to preserve the response exactly as currently rendered minus
  tool summaries.
- Should a future durable mailbox persist the full guidance text in the run log, use a
  separate sidecar, or rely on role-session JSONL? Any choice must preserve the loop's
  single-writer invariant.
- On a resumed run in a new process, should `latestResponse()` reconstruct the prior
  role response from its session JSONL, or return `null` until a new response completes?
- Does the TUI need an explicit notification when guidance transfers across a handoff,
  or is confirmation that the run accepted the message sufficient?
