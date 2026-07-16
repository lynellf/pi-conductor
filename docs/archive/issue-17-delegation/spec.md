# Spec: bounded sub-agent delegation with isolated worktrees (Issue #17)

Status: Acknowledged by overseer (2026-07-12). Implementation is authorized.

## 1. Verified context

GitHub issue #17 is **"Add bounded sub-agent delegation with isolated worktrees"**
and is open. Its requested feature is not handoff-context persistence. The
predecessor handoff incorrectly described #17 as that feature; bounded handoff
context is already shipped separately as issue #14 (`ADR-001` and
`src/host/handoff-context-tool.ts`). This spec addresses the actual #17 body.

The current system has a single host-owned FSM loop:

- `src/core`, `src/manifest`, `src/seam`, `src/cost`, and `src/persistence` are
  host-agnostic and the reducer is payload-blind.
- `src/host/loop.ts` is the sole owner of `reduce`, `reduceLifecycle`, persistence,
  and main-role spawning.
- `src/host/production-host.ts` creates standalone SDK sessions with
  `createAgentSession`; the extension shell never calls `ctx.newSession()` or
  `ctx.fork()`.
- `src/persistence/log.ts` defines the append-only `PersistedRecord` union and
  `src/host/log-file.ts` stores one JSONL file per run.
- Manifest parsing and semantic validation are split between
  `src/manifest/parse.ts` and `src/manifest/validate.ts`; `MachineDefinition`
  deliberately contains only reducer inputs.
- Existing parent-session usage, model fallback, run-cap, and cancellation logic
  lives in `src/host/loop.ts`, `src/host/session-event-handler.ts`,
  `src/host/cost.ts`, and `src/host/api.ts`.

The installed pi SDK supports independent `createAgentSession` instances,
explicit `tools`/`customTools` allowlists, custom working directories, and
file-backed `SessionManager` instances. It also documents `SessionManager`'s
`parentSession` header and `AgentSession.abort()` APIs. Those SDK sessions are
appropriate for auxiliary children; the main FSM must not be expanded to model
those children.

## 2. Objective and user outcome

Allow an explicitly enabled active role to call one host tool, `delegate`, with
multiple independent tasks. The host runs those tasks concurrently up to a
manifest limit, waits for all task terminals, and returns an ordered structured
result set to the parent role. The parent remains the only actor that can emit
`handoff` or `end`, and decides whether/how to integrate any child work.

The feature must provide useful parallelism without creating a nested conductor,
allowing child-owned FSM transitions, bypassing cost accounting, or allowing a
child's write to overwrite the primary checkout.

## 3. Goals

1. Opt-in, manifest-controlled delegation for selected parent roles.
2. Bounded task count, concurrency, depth, task/result sizes, model attempts, and
   per-child cost.
3. Concurrent auxiliary sessions that are observable in the existing run log but
   never enter the reducer checkpoint or main FSM transitions.
4. Read-only tasks that receive no mutation tools.
5. Writable tasks created from a pinned clean base commit in unique Git worktrees
   and branches; no automatic merge, cherry-pick, or conflict resolution.
6. Durable child session files and parent-linked lifecycle records.
7. Child usage included in run cost accounting and parent/run cancellation.
8. Resume-time discovery and reconciliation of interrupted children and safe
   worktree cleanup.
9. Existing manifests and runs behave exactly as before when delegation is absent.

## 4. Non-goals

- Nested conductor runs, child-owned `handoff`/`end`, or child FSM states.
- Recursive delegation in v1; `max_depth` is accepted only as `1`.
- Automatic merge, cherry-pick, conflict resolution, or mutation of the primary
  checkout by a child.
- Propagation of uncommitted parent changes into a writable child worktree.
- Strong OS/container isolation from arbitrary external resources. The v1 tool
  policy limits the child tools and the worktree command surface; it does not
  claim to sandbox the host process, network, credentials, ports, or databases.
- A new UI command. Existing run status and record-emitter consumers remain
  compatible; child records are available from the run log and cost roll-up.

## 5. Assumptions and recommended v1 decisions

These assumptions make the issue implementable without silently changing the FSM:

1. **Feature enablement:** a role must have both a `delegation` block and the
   literal `delegate` entry in `roles[].tools`. Neither is force-injected. This
   makes accidental model access impossible when only one half is configured.
2. **Manifest shape:** enabled delegation requires finite positive
   `max_parallel`, finite positive `max_children`, `max_depth: 1`, at least one
   `workspace_modes` entry, and finite positive `max_child_cost_usd`.
3. **Model policy:** a child starts with the active parent's resolved model and
   effort. If that model errors, the child follows the parent's already-pinned,
   finite retry/fallback entries in order; all attempts share the one
   `max_child_cost_usd` budget. There is no implicit model or uncapped fallback.
4. **Parent budget:** delegated usage is charged to the parent invocation's
   session budget for admission/cap purposes, while child usage remains in child
   terminal records so roll-ups do not double count it. The parent session's own
   lifecycle usage field remains its provider usage only.
5. **Worktree gate:** any batch containing a `worktree` task is rejected before
   spawning if the primary checkout is not a Git repository or has tracked or
   untracked changes. The cleanliness check is
   `git status --porcelain=v1 --untracked-files=all`, so ignored files do not block
   the batch. The base is the resolved `HEAD` commit.
6. **Child command surface:** children do not receive unrestricted SDK `bash`.
   Read-only children get path-confined read/search/list tools plus
   `report_result`. Worktree children additionally get path-confined edit/write
   tools and a host-owned argv-based test/Git command tool with no shell
   interpolation. The command policy is documented and tested; it is not an OS
   sandbox.
7. **Result authority:** child task IDs, child/session IDs, session paths,
   worktree paths, branch names, base/head commits, and usage are host-generated
   or host-verified. Child `report_result` supplies only status, bounded summary,
   and bounded verification lines.
8. **Cleanup:** after a successful or no-change result is durably recorded, the
   clean worktree directory may be removed while its branch is retained for the
   parent to inspect or cherry-pick. Failed, cancelled, dirty, or cleanup-error
   worktrees are preserved.
9. **Manifest versioning:** enabling, disabling, or changing delegation policy is
   a manifest semantic change and should bump `version`. A run continues to use
   the pinned manifest version; old manifests without delegation remain valid.

## 6. Manifest contract

Extend the parsed role configuration additively:

```yaml
roles:
  - name: implementer
    tools: [read, bash, edit, write, handoff, end, delegate]
    delegation:
      max_parallel: 3
      max_children: 6
      max_depth: 1
      workspace_modes: [read_only, worktree]
      max_child_cost_usd: 2.00
```

`delegation` is invalid unless all of the following hold:

- `delegate` is present in the role's declared `tools`.
- `max_parallel` and `max_children` are positive finite integers.
- `max_depth` is exactly `1` in v1.
- `workspace_modes` is a non-empty array containing only `read_only` and/or
  `worktree`, with no duplicates.
- `max_child_cost_usd` is a positive finite number.

The parser rejects malformed types and unsafe numeric values. Semantic manifest
validation reports typed hard errors for invalid delegation policy and a typed
hard error when `delegate` is declared without a delegation block. A role with
no delegation block is unchanged; its session does not receive `delegate`.
Delegation settings are host policy only and are not added to `MachineDefinition`.

## 7. Tool and session contracts

### 7.1 Parent `delegate` input

The TypeBox seam schema is the sole source of truth for the host tool and its
runtime validator. The input is:

```ts
{
  tasks: Array<{
    id: string,                 // ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
    objective: string,          // non-empty, bounded
    expected_output: string,    // non-empty, bounded
    workspace: "read_only" | "worktree"
  }>
}
```

The host additionally enforces, before any spawn:

- at least one task;
- no duplicate task IDs in the batch;
- batch count does not exceed the parent's remaining `max_children`;
- each requested workspace mode is allowed by the role's manifest policy;
- no task/objective/expected-output exceeds the documented bounds;
- the worktree cleanliness/base-commit gate when any worktree task is present;
- run and parent budget admission for each task.

A rejected batch produces one structured tool error and no child. The parent can
retry with a corrected batch; it does not create a machine transition.

### 7.2 Child result tool

Every child receives exactly one host-bound `report_result` tool. Its parameters
are:

```ts
{
  status: "completed" | "failed" | "no_changes",
  summary: string,             // bounded
  verification?: string[]      // bounded count and line length
}
```

The tool is bound to the host-generated task ID; children cannot report for a
different task. A second report is an `extra_emission` child failure. A child that
terminates without a valid report is a failed task with a host-generated reason.
The parent receives results in the original input order, regardless of completion
order. Each result includes host metadata: `task_id`, `child_id`, `session_file`,
`workspace`, optional branch/head commit, and normalized usage.

### 7.3 Forbidden child controls

Child sessions never receive `handoff`, `end`, `ask_user`, or `delegate`, whether
or not those names appear in the parent role's manifest. They cannot call the
reducer, persist records directly, spawn grandchildren, or choose arbitrary
session/worktree paths. Their system prompt states the bounded objective, expected
output, parent/run metadata, workspace mode, and report contract without injecting
the parent's full transcript.

### 7.4 Workspace tools

- `read_only`: path-confined `read`, `grep`, `find`, and `ls`, plus
  `report_result`. No `edit`, `write`, `bash`, or mutation-capable custom tool.
- `worktree`: the same path-confined inspection tools, path-confined `edit` and
  `write`, a restricted argv-based `run` tool for tests and approved Git
  operations, and `report_result`. The tool rejects absolute paths, `..` escapes,
  shell metacharacter command strings, and Git operations outside the generated
  worktree/branch policy. It must not expose the SDK's unrestricted `bash`.

The host uses `createAgentSession({ cwd, tools, customTools, sessionManager })`
for each child. It uses a separate file-backed session directory under the run
state directory and records the parent session relationship in the session
header and conductor records. The extension remains a shell; no
`ctx.newSession()`/`ctx.fork()` is introduced.

## 8. Concurrency and lifecycle

1. `delegate` validates the complete batch and performs budget/worktree admission
   before launching tasks.
2. The host allocates a fresh child ID per task, persists `subagent_started`, then
   starts tasks through a bounded worker pool. At most `max_parallel` children are
   active; task result ordering is deterministic input order.
3. A child session is an auxiliary `createAgentSession` invocation. Its checkpoint
   is never `active_role_session`; only the parent role session participates in
   `reduceLifecycle`.
4. A child prompt contains the task envelope and fixed policy. The child runs
   until `report_result`, a provider/model failure, abort, or no report.
5. Model retries/fallbacks are bounded by the pinned parent model configuration
   and share `max_child_cost_usd`. Each attempt has its own child session file and
   started/terminal record; the task's returned result aggregates the attempts.
6. One failed child does not cancel successful siblings. A batch returns every
   task's terminal result.
7. After all tasks are terminal, the tool returns results to the parent. The parent
   may continue using its ordinary tools and must still emit exactly one main
   `handoff` or `end`.

## 9. Persistence and accounting

Add host-agnostic records to `PersistedRecord` without involving the reducer:

```ts
{
  type: "subagent_started",
  run_id: string,
  child_id: string,
  task_id: string,
  parent_role: Role,
  parent_session: string,
  session_file: string,
  attempt: number,
  model: string | null,
  model_effort: ModelEffort,
  workspace: "read_only" | "worktree",
  worktree_path?: string,
  branch?: string,
  base_commit: string | null,
  ts: number
}
```

Each attempt ends with one terminal record. The common metadata is the same
as `subagent_started`; the terminal discriminant is intentionally precise:

```ts
type SubagentTerminal =
  | {
      type: "subagent_completed";
      status: "completed" | "no_changes";
      summary: string;
      verification?: readonly string[];
      head_commit?: string;
    }
  | {
      type: "subagent_failed";
      status: "failed" | "cancelled";
      summary: string;
      verification?: readonly string[];
      head_commit?: string;
      failure_reason: string;
    };

// Both variants also carry:
// run_id, child_id, task_id, parent_role, parent_session, session_file,
// attempt, model, workspace, optional worktree_path/branch,
// base_commit: string | null, usage: UsageRecord, and ts.
```

The host, not the child, writes these records. Summaries and verification lines
are bounded before persistence. Terminal usage is recorded for successful,
failed, cancelled, and model-error attempts. Intermediate model failures are
marked as retryable in their terminal metadata; the final task result remains
failed only after the configured attempts are exhausted.

Cost roll-up changes:

- `perRun` and `perModel` include child terminal usage.
- Add an additive `perSubagent`/delegation view keyed by child/task for
  observability; existing `perRole` remains the primary FSM-role view, avoiding
  double attribution of a child to a role.
- `runCostSoFar()` includes all child terminal usage.
- Parent session-cap admission includes the child's charged cost through a
  separate budget ledger, while `session_ended`/`session_failed` parent usage
  stays provider-only. No usage is counted twice.
- Before starting a child, the host reserves its finite child budget against the
  current run cap and parent budget. Reservation is released/settled on terminal.
  A run-cap breach aborts active children and prevents new admissions; the normal
  parent loop remains the only owner of any eventual machine `end` event.

Record ordering is append order, not completion order. Consumers reconstruct
siblings by `(run_id, parent_session)` and pair each `subagent_started` attempt
with its terminal record by `session_file`/`attempt`.

## 10. Git worktree and cleanup contract

For a worktree task, the host:

1. Resolves the primary repository root with `git -C <cwd> rev-parse
   --show-toplevel` and captures `HEAD` with `git rev-parse --verify HEAD`.
2. Rejects the whole batch before spawning if the repository is absent or the
   porcelain cleanliness check reports tracked/untracked changes.
3. Creates a generated path under the run state directory and a generated branch
   with a conductor-owned prefix, using `execFile` argument arrays (never shell
   interpolation):
   `git worktree add -b <generated-branch> <generated-path> <base-commit>`.
4. Records the generated path, branch, and base commit in `subagent_started`.
5. Verifies the final branch, `HEAD`, and clean/dirty status before accepting a
   `completed` or `no_changes` report. A completed writable task must have a
   committed head; `no_changes` must still point at the base commit. A dirty or
   incoherent result is recorded as failed and its worktree is preserved.
6. Never merges, cherry-picks, resets, or deletes the generated branch. The parent
   receives the branch/head and chooses any later integration.

Successful clean worktrees are removed only after the terminal record is durably
appended. Failed, cancelled, dirty, or cleanup-error worktrees remain for
inspection. The cleanup path verifies that both the worktree path is beneath the
run state directory and the branch has the conductor-owned prefix before removing
anything. It must never delete the primary checkout or an unrelated branch.

## 11. Cancellation, recovery, and failure containment

- **Cancellation ordering (superseded/clarified by
  `docs/issue-17-delegation-lifecycle-adjudication/spec.md`):** cancellation first
  closes child admission, initiates abort/dispose for every active child, then
  immediately initiates the active parent-session abort **without awaiting** child
  abort, terminal persistence, disposal, or cleanup. Child signals are issued first,
  but child and parent abort run concurrently; parent abort is never append-gated.
  Each child has one immutable cancelled-terminal candidate with captured usage where
  available. A failed append retains that candidate for retry and does not prevent
  any other child or parent abort.
- A run has one secure per-run execution lease held from start/resume state access
  through the whole loop. `run_id` is validated as the host-minted canonical UUID and
  state/lock roots are realpath-contained, non-symlinked direct descendants of the
  configured base root. Invalid IDs or unsafe roots make no writes or cleanup.
- A child task, distinct from its attempts, is durably finalized once. Retryable
  attempts persist retry intent; recovery finalizes interrupted retry chains as
  recovered cancellation rather than spawning unowned retry work. Each retry uses a
  fresh session, worktree, and branch while sharing the task's one cost envelope.
- A child failure is isolated to that task. Siblings continue unless the parent
  or run is cancelled or the run budget is exhausted.
- A provider/model error consumes the bounded child retry/fallback policy; after
  exhaustion it is a failed task, not a main `session_failed` lifecycle event.
- On resume, exact attempt records and task retry/finalization state are scanned.
  The host records an unmatched attempt terminal before finalizing interrupted work
  as recovered cancellation with zero or recoverable usage; it does **not** start a
  retry whose parent invocation crashed. It safely cleans only clean conductor-owned
  worktrees and preserves dirty or unsafe ones. The parent main-session crash
  reconciliation remains the existing `reduceLifecycle(session_failed, "crashed")`
  path, but executes while the per-run execution lease is held.
- Recovery and cleanup are idempotent: a second resume never duplicates an attempt
  terminal/task finalization or removes a non-conductor path. Missing session/worktree
  files are surfaced as explicit recovery metadata, not silently treated as success.

## 12. Invariants and failure modes

### Invariants

1. The reducer and `MachineDefinition` never see delegation tasks, child payloads,
   child sessions, worktree branches, or child costs as machine state.
2. The parent role session is the only session authorized to call `handoff` or
   `end`; the loop remains the sole owner of reducer calls and persistence policy.
3. Every admitted child attempt has one persisted `subagent_started` and exactly
   one persisted terminal record, including failures and cancellation.
4. Every child terminal usage is included once in run accounting.
5. Every writable child path and branch is host-generated, unique, and verified
   before cleanup; no child operation targets the primary checkout.
6. Delegation is bounded by manifest policy and current budget before any child is
   spawned; there is no recursive or unbounded fallback path.
7. Child result ordering is deterministic even though execution is concurrent.
8. A run can resume from the main checkpoint without replaying child output; child
   records are observability/recovery data, not event-sourced machine state.

### Failure matrix

| Failure | Host behavior | Main FSM effect |
|---|---|---|
| malformed/unauthorized delegate batch | Return structured tool error; spawn none | None |
| dirty/missing Git base for worktree batch | Return actionable tool error; spawn none | None |
| child no report or invalid report | Persist failed child terminal; continue siblings | None |
| child provider error | Retry/fallback within finite child budget; then fail task | None |
| one child failure | Return failed result alongside sibling results | None |
| child worktree dirty at report | Persist failed terminal and preserve worktree | None |
| child worktree cleanup failure | Terminal remains authoritative; preserve path and surface warning | None |
| parent/run abort | Abort parent and all children; persist cancelled terminals | Run exits through existing abort path |
| run budget exhausted during batch | Stop admission, abort active children, return terminal results | Parent loop owns any final machine close |
| process crash with active child | Resume reconciles unmatched child attempt | Main checkpoint path unchanged |
| concurrent tasks race shared external resource | No automatic resolution; return independent results | Parent decides whether to continue |

## 13. Compatibility, migration, rollback

- Delegation is disabled by default. Manifests without `delegation` and existing
  persisted logs require no migration and follow the existing execution path.
- New record variants are additive. Existing `RecordLog`, stats, and resume code
  must ignore the absence of child records; old logs never synthesize children.
- `MachineDefinition` and reducer signatures do not change. Delegation settings
  remain pinned host configuration associated with the loaded manifest version.
- Enabling or changing delegation should bump the manifest `version`, so a run
  cannot silently change its child policy during resume. A version mismatch uses
  the existing resume rejection path.
- Rollout/rollback is configuration-only for new runs: remove `delegate` and the
  delegation block to disable the tool. Completed child branches remain explicit
  Git artifacts; no automatic rollback of parent work or child commits is
  attempted.
- No new package dependency is needed. Git is an existing runtime prerequisite
  only for the `worktree` mode; `read_only` remains usable without Git.

## 14. Performance expectations

- `max_parallel` is a hard upper bound on active child SDK sessions per parent.
- Child summaries and verification arrays are bounded before being returned to the
  parent or persisted, preventing unbounded prompt growth.
- Worktree creation and synchronous JSONL appends are expected v1 overhead; finite
  `max_children` bounds the worst case. Do not introduce global unbounded queues.
- Results are assembled in input order without serializing child execution.
- Provider throttling is surfaced as child failure/retry; no hidden parallelism
  beyond the configured pool is allowed.

## 15. Testing and acceptance criteria

The feature is complete only when all of the following are demonstrated with
unit tests, temporary Git repositories, and stub-provider sessions (no API key):

1. A role with valid delegation policy can submit multiple tasks and tasks overlap
   in time up to `max_parallel`.
2. Task IDs, counts, duplicate IDs, workspace permissions, depth, and bounded
   strings are validated; unauthorized roles do not receive `delegate`.
3. Children cannot access `handoff`, `end`, `ask_user`, or `delegate`; read-only
   children have no mutation tools and cannot mutate the primary checkout.
4. Worktree tasks reject dirty primary repositories before spawning, use the pinned
   base commit, receive unique paths/branches, and cannot write the primary tree.
5. Completed worktree tasks require committed changes; no-change tasks require the
   base head; dirty/incoherent reports fail and preserve the worktree.
6. Child results are collected in input order, include partial-batch success and
   failure, and reject missing/duplicate reports.
7. Each child attempt has persisted parent-linked start/terminal records, a durable
   session file, normalized usage, and host-verified branch/head metadata.
8. Child usage appears exactly once in run cost roll-up and run-cap admission;
   parent session cap and model retry/fallback limits cannot be bypassed.
9. Parent/run cancellation aborts all active children, records cancelled terminals,
   and leaves no live child process behind.
10. Resume identifies unmatched child attempts, reconciles them idempotently, safely
    removes only clean conductor-owned worktrees, and preserves dirty worktrees.
11. A parent remains the sole main-FSM transition owner; child activity never changes
    `Checkpoint.active_role_session` or invokes `reduce`.
12. Existing tests for manifests without delegation, reducer behavior, run resume,
    extension spawning boundaries, and record consumers remain green.

Required repository gates after implementation:

```text
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm audit
```

## 16. Repository boundaries for tactical planning

Expected implementation surfaces (the tactical plan may split these further):

- `src/seam/` — TypeBox schemas and validation for `delegate` and child result.
- `src/manifest/types.ts`, `parse.ts`, `validate.ts` — additive policy shape and
  typed validation.
- `src/persistence/log.ts` and `src/core/types.ts` — host-agnostic child record
  contracts and usage metadata; no pi imports.
- `src/cost/rollup.ts` and host stats — child cost dimensions without double count.
- `src/host/` — delegation manager, bounded pool, child tool policy, SDK session
  creation, usage/cap/cancellation wiring, Git worktree lifecycle, resume
  reconciliation, and StubHost parity.
- `src/host/api.ts` / factory and run-state paths — pass an explicit run-state
  directory and wire recovery without changing reducer ownership.
- `tests/host`, `tests/manifest`, `tests/seam`, `tests/cost`, `tests/persistence`,
  and `tests/grep-guard.test.ts` — contract, security, lifecycle, and regression
  coverage. `extensions/` should remain free of child spawning APIs.
- `docs/issue-17-delegation/spec.md` — this acknowledged source of truth; an ADR
  should be added if implementation changes the recommended security/worktree or
  accounting decisions.

## 17. Open user decisions

These are the exact decisions to confirm before implementation is finalized:

1. **Manifest policy:** approve the recommended requirement that delegation needs
   both `delegation:` and `tools: [delegate]`, and that
   `max_child_cost_usd` is mandatory for enablement.
2. **Command policy:** approve the recommended replacement of unrestricted child
   `bash` with path-confined file tools plus a restricted argv-based `run` tool.
   If unrestricted shell is required, that is a separate security acceptance and
   must not be described as worktree confinement.
3. **Model policy:** approve that children inherit the active parent's model
   chain, with retries/fallbacks sharing one child budget, rather than getting a
   separately configured child model list.
4. **Cleanup policy:** approve retaining generated branches while removing clean
   worktree directories, and preserving dirty/failed worktrees until an explicit
   cleanup operation.

## 18. Research and verification sources

- GitHub issue #17: the requested delegation, worktree, budget, cancellation,
  recovery, and acceptance requirements.
- `docs/archive/orchestrator-fsm-spec.md`: hub-and-spoke FSM, host/core boundary,
  session lifecycle, cost caps, persistence, and explicit out-of-scope child
  delegation in the archived v1 contract.
- `docs/decisions/ADR-001-handoff-context.md`: precedent for host-generated
  session provenance that must remain outside reducer state.
- Installed pi SDK `docs/sdk.md` and `docs/session-format.md`: standalone
  `createAgentSession`, explicit tools/custom tools, custom cwd, abort, and
  `SessionManager` parent/session-file behavior.
