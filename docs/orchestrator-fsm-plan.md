# Implementation Plan: Orchestrator FSM (pure core + manifest checks)

> Derived from `docs/orchestrator-fsm-spec.md`. Read that spec first; this plan does
> not restate it, only sequences it into verifiable tasks.
>
> **Status:** Draft — awaiting human review before any task starts.
> **Scope:** Pure machine core + manifest static checks + unit tests (zero pi deps),
> then the **pi SDK host driver** that hosts it. Host decision (§9.5) is **resolved:
> the pi SDK** (not a TUI extension) — see spec §9.5 for rationale (tool handlers
> receive `ExtensionContext`, which lacks `newSession`; the SDK host makes the
> orchestration loop synchronous and unit-testable).

## Overview

A pure TypeScript library implementing the orchestrator FSM: a uniform hub-and-spoke
transition table, visit-cap guards, manifest static checks, session-lifecycle reduction,
and pure cost/usage roll-up over persisted record shapes. Everything is deterministic
given `(checkpoint, event, def)` where `def: MachineDefinition` is the pinned manifest
snapshot (§12). The deliverable is a tested, importable core that the SDK host driver
consumes unchanged.

## Architecture Decisions

- **Pure core, zero pi deps (§12).** `src/core/` imports nothing from pi. The host
driver (Phase 4) imports the core, never the reverse.
- **Host = pi SDK (§9.5 resolved).** Driver lives in-repo at `src/host/` and imports
`@earendil-works/pi-coding-agent`. It owns the orchestration loop: per role, it calls
`createAgentSession` with that role's `model`, `tools`, and per-role system prompt;
subscribes to the session's event stream to capture `usage` on `message_end` (both
terminals, §11.4) and evaluate caps on `turn_end`; reads the `handoff`/`end` emission
the role's tool captured; calls `reduce`; persists the record + a checkpoint snapshot;
spawns the next role session.
**Ownership is split to avoid a double-reduce / double-persist path:** the
`handoff`/`end` tools (`defineTool()` entries passed via `customTools`) only *validate
the emission at the seam, record it into a per-session capture buffer, and return a
terminating tool result* — they do **not** call `reduce` and do **not** persist. The
loop owns `reduce` + persistence + spawning (so the §9.5
`ExtensionContext`-lacks-`newSession` problem does not arise). Per-role system prompts
are wired via a `DefaultResourceLoader({ systemPromptOverride: () => rolePrompt })`
passed as `resourceLoader` to `createAgentSession` — `systemPromptOverride` is a
`ResourceLoader` option, not a direct `createAgentSession` option. The whole loop is
unit-testable against `SessionManager.inMemory()` and a stub provider — no `pi` CLI,
no manual runs.
- **TypeScript + Vitest.** Spec signatures are already TS; Vitest is TS-native and
fast. Pure functions → table-driven tests dominate.
- **Seam schema = TypeBox, single source of truth (§3 rule 2).** The `handoff`/`end`
`defineTool` parameter schemas are TypeBox (pi's tool-arg format), and the *same*
TypeBox schemas are the seam contract `validateEmission` checks. Zod is **not** used —
the earlier "Zod avoids double truth" claim was wrong because `registerTool`/`defineTool`
params are TypeBox, so Zod would reintroduce a second schema. TypeBox provides the
type (via `Static<typeof schema>`) the reducer's `MachineEvent` derives from, keeping
one schema for tool-args, seam validation, and the derived TS type.
- **Persistence is host-owned, append-only.** The checkpoint (§11.1) and every record
(§11.2–§11.5) are immutable entries the host appends to its own `run_id`-keyed log.
The live checkpoint is reconstructed by reading the latest checkpoint snapshot for the
run. SDK branch scoping is not used for reconstruction; role sessions are independent
`createAgentSession` calls, and branch membership is not a correctness dependency. The
pure core stays free of this: it exposes `RecordLog` as an interface + an in-memory impl
for unit tests only.
- **v1 defaults from §9 are committed:** single-active, per-worker `max_visits`,
per-invocation session cap shared across model fallbacks, hand-to-orchestrator-once
recovery. Not re-litigated in tasks.
- **Reducer does not own cost-cap enforcement (§11.7).** Caps are host guards. The
core only exposes *pure* helpers (usage roll-up, cap-evaluation predicates) so the host
has deterministic building blocks.
- **Repo layout:** a single in-repo package (`pi-conductor`) with `src/core/`
(host-agnostic) and `src/host/` (SDK driver). The grep guard asserts `src/core`
imports nothing from `@earendil-works/pi-coding-agent`; only `src/host/` may.

## Task List

This plan is the canonical index. Each phase is elaborated in its own sub-plan under
`docs/orchestrator-fsm-plans/`; the sub-plans reference back here for Overview,
Architecture Decisions, Risks, Open Questions, resolved hardening decisions, and
whole-plan Verification. Each phase's full task list, acceptance criteria, and
verification live in its sub-plan. Checkpoints are kept here as gates (and duplicated
in the sub-plan as the phase exit) so the gating sequence is readable from one place.

### Phase 1: Foundation — types, manifest, uniform table

➡️ Sub-plan: [`docs/orchestrator-fsm-plans/phase-1-foundation.md`](orchestrator-fsm-plans/phase-1-foundation.md) (Tasks 1–4)

Gate — **Checkpoint A** (foundation verified):
- [ ] `pnpm typecheck && pnpm build && pnpm test` all green
- [ ] A manifest (`.pi/conductor.yaml`) can be parsed and validated against every
      §13 rule, and a `MachineDefinition` derived from it
- [ ] No pi imports in `src/core` or `src/manifest` (grep guard test)
- [ ] Review with human before reducer work

### Phase 2: The pure reducer

➡️ Sub-plan: [`docs/orchestrator-fsm-plans/phase-2-reducer.md`](orchestrator-fsm-plans/phase-2-reducer.md) (Tasks 5–8)

Gate — **Checkpoint B** (reducer verified):
- [ ] Every legal transition + every rejection reason from §7.3 is covered by a test
- [ ] Reducer is pure: same `(checkpoint, event, def, meta)` always yields identical
      result **modulo `meta.ts`** (the only non-deterministic field, which flows into
      `record.ts`). The determinism test fixes `ts` or asserts equality of
      `state`/`effect`/`reason`/`legal_targets` while ignoring `ts`.
- [ ] `meta.role === checkpoint.current_role` is asserted inside `reduce` (§12); a
      mismatch is rejected/thrown, not silently trusted
- [ ] `pnpm typecheck && pnpm build && pnpm test` green
- [ ] Review with human before lifecycle/cost work

### Phase 3: Lifecycle, seam, and pure cost helpers

➡️ Sub-plan: [`docs/orchestrator-fsm-plans/phase-3-lifecycle-seam-cost.md`](orchestrator-fsm-plans/phase-3-lifecycle-seam-cost.md) (Tasks 9–12.5)

Gate — **Checkpoint C** (core complete):
- [ ] Spec §15 step 2 fully delivered: reducer + uniform table + manifest checks, with
      unit tests for every legal transition, every rejection reason, the visit-cap
      guard, manifest validation, and the shared-across-fallbacks cap rule
- [ ] `pnpm typecheck && pnpm build && pnpm test` green; coverage threshold set
- [ ] Public API matches §12 signatures exactly, including the `def` param (export
      audit)
- [ ] Review with human; **this is the gate before SDK host driver work**

### Phase 4: SDK host driver (host = pi SDK, §9.5 resolved)

➡️ Sub-plan: [`docs/orchestrator-fsm-plans/phase-4-sdk-host.md`](orchestrator-fsm-plans/phase-4-sdk-host.md) (Tasks 13–16.5)

Gate — **Checkpoint D** (SDK host driver wired):
- [ ] Legal handoff spawns + seeds the next role session end-to-end (automated test)
- [ ] Illegal handoff is rejected with `legal_targets` surfaced to the role (automated)
- [ ] Orchestrator sees run-memory context each turn (automated)
- [ ] Full linear run passes in CI via the stub provider, no API key
- [ ] Review with human before cost/observability surfaces

### Phase 5: Cost capture, caps, and observability surfaces

➡️ Sub-plan: [`docs/orchestrator-fsm-plans/phase-5-cost-observability.md`](orchestrator-fsm-plans/phase-5-cost-observability.md) (Tasks 17–20)

Gate — **Checkpoint E** (spec §15 steps 3–5 complete):
- [ ] Host: seam-validate → `reduce` → persist → spawn → seed → cap-enforce →
      observe, all via SDK primitives (§15.3), unit-tested in CI
- [ ] Default orchestrator + one worker role defined end-to-end (§15.4)
- [ ] Linear E2E run works: `orchestrator → worker → orchestrator → end` (§15.5), via
      the stub provider in CI
- [ ] Remediation loop exercises the visit cap forcing `end` (§15.5), via the stub
- [ ] Review with human; v1 shippable

### Phase 6 (genuinely out of v1 scope)

➡️ Sub-plan: [`docs/orchestrator-fsm-plans/phase-6-out-of-scope.md`](orchestrator-fsm-plans/phase-6-out-of-scope.md)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Reducer accidentally gains a pi import / I/O | High — breaks host-agnosticism | Grep-guard test in Task 1; CI check `src/core` + `src/manifest` + `src/seam` + `src/cost` import nothing from pi |
| Host driver couples to core internals instead of the public API | Med — erodes the seam | Phase 4 imports only from `src/index.ts`; core types stay the contract boundary |
| Seam schema and reducer disagree on `MachineEvent` shape | Med — double-truth | Single TypeBox schema (Task 9) derives the type the reducer consumes via `Static<>`; same schema is the `defineTool` param schema (Task 14) |
| Reducer reads caps/roles from ambient config instead of `def` | High — breaks determinism | `reduce`/`reduceLifecycle` take `def: MachineDefinition` (§12); determinism test (Checkpoint B) pins `(checkpoint, event, def, meta)` |
| Host supplies mismatched role/session identity | High — role-keyed logic mis-evaluates silently | `reduce` asserts `meta.role === checkpoint.current_role`; `reduceLifecycle` asserts `session_started` role matches `current_role` and terminal lifecycle matches `active_role_session` id+role (§12, Tasks 6/10) |
| Run-cap forced-`end` bypasses the reducer | High — broken audit trail / invariant | Single legal mechanism: host synthesizes a machine `end` event through `reduce`; direct checkpoint mutation forbidden (§11.7, Task 17) |
| Run-cap forced-`end` synthesized while a worker is `current_role` | High — `reduce` rejects `end` from a worker; hard stop silently fails | §12.1 advances `current_role` to the worker before its terminals fire, so a breach on a worker terminal must NOT synthesize `end` immediately. Host defers the forced `end` to the first `current_role === orchestrator` moment (always reached: a worker's only target is the orchestrator), suppressing any new dispatch in between (§11.7, Task 17) |
| `legal_targets` in rejected records is cap-unaware | Med — wrong retry guidance | `declaredTargets` vs `availableTargets` split (Task 5); rejected records use `availableTargets` (Task 7) |
| Checkpoint mutated in place / reconstructed from whole tree | High — silent state corruption on restart | Checkpoint is snapshot-appended + reconstructed from the host-owned `run_id` log (§11.1); SDK branch scoping is explicitly not used; in-memory `RecordLog` (Task 12) models the append-only contract |
| `session_failed` recovery (§8.2, §9.4) leaks into pure core | Med — scope creep | Core only records + does not advance role on retry; recovery policy lives in host (Task 10 enforces, Task 18 implements) |
| Cost-cap "shared across fallbacks" rule mis-implemented | Med — budget loophole | Dedicated predicate test in Task 11 enumerating the multiplier attack |
| Manifest versioning (§10) ignored early → uninterpretable logs later | Low–Med | `manifest_version` pinned on `Checkpoint` + `MachineDefinition` from Task 2/4; never mutated mid-run |
| Two reducers fight over `active_role_session`/`current_role` | Med — checkpoint inconsistency | Composition test (Task 12.5) drives both in real call order before the host is built |
| SDK `message_end` usage shape differs from §11.4 `usage` block | Med — cost caps silently wrong | **Resolved/pinned:** `message.usage` is camelCase + nested `cost.total` + `totalTokens` (`sdk-surface.md` §3). Task 17 maps to §11.4 explicitly, guards `message.role === "assistant"`, and sums across the session's assistant `message_end`s; stub (Task 16) emits canned usage in the SDK shape so the mapping is asserted in CI |
| Persisted host records drift from §11 record shapes | Med — uninterpretable logs | Task 14/17/16 assert persisted record shapes match §11.2–§11.5 exactly (via the stub-driven E2E test) |

## Open Questions / Resolved Decisions

Only items 3–4 still need human confirmation before Task 1. Struck-through items are
resolved decisions kept here for provenance so implementers do not re-open them.

1. ~~Zod vs. hand-rolled seam schema~~ — **Resolved: TypeBox** (single source of truth
   with `defineTool`; see Architecture Decisions). Zod rejected because pi tool params
   are TypeBox.
2. ~~Manifest source~~ — **Resolved: `.pi/conductor.yaml`** (single YAML file; see spec
   §8). Per-role frontmatter rejected for v1 (cross-file version agreement problem).
3. **Coverage threshold.** Propose 90% lines / 85% branches for `src/core` +
   `src/manifest` + `src/seam` + `src/cost`. Confirm or adjust. (Host coverage not
   gated by this threshold — stub-provider coverage is the host gate.)
4. **Package manager.** Assumed pnpm (matches pi ecosystem). Confirm.
5. ~~Extension scope (project-local vs. global)~~ — **N/A under the SDK host.** The
   host is an in-repo `src/host/` package; there is no extension install path in v1.

### Resolved Pre-Phase-4 Hardening Decisions

Promoted from `docs/sdk-surface.md` spike rows + this review. These are closed and
should be treated as implementation constraints unless the spec changes:

6. ~~**Usage/cost event shape (blocks Task 17).**~~ **Resolved** via `dist/**/*.d.ts`
   inspection (`docs/sdk-surface.md` §3, spec §11.4 SDK-mapping note). `usage` is on
   `message.usage` (`AssistantMessage`), camelCase with a nested `cost` object:
   `cacheRead`/`cacheWrite`/`totalTokens`/`cost.total`. Two implementation rules now
   pinned: guard `message.role === "assistant"` (message_end fires for non-assistant
   messages too), and the per-session `usage` is the **sum across** the session's
   assistant `message_end` events. Task 17 maps to the §11.4 normalized record; Task 16
   stub must emit canned usage in the camelCase/nested-`cost` SDK shape.
7. ~~**Role-session branch scoping (blocks Task 13).**~~ **Resolved: host owns a
   `run_id`-keyed append-only log; `getBranch()` scoping is not used at all** (spec
   §11.1 updated, `docs/sdk-surface.md` §6). This makes checkpoint reconstruction
   branch-independent and removes the need to confirm `SessionManager` branch semantics
   for spawned sessions — the prior blocker dissolves rather than being answered.
8. **Forced-`end` / steer-ignored (blocks Task 17).** Closed by spec §11.7 / Task 17:
   the authoritative close is a synthesized `end` event through `reduce`, not a steer.
   A steer is courtesy-only. **Refinement (this review):** the synthesized `end` must
   only be fed to `reduce` when `current_role === orchestrator` — a breach detected on
   a worker terminal defers the close until control returns to the orchestrator, since
   `end` from a worker is rejected (§7.2/§12.1). Owner: spec edit done; implementer
   confirms both the synthesized-event path **and** the worker-deferral guard are
   tested (no rejected `end` record on a worker-terminal breach).
9. **Model resolution form (blocks Task 13/15).** Closed by spec §8.1: `models:` uses
   `provider:id`, resolved via `modelRegistry.find(provider, id)`. Bare aliases hard-
   rejected by §13. Owner: spec edit done; implementer wires the resolver in Task 15.

## Verification (whole plan)

- [ ] Every task has acceptance criteria + an automated verification step (no "Manual"
      only tasks remain)
- [ ] Checkpoints A–E each gate the next phase
- [ ] `src/core` + `src/manifest` + `src/seam` + `src/cost` have zero pi imports
      (grep-guarded); only `src/host/` imports `@earendil-works/pi-coding-agent`
- [ ] Host driver is unit-tested against `SessionManager.inMemory()` + a stub provider
      (no `pi` CLI, no API keys required for CI)
- [ ] Human has reviewed and approved before Task 1 begins
