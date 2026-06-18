# Orchestrator FSM — Plan / Specification

Status: Draft (pre-implementation, abstraction-review stage)
Scope: Pure machine + contract. No pi runtime code. No sub-session internals.

## 1. Purpose

A finite-state machine that orchestrates multi-role agent workflows running on pi. The
machine owns transitions between role sessions. It does not own what roles do inside
their sessions, nor whether their work is any good.

The machine exists to make role-to-role handoffs **observable** and **closed by default**:
an agent may propose any event, but the machine only transitions when the
`(state, event)` pair is declared legal. Gaps in the machine surface as rejected events,
not as silent dead ends or unexpected behavior.

The topology is **hub-and-spoke** (§6): a designated orchestrator role is the entry and
terminal; worker roles never hand off to each other, only back to the orchestrator. This
keeps the transition shape uniform and tiny for every workflow, so adding a role means
declaring the role, not editing a routing graph.

## 2. Authority model

- **Open dispatch, closed validation.** Roles emit events; the machine decides whether
  the event is legal from the current state. The LLM can never put the system into an
  undeclared state.
- **Routing judgment lives in the orchestrator; structure is enforced by the machine.**
  The orchestrator picks which worker runs next (or ends). The machine does *not*
  second-guess that choice semantically — it validates that the named target is a
  declared role and that the hub-and-spoke shape is respected (workers can't target
  each other; `end` only from the orchestrator). Workers cannot self-route to other
  workers; that flaky path is structurally impossible.
- **Side-effects are driver-owned, not machine-owned.** The machine emits "transition
  accepted, next role = X." Model selection, session spawning, payload seeding are
  driver concerns (§8). The reducer stays pure.
- **Sub-session internals are out of scope.** The machine sees `session_started`,
  handoff emissions, and `session_failed`. It does not see tool calls, reasoning, or
  turn counts.

## 3. Boundary contract (machine ↔ role session)

The contract between the machine and a role session is intentionally narrow. A role
session **must**:

1. Terminate by emitting exactly one machine event: either `handoff` (with a
   `target_role`) or `end`.
2. Emit a payload whose shape matches the schema for that event.
3. Emit nothing else to the machine (no mid-session control events; internal tool
   calls are invisible to the machine).

A violation of (1)–(3) — crash, timeout, malformed emission, or no emission — is a
`session_failed` lifecycle event. The machine owns the recovery decision for that case.

Whether a given event is *legal* from the current role (e.g. `end` from a worker) is a
transition-legality concern (§7), not a contract concern. A worker emitting `end` honors
the contract (one well-formed event) but the machine rejects the transition and the
worker retries. The machine does **not** inspect payload *content* for adequacy. It
checks *shape* (schema validity at the seam) and *legality* (is this
`(state, event)` pair permitted). Semantic adequacy ("the implementer's work was
shallow") is resolved by the orchestrator routing back to the worker — not a machine
concern, not a contract violation.

## 4. Two failure channels (do not conflate)

| Failure | Owner | Machine response |
|---|---|---|
| Semantic payload inadequacy (work incomplete/shallow) | Orchestrator re-routes via handoff | None — transition was valid |
| Contract breach (no/invalid/extra handoff emission, crash, timeout) | The machine | `session_failed`; machine picks recovery |

Schema validation at the seam enforces the contract (rule 2), **not** quality. Keeping
these channels separate is what lets the machine stay small.

## 5. Events

The machine recognizes only mechanics. Semantic intent (`plan_ready`,
`concerns_raised`, `approved`, `needs_replan`, …) is **not** a machine concept: it
lives in the LLM's reasoning and, optionally, a free-form `reason` field in the handoff
payload that the machine stores for observability but never branches on. The machine
branches on *whether a handoff occurred, to whom, and whether the session ended* —
nothing more.

### 5.1 Machine events (role-issued)

| Event | Semantics | Payload |
|---|---|---|
| `handoff` | Role terminates its session and routes to another role | `target_role: Role`, `reason?: string`, `suggests_next?: Role`, plus role-defined fields |
| `end` | Role declares the overarching session complete | `reason?: string` |

The LLM decides which to emit and (for `handoff`) which `target_role`. The machine
decides whether that choice is legal given the hub-and-spoke shape (§7).

`suggests_next` is **advisory, not binding**. A worker may suggest where the orchestrator
should route next; the machine records it for observability and the driver surfaces it to
the orchestrator as context, but the machine never validates or branches on it. The
orchestrator still must emit a legal handoff of its own. This lets roles express intent
without creating the bilateral-declaration friction that per-role edge contracts would
impose.

### 5.2 Session-lifecycle events (driver-issued)

Emitted by the machine/driver, never by roles. Drive observability and recovery.

| Event | Semantics |
|---|---|
| `session_started` | A role session has begun |
| `session_ended` | A role session terminated cleanly with a `handoff` or `end` |
| `session_failed` | A role session breached the contract (§3), or reported it cannot proceed; the machine owns recovery |

`session_ended` and `session_failed` are mutually exclusive terminals for a role
invocation. "I'm blocked / need a human" is a `session_failed` with a reason, not a
distinct machine event — escalation is a recovery policy, not a transition.

## 6. Topology: hub-and-spoke

- **The orchestrator is the hub.** It is the run entry point and the only role from
  which `end` is legal.
- **Workers are spokes.** A worker's only legal handoff target is the orchestrator.
  Workers cannot hand off to each other. This makes worker→worker self-routing — the
  flaky path — structurally impossible.
- **The orchestrator picks the next worker** (or ends). Its judgment lives in *which
  declared worker it names*, bounded by "must be a declared role" and "must respect
  visit caps (§7.4)."
- **Default orchestrator.** The system provides a default orchestrator role. Users may
  override it with their own orchestrator configuration (system prompt, model, tools).
  The machine treats any role marked `is_orchestrator: true` as the hub; there is
  exactly one per run.

The entire transition shape is uniform and identical for every workflow:

1. From the orchestrator: `handoff → <any declared worker>` is legal (subject to visit
   caps); `end` is legal.
2. From any worker: `handoff → orchestrator` is the only legal target; `end` is illegal.
3. From `done`: nothing is legal (terminal).

Adding a workflow step means declaring a new worker role — not editing N role configs or
keeping a routing graph consistent. The friction of per-role edge contracts is avoided.

## 7. States and transitions

### 7.1 States

The machine's state is **the currently active role**, plus a small set of counters
guards require (§7.4). There is no separate `planning`/`implementing`/`reviewing` axis:
"which role is active" *is* the state. A worker visited twice (e.g. implementer, then
again after review) is the same role visited twice; the *payload* (reviewer's concerns)
distinguishes remediation from fresh implementation, visible in the transition log. The
distinct `remediating` state from earlier drafts is dropped.

Formally: `State = Role ∪ { done }`, where `done` is the terminal marker reached when
the orchestrator emits `end`.

### 7.2 Transition table (uniform, parameterized by declared roles)

| From | Event | To | Guard | Effect |
|---|---|---|---|---|
| orchestrator | `handoff → W` (any declared worker W) | `W` | `visit_count[W] < max_visits[W]` | `visit_count[W] += 1` |
| orchestrator | `end` | `done` | — | — |
| worker W | `handoff → orchestrator` | `orchestrator` | — | — |
| `done` | *(anything)* | *(rejected)* | — | — |

The machine does not bake role names into its core. The declared worker set and their
`max_visits` caps are user-defined role configuration (§8); the table is the same for
every workflow.

### 7.3 Undeclared / illegal pairs

Every `(state, event)` pair not matching the table is **rejected by default**. Examples:

- `handoff → worker_A` from `worker_B` — rejected (workers can only target the
  orchestrator).
- `handoff → <undeclared role>` from the orchestrator — rejected (not a declared role).
- `end` from any worker — rejected (only the orchestrator may end).
- Any event from `done` — rejected (terminal).

Rejections produce a persisted `transition_rejected` record (§11.3) and are surfaced to
the emitting role with the legal targets so it can retry.

### 7.4 Visit-cap guards (cycle safety)

Because the orchestrator may revisit workers, `orchestrator → W → orchestrator → W …` is
a cycle. Each worker declares `max_visits` (finite). After `visit_count[W]` reaches
`max_visits[W]`, `handoff → W` from the orchestrator is rejected (guard fails); the
orchestrator must pick a different uncapped worker or `end`. When all workers are
capped out, only `end` (or escalation via `session_failed`) remains legal. The guard is
config data, not ad-hoc code.

> "State" therefore does not vanish entirely — the machine carries `visit_count[W]` per
> worker. This is the minimal mutable state guards require; it is far smaller than a
> role-phase axis, and it is exactly what cyclic guards need.

## 8. Role configuration (manifest)

Roles are declared in a manifest the host driver reads. The machine core never imports
this; the driver uses it to spawn sessions and derives a `MachineDefinition` (§12) from
the pinned manifest version — the only manifest surface the reducer ever sees.

**Manifest source (resolved):** a single `.pi/conductor.yaml` file. YAML (not JSON) so
the role-config blocks below are copy-pasteable, and a single file so the §10 manifest
version is one value pinned atomically at run-start rather than N per-role files
that must agree. Per-role system prompts are referenced by path (`system_prompt:`) and
loaded by the host; they are *not* the manifest's source of truth. (Role Markdown
frontmatter was considered and rejected for v1: versioning frontmatter across N files
reintroduces the cross-file agreement problem §10 exists to prevent.)

```yaml
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [anthropic:claude-sonnet-4-5]   # provider:id form; omit to use pi's current model
    max_run_cost_usd: 25.0       # run-level cap; lives here, no separate run config
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, bash, handoff, end]   # handoff/end force-injected by host regardless

  - name: implementer
    max_visits: 3
    max_session_cost_usd: 5.0    # per-invocation cap, shared across model fallbacks
    models: [anthropic:claude-opus-4-5, openai:gpt-4o]  # ordered: primary, then fallbacks
    system_prompt: .pi/roles/implementer.md
    tools: [read, edit, write, bash, handoff, end]

  - name: reviewer
    max_visits: 3
    # models omitted → uses whatever pi is already configured with
    # max_session_cost_usd omitted → uncapped for this role's sessions
    system_prompt: .pi/roles/reviewer.md
    tools: [read, grep, handoff, end]
```

A top-level `version:` field is required (§10):

```yaml
version: 1
roles: [ ... ]
```

Run-level config has no separate file. `max_run_cost_usd` lives in the orchestrator's
manifest entry because the orchestrator owns the run; the orchestrator is a role, so
this keeps all run config in the single manifest. A runtime override is available via
the `/run-config` slash command (§11.8) for the current run without editing the
manifest; the manifest value remains the default.

### 8.1 Model assignment

- **User-defined per role.** `models: [primary, ...fallbacks]`, tried in order.
- **Model naming form is `provider:id`** (e.g. `anthropic:claude-opus-4-5`,
  `openai:gpt-4o`). The host resolves each entry to a `Model` via the SDK's
  `modelRegistry.find(provider, id)` / `getModel(provider, id)`. Bare aliases
  (`claude-sonnet`) are **not** accepted — they are ambiguous across providers and
  versions and would make `manifest_version` (§10) meaningless. A role with no
  `models` field uses pi's current/system model (no resolution, no fallback).
- **Omit the field → use pi's current/system model.** No fallback; a model failure just
  escalates as `session_failed`.
- **Driver-owned, not machine-owned.** On an accepted transition to role X, the driver
  reads `X.models[0]` (or the system model) and spawns the session with it. The reducer
  is unchanged; it only names the next role.
- **The orchestrator does not pick models.** Model selection stays deterministic config,
  keeping routing (the orchestrator's job) and execution (the driver's job) separate.
  Re-concentrating model choice in the orchestrator would re-introduce flakiness in the
  one role we want reliable.
- **`handoff`/`end` are force-included.** Every role's session must be able to emit a
  machine event (§3). The host injects `handoff` and `end` into each role's `tools`
  allowlist regardless of the manifest `tools:` list; a §13 static check additionally
  flags any role whose declared `tools:` omits them (defense in depth, since the host
  injects them anyway).

### 8.2 Model fallback as `session_failed` recovery

Model failure is a `session_failed` cause. Recovery specializes the existing policy
(§9.3):

1. Role session fails (`failure_reason: "model_error"`, recording which model).
2. Driver tries the next model in the role's `models` list, same role, fresh session.
3. If the list is exhausted (or no list was provided) → escalate: hand back to the
   orchestrator with a "role unavailable" payload, or escalate to a human.

The machine's state (current role) does **not** change on a model retry — the role didn't
transition, it re-ran. Model retries are invisible to the transition logic and visible
in the lifecycle trace (§11.4, §11.5).

### 8.3 Advisory `suggests_next`

Workers may include `suggests_next: Role` in their handoff payload. The machine records
it (observability) and the driver surfaces it to the orchestrator as context. It is not
validated and not binding — the orchestrator still emits its own legal handoff. This
satisfies "let a role express where things should go" without bilateral edge contracts.

### 8.4 Run memory artifact

Fresh orchestrator sessions (one per orchestrator invocation) have no built-in routing
continuity. The driver maintains a **run memory artifact** — a single structured record
keyed by `run_id` — that each fresh orchestrator session reads at startup. This is the
orchestrator's externalized memory: bounded, stable, parseable by small models.

```
run_id, goal, current_role, state,
visit_history: [{ role, visit_index, model, outcome, usage: { tokens, cost } }],
run_cost_to_date, run_cost_cap, remaining_budget,
per_role_cost: { role: { tokens, cost } },
next_candidates: [role]   # workers not visit-capped, with run budget remaining
```

`open_concerns` from earlier drafts is **dropped for v1**: the machine does not inspect
payload content (§3), so no core code can populate it, and a free-form prose field
would let a small model drift. If a future version wants it, it must be a derived field
with a declared writer (e.g. a convention that handoff payloads carry a structured
`concerns` array) — not added back as prose.

Rules:
- **Single writer: the orchestrator only.** Workers write their handoff payload; the
  orchestrator reads payloads, updates the artifact, hands off. If workers could write
  memory, bilateral-contract friction returns.
- **Structured, not prose.** A small model can parse and act on this consistently; a
  free-form notes field would let it drift. This is the lever for "smaller models
  perform consistently for long-horizon workflows."
- **Cost/budget-aware.** The artifact carries `run_cost_to_date`, `remaining_budget`, and
  per-role cost, so the orchestrator can route budget-awarely ("reviewer already cost
  $2; don't re-dispatch, end instead"). Run stats are therefore visible *to the
  orchestrator* between its turns, automatically, via the seed context.
- **Driver-mediated, not machine-owned.** The machine still sees only `handoff`/`end`/
  lifecycle. The artifact is the same category as seeding a worker session from a
  handoff payload — driver context, not machine state.

## 9. Open questions to resolve before implementation

1. **Concurrency.** Single active role at a time (flat FSM, as scoped here), or can
   multiple workers run in parallel? Parallel breaks the flat FSM into a
   hierarchical/Petri-net model. Out of scope for v1; explicitly single-active.
2. **Visit-cap granularity.** `max_visits` per worker per run (current draft), or a
   global dispatch cap, or both? v1 default: per-worker.
3. **Cost-cap defaults.** v1 adopts: per-session cap (`max_session_cost_usd`) is
   per-role-invocation and **shared across model fallbacks** within that invocation (no
   multiplier loophole — burning through each model can't spend `cap × len(models)`).
   Run cap (`max_run_cost_usd`) exceeded = forced `end`, non-negotiable; a graceful
   wind-down (warn at 90%, hard-stop at 100%) is available as a future option.
4. **Recovery policy for `session_failed`.** After model fallback exhaustion: hand back
   to orchestrator, or escalate to a human? v1 default: hand to orchestrator once; if
   the orchestrator also fails or re-dispatches to the same unavailable role, escalate.
5. **Host shape.** SDK host process (headless, testable) vs. in-TUI extension
   (interactive, watchable) vs. both via a pure-FSM-core split. **Resolved for v1: the
   pi SDK host.** The pure core is imported by an in-repo SDK host driver that owns the
   orchestration loop, spawns role sessions via `runtime.newSession`/
   `createAgentSession`, and is unit-tested against `SessionManager.inMemory()`. The
   TUI extension path was rejected because tool handlers receive `ExtensionContext`
   (which lacks `newSession` — that lives on `ExtensionCommandContext`), forcing an
   async command-queue dance and an unverifiable manual test surface; the SDK host makes
   the loop synchronous and testable with real assertions, not pinky-promises. TUI
   affordances (live widget, mid-run `/tree`) are accepted losses. The pure core remains
   host-agnostic, so a TUI extension viewing an SDK run is a future option, not blocked.

## 10. Versioning

The role manifest and guard config mutate over time. Two rules keep runs interpretable:

1. A manifest version is pinned to a run at run-start. All transitions in that run
   validate against the pinned version. Mid-run config changes do not affect an
   in-flight run. **Provenance:** the manifest version is a `version:` field declared
   at the top of `.pi/conductor.yaml`, an explicit, human-bumped integer (e.g.
   `version: 1`). It is *not* a content hash (opaque, no migration signal) and *not*
   auto-incremented (silent drift). The host rejects a manifest with no `version:` at
   load time. The pinned value is copied onto `Checkpoint.manifest_version` and
   `MachineDefinition.manifest_version` at run-start and never mutated.
2. Config changes are **additive and versioned**: new roles, new caps, new models are
   fine; silently changing the meaning of an existing role (e.g. removing `max_visits`
   to uncap a worker) is forbidden. Renaming or semantics changes require a new version
   and an explicit migration note.

Without (2), the transition log becomes uninterpretable across versions — the flakiness
you're trying to avoid, relocated into the config.

## 11. Persistence and observability

Every transition — accepted, rejected, and lifecycle — is an immutable persisted event.
The FSM state is **checkpointed**, never derived from agent output. On crash, resume
from the checkpoint, not by replaying agent emissions.

### 11.1 Checkpoint record (one per run, snapshot-appended per transition)

The checkpoint is **never mutated in place**. Each transition produces a new full
checkpoint snapshot that the host persists as an immutable record. On crash/restart,
the live checkpoint is **reconstructed** by reading the latest snapshot record for the
run (scoped to `run_id`), not by deriving state from agent output and not by replaying
an event-sourced fold over all records (snapshots are full, so the last one *is* the
state). Reconstruction reads records from the **host's own `run_id`-keyed append-only
log** — the host owns persistence directly, keyed by `run_id`, and does **not** rely on
SDK branch scoping. (`SessionManager.getBranch()` was considered but rejected: role
sessions are spawned as independent `createAgentSession` calls and are not guaranteed
to share the host session's branch, so a `getBranch()`-scoped replay could silently
miss role-session records — see plan Open Q #7 / `sdk-surface.md` §6. Keying solely on
`run_id` in the host-owned log is branch-independent and the safe default.) A raw scan
of the whole tree is likewise never used — it would pull sibling-run data.

```ts
{
  run_id: string,
  manifest_version: string,     // pinned at run-start (§10)
  current_role: Role | "done",
  visit_count: Record<Role, number>,   // per-worker, for guard evaluation
  active_role_session: string | null,  // host session id, or null when idle
  updated_at: number,
}
```

The host treats checkpoint snapshots the same as every §11.2–§11.5 record: an
append-only entry. The reducer returns a new `Checkpoint` value; it does not write it.

### 11.2 `transition_accepted`

```ts
{
  type: "transition_accepted",
  run_id: string,
  from: Role | "done",
  to: Role | "done",
  event: "handoff" | "end",
  target_role: Role | null,     // present for handoff, null for end
  role: Role,                   // emitting role
  suggests_next: Role | null,   // advisory, recorded not branched on
  payload_summary: { reason?: string; suggests_next?: Role | null; field_names: string[] },
  // shape-validated, not content-judged: `reason` and `suggests_next` are surfaced
  // for observability; `field_names` lists the payload's top-level keys (a stable
  // structural fingerprint) so the log is interpretable without storing arbitrary
  // payload content. The full validated payload is retained by the host for seeding
  // the next session but is NOT part of this persisted record.
  guard: string | null,         // e.g. "visit_count[W] < max_visits[W]"
  effect: string[],             // e.g. ["visit_count[W] += 1"]
  session_file: string,
  ts: number,
}
```

### 11.3 `transition_rejected`

The gap signal. Required for "prevent unexpected behavior from gaps" to hold.

**`transition_rejected` records only *legal-but-blocked* transitions** — pairs that are
in or near the uniform table but cannot proceed: `illegal_event` and `guard_failed`.
These keep a live session: the emitting role can retry against the surfaced
`legal_targets`. A contract breach (§3) is **not** a `transition_rejected`; it is a
`session_failed` lifecycle event (§11.4) with `failure_reason` set to `schema_invalid` /
`extra_emission` / `no_emission`. The session is dead, there is no legal target to retry
toward, and emitting a `transition_rejected` would imply the role can recover inline
when it cannot. The host therefore persists **exactly one** record for a breach — the
`session_failed` — and never a `transition_rejected`. (The `reason` union below keeps
the breach values so the lifecycle `failure_reason` type and the rejection type share a
vocabulary, but the reducer only ever returns `illegal_event` / `guard_failed`.)

```ts
{
  type: "transition_rejected",
  run_id: string,
  state: Role | "done",
  event: "handoff" | "end" | "<malformed>",   // "<malformed>" if emission didn't parse
  target_role: Role | null,
  reason:
    | "illegal_event"          // (state, event/target_role) not in the uniform table (§7.2)
    | "guard_failed"           // legal pair, visit cap blocked it
    | "schema_invalid"         // payload didn't match the handoff/end schema (contract breach)
    | "extra_emission"         // role emitted more than one machine event (contract breach)
    | "no_emission"            // role session ended without handoff or end (contract breach)
  legal_targets: { handoff: Role[]; end: boolean },  // guidance for retry
  role: Role,
  session_file: string,
  ts: number,
}
```

### 11.4 `session_started` / `session_ended` / `session_failed`

```ts
{
  type: "session_started" | "session_ended" | "session_failed",
  run_id: string,
  role: Role,
  visit_index: number,          // which visit of this role in the run (1-based)
  state: Role | "done",
  model: string | null,          // which model this session ran on (null if system default)
  session_file: string,
  parent_session: string | null, // links role sessions into a tree
  usage?: {                      // present on session_ended AND session_failed (both terminals cost)
    input: number, output: number,
    cache_read: number, cache_write: number,
    tokens: number, cost: number,  // normalized record shape (snake_case, flat cost)
  },
  // SDK mapping (pinned against @earendil-works/pi-ai `Usage`): the record above is the
  // host's NORMALIZED form. The SDK `Usage` carries camelCase fields and a nested cost
  // object, so the host maps explicitly:
  //   input        <- message.usage.input
  //   output       <- message.usage.output
  //   cache_read   <- message.usage.cacheRead
  //   cache_write  <- message.usage.cacheWrite
  //   tokens       <- message.usage.totalTokens
  //   cost         <- message.usage.cost.total   (NOT a flat number on the SDK side)
  // `usage` lives on AssistantMessage only; `message_end` also fires for user/toolResult
  // messages, so the host MUST guard `message.role === "assistant"` before reading it.
  // A role session emits MANY assistant messages, so the per-session `usage` here is the
  // SUM across that session's assistant `message_end` events (accumulated, not a single
  // capture). Cost caps (§11.7) read the same running sum.
  failure_reason?: string,       // session_failed only
  ts: number,
}
```

`usage` is captured on **both** terminals. A session that crashed after consuming 50k
tokens still cost those tokens; recording usage only on `session_ended` would make the
run total silently fail to reconcile. `visit_index` makes "implementer ran 3 times"
reconstructable from records alone. `failure_reason` gains `"session_cost_cap_exceeded"`
and `"model_error"`. `session_failed` triggers recovery (§8.2, §9.4). The session tree
formed by `parent_session` is the execution trace; drilling into a role's actual turns
is pi's `/tree`, not the machine's concern.

### 11.5 `model_fallback`

Driver-issued, parallel to the transition trace. The machine does not track models; this
record exists so the log shows "reviewer burned through 3 models."

```ts
{
  type: "model_fallback",
  run_id: string,
  role: Role,
  from_model: string | null,     // null = system default
  to_model: string | null,
  reason: string,                // e.g. "model_error", "rate_limited"
  session_file: string,
  ts: number,
}
```

### 11.6 Usage roll-up

All cost/token figures derive from the `usage` blocks captured on `session_ended` and
`session_failed` (§11.4). Roll-up is a pure query over persisted records, keyed by
`run_id`; no inference, no fuzziness. Dimensions:

- **Per-run total** — the headline number.
- **Per-role total** — sums across all visits, including failed/retried sessions.
- **Per-model total** — sums across sessions that ran a given model. Useful when a role
  has fallbacks and you want to see which model bore the load.
- **Orchestrator as overhead** — isolated from worker cost. Orchestrator cost is
  *routing overhead*, not work output; separating it shows "this run cost $4, of which
  $0.80 was routing." Without separation a cheap run looks expensive because the
  orchestrator ran many times.

**Cache caveat (do not misrepresent).** Within a session, pi reflects cache
read/write in usage. Across sessions, cache reuse is provider-dependent (a shared
system-prompt prefix may or may not hit cache). Report raw `cache_read`/
`cache_write` token counts per session; a "run cache hit rate" is a per-session ratio,
*not* a clean per-run number, and should not be presented as one.

### 11.7 Cost-cap enforcement

Caps are driver-owned guards evaluated against captured usage. The machine stays pure;
they are config data (`max_session_cost_usd` per worker, `max_run_cost_usd` in the
orchestrator manifest entry — §8), not machine state.

**Per-session cap (`max_session_cost_usd`):**
- Evaluated *during* the session, at every `turn_end`, against that session's
  cumulative `usage.cost`.
- Exceeded → driver calls `session.abort()`, records `session_failed` with
  `failure_reason: "session_cost_cap_exceeded"`.
- **Per-role-invocation, shared across model fallbacks.** Model retry within one
  invocation shares one budget — burning through each model cannot spend
  `cap × len(models)`. When the invocation's budget is exhausted, it fails and hands
  back to the orchestrator.
- Recovery: model fallback (cheaper model may complete within remaining budget), or
  hand back to orchestrator with a "role blew its budget" payload. Same channel as
  model failure (§8.2).

**Run cap (`max_run_cost_usd`):**
- Evaluated on every `session_ended`/`session_failed` usage capture, against the
  running sum across all sessions in the run.
- Exceeded → the driver **synthesizes a machine `end` event and feeds it to `reduce`**.
  This is the single legal mechanism: the machine sees a normal `end` transition,
  produces a `transition_accepted` → `done` record + a checkpoint snapshot, and the run
  stops. A steering message ("run cost cap reached, end now") may be offered to the
  orchestrator as a *courtesy* first, but the authoritative close is the synthesized
  `end` through the reducer — the host **must not** mutate the checkpoint to `done`
  directly. This preserves the invariant that every state change goes through `reduce`
  and the audit trail stays complete. Non-negotiable hard stop. (A graceful
  wind-down — warn at 90%, hard-stop at 100% — is a future option, not v1.)
- **Synthesized `end` is only legal from the orchestrator (state guard).** `end` is
  rejected from a worker (§7.2). Because §12.1 advances `current_role` to the next
  worker *before* that worker's `session_started`/`session_ended` fire, a run-cap
  breach detected on a **worker** terminal would hit `current_role = W` and `reduce`
  would reject the synthesized `end`. The host therefore **does not synthesize `end`
  while a worker is current**: it records the breach, lets the worker's handoff return
  control to the orchestrator (the next `reduce` advances to `orchestrator`), and
  synthesizes the `end` on the *first orchestrator-current moment* — which always
  exists, because a worker's only legal target is the orchestrator (§6). Equivalently,
  the host evaluates the run cap on each terminal but defers the forced close to
  `current_role === orchestrator`. The cap is still a hard stop; the orchestrator gets
  no worker dispatch in between (the host suppresses any new spawn once the cap is
  tripped and drives the synthesized `end` immediately on re-entry).

Neither cap touches the reducer. Both read usage already captured for observability.

### 11.8 User-facing visibility

Two surfaces, both host concerns; the machine is uninvolved. Under the SDK host
(§9.5), these are host functions + emitted events, not in-TUI slash commands.

- **To the orchestrator (LLM):** the run memory artifact (§8.4) *is* the run-stats
  surface. Each fresh orchestrator session is seeded with `run_cost_to_date`,
  `remaining_budget`, and per-role cost, so the orchestrator sees current stats as
  context at the start of every turn. This is what enables budget-aware routing by
  small models. No extra mechanism.
- **To the user (human):**
  - `runStats()` host function renders the current run's state, transition history,
    and cost roll-up (§11.6) from persisted records.
  - `runConfig()` host function overrides `max_run_cost_usd` for the current run
    without editing the manifest (the manifest value remains the default).
  - A live status surface is provided by host-emitted `stats` events on each terminal
    usage capture; whatever front-end wraps the SDK host renders them. An in-TUI live
    widget is **out of scope under the SDK host** (accepted loss; see §9.5).

`runStats`/`runConfig` are the only run-level config/visibility entry points; there is
no run config file.

## 12. Reducer signature (pure)

The machine core is a pure library with zero pi dependencies. It is imported by the
host driver (§9.5 — host resolved as the pi **SDK**, not a TUI extension). Model
config, session spawning, and payload seeding live in the host driver.

The declared role set and per-worker `max_visits` are validation inputs, not state.
They are passed to the reducer as a pinned `MachineDefinition` snapshot (derived from
the run's pinned manifest version, §10), never read from ambient config at reduce
time. This is what makes the reducer deterministic given `(checkpoint, event, def)`.

```ts
// Pinned, immutable per run. Derived from the manifest version pinned at run-start.
interface MachineDefinition {
  manifest_version: string;
  orchestrator: Role;
  workers: Role[];                        // declared worker set (the table is parameterized by this)
  max_visits: Record<Role, number>;       // per-worker cap, finite (§7.4)
}

type MachineEvent =
  | { type: "handoff"; target_role: Role; payload: unknown }
  | { type: "end"; payload: unknown };
// `payload: unknown` is deliberate: the reducer never branches on payload content
// (§3/§4 — semantic adequacy is the orchestrator's job, not the machine's). The
// payload is shape-validated by the host at the seam (validateEmission) before
// reduce is called; the validated/typed form is a host-side concern, not a reducer
// input. Keeping it `unknown` prevents the reducer from accidentally gaining a
// content dependency.

// Constructed once at run-start. The single, canonical way to build the initial
// Checkpoint; the host must not hand-roll it (otherwise crash-resume diverges).
function createInitialCheckpoint(def: MachineDefinition): Checkpoint;
//   => { run_id, manifest_version: def.manifest_version, current_role: def.orchestrator,
//        visit_count: { W: 0 for W in def.workers }, active_role_session: null, updated_at }

type TransitionResult =
  | { kind: "accepted"; state: Role | "done"; effect: Effect[]; record: TransitionAccepted }
  | { kind: "rejected"; state: Role | "done"; reason: RejectReason; legal_targets: { handoff: Role[]; end: boolean }; record: TransitionRejected };

// Pure. No I/O. Deterministic given (checkpoint, event, def) modulo `meta.ts`.
// `meta.role` MUST equal `checkpoint.current_role`; the reducer asserts this and
// returns a rejected/throws on mismatch rather than trusting a host-supplied role.
// The emitting role is, by construction, the currently active role — accepting it as
// a separate parameter would let a host bug silently mis-evaluate role-keyed
// transitions. `meta.ts` flows into `record.ts` and is the only non-deterministic
// field; the determinism invariant is "same inputs modulo ts → same state/effect/
// reason/legal_targets."
function reduce(
  checkpoint: Checkpoint,
  event: MachineEvent,
  def: MachineDefinition,
  meta: { role: Role; sessionFile: string; ts: number },
): TransitionResult;

// Session-lifecycle reducer, same purity contract. `meta.role` is asserted against
// `checkpoint.current_role`; the emitting/active role is, by construction, the current
// role (this holds for model retries too — §8.2 — where the same role re-runs).
// `reduceLifecycle` never advances `current_role` — only `reduce` does. The host MUST
// call the two reducers in the canonical order below; any other order corrupts the
// checkpoint.
function reduceLifecycle(
  checkpoint: Checkpoint,
  lifecycle: "session_started" | "session_ended" | "session_failed",
  def: MachineDefinition,
  meta: { role: Role; sessionFile: string; model?: string | null; failureReason?: string; ts: number },
): { checkpoint: Checkpoint; record: SessionLifecycleEvent };
```

### 12.1 Canonical reducer call order (host MUST follow)

Because `reduce` flips `current_role` and `reduceLifecycle` flips
`active_role_session`, their interleaving is a correctness invariant, not a test
detail. For an accepted handoff `A → B`:

1. `reduce(...)` → `current_role` becomes `B`, returns the accepted record.
2. `reduceLifecycle(session_ended, { role: A })` → clears `active_role_session`.
3. `reduceLifecycle(session_started, { role: B })` → sets `active_role_session`.
4. Host spawns B's session, seeds it, runs it.

For a rejected handoff (retry possible): `reduce` returns rejected; **no** lifecycle
change — the same role session retries; `active_role_session` stays set.

For a contract breach: the host records `session_failed` via `reduceLifecycle` (role
A); `reduce` is **not** called (there is no legal transition to evaluate — §11.3).

For a model retry (§8.2): `reduceLifecycle(session_failed, {role: A})` then
`reduceLifecycle(session_started, {role: A})` — `current_role` never moves.

```ts

Host driver responsibilities (impure): own the orchestration loop — create a role
session via the SDK (`createAgentSession` with per-role `model`, `tools`,
`customTools`, and `sessionManager`; the per-role system prompt is supplied via a
`DefaultResourceLoader({ systemPromptOverride: () => rolePrompt })` passed as
`resourceLoader` — `systemPromptOverride` is a `ResourceLoader` option, not a direct
`createAgentSession` option), seed it from the accepted handoff's
payload, subscribe to its event stream to capture `usage` on `message_end` (both
terminals) and evaluate caps on `turn_end`, read the role's emission (the `handoff`/
`end` tool recorded it), `validateEmission` at the seam, call `reduce`, persist the
resulting record + a checkpoint snapshot (append-only, §11.1), and spawn the next
role session. Maintain and seed the run memory artifact for orchestrator sessions
(§8.4). Execute model fallback on `session_failed` (§8.2), enforce cost caps (§11.7),
and expose `/run-stats` + `/run-config` equivalents as host functions (§11.8). The
TUI live widget is out of scope under the SDK host; the host emits run-stats events a
consumer can render instead.

## 13. Static checks on the manifest

Because the manifest is data, it is lintable. Checks run at host load time against the
`.pi/conductor.yaml` (§8) before a `MachineDefinition` is derived. v1 checks (run at
load):

- Exactly one role has `is_orchestrator: true`.
- The orchestrator is reachable as the run entry (it *is* the entry).
- Every worker is named as a legal handoff target from the orchestrator (i.e. declared).
- Every worker has a finite `max_visits` (cycle guard). An uncapped worker makes the
  `orchestrator ↔ worker` cycle unguarded and is rejected — this is the check that makes
  "gaps surface" hold for cyclic topologies.
- `end` is legal from the orchestrator (always true by table construction; checked for
  config sanity).
- `done` is terminal and reachable (reachable via `end` from the orchestrator).
- If a role declares `max_session_cost_usd`, its `models` list should include at least
  one model cheaper than the primary (otherwise fallback can't help on a cap hit).
  Soft warning, not a hard reject.
- `max_run_cost_usd`, if present, is on the orchestrator's manifest entry only (not on
  workers). Hard reject if found on a worker.
- Every role's `tools:` list contains `handoff` and `end` (§3 contract — every role
  must be able to terminate). Soft warning only: the host force-injects both regardless
  (§8.1), so the run is not broken, but a missing entry signals author intent drift.
- `models:` entries, when present, use the `provider:id` form (§8.1). Hard reject on a
  bare alias — it is ambiguous and defeats `manifest_version` (§10).
- A top-level `version:` integer is present (§10). Hard reject if missing.
- No undeclared role appears as a `target_role` in any persisted event at validation
  time (runtime check, not load-time).

These checks are what "simple to reason about regardless of how complex the workflow
becomes" actually cashes out to: the config is machine-checkable, not just human-readable.

## 14. Deliberately out of scope

- What roles do inside their sessions (tool calls, reasoning, turn counts).
- Whether a role's work is semantically adequate (the orchestrator resolves this by
  re-routing).
- Concurrency / parallel roles (v1 is single-active).
- Inter-agent message bus (roles communicate only via handoff payloads through the
  orchestrator, not directly).
- Worker→worker direct handoffs (structurally forbidden by hub-and-spoke).
- The orchestrator picking models (model assignment is deterministic per-role config).
- How the host spawns sessions is out of scope for the *core* (host-agnostic) — v1
  ships the SDK host driver; an alternate TUI-extension host is future work, not
  blocked by the core.

## 15. Next step

Validate this abstraction before any pi code is written. Suggested order:

1. Review this spec for wrong abstractions (the cheapest fix point).
2. Implement the pure reducer + uniform table + manifest static checks, with unit tests
   covering: every legal transition, every rejection reason, the visit-cap guard,
   manifest validation (missing orchestrator, uncapped worker, undeclared targets), and
   the cost-cap shared-across-fallbacks rule.
3. Wire the SDK host driver: schema-validate at the seam, call `reduce`, persist
   records + checkpoint snapshots, read role config, select models, spawn the next
   role session seeded from the payload. Unit-test the loop against
   `SessionManager.inMemory()` and a stub provider.
4. Define the default orchestrator role and one worker role end-to-end.
5. End-to-end one linear run (orchestrator → worker → orchestrator → `end`) before
   exercising the remediation loop (orchestrator → worker → orchestrator → worker → …
   until the visit cap forces `end`).
