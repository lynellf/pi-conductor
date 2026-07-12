# Phase 2 — Host Delegation Manager, Child Sessions, Tool Policy, Worktree

> **Resume note (2026-07-11):** This original Phase 2 task list remains the
> acceptance source. The interrupted checkout has partial helper code but not a
> complete Phase 2. Use [`phase-2-resume.md`](./phase-2-resume.md) for the
> evidence-backed delta, corrected SDK/tool contracts, remaining task order, and
> current verification baseline. Do not mark this phase complete from the
> existing partial files alone.

**Source:** [`../plan.md`](../plan.md); senior spec
[`./spec.md`](./spec.md). Phase 2 lands the host-side delegation
machinery: the `delegate` tool wired into the parent's session, the
`report_result` tool bound to each child, a bounded concurrency pool,
child tool policy per workspace mode (read_only / worktree), the
worktree lifecycle (creation + clean exit verification + cleanup),
and `StubHost` parity. Phase 1's host-agnostic types
(`DelegationPolicy`, `delegateInputSchema`, `reportResultInputSchema`,
`subagent_*` records, `rollup.perSubagent`) are the inputs to this
phase.

## Goal

End-to-end delegation works through `StubHost` (no API key, no
network) and is wired into `ProductionHost` such that an active role
in a manifest with delegation enabled can call the `delegate` tool,
run N tasks in parallel, and receive an ordered structured result
set. The parent role is unaware that work is happening in auxiliary
sessions; the FSM does not transition; the checkpoint is unchanged;
child records are appended via `host.persistRecord`; clean worktrees
are removed after the terminal record is durably appended; dirty
worktrees are preserved.

## Spec pointers (senior spec)

- §5 (assumptions — both `delegation:` and `tools: [delegate]`
  required, worktree gate, command policy, child result authority,
  cleanup)
- §6 (manifest contract — same as Phase 1)
- §7.1, §7.2, §7.3, §7.4 (tool and session contracts)
- §8 (concurrency and lifecycle)
- §9 (persistence — the host writes `subagent_*` records; the
  per-attempt terminal invariants)
- §10 (Git worktree and cleanup contract)
- §14 (performance expectations — bounded strings, deterministic
  ordering, no hidden parallelism)
- §15 (testing and acceptance criteria — 1, 2, 3, 4, 5, 6, 7, 11,
  12)
- §16 (repository boundaries — `src/host/delegation/` is new; the
  extension remains free of child spawning APIs)

## What this phase does NOT do

- No budget reservation against the run cap. Children consume the
  parent session's cap on admission but the run-cap enforcement for
  child spend is Phase 3.
- No cancellation propagation. `RunHandle.abort()` does not yet
  abort children; Phase 3 adds that.
- No resume reconciliation. A crashed run does not yet reconcile
  orphan children; Phase 3 adds that.
- No ADR, no version bump, no CHANGELOG entry. Those land in
  Phase 3 when the design is fully complete.
- No new package dependency. Git is an existing runtime
  prerequisite; `node:child_process.execFile` is built in.

## Tasks

### Task 2.1 — `delegation/` directory skeleton + child ID generation

**Description:** Create `src/host/delegation/` and add the
foundational pure helpers that everything else builds on. Keep this
file ≤ 250 LOC; split if it grows.

**Files:**

- `src/host/delegation/ids.ts` (new)

**Acceptance criteria:**

- [ ] Exports `generateChildId(): string` returning a host-allocated
      id of the form `child-<ULID>` or `child-<hex>` (use
      `node:crypto.randomBytes(8).toString("hex")`; deterministic
      enough for tests with a `randomBytes` injection seam).
- [ ] Exports `generateWorktreePath(stateDir, childId): string`
      returning a path of the form
      `<stateDir>/worktrees/<childId>` (always beneath `stateDir`).
- [ ] Exports `generateBranchName(childId): string` returning
      `conductor/<childId>` (always carries the `conductor/`
      prefix; the cleanup path verifies this prefix in Phase 3, but
      the generation rule is fixed here).
- [ ] All three helpers are pure: no I/O, no SDK imports, no
      time-based randomness. Tests use a deterministic randomBytes
      stub or a seed argument.
- [ ] File-level JSDoc documents the conductor-owned prefix policy
      and the cleanup invariant that depends on it.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/ids.test.ts` (new) green.

### Task 2.2 — `delegate` input validation helper

**Description:** Pure helper that validates a `delegate` input
against the manifest's delegation policy for the active role.
Returns a structured result (`ok` / `rejected` with reason) so the
host's `delegate` tool wrapper can surface a tool error without
spawning.

**Files:**

- `src/host/delegation/validate-batch.ts` (new)

**Acceptance criteria:**

- [ ] Exports `validateDelegateBatch(input: unknown, policy:
      DelegationPolicy, remainingChildren: number): ValidationResult`
      with discriminated `ok` / `rejected` branches.
- [ ] Rejection reasons (a typed string union, additive to
      `BreachFailureReason`-style vocabulary): `empty_tasks`,
      `task_id_invalid` (regex fail), `task_id_duplicate`,
      `task_count_exceeds_remaining`, `workspace_not_allowed`,
      `objective_empty` / `objective_too_long`,
      `expected_output_empty` / `expected_output_too_long`,
      `schema_invalid` (TypeBox failure — wraps
      `Value.Check(delegateInputSchema, input)`).
- [ ] `remainingChildren` is the parent's remaining
      `max_children` budget (host computes it as
      `max_children - admittedChildren`).
- [ ] `workspace_not_allowed` is checked against the role's
      declared `workspace_modes` (spec §6).
- [ ] Bounded string lengths match the Phase 1 schema bounds.
- [ ] Pure; no I/O; no SDK imports; unit-testable in isolation.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/validate-batch.test.ts` (new)
      green; ~12 table-driven cases per spec §7.1.

### Task 2.3 — Child prompt builder (envelope)

**Description:** Build the child's system prompt as a fixed
envelope: the parent's role name, the run id, the task objective,
expected output, workspace mode, and the report contract. The
envelope is **not** the parent's full transcript (spec §7.3).

**Files:**

- `src/host/delegation/child-prompt.ts` (new)

**Acceptance criteria:**

- [ ] Exports `buildChildSystemPrompt(args: { role: Role; runId:
      string; taskId: string; parentRole: Role; workspace:
      "read_only" | "worktree"; objective: string; expected_output:
      string; tools: readonly string[]; cwd: string; baseCommit?:
      string | null }): string`.
- [ ] The envelope includes a fixed, hard-coded policy block:
      "You are an auxiliary session. You will receive a single
      task; you MUST call `report_result` exactly once before
      stopping. You do not have `handoff`, `end`, `ask_user`, or
      `delegate`. You will not be prompted again."
- [ ] The envelope does NOT include the parent's transcript, prior
      `handoff` payloads, or any state from the parent's session
      (spec §7.3).
- [ ] The envelope is plain text, ≤ 8 KiB for a typical task.
- [ ] Pure function — no I/O, no SDK imports.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/child-prompt.test.ts` (new)
      green; verifies the envelope includes the required sections
      and never includes the parent transcript.

### Task 2.4 — Child tool policy (per workspace mode)

**Description:** Pure helper that returns the tool allowlist for a
child session given a workspace mode. The allowlist is the single
source of truth used by both `StubHost` and `ProductionHost`
(spec §16 — "extensions/ should remain free of child spawning
APIs"; the helper lives in `src/host/delegation/`).

**Files:**

- `src/host/delegation/child-tool-policy.ts` (new)

**Acceptance criteria:**

- [ ] Exports `buildChildToolsAllowlist(args: { workspace:
      "read_only" | "worktree"; role: Role }): readonly string[]`.
- [ ] `read_only` allowlist: `["read", "grep", "find", "ls",
      "report_result"]`. No `edit`, `write`, `bash`, `run`, or any
      machine tool.
- [ ] `worktree` allowlist: `["read", "grep", "find", "ls", "edit",
      "write", "run", "report_result"]`. No `bash`, no machine
      tools.
- [ ] `report_result` is always present in both modes.
- [ ] `handoff`, `end`, `ask_user`, `delegate` are NEVER in the
      allowlist (spec §7.3).
- [ ] Pure function — no I/O, no SDK imports.
- [ ] File-level JSDoc documents that the allowlist is the canonical
      policy used by both hosts; drift between hosts is a bug.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/child-tool-policy.test.ts`
      (new) green; matrix tests for both modes + a sanity check
      that forbidden tools are absent.

### Task 2.5 — `report_result` tool factory

**Description:** A `defineTool`-style tool factory (mirroring
`createHandoffTool` in `src/host/tools.ts`) that writes the child's
result to a host-owned capture buffer keyed by `(childId, attempt)`.
The tool's parameters use the Phase 1 `reportResultInputSchema`.

**Files:**

- `src/host/delegation/report-result-tool.ts` (new)

**Acceptance criteria:**

- [ ] Exports `createReportResultTool(args: { childId: string;
      attempt: number; onReport: (capture: ReportCapture) => void }):
      ToolDefinition`.
- [ ] The tool validates its args via
      `Value.Check(reportResultInputSchema, params)`; on failure it
      returns a structured error result WITHOUT writing the
      capture (mirroring the seam pattern in `tools.ts`).
- [ ] On valid args, the tool calls `onReport({ childId, attempt,
      status, summary, verification })` and returns a
      `terminate: true` result.
- [ ] A second call with the same `(childId, attempt)` pushes the
      buffer length to 2 — the host's child manager reads this as
      `extra_emission` (per spec §7.2).
- [ ] Defensive: never throws; all errors are returned as tool
      result errors.
- [ ] File-level JSDoc notes that the tool is bound to a specific
      `(childId, attempt)`; the host MUST construct one per child
      attempt and never reuse a closed attempt's tool.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/report-result-tool.test.ts`
      (new) green; happy path + extra-emission + schema-invalid.

### Task 2.6 — `run` tool factory (argv-based, for worktree children)

**Description:** A restricted argv-based `run` tool for worktree
children (spec §5 decision 2, §7.4). The tool:
  - Accepts a `command` (argv array) and optional `cwd` (must be
    the worktree path or a descendant).
  - Rejects absolute paths outside the worktree.
  - Rejects `..` escapes.
  - Rejects shell metacharacters in command strings (anything not
    in a tight allowlist of `[A-Za-z0-9_./=:-]`).
  - Has a hard list of allowed top-level commands (e.g., `git`,
    `pnpm`, `node`, `npm`, `ls`, `cat`, `grep`, `find` — pick the
    minimum set documented in JSDoc).
  - For `git` operations, restricts to the conductor-owned worktree
    path and branch prefix.
  - Returns the captured stdout/stderr to the child.

**Files:**

- `src/host/delegation/run-tool.ts` (new)

**Acceptance criteria:**

- [ ] Exports `createRunTool(args: { worktreePath: string; branch:
      string }): ToolDefinition`.
- [ ] The tool uses `execFile` (never `exec` / `spawn` with shell)
      with argv arrays.
- [ ] Reject conditions return a structured tool error WITHOUT
      invoking the underlying process.
- [ ] The tool is NOT registered for `read_only` children (only
      worktree children receive it).
- [ ] Defensive: never throws; process-spawn failures return as
      tool-result errors with the captured stderr.
- [ ] File-level JSDoc documents the allowlist and the explicit
      non-goal: "this is a tool policy, not an OS sandbox; it does
      not isolate the child from arbitrary network, credential, or
      port access."

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/run-tool.test.ts` (new)
      green; ~10 cases including:
        - Happy path: `["ls", "-la"]` inside the worktree.
        - `..` escape rejected.
        - Absolute path outside the worktree rejected.
        - Shell metacharacter rejected.
        - `git` operation against a non-conductor branch rejected.
        - Disallowed top-level command rejected.
        - `read_only` children never see this tool (asserted via
          `buildChildToolsAllowlist` in Task 2.4).

### Task 2.7 — Worktree lifecycle (pure-I/O wrapper)

**Description:** Wrap `node:child_process.execFile` in a
`runGit(args)` seam so the manager is testable with a fake
`runGit` (in `StubHost` tests) and uses real `execFile` in
`ProductionHost`. The seam lives in `src/host/delegation/worktree.ts`.

**Files:**

- `src/host/delegation/worktree.ts` (new)

**Acceptance criteria:**

- [ ] Exports `createWorktreeManager(args: { cwd: string; stateDir:
      string; runGit: (args: readonly string[], opts?: { cwd?:
      string }) => Promise<{ stdout: string; stderr: string }> }):
      WorktreeManager`.
- [ ] `WorktreeManager` interface methods (all async, all
      `Promise`-based):
        - `isRepo(): Promise<boolean>` — runs `git -C <cwd>
          rev-parse --show-toplevel`; resolves `true` iff exit code
          is 0.
        - `currentHead(): Promise<string | null>` — runs
          `git rev-parse --verify HEAD`; returns trimmed stdout, or
          `null` on non-zero exit.
        - `isClean(): Promise<boolean>` — runs `git status
          --porcelain=v1 --untracked-files=all`; resolves `true`
          iff stdout is empty.
        - `create(args: { childId: string; baseCommit: string }):
          Promise<{ path: string; branch: string }>` — runs
          `git worktree add -b conductor/<childId>
          <stateDir>/worktrees/<childId> <baseCommit>`.
        - `head(branch: string): Promise<string | null>` — runs
          `git rev-parse --verify <branch>`; returns the trimmed
          hash or `null`.
        - `isWorktreeClean(path: string): Promise<boolean>` —
          runs `git -C <path> status --porcelain=v1
          --untracked-files=all`; resolves `true` iff stdout is
          empty.
        - `remove(path: string): Promise<void>` — runs
          `git worktree remove --force <path>`; never deletes the
          primary checkout (the path is always under
          `stateDir/worktrees/`; the cleanup path verifies this
          prefix).
- [ ] All `runGit` calls use argv arrays; no shell interpolation
      anywhere in the file. (Defensive: the wrapper sanitizes
      inputs by checking that `childId` matches
      `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` before constructing any
      `git` command.)
- [ ] Defensive: every method's Promise is `.catch`-translated to
      a typed error; the manager does not throw raw
      `child_process` errors.
- [ ] File-level JSDoc documents the conductor-owned prefix policy
      and the cleanup invariant that depends on it.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/worktree.test.ts` (new)
      green; uses `mkdtemp` to create a real Git repo (matches the
      pattern at `tests/host/manifest.test.ts` for
      filesystem-touching tests). The test:
        - Inits a temp Git repo with a `git init && git -c
          user.email=test@test -c user.name=Test commit --allow-empty
          -m initial`.
        - Asserts `isRepo`/`currentHead`/`isClean` for the clean
          case.
        - Creates a worktree via `create`; asserts the path and
          branch; asserts `head(branch)` matches the base commit.
        - Makes a commit inside the worktree; asserts
          `isWorktreeClean` is `false`.
        - Removes the worktree; asserts the directory is gone but
          the primary checkout is intact.
        - Uses a fake `runGit` for the rejection tests (e.g.,
          rejects a `childId` that fails the regex).

### Task 2.8 — Bounded concurrency pool

**Description:** Pure helper that takes a list of async tasks and
runs them with at most `maxParallel` concurrent, returning the
results in input order. Spec §8 step 2: "At most `max_parallel`
children are active; task result ordering is deterministic input
order."

**Files:**

- `src/host/delegation/pool.ts` (new)

**Acceptance criteria:**

- [ ] Exports `runBounded<T>(args: { items: readonly T[];
      maxParallel: number; run: (item: T, index: number) =>
      Promise<unknown> }): Promise<readonly unknown[]>`.
- [ ] Returns results in `items` order, regardless of completion
      order.
- [ ] At no point are more than `maxParallel` `run` calls in
      flight simultaneously (asserted by a test that uses a
      `concurrentCount` counter).
- [ ] `maxParallel <= 0` is rejected (throws a typed error); the
      spec requires a positive finite integer.
- [ ] One task's rejection does NOT short-circuit the others; the
      rejected task's result slot holds the rejection.
- [ ] Pure control-flow; no I/O; no SDK imports.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/pool.test.ts` (new) green;
      ~6 cases: ordering, concurrency cap, mixed success/failure,
      empty input, maxParallel=1, maxParallel > items.length.

### Task 2.9 — `delegation-manager.ts` (orchestration)

**Description:** The host-side orchestrator that ties everything
together. Given a validated `delegate` input, a `DelegationPolicy`,
and a `hostFactory` (the same one used by `startRun` for the
parent's `createAgentSession`), it:
  1. Generates a `childId` per task.
  2. For worktree tasks, calls the worktree manager to verify
     clean primary checkout, then `create` a worktree.
  3. For each task, spawns a child session via the
     `createAgentSession` host factory with the
     child-tool-policy allowlist + the child-prompt envelope.
  4. Runs the children through the bounded pool.
  5. Waits for each child to terminate (via `report_result`,
     abort, or model error).
  6. For worktree tasks, verifies the head commit (or base commit
     for `no_changes`) and the dirty state at report time.
  7. Removes clean worktrees after the terminal record is durably
     appended; preserves dirty worktrees.
  8. Persists `subagent_started` before each task and a terminal
     (`subagent_completed` / `subagent_failed`) after each task.
  9. Returns an ordered result set in input order.

**Files:**

- `src/host/delegation/manager.ts` (new)

**Acceptance criteria:**

- [ ] Exports `class DelegationManager` (or a factory function
      `createDelegationManager`) with a single public method
      `run(args: { parentRole: Role; parentSession: string;
      policy: DelegationPolicy; input: unknown;
      hostFactory: ChildHostFactory;
      onRecord: (record: PersistedRecord) => void }): Promise<readonly ChildResult[]>`.
- [ ] `ChildHostFactory` is the type used to spawn a child session
      (separate from the parent's `createAgentSession` so the
      manager can pass a child-specific session manager rooted
      under the run state directory).
- [ ] `ChildResult` is the structured return value to the parent
      (per spec §7.2): `task_id`, `child_id`, `session_file`,
      `workspace`, optional `branch`/`head_commit`, normalized
      `usage`, `status`, `summary`, optional `verification`,
      optional `failure_reason`.
- [ ] Before any spawn, the manager calls the worktree gate (for
      worktree batches): `isRepo && currentHead && isClean`. A
      false result returns an actionable error result for the
      whole batch WITHOUT spawning any child.
- [ ] Each task persists exactly one `subagent_started` and
      exactly one terminal record (spec §12.1, invariant 3).
- [ ] Clean worktrees are removed only after the terminal record
      is durably appended (spec §10, step 5).
- [ ] The bounded pool is used for concurrent execution
      (`maxParallel` from the policy).
- [ ] The manager uses `host.persistRecord`-style
      `onRecord(record)` rather than the host object directly
      (single-owner rule).
- [ ] Defensive: any internal error is caught and persisted as
      `subagent_failed` with a host-generated `failure_reason`.
      The parent always gets a result for every task, in input
      order.
- [ ] Module size: this file is the largest in the directory.
      Target ≤ 350 LOC; if it grows past 400, split into
      `manager.ts` (orchestration only) and `results.ts` (result
      assembly + ordering).

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/manager.test.ts` (new)
      green; ~8 cases:
        - Happy path: 3 tasks, `maxParallel=2`, all `read_only`,
          all `completed`.
        - One task fails; siblings continue; result set has
          3 entries in input order.
        - Worktree batch with a dirty primary checkout → batch
          rejected with no spawns.
        - Worktree batch with a clean primary checkout → all
          tasks create worktrees, persist start/terminal records.
        - Worktree task with a dirty exit (`status: "completed"`
          but `isWorktreeClean` is `false`) → recorded as failed,
          worktree preserved.
        - Worktree task with `status: "no_changes"` and head ≠
          base commit → recorded as failed, worktree preserved.
        - Successful clean worktree removed after terminal record
          appended.
        - Pool concurrency cap respected (asserted via a
          `concurrentCount` test in the pool; the manager test
          reuses this).

### Task 2.10 — `delegate` tool wrapper (parent side)

**Description:** A `defineTool`-style tool that calls
`DelegationManager.run` and returns a structured text result to the
parent role. The tool is registered in the parent's `customTools`
ONLY when the role has both a `delegation:` block and
`tools: [delegate]` (Phase 1's validation guarantees this is
checked at load time).

**Files:**

- `src/host/delegation/delegate-tool.ts` (new)

**Acceptance criteria:**

- [ ] Exports `createDelegateTool(args: { manager:
      DelegationManager }): ToolDefinition`.
- [ ] The tool's `parameters` is `delegateInputSchema` (Phase 1).
- [ ] On `validateDelegateBatch` rejection, the tool returns a
      structured error result WITHOUT calling the manager.
- [ ] On accepted input, the tool calls
      `manager.run(...).then(results => …)` and returns a
      `terminate: false` result with a JSON-serialized
      `readonly ChildResult[]` payload (the parent role reads
      this as text).
- [ ] The tool is host-aware: it reads the active parent role,
      parent session, and policy from a `context` argument
      supplied by the host at registration time (the parent
      session knows its own role and policy).
- [ ] Defensive: never throws; manager errors are returned as
      tool-result errors with a generic message and a host-side
      log line for diagnostics.
- [ ] File-level JSDoc notes that `delegate` is a normal tool,
      not an emission tool; it does not write to the
      `SessionSeam` buffer.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/delegation/delegate-tool.test.ts`
      (new) green; ~4 cases: happy path, batch rejection (no
      spawns), batch rejection on dirty worktree, manager error
      returns tool-result error.

### Task 2.11 — `StubHost` delegation parity

**Description:** Extend `StubHost` in `src/host/stub-host.ts` so
that:
  1. The parent's `spawnRole` includes the `delegate` tool in
     `customTools` when the active role has a `delegation` block
     AND `tools: [delegate]`.
  2. The `delegate` tool's `context` argument is wired with the
     parent's role, parent session id, and the loaded manifest's
     policy for that role.
  3. The stub provider can be scripted with `StubStep.kind =
      "emit_delegate"` to drive a `delegate` tool call with a
     script-defined batch.
  4. Children spawned by the delegation manager use the same
     `StubStep` script but at a separate cursor (one cursor per
     child), so the same script can drive many children.
  5. The stub provider's `report_result` handler is wired into
     the manager; a child can be scripted with
     `StubStep.kind = "emit_report_result"` to produce a result.

**Files:**

- `src/host/stub-host.ts` (extend)
- `src/host/stub-provider.ts` (extend)

**Acceptance criteria:**

- [ ] `StubStep` union gains `"emit_delegate"` and
      `"emit_report_result"` variants (additive).
- [ ] `StubHost` exposes a way to pre-script per-child steps
      (e.g., `StubHostOptions.childSteps?: ReadonlyMap<string,
      readonly StubStep[]>` keyed by child id, or a factory
      function).
- [ ] The `delegate` tool, when called from a stub-driven parent,
      spawns children through the manager; the children run
      their own stub-driven `createAgentSession` instances.
- [ ] A test scenario: a parent emits `delegate` with 3 tasks,
      each child emits `report_result`; the parent receives 3
      results in input order; the log has 3 `subagent_started`
      + 3 `subagent_completed` records in append order.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/stub-host-delegation.test.ts` (new)
      green; ~6 cases:
        - Parent's `spawnRole` includes `delegate` in
          `customTools` for a role with delegation enabled.
        - Parent's `spawnRole` does NOT include `delegate` for a
          role without a `delegation:` block.
        - `emit_delegate` step drives the manager; 3 children
          complete in input order.
        - A child's failure does not cancel siblings; result set
          has 3 entries.
        - `subagent_started` + `subagent_completed` records are
          in the log in append order.
        - The parent's `handoff`/`end` behavior is unchanged
          (regression check).

### Task 2.12 — `ProductionHost` delegation wiring

**Description:** Mirror the StubHost changes in `ProductionHost`
(`src/host/production-host.ts`): the parent's `spawnRole` includes
`delegate` when the role permits; the `hostFactory` passed to
`DelegationManager` is a thin wrapper around `createAgentSession`
that uses a child-specific session manager rooted under
`<sessionDir>/children/<childId>/`.

**Files:**

- `src/host/production-host.ts` (extend)

**Acceptance criteria:**

- [ ] `ProductionHost.spawnRole` reads the role's `delegation`
      field from `loadedManifest`; if present AND `tools`
      includes `delegate`, the `customTools` list includes
      `createDelegateTool(...)`.
- [ ] Children use a `SessionManager` rooted at
      `<sessionDir>/children/<childId>/` (the file-backed
      `SessionManager.create(cwd, sessionDir)` call from the
      existing `ProductionHost` constructor pattern).
- [ ] No `ctx.newSession()` / `ctx.fork()` is introduced in
      `extensions/` or `src/extension/`. The grep guard on
      `extensions/**/*.ts` continues to pass.
- [ ] Defensive: a missing `delegation` block OR a missing
      `delegate` tool entry results in no `delegate` tool
      being added to the parent's `customTools` (no
      `crash`, no `throw`).
- [ ] `ProductionHost` is no larger than 500 LOC (AGENTS.md hard
      cap for "coherent concept" files). If the additions push
      past 500, extract the delegation-aware `spawnRole` path
      into `src/host/production-host-delegate.ts` and import it.

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test tests/host/production-host-delegation.test.ts`
      (new) green; ~4 cases:
        - Role with delegation + `delegate` tool → customTools
          includes `delegate`.
        - Role without delegation → customTools does NOT
          include `delegate`.
        - Role with delegation but no `delegate` tool →
          customTools does NOT include `delegate`.
        - The existing `production-host-spawn.test.ts` cases
          pass unchanged (regression check).

### Task 2.13 — `src/host/index.ts` re-exports

**Description:** Re-export the new public delegation APIs from
`src/host/index.ts` (and `src/index.ts` if they cross the public
barrel — `DelegationManager`, `createDelegateTool`,
`createReportResultTool`, `createRunTool`, `buildChildToolsAllowlist`,
`runBounded`, `validateDelegateBatch`, `WorktreeManager`, the
`ChildResult` type).

**Files:**

- `src/host/index.ts` (extend)
- `src/index.ts` (extend)

**Acceptance criteria:**

- [ ] All new public APIs are reachable via `import { … } from
      "pi-conductor"` (or the host subpath).
- [ ] The re-exports are named (no default exports; AGENTS.md
      code conventions).

**Verification:**

- [ ] `pnpm typecheck` clean.
- [ ] `grep "^export" src/index.ts src/host/index.ts` shows the
      new names.

### Task 2.14 — Repository gate

**Description:** Per AGENTS.md "Verification" — confirm the phase
gate is green before declaring Phase 2 done.

**Acceptance criteria:**

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm build` clean.
- [ ] `pnpm test` all green.
- [ ] `pnpm lint` clean.
- [ ] `pnpm format:check` clean.
- [ ] `tests/grep-guard.test.ts` passes.
- [ ] `pnpm audit` shows no new advisories.
- [ ] `extensions/` does not contain `ctx.newSession` or
      `ctx.fork` (grep-guard test on extensions continues to
      pass).

## Module-size check (new files in `src/host/delegation/`)

| File | Expected LOC | Notes |
|------|--------------|-------|
| `ids.ts` | ~50 | pure helpers |
| `validate-batch.ts` | ~150 | input validation logic + tests, ≤ 200 |
| `child-prompt.ts` | ~80 | envelope builder |
| `child-tool-policy.ts` | ~50 | pure allowlist builder |
| `report-result-tool.ts` | ~150 | `defineTool` factory, mirror of `tools.ts` |
| `run-tool.ts` | ~200 | argv-based tool with allowlist + path confinement |
| `worktree.ts` | ~250 | worktree lifecycle |
| `pool.ts` | ~80 | bounded concurrency |
| `manager.ts` | ~350 | orchestration; may split if grows |
| `delegate-tool.ts` | ~150 | parent tool wrapper |

All under the AGENTS.md 400-LOC soft ceiling individually. The
`manager.ts` is the highest-risk file for growth; if it pushes
past 400 during implementation, split into `manager.ts` +
`results.ts` per the plan's note.

## Files likely touched

| File | Change |
|------|--------|
| `src/host/delegation/*.ts` | **New** — 10 files (see table above) |
| `src/host/stub-host.ts` | Extend with `delegate` tool wiring + child script cursor |
| `src/host/stub-provider.ts` | Extend `StubStep` with `emit_delegate` and `emit_report_result` |
| `src/host/production-host.ts` | Extend `spawnRole` with `delegate` tool wiring + child session dir |
| `src/host/index.ts` | Re-export new APIs |
| `src/index.ts` | Re-export new public types |
| `tests/host/delegation/*.test.ts` | **New** — 10 test files (one per new module) |
| `tests/host/stub-host-delegation.test.ts` | **New** — StubHost delegation parity |
| `tests/host/production-host-delegation.test.ts` | **New** — ProductionHost delegation wiring |

## Checkpoint: end of Phase 2

- [x] Delegation code implemented (manager, child-runner, tools, worktree, pool, results, etc.).
- [x] `delegate` tool is wired into the parent's session for
      roles with delegation enabled (both hosts).
- [x] `report_result` tool is bound to each child attempt.
- [x] Bounded pool enforces `max_parallel`.
- [x] Worktree gate rejects dirty primary checkouts before any
      spawn; clean worktrees are removed after the terminal
      record is durably appended; dirty worktrees are preserved.
- [x] `subagent_started` and terminal records are persisted via
      `host.persistRecord` for every admitted child attempt.
- [x] StubHost parity: a parent role can call `delegate` end-
      to-end with no API key.
- [x] `tests/grep-guard.test.ts` and the extension grep guard
      continue to pass.
- [ ] Phase 3's implementer can extend the manager with
      budget, cancellation, and resume without further host-
      agnostic work.

> **Completion evidence:** 2026-07-12. See
> [`phase-2-resume.md`](./phase-2-resume.md) §Phase 2 completion for
> per-task evidence, gate results, LOC verification, and security audit.
>
> **Note:** Individual task acceptance boxes (lines 79+) remain unchecked pending
> remediation of reviewer findings (2 Critical + 7 Required; 2026-07-12).
> **Remediation complete: 2026-07-12.** See implementer handoff for per-finding evidence.

## Out of scope (deferred)

- Budget reservation against the run cap (Phase 3).
- Cancellation propagation, resume reconciliation, ADR-002,
  CHANGELOG, version bump (Phase 3).
- Recursive delegation (`max_depth > 1`).
- Multi-file mutations from a single child tool call (a single
  `write`/`edit` targets one path).
- `bash` tool in child sessions (explicitly out of scope per
  spec §5, decision 2; the `run` tool is the worktree-child
  replacement).
