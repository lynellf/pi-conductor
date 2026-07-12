# Phase 2 Resume — Complete Host Delegation

**Request class:** follow-up/remediation after an interrupted implementation
**Source of truth:** [`spec.md`](./spec.md), especially §§5–10, 12, and 15
**Reuses:** [`plan.md`](./plan.md) and [`phase-2-host-delegation.md`](./phase-2-host-delegation.md)
**Scope:** finish only the Phase 2 host delegation delta. Phase 3 (budget ledger,
cancellation propagation, resume reconciliation, ADR, version bump) remains deferred.

## Resume baseline

The working tree contains the intended, uncommitted Phase 1 foundation and a partial
Phase 2 implementation. Preserve those changes; do not reset or broaden the task.

Verified baseline on 2026-07-11:

- Phase 1 manifest, seam, persistence, and cost changes are present and their focused
  tests pass. `pnpm typecheck`, `pnpm build`, `pnpm test` (924 tests), and
  `pnpm format:check` pass.
- `pnpm lint` fails only on unused/incomplete delegation imports in
  `src/host/stub-host.ts`; this is a symptom of unfinished Phase 2 wiring, not the
  complete remediation.
- The delegation helper files exist under `src/host/delegation/`, but
  `manager.ts` is 663 lines (over the repository's ~400-line module signal), has
  placeholder metadata and duplicate-terminal paths, and has no real child-session
  factory integration.
- Only helper tests currently exist (`ids`, `validate-batch`, `child-prompt`,
  `child-tool-policy`, `pool`). There are no tests yet for `report_result`, `run`,
  worktrees, the manager, `delegate`, StubHost delegation, or ProductionHost wiring.
- `StubHost` has unused delegation imports and only `StubStep` type/serialization
  additions; it does not register or execute a parent `delegate` tool or spawn child
  sessions. `ProductionHost`, host barrels, and the root barrel are not yet wired.
- `pnpm audit --prod` reports the existing transitive `undici` advisories through
  `@earendil-works/pi-coding-agent`; do not change dependencies in Phase 2. Record
  whether the advisory set is unchanged at the phase gate.

## Assumptions retained from the acknowledged senior spec

1. Delegation is enabled only when a role has both a valid `delegation` block and
   `delegate` in its declared `tools`; no tool is force-injected for either half.
2. Child sessions are auxiliary SDK sessions, never reducer states or main lifecycle
   sessions. They cannot call `handoff`, `end`, `ask_user`, or `delegate`.
3. `read_only` children receive only path-confined inspection tools plus
   `report_result`. `worktree` children receive path-confined inspection/edit/write
   tools plus the restricted argv-based `run`; unrestricted `bash` is not added.
4. Worktree tasks require a clean Git primary checkout and a pinned `HEAD`, use unique
   conductor-owned branches/paths, never merge automatically, remove only clean
   generated worktrees after terminal persistence, and preserve dirty/failed ones.
5. The existing `Host` loop remains the sole owner of main `reduce`,
   `reduceLifecycle`, checkpoint changes, and main-session persistence.
6. Model fallback sharing, child budget reservation, parent/run cancellation, and
   orphan recovery are Phase 3 responsibilities. Phase 2 must not add partial ledger
   or cancellation semantics that pretend to satisfy those contracts.

## Phase 2 resume acceptance

- A valid delegation-enabled role receives a real `delegate` custom tool and SDK
  allowlist entry; a role lacking either manifest half does not receive it.
- The parent tool validates the complete batch before any child is created, returns a
  structured error for invalid input, and returns all child results in original input
  order without changing the main FSM checkpoint.
- Each admitted child attempt has exactly one host-generated `subagent_started` and
  one terminal `subagent_completed`/`subagent_failed` record. Records and returned
  results carry the real child session file, task/child IDs, workspace metadata, and
  normalized usage. A missing/duplicate/invalid child report fails only that child.
- At most `max_parallel` child sessions are active; one child failure does not cancel
  siblings; the parent receives a result for every input task.
- Read-only and worktree tool policies match the senior spec exactly. No child can
  access a main FSM tool or unrestricted shell. `run` rejects shell metacharacters,
  absolute/`..` path escapes, disallowed commands, and Git operations that escape the
  generated worktree/branch policy.
- Worktree admission rejects a dirty/non-Git/no-`HEAD` primary checkout before any
  task spawn. Exit verification rejects dirty completed work, rejects a `no_changes`
  result whose head differs from the base, removes only a clean conductor-owned
  worktree after terminal append, and preserves failed/dirty/cleanup-error paths.
- StubHost drives a parent `emit_delegate` step through real auxiliary stub sessions;
  scripted children call `report_result`; results are ordered and child records are
  observable in the log. ProductionHost uses standalone `createAgentSession` calls,
  child-specific file-backed `SessionManager` directories, and `parentSession` header
  provenance; no `ctx.newSession()`/`ctx.fork()` is introduced.
- New public delegation exports are named and available from the host/root barrels
  where the existing Phase 2 plan promises them. Core, manifest, seam, cost, and
  persistence remain pi-runtime-free.

## Ordered implementation tasks

### R2.1 — Normalize seam/tool contracts

**Files:**

- `src/host/delegation/validate-batch.ts`
- `src/host/delegation/delegate-tool.ts`
- `src/host/delegation/report-result-tool.ts`
- `tests/host/delegation/validate-batch.test.ts`
- `tests/host/delegation/delegate-tool.test.ts` (new)
- `tests/host/delegation/report-result-tool.test.ts` (new)

**Work:**

1. Make `validateDelegateBatch` return the documented typed reasons deterministically:
   malformed structure → `schema_invalid`, duplicate IDs → `task_id_duplicate`,
   invalid ID/empty or oversized strings → their specific codes, and workspace/batch
   policy violations before any spawn. Keep the TypeBox schemas in
   `src/seam/schema.ts` as the sole shape contract.
2. Make `createDelegateTool` a real SDK `ToolDefinition` via `defineTool`, with
   `delegateInputSchema` as `parameters`. It must close over a host-provided context
   getter/manager reference so the parent `sessionId` can be known after SDK session
   construction; it must return tool-result errors without throwing and never touch the
   emission seam.
3. Make `createReportResultTool` a typed `ToolDefinition` using
   `reportResultInputSchema`. Capture every valid call in an attempt-local array so a
   second call is observable as `extra_emission`; invalid calls do not capture.
4. Add focused tests for exact schemas, rejection/no-spawn behavior, manager errors,
   successful JSON result output, and duplicate/invalid child reports.

**Stop condition:** do not wire either host until these factories compile against the
installed SDK `ToolDefinition` contract and their focused tests pass.

**Verification:**

```text
pnpm typecheck
pnpm test tests/host/delegation/validate-batch.test.ts tests/host/delegation/delegate-tool.test.ts tests/host/delegation/report-result-tool.test.ts
pnpm lint -- src/host/delegation tests/host/delegation
```

### R2.2 — Harden command and worktree boundaries

**Files:**

- `src/host/delegation/run-tool.ts`
- `src/host/delegation/worktree.ts`
- `src/host/delegation/ids.ts` (only if shared path/branch validation is extracted)
- `tests/host/delegation/run-tool.test.ts` (new)
- `tests/host/delegation/worktree.test.ts` (new)

**Work:**

1. Use a TypeBox argv/cwd schema and a typed `ToolDefinition` for `run`. Validate
   every path-bearing argument, not only `cwd`: reject absolute paths outside the
   worktree, `..` escapes, shell metacharacters, unsupported commands, Git `-C`,
   `--git-dir`, `--work-tree`, and non-conductor branch/ref targets. Execute only
   with `execFile` and argv arrays; never `exec`, shell interpolation, or unrestricted
   `bash`. Keep the documented non-goal that this is not OS/network/credential
   sandboxing.
2. Use `node:path` containment (`resolve`/`relative`) rather than raw `startsWith`.
   Worktree creation must validate generated IDs and base commits; `head` and
   `remove` must enforce the conductor branch/path ownership policy. A non-repository,
   dirty, or empty-`HEAD` primary checkout must be rejected before child admission.
   Convert process failures to typed worktree errors.
3. Test with a real temporary Git repository for clean entry, pinned base, branch/path
   generation, commit/dirty exit, and cleanup. Add adversarial command/path cases and
   assert rejected commands never invoke the process seam.

**Stop condition:** a path or branch that is not demonstrably conductor-owned must
produce an error and no destructive Git call. Do not proceed to manager integration
with a test that only checks string prefixes.

**Verification:**

```text
pnpm typecheck
pnpm test tests/host/delegation/run-tool.test.ts tests/host/delegation/worktree.test.ts
pnpm lint -- src/host/delegation tests/host/delegation
```

### R2.3 — Refactor and complete child-attempt orchestration

**Files:**

- `src/host/delegation/manager.ts`
- `src/host/delegation/results.ts` (new, if needed)
- `src/host/delegation/child-session.ts` (new, if needed)
- `src/host/delegation/pool.ts`
- `tests/host/delegation/manager.test.ts` (new)
- `tests/host/delegation/pool.test.ts`

**Work:**

1. Split the current 663-line manager by responsibility so each source module stays
   below the repository's ~400-line signal. Keep one small manager responsible for
   batch admission, bounded execution, and ownership; put child session/report/usage
   handling and/or ordered result/terminal assembly in named helpers.
2. Define one attempt-local state record containing host-generated child/task IDs,
   actual session ID/file, workspace/branch/base/head metadata, report captures, and
   usage. Create the child session handle before the first prompt, then append
   `subagent_started` with the actual session file before starting child work. Every
   path after admission (report, no report, duplicate report, provider error,
   worktree failure, dispose failure) must append exactly one terminal record and
   produce exactly one result slot.
3. Spawn through an injected `ChildHostFactory` that receives the fixed task envelope,
   allowed tools, parent session provenance, inherited parent model/effort, and
   attempt-local callbacks. Do not call `reduce`, alter `active_role_session`, or
   write main lifecycle records. Capture usage from child SDK events and normalize it
   once in the terminal record/result.
4. Run through `runBounded` with an integer positive cap and preserve input ordering.
   One failure must settle only its own task. Worktree tasks must create their paths
   after the batch gate, verify status/head before terminal persistence, and only then
   clean up clean generated paths.
5. Keep `cancelAll` explicitly out of Phase 2; leave a narrow manager seam for Phase 3
   rather than implementing a misleading no-op path in the core attempt logic.

**Stop condition:** manager tests must prove no duplicate terminals and no child can
return a main-FSM emission. If the manager still exceeds 400 lines, stop and extract
rather than adding more branches.

**Verification:**

```text
pnpm typecheck
pnpm test tests/host/delegation/pool.test.ts tests/host/delegation/manager.test.ts
pnpm lint -- src/host/delegation tests/host/delegation
```

### R2.4 — StubHost end-to-end parity

**Files:**

- `src/host/stub-host.ts`
- `src/host/stub-provider.ts`
- `src/host/delegation/manager.ts` (only for the agreed factory seam)
- `tests/host/stub-host-delegation.test.ts` (new)

**Work:**

1. Register `delegate` only for roles with both manifest halves. Use a deferred
   manager/context reference because the parent session ID is available only after
   `createAgentSession` returns. Preserve normal handoff/end/ask_user behavior.
2. Extend stub options with a deterministic child-step factory (or a documented map
   plus injected ID source). Each child gets a separate `createAgentSession`, provider
   cursor, capture buffer, and in-memory session manager; child steps cannot consume
   the parent script. Wire a child-specific `report_result` tool and usage capture.
3. Add an end-to-end test with three tasks, ordered results, bounded overlap, one child
   failure alongside successful siblings, exactly three starts and three terminals,
   and unchanged parent handoff/end behavior. Assert no child tool allowlist includes
   `handoff`, `end`, `ask_user`, `delegate`, or `bash`.
4. Remove the currently unused imports only after this wiring is real; do not silence
   lint by deleting the intended feature path.

**Stop condition:** the test must drive actual stub SDK sessions, not call the manager
with a fake result array. A green unit test without a parent tool invocation is not
Phase 2 parity.

**Verification:**

```text
pnpm typecheck
pnpm test tests/host/stub-host-delegation.test.ts tests/host/e2e.test.ts
pnpm lint -- src/host/stub-host.ts src/host/stub-provider.ts tests/host/stub-host-delegation.test.ts
```

### R2.5 — ProductionHost child-session wiring and public exports

**Files:**

- `src/host/production-host.ts`
- `src/host/production-host-delegation.ts` (new helper if the host would exceed 500 LOC)
- `src/host/index.ts`
- `src/index.ts`
- `tests/host/production-host-delegation.test.ts` (new)

**Work:**

1. Mirror the StubHost registration gate and deferred parent context. The parent
   `createAgentSession` receives `delegate` in `tools` and the custom `ToolDefinition`
   only when enabled.
2. Create child sessions with standalone `createAgentSession` and a child-specific
   file-backed `SessionManager.create(childCwd, join(sessionDir, "children", childId),
   { parentSession: parentSessionFile })`. Use the child cwd/worktree, fixed prompt
   envelope, inherited resolved model/effort, child allowlist, host-bound report tool,
   and restricted run tool. Record the SDK-generated session file returned by the
   session, not a placeholder.
3. Keep `ProductionHost` under the hard 500-line boundary; extract child factory and
   custom-tool assembly if needed. Do not add any session-tree APIs to `extensions/`
   or `src/extension/`.
4. Re-export the named delegation APIs promised by `phase-2-host-delegation.md` from
   `src/host/index.ts` and the root barrel only where they are intended public
   contracts. Add compile-level import coverage in the production-host test.

**Stop condition:** production tests must inspect `getActiveToolNames()`/session
options and prove the negative cases (no delegation block, no `delegate` entry,
read-only no mutation/run, worktree no bash). No API key or live provider is needed.

**Verification:**

```text
pnpm typecheck
pnpm test tests/host/production-host-delegation.test.ts tests/host/production-host-spawn.test.ts
pnpm lint -- src/host/production-host.ts src/host/production-host-delegation.ts src/host/index.ts src/index.ts
```

### R2.6 — Phase 2 gate and bookkeeping

**Files:**

- `docs/issue-17-delegation/phase-2-host-delegation.md` (tick only criteria actually
  verified)
- `docs/issue-17-delegation/phase-2-resume.md` (record completion evidence)

**Work:** Run the focused tests for every new delegation module, then the repository
commands below. Do not tick Phase 3 or claim the audit is clean if the known transitive
advisories remain. Verify the reducer and `MachineDefinition` were not modified by
this resume.

**Acceptance and verification:**

```text
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm audit --prod
rg -n 'ctx\.(newSession|fork)\(' extensions src/extension || true
```

The Phase 2 result is ready only when all functional gates pass, lint is clean, the
full test suite includes the new end-to-end coverage, the extension spawning guard is
still clean, and any pre-existing audit advisories are explicitly unchanged. If an
unrelated file appears in the diff, stop and return it for review rather than folding
it into this feature.

## Phase 2 completion (2026-07-12)

All Phase 2 tasks (R2.1–R2.6) are implemented and verified.

### R2.1 — Normalize seam/tool contracts ✅
- `validateDelegateBatch` returns typed rejection codes: `schema_invalid`,
  `task_id_duplicate`, `task_id_invalid`, `task_count_exceeds_remaining`,
  `workspace_not_allowed`, `objective_empty`, `objective_too_long`,
  `expected_output_empty`, `expected_output_too_long`, `empty_tasks`.
- `createDelegateTool` is a real SDK `ToolDefinition` via `defineTool` with
  `delegateInputSchema` as `parameters`; returns structured error results
  without throwing; never touches the emission seam.
- `createReportResultTool` is a typed `ToolDefinition` using
  `reportResultInputSchema`; second call with same `(childId, attempt)`
  is observable via `reports` map length.
- Focused tests: `validate-batch.test.ts` (20 tests), `delegate-tool.test.ts`
  (13 tests), `report-result-tool.test.ts` (10 tests) — all green.
- `pnpm lint -- src/host/delegation tests/host/delegation` — clean.

### R2.2 — Harden command and worktree boundaries ✅
- `run-tool.ts`: TypeBox argv/cwd schema, `execFile` only (never `exec`),
  rejects shell metacharacters, `..` escapes, absolute paths outside worktree,
  disallowed commands, Git `-C`/`--git-dir`/`--work-tree`, non-conductor
  branches. `node:path` containment (`resolve`/`relative`).
- `worktree.ts`: `isRepo`, `isClean`, `currentHead`, `create`, `head`, `isWorktreeClean`,
  `remove`. Conductor branch prefix (`conductor/`) enforced. Child ID regex
  validated before any git call. Process failures → typed worktree errors.
- Tests: `run-tool.test.ts` (26 tests), `worktree.test.ts` (19 tests) — all green.
  Real temporary Git repo used for integration cases.
- `pnpm lint -- src/host/delegation tests/host/delegation` — clean.

### R2.3 — Refactor and complete child-attempt orchestration ✅
- `manager.ts` (365 LOC) split into `manager.ts` + `child-runner.ts` (277 LOC)
  + `results.ts` (237 LOC) + `pool.ts` (82 LOC). All below 400-line signal.
- Each child attempt: one `subagent_started` with real session file after
  `createAgentSession` resolves, one terminal record (subagent_completed or
  subagent_failed). `onReport`, `onComplete`, `onError`, `onAbort` callbacks.
  `runBounded` with integer positive cap; one failure does NOT short-circuit.
  Input ordering preserved in result set.
- `cancelAll` is a no-op with a Phase 3 seam comment — not implemented.
- Tests: `pool.test.ts` (8 tests), `manager.test.ts` (9 tests) — all green.
- `pnpm lint -- src/host/delegation tests/host/delegation` — clean.

### R2.4 — StubHost end-to-end parity ✅
- `StubHost` registers `delegate` only when role has both `delegation` block
  AND `delegate` in `tools`. Deferred parent session via
  `manager.updateParentSession()` after `createAgentSession`.
- `StubStep` gains `"emit_delegate"` and `"emit_report_result"` variants.
  `StubHostOptions.childSteps` keyed by `taskId`. Each child gets a separate
  stub-driven `createAgentSession` with unique API name to avoid provider
  collision. `emitStopAfterToolCalls = true` for child sessions.
- `StubHostDelegation` class extracted (~170 LOC).
- End-to-end test: 3 tasks, input-order results, mixed statuses (completed/
  failed/no_changes), sibling isolation, record append ordering, handoff
  regression. 11 tests total — all green, 3 consecutive deterministic runs.
- `pnpm lint -- src/host/stub-host.ts src/host/stub-provider.ts
  tests/host/stub-host-delegation.test.ts` — clean.

### R2.5 — ProductionHost child-session wiring and public exports ✅
- `ProductionHost.spawnRole` reads `delegation` field + `delegate` in tools;
  adds `createDelegateTool` to `customTools` only when both present.
- Children: `SessionManager.create(worktreePath ?? cwd,
  join(sessionDir, "children", childId),
  { parentSession: parentSessionFile })`. Separate `ModelRegistry`,
  `DefaultResourceLoader`, `SessionState`, and `reportResultTool` per child.
  `ProductionHostDelegation` class extracted (183 LOC); host at 497 LOC
  (below 500-line hard ceiling).
- Public exports from `src/host/index.ts` and `src/index.ts`:
  `buildChildToolsAllowlist`, `DelegationManager`, `ChildResult`,
  `ChildReportCapture`, `ChildSpawnHandle`, `ChildUsage`, `PoolItem`,
  `SpawnChildArgs`, `CreateDelegationManagerArgs`, `DelegateTask`,
  `runBounded`, `createReportResultTool`, `ReportCapture`,
  `createRunTool`, `validateDelegateBatch`, `createWorktreeManager`,
  `WorktreeManager`.
- Tests: `production-host-delegation.test.ts` (17 tests) — all green.
- `pnpm lint -- src/host/production-host.ts src/host/production-host-delegation.ts
  src/host/index.ts src/index.ts` — clean.

### R2.6 — Phase 2 gate ✅
All gates green (2026-07-12):
- `pnpm typecheck` — clean
- `pnpm build` — clean
- `pnpm test` — 1029 tests, 76 files, all green
- `pnpm lint` (`biome check .`) — clean, 155 files
- `pnpm format:check` — clean, 155 files
- `pnpm audit --prod` — 7 vulnerabilities (2 low, 2 moderate, 3 high);
  all are existing transitive undici advisories through
  `@earendil-works/pi-coding-agent`; no new advisories introduced
- `tests/grep-guard.test.ts` — 4 tests, all green
- Extension spawning guard: `rg 'ctx\.(newSession|fork)\(' extensions/
  src/extension/` — only comment reference in `extensions/conduct.ts:22`
  (architectural documentation, not API usage); no forbidden patterns

### Delegation module size verification

| File | LOC | Limit | Status |
|------|-----|-------|--------|
| `ids.ts` | 82 | 50 | below |
| `validate-batch.ts` | 212 | 200 | below |
| `child-prompt.ts` | 88 | 80 | below |
| `child-tool-policy.ts` | 78 | 50 | below |
| `report-result-tool.ts` | 89 | 150 | below |
| `run-tool.ts` | 274 | 200 | OK |
| `worktree.ts` | 255 | 250 | OK |
| `pool.ts` | 82 | 80 | below |
| `manager.ts` | 365 | 350 | OK |
| `delegate-tool.ts` | 124 | 150 | below |
| `child-runner.ts` | 277 | (split) | OK |
| `results.ts` | 237 | (split) | OK |
| `production-host-delegation.ts` | 183 | 200 | below |
| `stub-host-delegation.ts` | ~170 | 200 | below |

All delegation files are below the ~400 LOC soft ceiling individually.
`manager.ts` (365 LOC) is within the split-threshold of 400 and was split
into `manager.ts` + `child-runner.ts` + `results.ts` per plan.
`ProductionHost` (497 LOC) is below the 500 LOC hard ceiling.

### Security and boundary audit ✅

No child `handoff`/`end`/`ask_user`/`delegate`/`bash` tools in any child
session (verified by `buildChildToolsAllowlist` and integration tests).
`run` tool uses `execFile` only; rejects shell metacharacters, `..`
escapes, absolute paths outside worktree, non-conductor branches. Worktree
gate rejects dirty or non-Git primary checkouts before any spawn.
No reducer, checkpoint, or main lifecycle changes. No
`ctx.newSession()`/`ctx.fork()` in `extensions/` or `src/extension/`.
Core, manifest, seam, cost, and persistence remain pi-runtime-free
(grep-guard test: 4/4 green).

## Risks and rollback

- **SDK contract drift:** use the installed `@earendil-works/pi-coding-agent` SDK
  `docs/sdk.md` and `dist` declarations as authority for `ToolDefinition`,
  `createAgentSession`, `SessionManager.create`, custom tool allowlists, and
  `AgentSession.abort`. If the installed contract conflicts with the senior spec,
  stop and surface the exact discrepancy; do not cast around it.
- **Security regression:** any uncertain path/branch check is a hard stop. Revert only
  the Phase 2 delegation files to the last clean checkpoint while preserving the
  accepted Phase 1 files; never delete a user worktree or branch as recovery.
- **Large-module growth:** split at responsibility boundaries before adding features;
  do not lower the lint/module-size bar to make the resume appear complete.
- **Uncommitted working tree:** implementation should be incremental and test-backed;
  if a slice fails, stop with its focused test output and leave the prior slice intact.

## External/source facts used

The installed SDK documentation and declarations were inspected during planning:

- `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` — `createAgentSession`,
  explicit `tools`/`customTools`, `AgentSession.subscribe`/`prompt`/`abort`/`dispose`,
  and custom cwd behavior.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` —
  `ToolDefinition` requires a TypeBox `parameters` schema and the SDK execute
  signature.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts` —
  `SessionManager.create(cwd, sessionDir, { parentSession })` and parent-session
  header support.
- `node_modules/@earendil-works/pi-coding-agent/docs/session-format.md` — durable
  JSONL session files and `parentSession` provenance.

No researcher handoff is required: all external facts needed for this Phase 2 delta
are available in the installed SDK documentation and the repository's acknowledged
spec.
