# Implementation plan: issue #139 host-materialized phase work packets

Authority: issue #139. If this plan conflicts with its acceptance criteria, the
issue is authoritative.

## Outcome

Before every **fresh FSM role prompt**, the host supplies one bounded,
deterministic phase work packet. It gives a recipient the process state needed
to act without reconstructing it from a predecessor transcript. It is a
host-owned seed section, never part of the role-emitted handoff payload.

The packet has three visibly separate authority domains:

- `phase_process`: facts the host can derive from the FSM, dispatch trigger,
  review-gate records, and checkpoint;
- `host_observed`: facts copied from host-owned evidence records, with their
  source record keys and explicit unavailable/omitted markers;
- `reported_narrative`: bounded model-reported objective, requested action, and
  return hints. These are useful assignment context, but never process facts or
  verification results.

A packet is authoritative only for its `phase_process` and `host_observed`
sections. It must say `unavailable`, `not_configured`, or `blocked` rather than
invent a value.

## Design decisions

1. **The packet is a host seed, not a handoff extension.** The accepted-handoff
   payload is model-authored and seam-validated. Adding a host packet to it
   would blur provenance and let the packet appear to originate with the
   sender. The loop appends a separately labelled `host_phase_work_packet`
   section after it has selected the ordinary fresh seed.
2. **The core remains uninvolved.** The reducer stays payload-blind. The packet
   type, schema, projection, and record live in `src/persistence`/`src/host`,
   not `src/core/types.ts`.
3. **Persist the dispatch-time projection.** A `phase_work_packet` record stores
   the canonical JSON-safe packet, rendered text, its bounded byte count, and
   immutable source identities. Resume reuses that exact record for the same
   dispatch. If a crash occurred before it was appended, the host may
   materialize it once from the same immutable source cutoff before prompting.
   It must never re-render an old packet against later records.
4. **Existing evidence is projected, not recollected.** Review records provide
   gate/decision/check facts; issue #135 handoff-evidence records provide
   observed worktree and command facts when that policy was enabled. This work
   adds no verification executor and no parallel gate-state authority.
5. **Absence is meaningful.** A missing typed reviewer decision is
   `incomplete`/`blocked`, never approval inferred from prose. Contradictory or
   uncorrelatable required process records block dispatch with a typed
   materialization error; optional facts render with a stable unavailable
   reason.
6. **Agent return narrative is optional enrichment.** A mechanically valid
   handoff remains acceptable when a small model omits narrative fields or
   places them in unknown fields. The host ignores unsupported fields, records
   diagnostics, and projects the known dispatch directive, phase/review facts,
   and legal process actions to the fresh recipient. Missing narrative renders
   as unavailable; it is not retried, treated as a contract breach, or allowed
   to manufacture phase completion. Role prompts may still request concise
   operational narrative, but that is guidance rather than an advancement gate.
   Only an unparseable machine event or an invalid routing target prevents a
   safe handoff.

## Field authority and source matrix

| Packet field | Source and correlation | Authority / absent behavior |
|---|---|---|
| packet identity, recipient role, visit index | current checkpoint plus dispatch trigger | host-derived; essential mismatch blocks dispatch |
| dispatch trigger | initial run seed, accepted transition identity, or review-route identity | host-derived; essential mismatch blocks dispatch |
| active phase | matching `review_gate_pinned` / review route when one exists; otherwise FSM role visit | host-derived; ordinary ungated work is `fsm_visit`, not a fabricated named phase |
| gate state | matching `review_decision`, `review_incomplete`, approval invalidation, and route records | host-derived; no terminal decision is `incomplete` and blocked |
| legal process action | checkpoint + pinned `MachineDefinition` legal targets/end authority; review route when present | host-derived; it describes legal routing, not a semantic model verdict |
| host directive | accepted-control v2 task directive or initial-run directive | host-authored; unavailable on legacy records |
| objective, requested action, summary/reason | accepted-control v2 / accepted handoff | `reported_narrative`; bounded and labelled untrusted; missing or ignored model fields are explicit unavailable entries |
| revision, dirty/changed paths, command results | correlated issue #135 `handoff_evidence` record | host-observed only when present; otherwise `not_configured` or `unavailable` |
| verification entries | review `evidence.checks` and eligible host-observed command captures, each with source key and raw outcome | host-observed; no model claim can yield `passed` |
| required inspection paths | a host-pinned review-gate/host directive only | unavailable unless a host-owned source explicitly provides it; model path lists remain reported narrative |
| omissions/blockers | projection bounds and failed/unavailable source resolution | host-derived with stable reason codes; missing agent narrative is an omission, not a process blocker |

`stage`, a generic semantic “next action,” and a universal `phase_id` are not
independent FSM facts. The packet instead uses a discriminated process state:
`review_gate` (with its pinned phase/gate IDs) or `fsm_visit` (role and visit
index). This avoids representing model-proposed stages as host authority.

## Packet and persistence contract

Create a strict TypeBox `PhaseWorkPacketRecord` in
`src/persistence/phase-work-packet.ts` and add it to the central
`PersistedRecord` union and record-materialization validation path. It is
append-only and keyed by:

```text
run_id + recipient_role + recipient_visit_index + dispatch_source
```

`dispatch_source` is one of `initial_run`, `accepted_handoff`, or
`review_route`, and contains the source record's durable identity (including
its timestamp/role/session identity where applicable). The record includes:

- `schema_version`, identity, source identities, and a deterministic source
  cutoff definition;
- structured `phase_process`, `host_observed`, `reported_narrative`, and
  `omissions` sections;
- rendered packet text, `utf8_bytes`, `max_utf8_bytes`, and omission counts;
- a status of `ready` or `blocked` plus stable block/omission reason codes.

The renderer has one explicit UTF-8 budget. It retains identity, process/gate
state, and blockers first; then host-observed verification; then reported
narrative. Dropped optional entries increment typed omission counters. It never
silently truncates strings or lets reported narrative displace process state.

The packet must be JSON-safe, TypeBox-validated at append/replay, and contain
no full transcripts, raw diffs, or unbounded command output. Existing #135
redaction and bounds apply to evidence copied from its records.

## Dispatch and resume protocol

The loop owns this sequence immediately before each fresh `session.prompt`:

1. Resolve the receiving role/visit and the durable dispatch source.
2. Look up an exact matching `phase_work_packet` record.
3. If found, validate identity and append its saved rendering to the selected
   ordinary seed.
4. If absent, project strictly from records at the source cutoff, persist one
   packet record, then append its rendering.
5. If essential process sources conflict or cannot be correlated, do not prompt
   the role; surface a typed materialization error and leave an inspectable
   blocked record. Optional evidence and absent/ignored agent narrative render
   explicitly instead; neither causes a model retry or a handoff rejection.

This single seam must cover initial dispatch, ordinary accepted handoffs,
review-route recovery/synthetic hops, public restart/resume, and fresh fallback
sessions. Trajectory continuations are not fresh recipients and do not receive
a new packet; their existing transport remains unchanged. A resumed fresh role
must receive byte-identical packet rendering to the live dispatch associated
with the same identity.

## Reconstruction-signal scope

Signals are observability only; they neither reject tool calls nor claim to
observe all repository reads. Add a bounded `reconstruction_signal` persistence
record and emit it from host tool interception before a fresh recipient's first
terminal machine event. It stores packet identity, role/visit, signal kind, a
redacted/hash-only command fingerprint where applicable, and timestamp.

The initial classifier is deliberately conservative and documented:

- `broad_find`: host-observed `bash` invocation whose parsed command is `find`
  over `.`/the workspace without a restrictive `-maxdepth`;
- `wide_rg`: host-observed `bash` invocation whose parsed command is `rg` with
  no path or `.`/the workspace as its search root;
- `predecessor_context_read`: an invocation of the host-mediated
  `handoff_context` tool.

Direct filesystem reads outside host-mediated tools are unobservable and must
not be reported as absent signals. Command parsing/redaction and the thresholds
are unit-tested; the metric is a heuristic, not an enforcement mechanism.

## Acceptance criteria mapping

| Issue criterion | Planned implementation |
|---|---|
| Live and resumed fresh recipients receive a bounded deterministic packet | strict packet record + one pre-prompt composition seam; exact-record reuse on resume |
| Process, reported narrative, and #135 evidence remain distinct | three explicit sections and field-source matrix |
| Orchestrator can route without transcript verdict inference | legal targets and gate state project from checkpoint/review records; missing verdict blocks |
| Verification is host-observed | only review evidence/checks and #135 captures may populate verification entries |
| Bounded, omission-aware rendering | one UTF-8 renderer and typed omission reasons |
| Prompt guidance reduces broad rediscovery | role prompt/`AGENTS.md` instructions reference the packet first, including when model-returned narrative is unavailable, while allowing a stated omission/contradiction |
| Reconstruction can be measured | bounded host-tool interception signals with explicit blind spots |

## Phase map (TDD, sequential)

### Phase 1 — record contract and pure projection

- [x] **RED:** add `tests/persistence/phase-work-packet.test.ts` covering the
  source matrix: ordinary FSM visit, review-gate phase, absent reviewer verdict
  (`incomplete`), contradictory required records (`blocked`), optional missing
  #135 evidence, reported-vs-host-observed separation, byte bounds, and
  deterministic rendering from an explicit record cutoff. Run
  `pnpm exec vitest run tests/persistence/phase-work-packet.test.ts`; expect
  failure because the schema/projection does not exist.
- [x] **GREEN:** add `src/persistence/phase-work-packet.ts`, wire the strict
  record into `src/persistence/log.ts`, `src/persistence/record-materialization.ts`,
  `src/persistence/in-memory-log.ts`, and public exports as appropriate. The
  pure projection accepts records and an explicit dispatch-source identity; it
  performs no I/O and does not import pi.
- [x] **Acceptance:** only declared record sources populate authoritative
  fields; missing optional sources are explicit; essential ambiguity yields a
  typed blocked result; a model-reported verification string cannot become
  `passed`.
- [x] **Verify:** focused suite, `pnpm typecheck`, `pnpm lint`.

### Phase 2 — durable pre-prompt packet delivery

- [x] **RED:** add focused live/restart cases (new
  `tests/host/phase-work-packet.test.ts`, keeping unrelated `loop.test.ts`
  small): initial dispatch, accepted handoff, synthetic review route, fallback
  fresh session, and restart after packet persistence. Include a mechanically
  valid sparse return and a return with narrative under ignored/unknown fields:
  the host must preserve its diagnostics, render reported narrative as
  unavailable, and seed the fresh orchestrator with the prior host directive,
  phase/review facts, and legal process action without retrying or rejecting the
  sender. Assert one packet record per dispatch identity, a byte-identical
  resumed seed, and no packet added to `accepted_handoff`/accepted-control
  payloads.
- [x] **GREEN:** add a narrow host materializer/composer and wire the one
  pre-prompt seam in `src/host/loop.ts` and the established resume/review
  recovery paths. Extend `Host` only with the minimum packet lookup/materialize
  capability required for deterministic fakes and production. Do not alter
  reducer inputs or handoff schemas.
- [x] **Acceptance:** a crash before packet append can materialize once from
  the defined cutoff; a crash after append reuses it; contradictory essential
  sources do not silently prompt a recipient; sparse or ignored agent narrative
  does not block a mechanically valid handoff or erase host-derived process
  context.
- [x] **Verify:** focused suites, four foreground Vitest shards,
  `pnpm typecheck`, `pnpm lint`.

### Phase 3 — prompt guidance and reconstruction telemetry

- [x] **RED:** add `tests/host/reconstruction-signals.test.ts` for each
  classifier, redaction/bounds, and explicit non-observability; add
  `tests/host/role-prompt-integration.test.ts` asserting the delivered prompt
  names the host packet first and permits a broad scan only after a precise
  omission or contradiction is identified.
- [x] **GREEN:** add the bounded telemetry record/classifier and interception
  wiring; update role prompt templates and `AGENTS.md`. The prompt must retain
  the requirement to read `AGENTS.md` and the named plan.
- [x] **Acceptance:** signals are audit-only, bounded, and cannot expose raw
  commands/secrets; prompt text does not forbid necessary investigation.
- [x] **Verify:** focused suites, `pnpm typecheck`, `pnpm lint`.

### Phase 4 — final integration and independent review

- [x] **Regression coverage:** prove #137 reported reasons remain reported
  rather than host facts; sparse/ignored return narrative is explicitly
  unavailable while prior host directives and review facts remain usable;
  #135-disabled runs render explicit evidence absence; #135-enabled and
  review-gated runs preserve source correlation; legacy runs without a packet
  can materialize only from an unambiguous source or fail closed.
- [x] **Repository gates:** `pnpm typecheck`, `pnpm build`, four foreground
  `pnpm exec vitest run --shard=1/4` … `--shard=4/4`, `pnpm lint`,
  `pnpm format:check`, and `pnpm audit --audit-level high`.
- [x] **Review gate:** independently verify provenance separation, cutoff
  determinism, resume idempotency, missing-verdict blocking, telemetry blind
  spots, and no reducer/handoff-payload regression.
- [x] **Completion:** tick only performed boxes; add a CHANGELOG entry if the
  public persistence contract is exported.

## Failure handling

| Trigger | Disposition |
|---|---|
| Missing reviewer terminal decision | Render `incomplete`/`blocked` from `review_incomplete` or a deterministic absence classification; never infer approval from prose |
| Conflicting/mismatched essential dispatch or review identities | Persist/return typed blocked materialization result; do not prompt the recipient; operator inspects the log |
| Missing optional evidence, #135 disabled, or sparse/ignored agent narrative | Render `not_configured`/`unavailable` with reason; continue only if process state is otherwise sound |
| Packet record exists but fails schema/identity validation | Fail closed; do not substitute a nearby packet or regenerate against later records |
| Telemetry capture/classification fails | Persist a bounded unavailable signal if possible; never affect machine routing or packet authority |

## Deliberately out of scope

Model-authored continuity packets (#123), new host verification-command
execution, re-collecting #135 evidence, delegated-child continuity, changes to
the reducer or handoff schema, and model/provider routing changes are out of
scope. Existing #137 return narrative remains unchanged except that its already
persisted reported fields may be projected under `reported_narrative`.

## Dependency order and risks

Projection and persistence are the foundation; delivery depends on them;
telemetry/prompt guidance follows delivery. These phases are sequential because
they share one record identity and rendering contract.

| Risk | Mitigation |
|---|---|
| Treating model prose as an authoritative phase fact | field-source matrix, discriminated process state, and negative tests |
| Resume produces a different packet | durable dispatch identity, source cutoff, and byte-identical replay tests |
| Duplicate review/evidence authority | project existing review/#135 records only |
| Telemetry overclaims observability or leaks command content | host-tool-only scope, conservative classifier, redacted/hash-only records |
| Packet becomes a historical diary | fixed UTF-8 budget, priority order, typed omissions |
