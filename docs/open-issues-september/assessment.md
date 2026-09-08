# Post-merge assessment — 2026-09-08

Assessed `main` after PR #83 merged at `2e3572b767adaa951aaa2084d64ff93b7a0a48ee`.
Its tree exactly matches reviewed implementation head `12a79f375c880f3c5b61c3231e8edd8f2d50e30e`.
Implementation used Luna; the main agent integrated and verified the work,
with independent adversarial review before merging.

## Issue disposition

The original eight open issues are now one. Remote inventory after merge lists
only #67.

| Issue | Result on merged main |
| --- | --- |
| #68 bounded role-turn telemetry | Closed via PR #79. Existing implementation verified; cumulative byte-budget and truncation defects fixed with durable-log regressions. |
| #71 trajectory failure diagnosis | Closed via PR #79. Unsupported SDK versions fail preflight; actionable terminal identity and detail are retained. |
| #73 empty-completion recovery | Closed via PR #79. Three recovery prompts per invocation with bounded exhaustion and durable diagnosis. |
| #74 README split | Closed via PR #79. README links to focused reference pages; original section coverage verified. |
| #76 tool deadlines and cleanup | Closed via PR #81, merged `6b7f245`. Pinned deadlines, bounded timeout recovery, supervised cleanup and restart ownership checks. |
| #75 deterministic end guard | Closed via PR #82, merged `71a18c1`. Durable attempts, bounded retries and legal-completion checks across fallback/resume. |
| #77 asynchronous delegation | Closed via PR #83. Durable batch admission, selected result/wait/cancel controls, pinned inputs, shared capacity, safe-turn notices and settlement before parent replacement. |
| #67 public SDK runtime API | Open, upstream-blocked. Pi 0.85.1 lacks the required public runtime-identity transfer; [source assessment](sdk-assessment.md). Pi remains pinned at 0.80.6. |

## Current confidence

The repository now has explicit controls for the main unattended-run gaps in this
issue set: executable deadlines and confirmed cleanup, deterministic completion
checks, bounded recovery, and durable asynchronous child scheduling. The pure FSM,
single reducer owner and host-owned append-only log boundaries remain intact.

The final suite passed **179 files / 2,082 tests**, plus strict typecheck,
build, lint and formatting. Required pre-push lint, typecheck and full tests also
passed. The final reviewed source tree matched remote main after merge. Evidence
and checked acceptance gates are in [controls-plan.md](controls-plan.md),
[async-design.md](async-design.md), and the [initial review](review.md).

Review reproduced and fixed ambiguous append handling, lost admission accounting,
late prompts after cancellation, cleanup ordering before model fallback, budget
wiring and forced closure, late notices to settled parents, and isolated RPC abort
response races. Real process, Git worktree, production-host and RPC regressions
supplement deterministic scheduler tests.

Production dependency audit is clean. The full development graph retains one low
esbuild advisory and no moderate/high/critical findings. The exact SDK pin and
scoped Undici override remain unchanged. Concurrent edits in the original working
checkout were preserved.

## Limits and next work

- The changes are merged source, not a published release or deployment. No paid
  provider trial was performed; local tests do not establish live-provider quality,
  reliability or Prewalk cost savings. Remote CI still reports zero tasks,
  so the execution evidence is local verification and the enforced pre-push hook.
- Process cleanup is supported on Linux; unknown executable ownership stops
  resumably. Restart interrupts accepted unfinished children instead of replaying
  work or guessing process identities. Historical malformed telemetry logs remain
  rejected rather than automatically repaired.
- Child branches/worktrees remain for explicit parent or operator review and
  integration. File-tool confinement does not provide an OS/credential sandbox.
  Subprocess-backed file operations have measurable overhead (about 0.6 seconds
  per tool in local checks).
- Host module size remains a maintenance concern: 19 of 200 source modules exceed
  400 lines, including 10 at least 500 lines. `loop.ts` (~1,580),
  `production-host.ts` (~1,286), and `api.ts` (990) are the largest ownership hubs.
  Most new behavior lives in focused modules; extracting these existing hubs
  warrants separate, behavior-preserving work.
- A previously observed concurrent Git worktree provisioning race did not recur
  in the final gates. Retain it as a focused follow-up if repeated; it was not
  folded into this remediation.

Next, validate an operator-chosen provider/workflow in a bounded real run before
releasing, establish remote CI execution, and address the low-severity toolchain
advisory in a focused dependency update. Revisit #67 when upstream exposes the
required public API, and rerun the exact trajectory compatibility spike before
changing the SDK pin.
