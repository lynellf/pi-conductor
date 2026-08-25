# Issue #48 remediation: worktree-isolated Node role processes

**Status:** Approved by the overseer on 2026-08-24: create this spec and implement it in one pass.
**Supersedes:** the incomplete host integration claimed by `spec.md` Tasks T3–T9. The manifest and seam contracts from T1–T2 remain valid.

## Objective

Make the existing per-role worktree feature real and honest. An isolated role runs in its own Git worktree and in a distinct host-launched Node process (`pi --mode rpc`). It has no container and earns only a `confined` guarantee: process separation and a restricted tool surface are useful operational boundaries, but not OS, credential, or network isolation.

## Non-negotiable decisions

- `backend: container` is **unavailable**. It must fail with a typed host error; it must never fall through to an in-process worktree or be labeled `sandbox`.
- Isolated `worktree`/`copy` roles use a per-role `pi --mode rpc` subprocess with the provisioned workspace as `cwd`. Shared roles preserve today’s in-process SDK behavior.
- `confined` is the strongest available guarantee. No record, seed, README, or CHANGELOG may claim `sandbox`.
- One `snapshot_pinned` record determines a run’s immutable commit. Later spawns and resume reuse that record; they never re-resolve a moving `HEAD` or ref.
- The role workspace—not the integration checkout—is the root for built-in file tools and declared artifact paths. The integration checkout is reachable only through an explicit mount.
- Artifact collection/routing is host-owned and wired through accepted handoffs. The host never applies patches to the integration checkout.

## Acceptance criteria

1. A `worktree` role’s file tools resolve relative paths inside its provisioned workspace; a canary in the integration checkout cannot be read or changed without an explicit mount.
2. An isolated role session is owned by a distinct `pi --mode rpc` Node process, receives the worktree as cwd, and supports prompt, steer, abort, session identity, usage, and tool-call capture.
3. A container manifest is rejected with a typed `WorkspaceError` before any role session starts; no persisted record can contain `guarantee: "sandbox"`.
4. Snapshot pinning occurs once per run and resume uses the persisted commit after `HEAD`/a source ref moves.
5. Declared relative artifacts are collected from the emitting workspace, rejection/cap records are persisted, accepted handoffs materialize artifacts into an isolated receiver, and the host-generated seed lists only host-collected artifacts.
6. Delegation from an isolated parent cannot use a base checkout wider than the parent workspace.
7. Tests directly exercise the required canaries, artifact route, immutable pin, and process adapter protocol. Shared-mode tests remain green unchanged.
8. Run execution ownership is crash-recoverable on every supported Node platform: a retained lease-probe client cannot delay terminal completion or re-acquisition; a live foreign process blocks public resume before reconciliation, pinning, workspace provisioning, or host construction; a SIGKILLed owner releases kernel ownership so resume reconciles and reuses its persisted pin after `HEAD` moves; and different/unresponsive occupied candidates are skipped rather than reported as this run.

## Architecture

### Live run lease

`FileRecordLog.acquireRunLease(runId)` is the host-owned live-execution guard for both public entrypoints. It coordinates **only processes on the same host and loopback network namespace**; it is not a distributed lock and provides no exclusion across containers or other network namespaces.

The log canonicalizes `baseDir`, hashes canonical `baseDir + runId`, and deterministically derives a bounded sequence of loopback TCP candidates. It listens on the first free `127.0.0.1` candidate. The deterministic identity is for contention discovery, not authentication. On `EADDRINUSE`, it briefly connects to that candidate: an endpoint that returns the same deterministic lease identity causes `RunInProgressError`; a different identity, refusal, malformed response, timeout, or other unresponsive occupant advances to the next candidate. Candidate exhaustion or another bind failure throws `RunLeaseUnavailableError`. The implementation uses Node built-ins only—never a PID, marker file, stale-time heuristic, cleanup fallback, dependency, or platform-specific branch.

The lease endpoint writes its identity and promptly ends accepted probe sockets. It tracks accepted sockets, and `release()` forcibly destroys every tracked socket before awaiting `server.close()`, so a probe client cannot retain a completed run's lease. `released` becomes true only after a successful close. TCP listener ownership is kernel-managed and therefore releases when the owner process exits, including SIGKILL.

Lease acquisition remains before checkpoint reads, crash reconciliation, pinning, provisioning, and spawning; pre-loop failures and terminal loop completion release it. This changes neither the no-container policy nor the `confined` guarantee: `backend: container` still fails typed, and isolated roles still do not claim sandbox or OS isolation.

### Process adapter

`src/host/rpc/node-role-session.ts` implements `RoleSession` over a child process spawned using `process.execPath` and the package-local `pi` CLI in RPC mode. It speaks strict JSONL, correlates requests by id, and observes `tool_execution_start` events to capture `handoff`/`end` arguments. A static machine-tools extension is loaded with per-run JSON configuration; this is the only way an RPC role can terminate through conductor’s seam.

The adapter is only selected for isolated worktree/copy roles. It supplies the same `RoleSession` contract as an in-process SDK session. `abort()` writes the RPC abort command, and child-process exit without an agent settlement is surfaced as a typed session failure. The adapter does not claim a sandbox.

### Pin and projection state

The production host reads `snapshot_pinned` records for its `runId`. On the first isolated spawn it resolves and persists the source commit, then creates the snapshot checkout. Later spawns and resumed hosts use the saved commit. Projection construction takes the real `workspacePath` and real `sharedSnapshot.checkoutPath`; it never manufactures paths from `cwd` and a hash.

### Artifact lifecycle

The loop owns reduction and lifecycle records. The host exposes an additive post-handoff hook that receives the accepted handoff plus emitting-session workspace metadata, collects artifacts, persists collection records, and appends the host-generated artifact seed section before the receiver is prompted. Failed sessions may store auto-patches but never route them.

## Task plan

- [x] **R1: honest contracts and projection state**
  - Reject container backend at host start; remove `sandbox` from available guarantee computation.
  - Make projection construction consume actual workspace/snapshot paths.
  - Acceptance: container typed-error and integration-canary tests fail before implementation, then pass.

- [x] **R2: immutable pinning and workspace metadata**
  - Load/store one run pin; reuse it across spawns and resume; retain snapshots.
  - Carry per-session workspace metadata to the loop and `session_started.workspace`.
  - Acceptance: moved-HEAD/ref test proves every visit uses the recorded commit.

- [x] **R3: Node RPC role-process adapter**
  - Implement strict JSONL child-process protocol, machine-event capture, prompt/steer/abort/dispose, session state and usage mapping.
  - Production host selects it for isolated roles; shared roles remain SDK sessions.
  - Acceptance: adapter protocol tests use a fake RPC child; a manual local smoke command is documented.
  - Manual local RPC smoke (starts a config-gated child with Pi's configured default model; then send RPC JSONL such as `{"id":"state-1","type":"get_state"}`):
    ```bash
    run_dir="$(mktemp -d)" && config="$run_dir/machine-tools.json" && node -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({workspaceRoot:process.argv[2],mounts:[],declaredToolNames:["read"]}), {mode:0o600})' "$config" "$PWD" && PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" PI_CONDUCTOR_MACHINE_TOOLS_CONFIG="$config" node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc --no-extensions --no-builtin-tools --extension "$PWD/src/host/rpc/machine-tools-extension.ts" --session-dir "$run_dir/sessions" --thinking medium
    ```

- [x] **R4: artifact integration and delegation monotonicity**
  - Repair realpath containment and artifact storage; wire terminal collection, accepted-handoff materialization, and seed section into the loop.
  - Pass an isolated parent’s workspace as delegation’s base checkout.
  - Acceptance: declared artifact, auto-patch, rejected path, receiver materialization, and delegation-base tests.

- [x] **R5: E2E and documentation**
  - Replace spawn-success E2Es with canary behavior tests and correct all guarantee/artifact documentation and stale pointers.
  - Acceptance: all criteria above are automatically tested; README calls the boundary `confined`, not a sandbox.

## Verification

After each task: targeted tests, `pnpm typecheck`, `pnpm lint`, and `pnpm test`. Final gate: `pnpm build && pnpm format:check`; `pnpm audit` is recorded separately because the existing main branch has pre-existing advisories and this work adds no dependencies.

## Boundaries

- **Always:** retain worktrees/artifacts for inspection; keep reducer/core untouched; use typed failures rather than fallback.
- **Ask first:** adding an npm dependency, restoring a container/sandbox backend, or granting an isolated role a shell outside its own Node process.
- **Never:** auto-apply artifacts to integration, run `backend: container` in-process, claim OS isolation, or widen an isolated delegation child’s projection.
