# September execution controls — proposed specification

Status: awaiting overseer acknowledgment for new features #75–#77.
Existing fixes #71/#73, documentation move #74, and verification of the already
merged #68 proceed under their issue requirements and existing specifications.

## Objective and authority

Make unattended runs bounded and diagnosable, and let a delegating parent act on
individual child completions. Preserve the pure FSM, host-owned persistence,
pinned manifests, workspaces, and single top-level role. This supplements FSM
§§3, 7, 10–12 and the existing delegation and end-request specifications.

## #75: deterministic end guard

- Optional top-level `end_guard: { command: string, timeout_seconds?: number }`.
  Default deadline 60 seconds; finite positive configurable maximum 3,600 seconds.
  The pinned manifest stores it; omitted preserves historical behavior.
- Execute in the run's primary checkout with the host's environment, immediately
  before a mechanically legal role-issued orchestrator `end`. Never run it for
  illegal worker ends or missing required end requests. Machine-authority forced
  close (cost cap) bypasses it, so a guard cannot defeat a hard stop.
- Exit zero permits the normal reducer transition. Failure, timeout, or spawn
  error leaves checkpoint and pending end request intact and returns a bounded
  correction through the existing rejected-emission retry path. Permit at most
  three failed guard executions per pending end-request identity (or per run in
  ungated mode), persisted across model fallback and restart. Exhaustion stops
  resumably, never as `done`; a new authorized request resets that budget. In
  ungated mode an explicit operator resume resets the exhausted budget with a
  durable reset record. No interpretation of handoff prose.
- Append a durable guard-attempt start before spawning, with a unique attempt ID
  and owned process supervision identity. Correlate exactly one terminal result
  with that ID; use the #76 supervised-process cleanup contract for guards too.
  Append a typed guard-result record before any accepted end, with role-session
  identity, elapsed time, exit/signal/timeout outcome and at most 4 KiB combined
  diagnostic output, explicitly marked truncated. Treat guard commands as trusted
  repository configuration; do not persist environment values.
- A successful result is not cached across end attempts or resume. On restart an
  unfinished attempt is diagnosed and its process cleanup confirmed before
  retry/resume. Never infer success from a prior result. An unknown owner stops
  resumably rather than starting an overlapping guard.

## #76: executable tool deadlines

- Add a pinned `tool_execution` policy for roles and subagent profiles. Defaults:
  300-second wall-clock deadline, 3,600-second configurable maximum, 2 recoverable
  timeouts per logical invocation, and 2-second graceful termination window.
  Validate positive finite integers. An explicit model-supplied timeout can
  shorten the configured deadline, never enlarge it. Owners can raise the finite
  ceiling for legitimate long jobs; there is no unlimited value.
- Apply at the executable process boundary in shared SDK and isolated RPC paths,
  including delegated workers. A promise timer alone is insufficient. Own and
  terminate shell process groups, including pipelines/descendants; escalate to
  forceful termination and confirm cleanup before allowing another attempt.
  Platform support must be explicit; unsupported cleanup fails preflight.
- Exempt intentional owner waits (`ask_user`) and delegation result waits. File
  operations must settle or fail with an unconfirmed-cleanup stop; do not claim
  cancellation merely because an AbortSignal was dispatched.
- Return a structured timeout error when cleanup is confirmed. The model may
  inspect/repair; the host never automatically replays the command. Exhaustion
  or unconfirmed cleanup fails the invocation with an actionable resumable cause.
- Persist start and terminal execution identities without command arguments,
  environment or raw output: run/logical session, tool call ID/name, effective
  deadline, elapsed time, recovery count and cleanup outcome. On resume an
  unfinished execution requires cleanup confirmation; unknown ownership stops
  rather than replaying or killing an unrelated process after PID reuse.
- Operator status shows active tool/elapsed time and timeout/recovery state.
  Output or CPU activity never resets the wall-clock deadline. Abort and timeout
  races have one cleanup owner and one terminal record.

## #77: asynchronous delegation

- Preserve existing blocking `delegate` calls. Add explicit non-blocking
  submission mode returning stable task handles after validation and durable
  acceptance. A session-owned scheduler shares one capacity/admission budget
  across all submissions; no per-batch independent concurrency pools.
- Scope a durable submission ID to run + logical parent invocation + actual
  tool-call ID; forward that ID through isolated RPC. Atomically accept the
  validated batch/context fingerprints and consume admission allowance before
  acknowledging it. Repeating that ID with identical inputs returns the same
  handles; different inputs reject. Response loss cannot duplicate acceptance.
  Accepted-but-unstarted tasks count against admission and recover as interrupted
  on restart; a new explicit task consumes a new allowance.
- Provide status, result retrieval, targeted wait and cancellation operations.
  Notify at safe parent-turn boundaries using the public SDK interface; results
  remain durably retrievable if notifications are missed. Failure of one child
  does not block unrelated results or new work by default.
- At acceptance pin task context, base commit, profile and authorized projection;
  queued tasks retain those exact inputs even if the parent advances integration.
  Children keep isolated worktrees and existing confinement. Parent performs
  verification and integration with existing serial integration checks.
- Reject role handoff/end while queued or active children exist, with task IDs and
  a correction to await/cancel. Terminal results persist across handoff; explicit
  result retrieval does not delete them or count usage again.
- Targeted cancellation affects only the selected tasks; unrelated children and
  admission remain available. Parent/run abort or budget exhaustion close
  admission, settle queued tasks,
  cancel active children and confirm owned execution cleanup before parent
  settlement. Persist exactly one result/usage terminal per task.
- Parent model failure, fallback or replacement cancels and settles all its
  active/queued tasks before disposal or replacement. Persist admission consumption
  across fallbacks within the same invocation; a replacement cannot regain spent
  slots. Completed results remain available to the replacement.
- Restart does not resurrect processes or resubmit accepted tasks. Reconcile
  unfinished task executions as interrupted after cleanup, retain worktrees and
  completed results, and let the resumed parent submit explicit new tasks.
- No service, database, automatic merge, child-to-child routing, or concurrent
  top-level reducer owner is introduced.

## Structure, conventions and verification

Implementation belongs in `src/host/` execution/delegation modules, manifest
parsing/validation, additive persistence contracts and extension status helpers.
Pure core changes are restricted to explicit legality/result contracts. Follow
strict TypeScript, named exports, TypeBox and existing immutable records, e.g.
`return { ...checkpoint, end_request: checkpoint.end_request };` (no mutation).
Split by responsibility before modules approach the repository size limit.

Commands: `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`,
`pnpm format:check`, `pnpm audit --prod`. Focused Vitest suites go under
`tests/host/`, `tests/manifest/`, `tests/persistence/` and `tests/extension/`.

- #75: omitted/success/failure/timeout, pending request retention, forced-close
  bypass, retry exhaustion, durable ordering and crash during guard execution.
- #76: real subprocess silent/CPU hangs, descendant pipelines, successful and
  long configured calls, abort races, recovery exhaustion and restart ownership.
  Test deadlines must operate outside a blocked child event loop.
- #77: gated A/B workers; parent tool action while both run; finish/review B and
  start C before A completes; prove shared limit, independent failures, pinned
  snapshots, targeted cancellation, parent fallback, handoff restrictions, response
  loss after acceptance (shared/RPC) and exactly-once accounting.

Always preserve existing work/checkpoints and run focused regressions before
merging. Never bypass confinement, use private SDK fields, replay an ambiguous
side effect, or claim a cleanup outcome without evidence. New dependencies or
material deviations from this contract require a documented decision.

## Decisions for acknowledgment

The proposed defaults, process-cleanup support boundary, and restriction on
handoff with active children are product behavior. Accepting this specification
acknowledges those choices; implementation may refine internal module boundaries
without changing them. #67 remains a separate public-SDK feasibility question.
