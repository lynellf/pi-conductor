# Phase 1 — Foundation: Host-Agnostic Types, Schemas, Records, Cost

**Source:** [`../plan.md`](../plan.md); senior spec
[`./spec.md`](./spec.md). Phase 1 lands the host-agnostic surface that
Phase 2 (host delegation) and Phase 3 (lifecycle + recovery) build on.
Every change in this phase is **additive**: existing manifests (no
`delegation:` block) parse and validate identically; existing
`PersistedRecord` consumers and the cost rollup gain additive fields
but never lose existing ones.

## Goal

Extend the parsed manifest with an opt-in `delegation` policy block on
roles; expose two new TypeBox schemas at the seam (`delegate` parent
input, `report_result` child output); add three new `PersistedRecord`
variants (`subagent_started`, `subagent_completed`, `subagent_failed`);
extend the cost rollup to integrate child terminal usage with no
double-attribution; ship pure tests for all of the above.

## Spec pointers (senior spec)

- §6 (manifest contract) — additive `roles[].delegation` shape
- §7.1 (parent `delegate` input schema)
- §7.2 (child `report_result` schema)
- §9 (persistence and accounting — record variants + cost rollup changes)
- §12.1 (invariants — reducer is uninvolved; FSM is payload-blind)
- §13 (compatibility — additive; existing manifests unchanged)
- §16 (repository boundaries — this phase touches `src/seam`,
  `src/manifest`, `src/persistence/log.ts`, `src/cost/rollup.ts`)

## What this phase does NOT do

- No host-side delegation manager. The `delegate` and `report_result`
  schemas are defined and validated; nothing invokes them yet.
- No child sessions, no worktree, no budget reservation.
- No `runLoop` change. The loop is unaware of delegation in this
  phase.
- No new package dependency. Pure addition of types and tests.

## Tasks

### Task 1.1 — Add `DelegationPolicy` to manifest types

**Description:** Add the `DelegationPolicy` interface to
`src/manifest/types.ts` and add an optional `delegation?: DelegationPolicy`
field to `RoleConfig`. Pure type work; no runtime logic.

**Files:**

- `src/manifest/types.ts` (extend)

**Acceptance criteria:**

- [ ] `DelegationPolicy` interface is exported and matches the senior
      spec §6 shape: `max_parallel: number`, `max_children: number`,
      `max_depth: 1` (literal), `workspace_modes: readonly ("read_only"
      | "worktree")[]`, `max_child_cost_usd: number`.
- [ ] `RoleConfig.delegation?: DelegationPolicy` is added (optional).
- [ ] No change to `MachineDefinition` (the reducer must not see
      delegation policy; spec §6, §12.1).
- [ ] `toMachineDefinition` is unchanged (it doesn't read
      `role.delegation`).
- [ ] File-level JSDoc on `RoleConfig` updated to mention the new
      optional `delegation` field with a spec-section pointer.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `git diff src/manifest/types.ts` shows the additive change.

### Task 1.2 — Parse the `delegation` block in `parseManifest`

**Description:** Extend `parseRoleConfig` in `src/manifest/parse.ts` to
parse the `delegation` YAML block when present. This task is the
**structural** layer only — type coercion and shape. The semantic
validation (hard errors vs. warnings) lives in Task 1.3.

**Files:**

- `src/manifest/parse.ts` (extend)

**Acceptance criteria:**

- [ ] `parseManifest(YAML)` accepts a role with a `delegation:` block
      and produces a `RoleConfig` whose `delegation` field matches the
      expected shape.
- [ ] Malformed `delegation` (non-object, non-array where array is
      expected, wrong types) throws `ManifestParseError` with a path
      like `roles[<i>].delegation.<field>`.
- [ ] `max_depth` is accepted as the literal `1` only; other values
      throw `ManifestParseError` (per spec §6: `max_depth: 1` in v1).
- [ ] `workspace_modes` items must be `"read_only"` or `"worktree"`;
      other values throw `ManifestParseError`.
- [ ] A role without a `delegation:` block is unchanged (no field
      added to the parsed `RoleConfig`).
- [ ] No new imports; pure additive coercion helpers in the same file
      (`toPositiveInt`, `toLiteral`, `toWorkspaceModeArray` — or
      similar; pick the boring names that match the existing
      `to*` family).

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/manifest/parse.test.ts` (extended in Task 1.6)
      green.

### Task 1.3 — Add delegation semantic validation

**Description:** Extend `validateManifest` in `src/manifest/validate.ts`
with the §6/§13 hard-error rules and the recommended warning rules for
delegation. The validation runs against the parsed `RoleConfig` and
emits `ManifestError` / `ManifestWarning` entries with typed codes.

**Files:**

- `src/manifest/validate.ts` (extend)

**Acceptance criteria:**

- [ ] New `ManifestErrorCode` values added (extend the union, additive):
      - `"delegation-without-delegate-tool"` — role has a `delegation:`
        block but no `tools: [delegate]` entry.
      - `"delegation-without-block"` — role has `tools: [delegate]`
        but no `delegation:` block.
      - `"delegation-invalid-policy"` — `max_parallel`, `max_children`,
        `max_depth`, `workspace_modes`, or `max_child_cost_usd` violate
        the §6 constraints (positive finite, depth=1, non-empty
        workspace_modes, finite USD).
      - `"delegation-duplicate-workspace-mode"` — `workspace_modes`
        contains a duplicate.
- [ ] Existing `ManifestErrorCode` values are unchanged (additive
      extension to the union).
- [ ] Each new error includes a human message with the role name and
      the offending field path, matching the existing error-message
      style.
- [ ] No new `ManifestWarningCode` values (delegation is opt-in; the
      warnings from §13 are unchanged). If a `delegation` block is
      present with no `tools: [delegate]`, the role silently doesn't
      receive the tool — that's the spec's "neither is force-injected"
      rule (spec §5, decision 1) and not a warning.
- [ ] `toMachineDefinition` is unchanged; it does not consult
      `delegation` (the policy is host-only).

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/manifest/validate.test.ts` (extended in Task 1.6)
      green.

### Task 1.4 — Add `delegate` and `report_result` TypeBox schemas

**Description:** Extend `src/seam/schema.ts` with two new TypeBox
schemas — the parent `delegate` input and the child `report_result`
input — and export their `Static<>` typed views. The schemas are the
single source of truth for the host tool's param validation (Phase 2)
and for the seam contract.

**Files:**

- `src/seam/schema.ts` (extend)

**Acceptance criteria:**

- [ ] `delegateInputSchema` is exported with shape:
      ```ts
      {
        tasks: Array<{
          id: string,                  // ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
          objective: string,           // non-empty
          expected_output: string,     // non-empty
          workspace: "read_only" | "worktree"
        }>
      }
      ```
- [ ] `reportResultInputSchema` is exported with shape:
      ```ts
      {
        status: "completed" | "failed" | "no_changes",
        summary: string,              // non-empty
        verification?: string[]       // optional
      }
      ```
- [ ] Bounded string and array lengths are enforced at the schema
      level (`maxLength` on `objective`/`expected_output`/`summary`;
      `maxItems` on `tasks` and `verification`). Recommended values:
      `objective`/`expected_output` ≤ 8 192 chars; `summary` ≤ 4 096
      chars; `tasks` ≤ 64 entries; `verification` ≤ 32 entries, each
      ≤ 256 chars. (Document the bounds in JSDoc; the host enforces
      additional host-only checks in Phase 2.)
- [ ] The schemas pass `Value.Check` on the canonical example inputs
      and reject malformed inputs (round-trip test in Task 1.6).
- [ ] `validateEmission` in `src/seam/validate-emission.ts` is
      **unchanged** — `delegate` and `report_result` are normal tools,
      not emission tools; the existing two-variant
      `EmissionCapture` is preserved.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/seam/delegation-schema.test.ts` (new in Task
      1.6) green.

### Task 1.5 — Add `subagent_*` record variants and extend cost rollup

**Description:** Three coupled changes:

  1. Extend `PersistedRecord` in `src/persistence/log.ts` with three
     new variants per spec §9 (`subagent_started`,
     `subagent_completed`, `subagent_failed`). The host, not the
     reducer, writes these records; the reducer never branches on
     them (spec §12.1, invariant 1).
  2. Add the necessary imports from `src/core/types.ts` (use
     `UsageRecord` and `ModelEffort`).
  3. Extend `rollup` in `src/cost/rollup.ts` to include child
     terminal usage in `perRun` and `perModel` (additive), and add a
     new `perSubagent` view keyed by `child_id` (additive — the
     existing `perRole` shape is preserved with no new entries for
     children). The orchestrator-overhead semantics are unchanged.

**Files:**

- `src/persistence/log.ts` (extend)
- `src/cost/rollup.ts` (extend)

**Acceptance criteria:**

- [ ] `SubagentStartedRecord`, `SubagentCompletedRecord`,
      `SubagentFailedRecord` interfaces are exported from
      `src/persistence/log.ts`. Each carries the common metadata
      block per spec §9 (`run_id`, `child_id`, `task_id`, `parent_role`,
      `parent_session`, `session_file`, `attempt`, `model`,
      `model_effort`, `workspace`, optional `worktree_path`/`branch`,
      `base_commit`, `ts`). Terminals carry the additional
      `usage: UsageRecord` field and the spec's terminal-specific
      fields (`status`, `summary`, optional `verification`,
      `head_commit`, `failure_reason`).
- [ ] The `PersistedRecord` union is extended (additive); existing
      variants (`TransitionAccepted`, `TransitionRejected`,
      `SessionLifecycleEvent`, `ModelFallback`, `ModelRetry`,
      `CheckpointSnapshot`, `RunSeededRecord`) are unchanged.
- [ ] `InMemoryRecordLog.append` is unchanged (it already keys by
      `record.run_id` and routes the `checkpoint_snapshot` variant
      through its checkpoint's run_id; new variants carry their own
      `run_id`).
- [ ] `rollup` includes child terminal usage in `perRun` and
      `perModel` (additive). The `perModel` key for a child is the
      child's `model` string (or `SYSTEM_DEFAULT_MODEL_KEY` if
      `null`). `perRun` increments the cost/input/output/cache sums.
- [ ] `rollup` exposes a new additive `perSubagent: Readonly<Record<string, UsageAggregate>>`
      view keyed by `child_id` (one row per child). Empty if no
      children. `perRole` is unchanged (children don't appear in
      `perRole` — they're auxiliary, not FSM roles; this avoids
      double-attribution).
- [ ] `runCapExceeded` predicate is unchanged (it reads
      `rollup.perRun.cost`; child usage flowing into `perRun` is the
      correct semantic — the run cap bounds total spend, including
      delegated work).
- [ ] `RunRollup` interface is extended with `perSubagent`
      (additive; existing fields unchanged). The `finalize` helper
      in `rollup.ts` returns a frozen `perSubagent` map.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/persistence/log.test.ts` (extended in Task
      1.6) green.
- [ ] `pnpm test tests/cost/rollup.test.ts` (extended in Task 1.6)
      green.

### Task 1.6 — Tests for Phase 1

**Description:** Add or extend tests covering each of Tasks 1.1–1.5.
Table-driven where the spec enumerates cases (per AGENTS.md "Tests
are table-driven where the spec enumerates cases").

**Files:**

- `tests/manifest/parse.test.ts` (extend) — `describe("parseManifest
  with delegation block")` block
- `tests/manifest/validate.test.ts` (extend) — `describe("validateManifest
  with delegation policy")` block
- `tests/seam/delegation-schema.test.ts` (new) — TypeBox round-trip
  tests for `delegateInputSchema` and `reportResultInputSchema`
- `tests/persistence/log.test.ts` (extend) — new `describe("subagent
  records")` block
- `tests/cost/rollup.test.ts` (extend) — new `describe("rollup
  includes child terminal usage")` block

**Acceptance criteria:**

- [ ] `parseManifest with delegation block`:
      - Happy path: parses a role with a valid `delegation:` block;
        the resulting `RoleConfig.delegation` matches the input.
      - No delegation: a role without `delegation:` parses identically
        to before (the `delegation` field is `undefined`).
      - `max_depth !== 1` throws `ManifestParseError`.
      - `workspace_modes` containing an invalid string throws
        `ManifestParseError`.
      - Non-positive `max_parallel` / `max_children` /
        `max_child_cost_usd` throw `ManifestParseError`.
      - Non-object `delegation` (e.g., a string) throws
        `ManifestParseError`.
- [ ] `validateManifest with delegation policy`:
      - `delegation:` without `tools: [delegate]` produces
        `"delegation-without-delegate-tool"`.
      - `tools: [delegate]` without `delegation:` produces
        `"delegation-without-block"`.
      - Both present with valid policy → no errors.
      - Both present with `max_depth: 2` (or non-positive integer in
        another numeric field) →
        `"delegation-invalid-policy"`.
      - `workspace_modes` with a duplicate →
        `"delegation-duplicate-workspace-mode"`. [x] ✅
      - Existing validation cases pass unchanged (the existing
        `validateManifest` test block remains green).
- [ ] `delegation-schema.test.ts`:
      - `Value.Check(delegateInputSchema, valid)` is `true` for a
        representative valid input.
      - `Value.Check(delegateInputSchema, …)` is `false` for:
        empty `tasks`, non-array `tasks`, missing `id`/`objective`/
        `expected_output`/`workspace`, invalid `id` regex (e.g.,
        starts with `-`), unknown `workspace` value, oversized
        `objective`/`expected_output`.
      - `Value.Check(reportResultInputSchema, valid)` is `true`.
      - `Value.Check(reportResultInputSchema, …)` is `false` for:
        unknown `status`, missing `summary`, oversized `summary`,
        oversized `verification` array or items.
- [ ] `log.test.ts` with `subagent records`:
      - `InMemoryRecordLog.append` accepts a `subagent_started`
        record and a paired `subagent_completed` record; the run
        reads both back via `records(runId)`.
      - `latestCheckpoint` is unchanged (subagent records do not
        affect the snapshot lookup).
      - `append` keys subagent records under their `run_id` (the
        record's own `run_id` field, not the parent's session
        file).
- [ ] `rollup.test.ts` with `rollup includes child terminal usage`:
      - A run with one orchestrator `session_ended` and one child
        `subagent_completed` produces a `perRun` aggregate that is
        the sum of both.
      - `perModel` includes the child's model under its `model`
        string (or `SYSTEM_DEFAULT_MODEL_KEY` for `null`).
      - `perSubagent` has one row per `child_id` with that child's
        `subagent_completed` usage.
      - `perRole` is **unchanged** for a run where the only role
        session was the orchestrator (children do not enter
        `perRole`).
      - Existing rollup test cases pass unchanged.

**Verification:**

- [ ] `pnpm test tests/manifest/parse.test.ts` green.
- [ ] `pnpm test tests/manifest/validate.test.ts` green.
- [ ] `pnpm test tests/seam/delegation-schema.test.ts` green.
- [ ] `pnpm test tests/persistence/log.test.ts` green.
- [ ] `pnpm test tests/cost/rollup.test.ts` green.
- [ ] `pnpm test` (full suite) green.
- [ ] `tests/grep-guard.test.ts` passes (Phase 1 adds no new pi
      imports to `src/core`/`src/manifest`/`src/seam`/`src/cost`).
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm lint` clean.
- [ ] `pnpm format:check` clean.

### Task 1.7 — Repository gate

**Description:** Per AGENTS.md "Verification" — confirm the phase
gate is green before declaring Phase 1 done.

**Acceptance criteria:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm build` clean (`dist/` regenerated with new types).
- [ ] `pnpm test` all green.
- [ ] `pnpm lint` (`biome check .`) clean.
- [ ] `pnpm format:check` clean.
- [ ] `tests/grep-guard.test.ts` passes.
- [ ] `pnpm audit` shows no new advisories.

## Module-size check

This phase adds to existing files; no new modules are introduced.

- `src/manifest/types.ts` — ~30 lines added (one interface, one
  field, JSDoc). Current ~80 LOC → ~110. Well under 400.
- `src/manifest/parse.ts` — ~50 lines added (one new branch in
  `parseRoleConfig`, plus 2–3 small coercion helpers). Current
  ~290 LOC → ~340. Approaches the soft ceiling but stays under 400.
- `src/manifest/validate.ts` — ~50 lines added (one new helper
  function, one new error-code union extension, validation loop
  body). Current ~155 LOC → ~205. Well under 400.
- `src/seam/schema.ts` — ~80 lines added (two schemas + typed
  views). Current ~80 LOC → ~160. Well under 400.
- `src/persistence/log.ts` — ~80 lines added (three interfaces,
  import addition, JSDoc). Current ~210 LOC → ~290. Well under 400.
- `src/cost/rollup.ts` — ~50 lines added (one new loop body
  branch, one new return-shape field, `perSubagent` Map handling
  in `finalize`). Current ~180 LOC → ~230. Well under 400.

If any file approaches 400 LOC during implementation, split per
AGENTS.md "split by responsibility (not mid-function)." Likely
split candidates: extract delegation validation into
`src/manifest/validate-delegation.ts` if `validate.ts` exceeds
the ceiling.

## Files likely touched

| File | Change |
|------|--------|
| `src/manifest/types.ts` | Add `DelegationPolicy`; add `RoleConfig.delegation?`; update JSDoc |
| `src/manifest/parse.ts` | Extend `parseRoleConfig` with delegation parsing; add coercion helpers |
| `src/manifest/validate.ts` | Add delegation validation rules; extend `ManifestErrorCode` |
| `src/seam/schema.ts` | Add `delegateInputSchema` and `reportResultInputSchema` + typed views |
| `src/persistence/log.ts` | Add `SubagentStartedRecord` / `SubagentCompletedRecord` / `SubagentFailedRecord`; extend `PersistedRecord` |
| `src/cost/rollup.ts` | Read child terminals in the rollup loop; add `perSubagent` view |
| `src/index.ts` | Re-export new types (typed views + record variants + `perSubagent`) |
| `tests/manifest/parse.test.ts` | Extend with delegation cases |
| `tests/manifest/validate.test.ts` | Extend with delegation cases |
| `tests/seam/delegation-schema.test.ts` | New — TypeBox round-trip tests |
| `tests/persistence/log.test.ts` | Extend with subagent record cases |
| `tests/cost/rollup.test.ts` | Extend with child-usage cases |

## Checkpoint: end of Phase 1

- [x] All Task 1.1–1.7 checkboxes ticked.
- [x] Manifest parses and validates delegation blocks additively; an
      existing manifest without `delegation:` is unchanged.
- [x] Seam exposes `delegateInputSchema` and `reportResultInputSchema`.
- [x] `PersistedRecord` carries three new subagent variants.
- [x] Cost rollup integrates child terminal usage with no
      double-attribution; `perSubagent` is a new additive view.
- [x] Grep guard still passes; all repo gates green.
- [x] Phase 2's implementer can build on this without further
      host-agnostic work.

## Out of scope (deferred)

- Host delegation manager and child SDK sessions (Phase 2).
- Worktree creation, cleanup, and the worktree gate (Phase 2).
- Budget reservation against the run cap (Phase 3).
- Cancellation propagation, resume reconciliation, ADR-002,
  CHANGELOG, version bump (Phase 3).
- Any change to the orchestration loop or the reducer. The loop is
  unaware of delegation in this phase.
