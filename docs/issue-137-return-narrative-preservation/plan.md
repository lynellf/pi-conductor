# Implementation plan: issue #137 preserve supported worker-return narrative in fresh handoff context

Authority: Forgejo issue [#137](https://git.eznas.link/lynellf/pi-conductor/issues/137).
If this plan conflicts with the issue's acceptance criteria, the issue is
authoritative.

## Outcome

A fresh orchestrator seed must receive the accepted worker return's *supported*
narrative fields — most importantly a non-empty `reason` — after both a live
handoff and a restart/resume. The returned narrative is delivered as clearly
labelled **reported/untrusted** context. Host-observed continuity remains a
separate, authoritative evidence channel.

The supporting ground truth for this plan (issued run
`c361e0c9-f024-43da-a2ae-50594fd64e14`, issue #135): an implementer returned
from a Phase-2 slice with a non-empty `reason` and custom outcome fields
(`phase`, `tdd_stage`, `changed_paths`, `red_*`, `green_*`). The host accepted
the transition, the accepted-control record retained `reported_hints.reason`,
and the custom fields were recorded as ignored — yet the fresh orchestrator
seed rendered the return as `worker omitted reason`, and its primary reported
context degraded to a generic final message instead of the return's
substantive narrative. Recovery relied on host continuity (changed paths,
execution dispositions, omissions, source-session reference) plus the
orchestrator inspecting the repository and prior session. That is graceful
degradation, not a high-signal return handoff.

## Acceptance criteria (issue #137) → this plan's mapping

| Issue criterion | Where it lands |
|---|---|
| A non-empty `reason` yields a fresh seed including it (live + resume) | `buildLastMessage` + `formatRunMemorySeed` (`src/core/run-memory.ts`); v2 continuity seed (`src/persistence/work-observation-seed.ts`); resume via `formatIncomingHandoffSeed`/`formatRunMemorySeed` |
| Seed never labels a supplied non-empty `reason` as omitted | mandatory inclusion of the returned `reason` in both seed surfaces; `LastMessage.text` never reads `(worker omitted reason)` when a reason is present |
| One documented, schema-validated return envelope for supported narrative fields | seam return-envelope validation (`src/seam/schema.ts`, `src/seam/control-arguments.ts`); core types (`src/core/types.ts`) |
| Unsupported fields rejected with a bounded retriable seam diagnostic, OR explicitly reported as ignored before terminal handoff; must not silently displace supported fields | seam ignored-field handling (`src/seam/control-arguments.ts`); run-memory + operator rendering surfaces the ignored list |
| Host-derived observations stay visually/semantically distinct from reported narrative | seed labels; `reported reason:`/`reported hints:` sections separate from host-observed fields |
| Regression tests cover Phase-2-style return, live delivery, replay/resume, omitted reason, unknown-field behavior | `tests/persistence/return-narrative.test.ts`, `tests/seam/return-envelope.test.ts`, `tests/host/run-memory-return.test.ts` |

## Root cause (why the reason degrades)

There are two fresh-orchestrator seed surfaces, and the returned worker's
`reason` is not surfaced in either:

1. **Run-memory artifact** (`src/core/run-memory.ts` `buildLastMessage`,
   rendered by `src/host/run-memory.ts` `formatRunMemorySeed`, wired at
   `src/host/loop-session-accepted.ts:339` and `src/host/loop.ts:235`).
   `buildLastMessage` reads `accepted_control.reported_hints.summary` and
   `payload_summary.reason`, but **never reads**
   `accepted_control.reported_hints.reason`. When `summary` is absent and
   `payload_summary.reason` is empty, `text` becomes `null` and the seed prints
   `worker omitted reason`. The returned `reason` is retained on the persisted
   control envelope but is dead weight on this read path.
2. **Host-generated v2 continuity seed** (`src/persistence/work-observation-seed.ts`
   `renderMandatory`/`renderObservation`, rendered into
   `loop-session-accepted.ts` `hostGeneratedSeed.rendered`). It surfaces
   host-observed facts (`changed_paths`, `execution_statuses`, `artifact_labels`,
   `reported context`) but **not** the returned worker's `reported_hints.reason`.

Both surfaces are built from the same accepted-control record, so the fix is
symmetric: read the supported `reason` off that record and render it
deterministically as reported context in both.

## Scope

**In scope:** the worker→orchestrator return-transport contract and the two
fresh-orchestrator seed surfaces. Specifically:

- `src/core/run-memory.ts` — `buildLastMessage` surfaces the returned worker's
  supported `reason` (accepted-control `reported_hints.reason`, then
  `payload_summary.reason`); `LastMessage` carries it; never null-omit a present
  reason.
- `src/host/run-memory.ts` — `formatRunMemorySeed` `last_message` block renders a
  `reported hints:` sub-block (`reason`/`summary`/`verification`) and an
  `ignored optional fields:` line, labelled reported/untrusted and distinct from
  the host continuity section.
- `src/persistence/work-observation-seed.ts` — the returned worker's
  `reported reason` is a mandatory inclusion of the v2 seed (before the
  byte budget truncates historical observations); labelled reported/untrusted;
  separate from host-observed fields and `reported context`.
- `src/persistence/work-observation.ts` / `work-observation-report.ts` — operator
  JSON/markdown render surfaces `reported hints` (esp. `reason`) and the ignored
  field list for a `role_return` observation.
- `src/seam/schema.ts` / `src/seam/control-arguments.ts` — one documented
  return envelope: supported narrative fields are `reason` (primary), `summary`,
  `verification`; unsupported custom fields (e.g. `phase`, `tdd_stage`,
  `changed_paths`, `red_*`, `green_*`) are recorded in a stable, explicitly
  reported `ignored` list (issue option B) and never silently displace the
  supported `reason`. A stable diagnostic name is surfaced for each ignored
  field so a role can self-correct.
- `src/host/accepted-control-v2.ts` — the production worker-return promotion
  path uses the return-envelope parser; it persists compatible field names plus
  additive stable diagnostics before the accepted transition is logged.
- `src/persistence/accepted-control-v2.ts` — the persisted accepted-control
  schema validates the additive diagnostic list and its UTF-8 bounds.
- `src/core/types.ts` — any `AcceptedControlV2`/`LastMessage`/`WorkObservationV2`
  shape additions (all additive; no reducer dependency).

**Out of scope:** the model-authored `continuity` packet (issue #123), the
host-materialized handoff-evidence slice (issue #135), delegated child
continuity, model-management/remote-provider routing changes, and any change to
the reducer's payload-blind path.

## Why option B (explicitly reported) over option A (seam rejection)

The issue allows either "rejected with a bounded retriable seam diagnostic"
(option A) or "explicitly reported as ignored before terminal handoff" (option
B). This repo already records unsupported fields on the persisted accepted
control envelope as an ignored list and renders them to the operator; changing
the worker return into a hard `schema_invalid` breach (option A) would reroute a
clean `session_ended` to `session_failed`, consuming a visit and a model
fallback purely on field-shape grounds. That is a large blast radius for a
contract refinement. Option B is the contained, additive choice: keep the
return flowing, make the supported `reason` authoritative in the seed, and make
the ignored list first-class and visible to the orchestrator (not just the
operator view). The fixed criterion "must not silently displace supported
fields" is satisfied because the supported `reason` is now mandatory in the seed
and the ignored list is surfaced to the orchestrator.

## Phase map (TDD, gated)

Change is tightly coupled (the seam return-envelope contract feeds the core
`buildLastMessage` read and the v2 seed render; all three read the same
accepted-control record). Concurrency would duplicate the contract across
workers and risk drift, so phases are sequential — the honest speed choice for a
coupled fix is one implementer owning the seam→core→host chain end to end.

### Phase 1 — return-envelope contract + durable reason carry

- [x] **Behavior slice / acceptance:** supported return fields = `reason` (primary),
  `summary`, `verification`; custom fields recorded in a stable, explicit
  ignored list; `reported_hints.reason` survives on the persisted accepted
  control and is reconstructable on resume.
- [x] **RED change / command / expected failure:** new test
  `tests/seam/return-envelope.test.ts`. RED case: a worker return with only a
  non-empty `reason` (no `summary`) yields a supported return envelope carrying
  that reason; run
  `pnpm exec vitest run tests/seam/return-envelope.test.ts`; expect it to fail
  until the return-envelope validation surfaces `reason` (and the ignored list
  is reported). Also add `tests/persistence/return-narrative.test.ts` asserting
  the returned `reason` is carried on the persisted accepted-control record and
  reconstructs on replay.
- [x] **GREEN scope / owned files:** `src/seam/schema.ts` (return envelope),
  `src/seam/control-arguments.ts` (supported + ignored return fields, stable
  diagnostic name), and `src/persistence/accepted-control-v2.ts` for bounded
  diagnostic validation. The production promotion wiring is covered by the
  Phase 3 remediation below.
- [x] **REFACTOR boundary:** additive; no reducer path touched; no exported signature
  removals.
- [x] **Repository gates:** focused shard above green, `pnpm typecheck`, `pnpm lint`.
- [x] **Owners:** test + implementer = implementer; reviewer = reviewer.

### Phase 2 — deterministic rendered narrative (live + resume)

- [x] **Behavior slice / acceptance:** a non-empty returned `reason` appears in the
  fresh orchestrator seed (live handoff and resume) and is never labeled
  omitted; it renders as reported/untrusted distinct from host continuity.
- [x] **RED change / command / expected failure:** new test
  `tests/host/run-memory-return.test.ts`. RED case: a worker return with only a
  non-empty `reason` produces a run-memory seed whose `last_message` shows the
  reason (not `worker omitted reason`) and whose continuity seed carries the
  reported reason; run
  `pnpm exec vitest run tests/host/run-memory-return.test.ts tests/persistence/return-narrative.test.ts`;
  expect failure until both surfaces render it.
- [x] **GREEN scope / owned files:** `src/core/run-memory.ts` (`buildLastMessage`,
  `LastMessage`), `src/host/run-memory.ts` (`formatRunMemorySeed` last_message
  block), `src/persistence/work-observation-seed.ts` (mandatory reported reason),
  `src/persistence/work-observation.ts` / `work-observation-report.ts` (operator
  view), and resume wiring via `formatIncomingHandoffSeed`.
- [x] **REFACTOR boundary:** byte-budget of the v2 seed preserved; the returned
  `reason` is mandatory and counted in `omitted` only if it itself is truncated.
- [x] **Repository gates:** focused shard above green, plus the four foreground
  shards `pnpm exec vitest run --shard=1/4`…`--shard=4/4`, `pnpm typecheck`,
  `pnpm lint`.
- [x] **Owners:** test + implementer = implementer; reviewer = reviewer.

### Phase 3 — integration, full-suite gate, final independent review

- [x] **Behavior slice / acceptance:** full regression coverage; no behavior
  regression on legacy returns (no reason) or on dispatch; byte-identical seed
  when continuity policy absent.
- [x] **RED change / command / expected failure:** new `tests/persistence/return-narrative.test.ts`
  resume + legacy cases and `tests/seam/return-envelope.test.ts` unknown-field
  cases; expect them to fail until Phase 2 lands them. **Phase 3 RED state:**
  the Phase 1 + Phase 2 RED tests already cover resume / legacy / unknown-field
  scenarios (46 cases across the three new files); Phase 3 adds three
  cross-phase integration cases (`formatRunMemorySeed` × resume, byte-identical
  legacy `text:` line, byte-identical seed when no continuity policy is
  supplied) and they pass immediately on this commit because Phase 2's
  implementation is verified correct.
- [x] **GREEN scope / owned files:** the new tests from both phases, the
  production promotion path (`src/host/accepted-control-v2.ts`), persisted
  diagnostics (`src/persistence/accepted-control-v2.ts`), observation/seed
  propagation, plus `docs/issue-137-return-narrative-preservation/report.md`.
- [x] **Repository gates:** `pnpm typecheck`, `pnpm build`,
  `pnpm exec vitest run --shard=1/4`…`--shard=4/4`, `pnpm lint`,
  `pnpm format:check`, `pnpm audit --audit-level high`, CHANGELOG entry, this
  plan's checkboxes ticked for work actually done.
- [x] **Review gate:** final independent review — APPROVED; compatibility and production-path remediation were re-reviewed after the final test run (see below).

### Production-path remediation after initial review

- [x] Connect `parseReturnEnvelope` to `createAcceptedControlV2` for worker
  returns; keep `reason`, `summary`, and `verification` separate from the
  broader task-context sanitizer.
- [x] Persist stable `ignored_return_field:<name>` diagnostics in an additive
  accepted-control field while preserving the existing ignored-name list.
- [x] Cover direct promotion, bounded persistence, observation-seed
  propagation, and the real `StubHost`/`runLoop` handoff path.

## Failure-route table (verified abort path)

| Trigger | Current role | Remaining legal targets | Max retries | Next owner | Disposition |
|---|---|---|---|---|---|
| Implementer `model_error` on all fallbacks | implementer | handoff→orchestrator with `status: blocked` | 1 per phase | orchestrator | repair (orchestrator re-dispatches a different fallback model path) |
| Implementer visit cap exhausted mid-phase | implementer | handoff→orchestrator `status: blocked` | — (cap reached) | orchestrator | operator escalation if no alternative; else end |
| Reviewer `request_changes` at final remediation visit | reviewer | handoff→orchestrator `status: blocked` | — | orchestrator | operator escalation |
| Guard rejection leaves empty candidate set | any | none (reducer rejects) | 0 | — | stop; report stuck checkpoint + `/conduct:abort` |
| No legal target on return (worker `end`) | worker | end rejected; handoff→orchestrator only | — | orchestrator | repair / operator escalation |
| Uncertain cleanup after a bounded command | implementer | (none automated) | — | operator | external abort; no auto-replay |

External abort: `/conduct:abort` plus log inspection. No role may fabricate a
takeover, repeat a rejected handoff, or claim `status: blocked` changes the
FSM.

## Model routing (speed)

Speed uses remote (non-`omlx`) models verified against `pi --list-models`.
Concrete `provider:id` forms only — dynamic `openrouter:~…` "latest" aliases are
rejected by the manifest (they defeat the pinned `manifest_version`).

**Provider priority.** Each role's three-model chain is ordered by ascending
account pressure, the preference hierarchy in the
`pi-conductor-role-orchestration` skill's "External subscription and
paid-routing inventory": minimax → openai-codex → opencode-go → openrouter
(see `references/model-routing.md`). Minimax has the lowest pressure
(generous rolling allowance), so it is the primary on every role; higher-
pressure providers escalate as fallbacks so cheaper routes are consumed first.

Distinct primary + two verified fallbacks per role, spread across providers so
a single provider outage is not a single point of failure:

- Orchestrator: `minimax:MiniMax-M3` + `minimax:MiniMax-M2.7` +
  `openai-codex:gpt-5.6-terra` (reliability-critical hub: two cheap minimax
  fallbacks, then a strong cross-family openai. Swap M2.7 for a second openai
  (`gpt-5.6-luna`/`gpt-5.6-terra`) if you would rather the hub never fall back
  to a weaker model — but then it reaches openai before the second minimax).
- Implementer: `minimax:MiniMax-M3` + `openai-codex:gpt-5.6-terra` +
  `opencode-go:mimo-v2.5` — the strict 3-tier order. `mimo-v2.5` is the only
  normally-admissible Go route (skill: single, deliberately budgeted Go task);
  its two other fallbacks (M3, terra) are non-Go, as required. Openai-codex is
  deliberately skipped on the reviewer (see below) but used here; this keeps
  scarce openai budget for strategy/review roles. Effort `medium` on mimo to
  bias it toward raw speed for this narrow fallback.
- Reviewer: `minimax:MiniMax-M3` + `openai-codex:gpt-5.6-sol` +
  `openrouter:anthropic/claude-sonnet-4.6`. Opencode-go is skipped (it is an
  implementation route, not a review route per the skill). The final slot is
  `openrouter` break-glass only: not an automatic fallback — it requires
  explicit operator authorization, a dollar cap, and a stated reason; it is a
  last resort when subscribed (minimax/openai) routes cannot complete a
  consequential review.

Exact model IDs are pinned in `.pi/issue-137.yaml`; do not change provider
configuration from this plan. Verify live residency before dispatching each
candidate (latency/capacity are not verifiable here, and the fallbacks are
not preloaded). Effort is the speed lever: `high` defaults to correctness-
critical roles; lower any role to `medium`/`low` where raw speed outweighs
reasoning depth. Note the skill's `max` effort is available on models that
support it (e.g. GPT-5.6); not needed for a fast fix, but worth knowing if you
want to dial up reasoning on the reviewer.

**Account-pressure caveats (cannot be closed from here):** openai-codex is a
scarce $20-plan resource (~$200 inference/week); opencode-go has a low Go
allowance; openrouter is pay-as-you-go break-glass. Revalidate availability with
`pi --list-models` before the run, and report every remote route and its budget.

## Context-enrichment disclosure (asked, not assumed)

`context_enrichment` is **omitted** from `.pi/issue-137.yaml` pending an
operator answer. See the closing question. If accepted, the manifest gains the
strict `context_enrichment` block (matching `continuity.schema_version`),
verified against the installed runtime before generation.
