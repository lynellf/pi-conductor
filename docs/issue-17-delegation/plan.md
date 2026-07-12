# Plan — Issue #17: Bounded Sub-Agent Delegation with Isolated Worktrees

**Source:** GitHub issue #17 (`Add bounded sub-agent delegation with isolated
worktrees`, enhancement). Senior spec: [`spec.md`](./spec.md) (status: acknowledged;
authorised 2026-07-12). This plan condenses the senior spec into a
tactical, phased package and surfaces the implementation surfaces the
spec §16 listed.

**Investigated by:** this planner via the senior spec; the in-flight
`docs/issue-17-delegation/spec.md` (read in full); OKF docs
(`.okf/components/record-emitter.md`,
`.okf/concepts/manifest-validation-boundary.md`,
`.okf/concepts/model-id-provider-colon-format.md`,
`.okf/pitfalls/fake-timer-isolate-false-leak.md`); and source inspection of
`src/manifest/{types,parse,validate,definition}.ts`,
`src/seam/{schema,validate-emission,payload-summary}.ts`,
`src/persistence/log.ts`, `src/cost/{rollup,caps}.ts`,
`src/core/types.ts`, `src/host/{host,loop,tools,stub-host,production-host,
run-handle,api,seam,ask-user-tool,cost}.ts`,
`src/host/{session-event-handler,display-sink,stub-provider}.ts`,
`tests/grep-guard.test.ts`, and the existing test structure under
`tests/{host,manifest,seam,cost,persistence}/`. Prior plans
(`docs/open-issues-round-3/plan.md` and `phase-2-issue-13-diff-hunks.md`)
were read for plan-shape convention.

## Status

The senior spec was acknowledged by the overseer on 2026-07-12.
Implementation is authorised. All senior spec §17 decisions (manifest
policy, command policy, model policy, cleanup policy) are accepted as-is.
If the overseer revises any of them at end-of-loop review, the affected
phases will need to be updated; that is a follow-up, not a plan-level
blocker.

## Goal

Allow an explicitly enabled active role to call one host tool, `delegate`,
with multiple independent tasks. The host runs those tasks concurrently up
to a manifest limit, waits for all task terminals, and returns an ordered
structured result set to the parent role. Children are auxiliary SDK
sessions; they never enter the reducer checkpoint, never call `reduce`,
and never persist directly. The parent remains the only actor that can
emit `handoff` or `end`. Detail in the senior spec §2–§15.

## Architecture decisions (tactical, from the senior spec)

The senior spec makes the load-bearing decisions; the tactical plan
re-asserts the ones that bind a phase's task list:

1. **Reducer is payload-blind; child records are host-agnostic, not
   machine state.** `subagent_*` records live in `PersistedRecord` but
   the reducer never branches on them. The single-owner rule (§12.1) is
   preserved: only the loop calls `reduce` and `host.persistRecord`.
   Delegation emits a normal `tool_result` text back to the parent
   inside its own session — no FSM transition, no checkpoint change,
   no `session_ended` for the parent.
2. **`MachineDefinition` is unchanged.** `delegation` is host policy
   only. `toMachineDefinition` keeps the same shape.
3. **The `delegate` tool is a normal tool, not an emission.** The
   parent's session records are unchanged. `validateEmission` keeps
   its two-variant input.
4. **Children never receive `handoff`/`end`/`ask_user`/`delegate`.** The
   `buildToolsAllowlist` for child sessions drops these names. The
   post-emission seal wrapper is unnecessary for children — they have
   no emissions to seal against — but a different wrapper denies
   `bash` and forces a path-confined `run` tool for worktree children.
5. **Worktree paths and branches are host-generated, conductor-owned.**
   Cleanup verifies both are beneath the run state directory and carry
   a conductor-owned prefix; the primary checkout is never touched.
6. **Child budget reservation against the run cap.** Before a child
   starts, the host reserves its `max_child_cost_usd` against the
   current run cap. Reservation is released/settled on terminal. A
   run-cap breach aborts active children and prevents new admissions;
   the parent loop is the only owner of any eventual machine `end`.
7. **StubHost parity is required.** Every delegation behavior must be
   exercisable through `StubHost` with no API key. `StubHost` is
   extended in Phase 2 with delegation-aware `spawnRole`; `ProductionHost`
   gets the same delegation manager.
8. **No new package dependency.** Git is an existing runtime
   prerequisite. The `node:child_process` `execFile` API is built in.
   The `delegate` and `report_result` TypeBox schemas are reused
   through `typebox` (already a peer dep).

## Phase index

| Phase | File | Scope | Status | Sub-plan |
|-------|------|-------|--------|----------|
| 1 | `phase-1-foundation.md` | Host-agnostic foundation: manifest types/parse/validate, seam TypeBox schemas, new `PersistedRecord` variants, cost rollup extension, pure tests | Complete (resumed run baseline) | Manifest + seam + persistence + cost are additive; reducer unchanged; focused and full tests pass |
| 2 | `phase-2-host-delegation.md` | Host delegation manager + child SDK sessions + tool policy (read_only + worktree modes) + worktree lifecycle + `delegate` and `report_result` tools + StubHost parity | In progress — resume delta in `phase-2-resume.md` | Existing checkout contains partial helpers and an incomplete manager; production wiring and end-to-end delegation remain |
| 3 | `phase-3-lifecycle-recovery.md` | Budget reservation against run cap; parent/run cancellation propagation; resume reconciliation of orphan children; ADR-002; CHANGELOG and version bump | Not started | Begins only after Phase 2 gate is green |

**Sequencing:** phases are strictly sequential — Phase 2 needs Phase 1's
types/schemas/records; Phase 3 needs Phase 2's manager and child session
plumbing. Within each phase, tasks are M-sized (3–5 files touched) and
gated by their own acceptance criteria + the repository's standard
verification gate (AGENTS.md "Verification").

**Version bump:** 0.8.2 → **0.9.0** (MINOR). Rationale: a new host tool
(`delegate`) + new `PersistedRecord` variants + new manifest schema shape
are additive, public-type extensions; the additive posture is consistent
with prior MINOR bumps (`0.6.0` for `DisplayEvent.files`,
`0.7.0` for `hunks`).

## Repository surfaces (from spec §16, refined)

| Surface | Phase | Files |
|---------|-------|-------|
| `src/seam/` | 1 | `schema.ts` (extend) |
| `src/manifest/` | 1 | `types.ts` (extend), `parse.ts` (extend), `validate.ts` (extend) |
| `src/persistence/log.ts` | 1 | (extend) |
| `src/cost/rollup.ts` | 1 | (extend) |
| `src/host/delegation/` | 2 | **new** — `manager.ts`, `pool.ts`, `child-session.ts`, `child-prompt.ts`, `child-tool-policy.ts`, `delegate-tool.ts`, `report-result-tool.ts`, `run-tool.ts`, `worktree.ts`, `child-budget.ts` |
| `src/host/` | 2 | `stub-host.ts` (extend), `production-host.ts` (extend), `index.ts` (re-export) |
| `src/host/` | 3 | `loop.ts` (extend — cancel/cleanup hooks), `run-handle.ts` (extend — child abort), `api.ts` (extend — resume reconciliation) |
| `src/host/delegation/recovery.ts` | 3 | **new** — orphan reconciliation + idempotent cleanup |
| `docs/decisions/ADR-002-subagent-delegation.md` | 3 | **new** |
| `CHANGELOG.md` | 3 | (extend) |
| `package.json` | 3 | (bump `0.8.2` → `0.9.0`) |
| `tests/manifest/` | 1 | `parse.test.ts` (extend), `validate.test.ts` (extend) |
| `tests/seam/` | 1 | new `delegation-schema.test.ts` |
| `tests/persistence/` | 1 | `log.test.ts` (extend) |
| `tests/cost/` | 1 | `rollup.test.ts` (extend) |
| `tests/host/delegation/` | 2 | new — manager, pool, child-session, tool-policy, worktree, delegate-tool, report-result-tool, run-tool |
| `tests/host/` | 2 | `stub-host.test.ts` (extend, if not already present) — delegation stub parity |
| `tests/host/` | 3 | `loop.test.ts` (extend — cancel aborts children), `resume.test.ts` (extend — reconciliation) |
| `tests/grep-guard.test.ts` | 1, 2, 3 | unchanged; verify after each phase |

**Module-size guard.** Each new `src/host/delegation/*.ts` file is
expected to be ≤ 250 LOC. The `manager.ts` may push toward the
AGENTS.md ~400-LOC ceiling if it accumulates state-machine logic; if it
does, split into `manager.ts` (orchestration) + `results.ts` (result
assembly + ordering). Phase 2's task list notes the split point.

## Acceptance criteria (overall, from spec §15)

The feature is complete when all 12 numbered spec-§15 criteria are
demonstrated by unit and integration tests with stub-provider sessions
(no API key). Phase-by-phase gate expansion in each phase file.

The repository's standard verification gate runs after each phase:

```text
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm audit
```

Plus the `tests/grep-guard.test.ts` continuation (phases 1 and 2 add no
new imports of `@earendil-works/pi-coding-agent` into
`src/core`/`src/manifest`/`src/seam`/`src/cost`; phase 3's loop
extension may add an import of the new `delegation/` modules but
remains inside `src/host/`).

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `src/host/loop.ts` is 1000+ LOC; adding child-abort hooks in Phase 3 may push it past the ~400-LOC soft ceiling | Medium — AGENTS.md allows up to 500 LOC for a coherent concept, but the file is already over the soft ceiling; further growth is a smell | Phase 3's loop extension is small (~30 LOC at the cancel + reconciliation seams); if it exceeds 500, extract child-abort into a `child-cancel.ts` helper that the loop calls; do not split the orchestration loop itself |
| Phase 2 introduces 8–10 new files; a single implementer may not finish in one session | Medium | Each task in Phase 2 is M-sized (3–5 files); explicit checkpoints after every 2–3 tasks; the implementer is expected to land at most 2–3 tasks per fresh-context session, ending with `pnpm test` green |
| `node:child_process.execFile` for git worktree commands must never use shell interpolation | High — shell injection in a worktree command would compromise the conductor's host | Phase 2's `worktree.ts` uses `execFile` exclusively with argv arrays; tests pin a "no shell metacharacters" case (e.g., a branch name with `;` and `&&` is rejected) |
| Child tool allowlist drift between `StubHost` and `ProductionHost` | Medium — the test path is the canonical reference; production must match exactly | Phase 2 ships `buildChildToolsAllowlist(workspaceMode, manifestPolicy)` as a single shared helper used by both hosts; tests cover the full matrix |
| Resume reconciliation of orphan children could be a performance hazard on huge log files | Low — `run_id`-keyed scan is O(records) and the records are typically < 1k per run | Phase 3 uses the same record-scan pattern as existing `latestCheckpoint` / `records()` (in-memory) and the file-backed `FileRecordLog.records(runId)` reads; tests pin a 1000-orphan reconciliation under 100ms |
| `StubHost` parity may tempt a stub-specific shortcut (e.g., a fake `git` shell-out) that production cannot reuse | Medium — short-term win, long-term drift | Phase 2's `worktree.ts` is a pure-I/O module that takes a `runGit(args)` seam; `StubHost` uses a fake `runGit` (records argv), `ProductionHost` uses `execFile`. Tests cover both paths with the same shape. |
| Phase 1's `delegation` field is additive; existing manifests (no `delegation`) must still parse and validate identically | High — a backward-incompatible change would break every existing user | Phase 1's parser and validator treat `delegation` as opt-in. The existing `tests/manifest/{parse,validate}.test.ts` cases must pass unchanged. New cases are added in a separate `describe` block. |

## Open assumptions surfaced for the overseer

These match the senior spec's §17 "open user decisions." The senior
spec recommends them; this plan accepts the recommendation and moves
forward, but the overseer is expected to confirm or revise at the
end-of-loop review:

1. **Manifest policy:** delegation requires both `delegation:` and
   `tools: [delegate]`; `max_child_cost_usd` is mandatory for
   enablement.
2. **Command policy:** no unrestricted child `bash`; path-confined
   file tools plus a restricted argv-based `run` tool.
3. **Model policy:** children inherit the active parent's model chain
   with retries/fallbacks sharing one child budget.
4. **Cleanup policy:** retain generated branches; remove clean worktree
   directories; preserve dirty/failed worktrees.

The plan does not block on these; Phase 1's manifest extension is
shaped around decision 1, Phase 2's child tool policy is shaped around
decision 2, and so on. If the overseer reverses any, the affected
phases get a follow-up.

## Plan-sufficiency note

This is a large feature with 12 acceptance criteria (spec §15). Three
phases is the minimum needed to keep tasks M-sized and to maintain
working-state checkpoints. The single highest-risk area is Phase 2's
worktree lifecycle: the spec requires both a clean-tree entry gate and
a clean/dirty exit verification, and both are Git-level integration
points that unit tests can pin but production behavior depends on the
host's Git installation. Mitigation: Phase 2's `worktree.ts` is
isolated and unit-tested against `mkdtemp` + a real Git repo (no
mocking of Git itself), and the integration tests in Phase 2 cover
the full path: clean primary checkout → worktree task → commit
changes → report → verify → cleanup.

The plan is dispatchable. No UI designer is required (no new UI
command; existing record-emitter consumers stay compatible; child
records are observability/recovery data, not user-facing). No
researcher is required (the senior spec already cites the SDK
contract and the Git porcelain CLI; no new external facts needed).
The next role is `plan-reviewer-a` per AGENTS.md §8.3.

## Telemetry (plan-time)

- `okf_docs_read`: 4
  (`.okf/components/record-emitter.md`,
  `.okf/concepts/manifest-validation-boundary.md`,
  `.okf/concepts/model-id-provider-colon-format.md`,
  `.okf/pitfalls/fake-timer-isolate-false-leak.md`).
  The 5th OKF file (`.okf/components/markdown-continuation.md`) is
  deprecated and intentionally not read.
- `okf_tokens_read`: ~5K
- `source_files_read`: ~24
  (`src/manifest/{types,parse,validate,definition}.ts`,
  `src/seam/{schema,validate-emission,payload-summary}.ts`,
  `src/persistence/log.ts`, `src/cost/{rollup,caps}.ts`,
  `src/core/types.ts`,
  `src/host/{host,loop,tools,stub-host,production-host,run-handle,api,seam,ask-user-tool,cost,index}.ts`,
  `src/host/{session-event-handler,display-sink,stub-provider}.ts`,
  `src/index.ts`, `tests/grep-guard.test.ts`,
  `tests/cost/rollup.test.ts`).
- `stale_okf_hits`: 0
- `missing_okf_hits`: 0
- `planner_cost_before_okf`: unknown
- `planner_cost_after_okf`: unknown

## Knowledge candidates (for `okf-curator` follow-on, not blocking)

1. **"Delegation is host-owned auxiliary state, not machine state."**
   The FSM is payload-blind; the reducer never sees child sessions,
   worktree branches, child costs, or delegation tool results. The
   parent's `delegate` tool call is a normal tool that returns text
   to the parent; no FSM transition is produced; the checkpoint is
   unchanged. The single-owner rule (§12.1) is preserved: only the
   loop calls `reduce` and `host.persistRecord`. (Stable architecture
   contract; load-bearing for future planners who might be tempted
   to add a `delegate` machine event.)
2. **"`subagent_*` records are host-agnostic `PersistedRecord`
   variants."** They live in `src/persistence/log.ts` (host-agnostic
   module, no pi imports) but the reducer never branches on them. The
   cost rollup reads them for `perRun`/`perModel` integration and a
   new additive `perSubagent` view; the run's per-role accounting
   stays at the FSM-role grain (no double-attribution). (Stable
   persistence contract; explains the record placement decision.)
3. **"Worktree paths and branches are host-generated, conductor-owned,
   and uniquely prefixed."** The cleanup path verifies both are
   beneath the run state directory and carry a conductor-owned
   prefix; the primary checkout is never touched. Successful clean
   worktrees are removed only after the terminal record is durably
   appended; failed/cancelled/dirty/cleanup-error worktrees are
   preserved. (Stable worktree boundary; load-bearing for the
   "concurrent tasks race shared external resource" failure case.)
4. **"Child budget reservation is a separate ledger from parent
   session cap admission."** The host reserves each child's
   `max_child_cost_usd` against the current run cap before spawning.
   Reservation is released/settled on terminal. Parent session-cap
   admission includes the child's charged cost through this ledger
   while `session_ended`/`session_failed` parent usage stays
   provider-only. No usage is counted twice; no parent cap is
   bypassable. (Stable accounting contract; explains the additive
   budget seam.)
