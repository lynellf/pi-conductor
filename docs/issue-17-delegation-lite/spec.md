# Spec: Concurrent worktree subagent profiles (Issue #17 lite)

**Status:** Draft — requires overseer acknowledgement before implementation.

## 1. Objective

Let an active conductor role delegate multiple independent coding tasks to named
subagent profiles. The host creates one isolated Git worktree and branch per
task, runs the children concurrently up to a manifest limit, and returns ordered
results to the parent. The parent reviews the branches and decides whether to
merge or cherry-pick them.

This is a single-user productivity feature. It deliberately retains the useful
part of Issue #17—parallel implementation in isolated worktrees—and removes the
reliability machinery whose cost is disproportionate for that use case.

### Relationship to the archived Issue #17 spec

This is a new, narrower successor to
[`../archive/issue-17-delegation/spec.md`](../archive/issue-17-delegation/spec.md).
It does **not** amend, supersede, or delete that document. The archived spec
remains the design for the original feature, including retry/fallback chains,
cost reservation, guarded cleanup, and comprehensive recovery.

| This spec includes | This spec deliberately excludes |
| --- | --- |
| Named child profiles | Child retries, fallback chains, and retry-intent records |
| Multiple tasks per `delegate` call | Cross-call queues or a global worker pool |
| Bounded concurrent child sessions | Cost reservation, parent-cap projections, or per-task budget envelopes |
| One clean Git worktree + branch per task | Automatic merge, cherry-pick, conflict resolution, or branch deletion |
| Writable child tools constrained to that worktree | Unrestricted child shell or OS/network isolation claims |
| Start/terminal records and terminal cost roll-up | Resuming/relaunching an in-flight child after a crash |
| Parent/run abort signals for active children | Automatic worktree cleanup or recovery cleanup |

The parent remains the only FSM actor: it alone edits the primary checkout,
emits `handoff`/`end`, and decides how to integrate child branches.

## 2. Architecture and terminology

- **Parent role:** an ordinary FSM role currently running in the conductor.
- **Subagent profile:** a named manifest entry that defines a child prompt and
  model policy. It is not an FSM `Role`, cannot appear in `MachineDefinition`,
  and cannot be a reducer target.
- **Child task:** one requested profile/objective pair, one child SDK session,
  one generated worktree, and one generated branch.
- **Child:** the auxiliary session executing that task.

`delegate` is an ordinary host tool. It never creates a machine event, calls
`reduce`, changes `Checkpoint.active_role_session`, or writes a main-session
lifecycle record. Child records are host observability data only.

## 3. Manifest contract

Add optional top-level `subagents` and optional parent-role `delegation`:

```yaml
roles:
  - name: implementer
    tools: [read, grep, edit, write, bash, handoff, end, delegate]
    delegation:
      allowed_subagents: [api-implementer, test-writer]
      max_children_per_session: 6
      max_parallel: 3

subagents:
  - name: api-implementer
    models:
      - model: anthropic:claude-sonnet-4-5
        effort: high
    max_session_cost_usd: 2.00
    system_prompt: .pi/subagents/api-implementer.md

  - name: test-writer
    models: [anthropic:claude-sonnet-4-5]
    max_session_cost_usd: 1.00
    system_prompt: .pi/subagents/test-writer.md
```

Validation rules:

1. A parent receives `delegate` only when it declares both `tools: [delegate]`
   and a `delegation` block. Neither is injected implicitly.
2. `allowed_subagents` is a non-empty, duplicate-free list of declared profiles.
3. `max_children_per_session` and `max_parallel` are finite positive integers;
   `max_parallel <= max_children_per_session`.
4. A parent session may admit at most `max_children_per_session` tasks across
   all of its `delegate` calls. A task admitted for a child does not free a slot
   when it completes.
5. Subagent names are unique, use the existing role-name grammar, and cannot
   collide with ordinary FSM role names.
6. A profile uses the existing model/system-prompt syntax and declares a finite
   positive `max_session_cost_usd`. It has no routing, tools, delegation, or
   visit-cap fields.
7. Changing delegation or profile policy is a manifest semantic change and uses
   the existing manifest-version bump process.

The parser, validator, `MachineDefinition`, and reducer remain separate:
subagent profiles are host-only configuration.

## 4. Parent tool contract

The enabled parent receives one TypeBox-backed `delegate` tool:

```ts
{
  tasks: Array<{
    id: string,              // ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
    subagent: string,        // profile name allowed to this parent
    objective: string,       // 1–8,192 characters
    expected_output: string  // 1–8,192 characters
  }>
}
```

The host validates the full batch before any child spawn:

- at least one task and at most the parent's remaining child allowance;
- unique task IDs;
- every profile allowed to the parent;
- bounded non-empty objective and expected output;
- a clean Git primary checkout with a resolvable `HEAD` commit.

The clean-check is exactly `git status --porcelain=v1 --untracked-files=all`;
ignored files do not block delegation. Any validation or Git-gate failure returns
one structured tool error and creates no worktree or child.

The host launches admitted tasks through a bounded pool of `max_parallel`. A
child failure does not cancel siblings. The tool waits for every child terminal
and returns results in input order:

```ts
{
  results: Array<{
    task_id: string,
    subagent: string,
    child_id: string,
    status: "completed" | "failed" | "no_changes" | "cancelled",
    summary: string,
    verification?: string[],
    branch: string,
    worktree_path: string,
    base_commit: string,
    head_commit: string | null,
    session_file: string,
    usage: { input: number, output: number, cache_read: number,
             cache_write: number, tokens: number, cost: number },
    failure_reason?: string
  }>
}
```

Host-generated identity, Git metadata, and usage are authoritative. Child
summary is capped at 4,096 characters; verification is capped at 16 lines of
256 characters each.

## 5. Worktree lifecycle

For each admitted task, the host:

1. Captures one clean primary `HEAD` as the batch base commit.
2. Allocates unique host-generated names:
   - worktree: `<runStateDir>/worktrees/<childId>`
   - branch: `conductor/<runId>/<childId>`
3. Runs `git worktree add -b <branch> <worktree> <baseCommit>` through argv
   arrays (`execFile`), never a shell string.
4. Creates the child with the worktree as its `cwd`.
5. At terminal time, verifies the worktree belongs to the generated path and
   branch and checks its Git status and `HEAD`.

A `completed` child must leave uncommitted file changes in its worktree. A
`no_changes` child leaves the worktree clean at `base_commit`. The host derives
the authoritative terminal status from that verified state; a child that reports
`completed` without changes becomes `no_changes`. A checked-out commit different
from `base_commit` is rejected because child sessions cannot create commits.

**No automatic cleanup occurs.** Every worktree and branch is retained for the
parent/operator to inspect, diff, cherry-pick, or remove manually. This removes
an entire class of destructive cleanup and crash-recovery behavior. The host
never merges, cherry-picks, resets, or deletes a child branch.

## 6. Child session and tool policy

A child is a standalone `createAgentSession` using the profile's resolved model,
effort, system prompt, and per-session cost cap. Its prompt contains the task,
expected output, run/parent metadata, generated worktree path, and its reporting
contract; it does not include the parent transcript.

The child gets path-confined file tools rooted in its worktree:

```text
read, grep, find, ls, edit, write, report_result
```

`report_result` is host-bound to the generated child/task identity and terminates
the child after a valid call:

```ts
{
  status: "completed" | "failed" | "no_changes",
  summary: string,
  verification?: string[]
}
```

Children receive no process-execution tool. The parent runs tests, linters,
formatters, builds, Git inspection, commits, and integration after it receives
the child worktree path. This deliberately avoids claiming that a restricted
process allowlist is a sandbox.

Children never receive `handoff`, `end`, `ask_user`, `delegate`, `run`, `bash`,
any parent custom tool, or arbitrary path access. A missing/invalid report,
provider error, child session-cap breach, or abort produces a host-generated
terminal result. There are no child retries or model fallbacks in this version.

## 7. Persistence, accounting, cancellation, and resume

The host uses the existing additive child records:

1. Append `subagent_started` after the child SDK session exists and its real
   session file, worktree path, branch, and base commit are known, before prompt.
2. Append exactly one `subagent_completed` or `subagent_failed` for every
   started child attempt, with observed normalized usage and verified Git metadata.

Child terminal usage contributes to existing `perRun`, `perModel`, and
`perSubagent` roll-ups. It never enters the parent lifecycle usage or `perRole`.
There is no child-cost reservation or pre-admission against the run cap; normal
run-cap enforcement observes terminal child cost. A child can therefore overshoot
the current run cap by at most its profile's session cap.

Run abort closes new task admission, signals all active children first, and then
immediately signals the parent session without waiting for children to finish.
The host attempts cancelled child terminal records with captured usage where
available. Child activity never reaches the reducer.

In-flight child recovery is deliberately unsupported. Resume converts each
unmatched `subagent_started` to one `subagent_failed` with
`status: "cancelled"` and reason `recovered_child_lost`; it never resumes,
retries, deletes, or assumes success for the child. Its worktree and branch stay
preserved for operator inspection. A second resume must not duplicate that
terminal.

## 8. Implementation boundaries

### Always

- Keep all child activity outside the reducer, `MachineDefinition`, checkpoint,
  and main role lifecycle.
- Use TypeBox as the sole schema source for `delegate` and `report_result`.
- Use standalone `createAgentSession`; do not use `ctx.newSession()` or
  `ctx.fork()` in extension code.
- Use the same child worktree/tool policy in production and StubHost tests.
- Validate the whole batch and primary Git cleanliness before any child spawn.
- Preserve child worktrees and branches; make integration an explicit parent or
  operator action.

### Ask first

- Adding automatic cleanup, merging/cherry-picking, retries/fallbacks, a global
  queue, cross-parent scheduling, child-to-child communication, or a UI command.
- Loosening the path-confined `run` policy or adding unrestricted child shell.
- Adding a dependency, changing child record shapes, or changing the reducer.
- Reusing the current Issue #17 implementation rather than starting clean.

### Never

- Let a child target the FSM, call `handoff`/`end`/`ask_user`/`delegate`, or
  persist directly.
- Let a child tool act on the primary checkout, an arbitrary path, or arbitrary
  Git repository state.
- Merge, cherry-pick, reset, or delete a child branch automatically.
- Claim worktree confinement is an OS or credential sandbox.
- Convert an unmatched child start into success during resume.

## 9. Project structure and code style

Expected implementation surface:

```text
src/manifest/            # Profiles and parent delegation policy
src/seam/                # TypeBox schemas
src/persistence/log.ts   # Existing subagent start/terminal record variants
src/cost/rollup.ts       # Existing child-terminal roll-up path
src/host/delegation/     # Batch validator, bounded pool, worktree, child runner, tools
src/host/{stub,production}-host*.ts # Parent registration and SDK child factory
tests/{manifest,seam,host}/ # Contract, Git, stub-provider, and abort coverage
```

Prefer small responsibility-focused modules: `validate-batch`, `pool`,
`worktree`, `run-tool`, `report-result-tool`, and `child-runner`. Do not add
budget ledgers, attempt registries, recovery locks, task finalization records,
or cleanup managers.

```ts
// Host orchestration stays ordinary tool work, never an FSM transition.
const results = await runBoundedWorktreeChildren({ tasks, maxParallel, parent });
return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
```

TypeScript remains strict ESM with named exports, TypeBox schemas, no `any`, and
Biome. The pure-layer no-pi-import grep guard remains mandatory.

## 10. Testing and verification

Use Vitest, temporary real Git repositories, and existing StubHost/stub-provider
sessions; no API key or live provider is required.

1. Manifest gates expose `delegate` only to enabled parents and reject invalid
   profile/cap configuration.
2. Invalid batch/profile/task IDs and a dirty/non-Git primary checkout create no
   child or worktree.
3. Three tasks with `max_parallel: 2` overlap but never exceed two active
   sessions; results retain input order despite completion order.
4. Every child gets a unique worktree/branch at the pinned clean base and cannot
   access FSM tools, process execution, or the primary checkout.
5. Completed results require verified uncommitted changes; `no_changes` requires
   a clean base worktree; unexpected committed/incoherent results fail and remain
   preserved.
6. Child start/terminal records contain real session/Git metadata; usage appears
   once in run/model/subagent rollups and not parent lifecycle usage or `perRole`.
7. One child failure leaves sibling tasks running and returns all terminal results.
8. Run abort signals active children and parent without an FSM child transition.
9. Resume terminalizes unmatched children once and preserves their worktrees.
10. Existing no-delegation manifests, core/reducer behavior, extension
    session-tree guard, and record consumers remain green.

Repository gate:

```text
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm audit
```

## 11. Starting point and current worktree

This document changes no implementation and does not reset, delete, or commit
any current worktree change.

The current `main` contains the large original Issue #17 implementation through
`39a8946` plus a substantial dirty worktree. If this draft is accepted, begin in
a new clean worktree/branch from `fab009c`, the commit immediately before the
original Issue #17 implementation. This is preferable to subtracting worktree,
retry, reservation, cleanup, and recovery systems from the current branch.

Preserve/archive the current dirty worktree first. Do not reset or rewrite `main`
until the overseer explicitly chooses that disposal path.

## 12. Success criteria and approval

- A configured parent delegates multiple coding tasks concurrently to named
  profiles, each in a distinct worktree and branch.
- The parent receives ordered, host-verified results and manually chooses branch
  integration.
- Children cannot change the primary checkout or FSM state.
- The implementation remains a small, reviewable feature: concurrent worktrees
  plus the essential path-confinement boundary, not the archived feature's full
  lifecycle framework.
- The archived full Issue #17 spec remains intact.

Acknowledge this draft before implementation, specifically confirming that the
intentional omissions—retry/fallback, cost reservations, automatic cleanup, and
active-child recovery—are acceptable for the single-user version.
