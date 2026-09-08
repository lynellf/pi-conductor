# Orchestrator context retention — Issue #87

Status: acknowledged by the repository owner on 2026-09-08; implementation in progress.
Implementation baseline: origin/main `7592fa4` (after delegation policy and host module refactors). Extends the fresh-session memory contract in
`docs/archive/orchestrator-fsm-spec.md` §8.4 without changing the FSM.

## Objective and proposed operator contract

A designated orchestrator can keep its conversation between its role invocations
within one run, including a process restart followed by `/conduct:resume`.
Earlier planning decisions, constraints, tool results, and worker outcomes remain
available alongside the current structured run-memory seed.

```yaml
roles:
  - name: orchestrator
    is_orchestrator: true
    context_retention: run
    tools: [read, handoff, end]
```

`context_retention` accepts `none | run`, only on the designated orchestrator.
Omitted means `none`, retaining current fresh-session behavior. Resolve and pin the
policy for new runs. Historical snapshots without the field retain `none`.
Invalid values and use on workers are configuration errors, including programmatic
manifest input. Models cannot override this policy through tool arguments.

The scope is a single run, not persistent memory shared between independent runs.
A new `/conduct` starts fresh. Cross-run memory is deferred, with no implicit lookup
of the newest session in a working directory.

## Context and execution semantics

1. Preserve the orchestrator's own chronological conversation and tool-result
   history, or the equivalent context produced by supported Pi compaction. It is
   not enough to retain only the existing run-memory fields or latest handoff.
2. Returning from a worker adds the current host-generated seed once. Worker
   conversations are not automatically imported; ordinary handoff outcomes and
   explicit context tools remain the disclosure boundary.
3. Physical sessions may be recreated, but each role invocation retains a distinct
   logical lifecycle identity. Restore history only: never replay historical tools
   or agent emissions to reconstruct machine state.
4. Current checkpoint, manifest, role prompt, model assignment, tool allowlist,
   budget and delegation policy are authoritative. Restored history is historical
   context and cannot grant permissions or revive stale work.
5. Persist context selection in the host-owned run log, identifying the run, role,
   source conversation, and precise committed history boundary. Context delivery
   to a new invocation must have a durable identity so resume cannot duplicate it.
   Do not rewrite historical logs or mutate checkpoints in place.
6. Retain only settled history: source tools, delegated children and process cleanup
   settle before recording a reusable boundary. A crash during an incomplete tool
   exchange must not feed an invalid tool-call/result sequence to a provider or
   silently repeat its side effects. Surface unresolved execution for recovery.
7. Each new run and reset begins a durable empty context epoch. Restart before its
   first invocation is valid and starts from the current run-memory seed. Otherwise,
   restore the last proven durable context for this run and orchestrator.
   Missing expected history, malformed, mismatched, or ambiguously committed context gives
   an actionable error before prompting; never silently start fresh under `run`.
8. Model fallback retains the last usable context and spent invocation allowance.
   Rebind the configured target model through supported APIs. Unsupported history
   conversion or context size must be diagnosed, without dropping context silently.
   Preserve existing tool/delegation idempotency and accounting across retries.

## Bounded context, inspection and reset

Use the supported Pi compaction mechanism and the effective model's context window
rather than introducing a second summarization agent. Capture the effective
compaction settings in the run policy so restart does not silently change them.
Compaction may reduce historical detail and must be observable. When compaction is
disabled or fails to make context fit, stop with an actionable context-limit error.
Any model usage required for compaction belongs in run/invocation accounting.
Pi 0.80.6 native compaction results do not expose usage; use its public
`session_before_compact` hook and exported `compact` with a metered `streamFn`
adapter in both SDK and RPC paths. Prove this path before the lifecycle integration.
Imported historical assistant usage is never charged again to a new invocation.
If supported metering cannot be demonstrated, revise this contract explicitly
before implementation continues; never report missing usage as zero.

Inspection must expose the retained conversation reference and compaction/reset
status without dumping the full transcript into ordinary status output. Stored
session files remain inspectable through supported tools. This feature does not
introduce automatic deletion of existing run logs or session files.

Provide an explicit reset on an idle run through the resume interface and library
API (proposed CLI/extension spelling: `--reset-orchestrator-context`). A reset is a
durable marker and begins a new context epoch; it does not reset the run's FSM,
budgets, visits, child admission allowance or accepted work. It affects the next
orchestrator invocation even when a worker is currently recorded as the role.
Reject reset on an actively owned run. Normal resume does not reset context.

## Transport and existing features

Support shared SDK and isolated RPC orchestrators using public Pi session APIs,
with trusted host-owned configuration and exact context provenance. Retain the
existing SDK compatibility posture; do not add private runtime reflection.

For the first version, reject combining `context_retention: run` with trajectory
handoff transport in the same manifest. Trajectory transfers a predecessor's
conversation, whereas this feature retains the orchestrator's own conversation;
choosing one implicitly would lose or broaden context. Report the incompatible
configuration before starting a run. Existing trajectory behavior with `none`
remains unchanged. Reject retention on an orchestrator configured with Prewalk
in this first version, because planner/executor phases have distinct conversation
and disclosure rules. Prewalk workers remain allowed; their internal conversations
are not imported into the orchestrator.

## Implementation plan and acceptance

Implementation uses Luna in dependency-ordered, reviewable increments.

- [x] Manifest contract: parse/validate both policies, orchestrator-only restriction,
  explicit new-run pinning and historical default. Test invalid/programmatic input.
- [ ] Durable context boundaries and epochs: define records and restoration queries;
  test round trips, run/role isolation, missing/corrupt history, crash boundaries,
  reset, restart in an empty epoch, and duplicate delivery. Keep pure record validation separate from host I/O.
- [x] Metered compaction spike: prove public-hook/stream interception and SDK/RPC
  cost parity, including failures and exclusion of imported historical charges.
- [ ] Shared SDK lifecycle: retain own history across A/B worker round trips with
  current role authority, no repeated side effects, and fresh logical identities.
- [ ] Resume/fallback and compaction: prove restart continuity, context admission,
  compaction observability/accounting, model changes and spent-limit preservation.
- [ ] Isolated RPC parity: trusted context selection, process restart, cleanup,
  error reporting and the same conversation continuity contract.
- [ ] User surfaces: reset, context-reference inspection, configuration guide,
  examples and changelog; verify extension/CLI/library behavior.
- [ ] Independent review and all repository gates; update checked items only when
  their acceptance and verification have actually completed.

Vitest tests belong in `tests/manifest`, `tests/host`, `tests/host/rpc`, and relevant
extension/CLI suites. Prefer deterministic stub-provider integration tests and
real temporary session files over paid provider runs. Existing trajectory, budget,
end-guard, async delegation, abort and persistence suites must remain green.

Commands: `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`,
`pnpm format:check`, `pnpm audit --prod`, plus focused Vitest runs per increment.

## Structure, style and boundaries

Use focused host modules under `src/host/` and existing manifest/record seams.
Strict TypeScript, named exports and JSDoc; TypeBox only; no new dependencies.
Keep modules below roughly 400 lines (documented coherent exceptions below 500).
Example public contract: `type ContextRetention = "none" | "run"`.

Always preserve pure reducer behavior, append-only checkpoints and single host
ownership of spawning/persistence. Ask for acknowledgment of this new contract
and any material change to its scope. Never derive authoritative FSM state from
transcripts, mutate old records, share context across runs implicitly, or call
extension `ctx.newSession()` / `ctx.fork()`.

## Public SDK evidence and unresolved implementation decisions

The installed, pinned Pi 0.80.6 package documents `SessionManager.open`,
`forkFrom`, `createBranchedSession`, `buildContextEntries`, and `AgentSession.compact`.
See its official documentation in
`node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` and
`docs/session-format.md`, and declarations under `dist/core/`.
Choose the smallest supported restoration mechanism only after testing exact
history-boundary handling, current-model rebinding, and cost accounting.
No upstream SDK upgrade is assumed or required by this proposal.
