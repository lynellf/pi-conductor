# Post-merge assessment — 2026-09-08

Assessed remote `main` after PR #79
merged at `d628f8de4791d07b4e96baae43c7956fc3961a37`. Its tree exactly matches the
verified implementation head `57727e5`; fetching and comparing found no merge-time
changes. Implementation work used Luna.

## Issue disposition

Eight open issues became four. The open-issue inventory after merge lists
only #67, #75, #76 and #77.

| Issue | Result on merged main |
| --- | --- |
| #68 bounded role-turn telemetry | Closed. Existing implementation verified; two byte-budget/truncation defects fixed with durable-log regressions. |
| #71 trajectory failure diagnosis | Closed. Unsupported SDK versions fail at production-host preflight; terminal messages retain actionable failure identity. |
| #73 empty-completion recovery | Closed. Three recovery prompts per invocation, bounded exhaustion and durable terminal diagnosis. |
| #74 README split | Closed. README reduced to 279 lines with linked reference pages and verified section coverage. |
| #67 public SDK runtime API | Open, blocked. Pi 0.85.1 still lacks the required public runtime-identity transfer; see [source assessment](sdk-assessment.md). |
| #75 host-executed end guard | Open. Proposed specification awaits human acknowledgment. |
| #76 tool timeouts and cleanup | Open. Proposed specification awaits human acknowledgment. |
| #77 asynchronous delegation | Open. Proposed specification awaits human acknowledgment. |

## Current confidence and limits

The merged changes improve recovery, failure visibility and telemetry durability
while preserving the pure FSM and host-owned persistence/session boundaries.
The verification suite passed **137 files / 1,797 tests**, plus strict typecheck,
build, lint and format checks. The actual pre-push hook passed after its temporary
Git repository isolation fix. See [review evidence](review.md).

Production dependency audit is clean. The full graph retains one low esbuild
advisory; no moderate/high/critical findings remain. SDK pinning stays at 0.80.6.
The esbuild fix lies outside the current Vite dependency range and needs a focused
toolchain decision. Concurrent broad dependency edits in the original checkout
were preserved and excluded from the merged branch.

These checks establish deterministic/local behavior, not live-provider reliability
or Prewalk quality and cost improvements. No paid provider trial or release was
performed. Remote CI reported zero tasks at assessment time; local gates
are the available execution evidence, not a remote CI success claim. Historical
malformed telemetry logs remain rejected rather than automatically repaired.

## Next work

1. Acknowledge the [proposed controls specification](spec.md), then implement
   #76 first: bounded executable tool time and proven process cleanup. Hung tools
   remain the most consequential unattended-execution gap in this issue set.
2. Build #75's guard execution on that supervision boundary; prove durable guard
   attempts and retry exhaustion across resume.
3. Build #77's asynchronous delegation on cleanup and lifecycle settlement; prove
   cancellation, concurrency accounting and crash recovery before relying on it.
4. Revisit #67 when upstream exposes the required public API, then run the complete
   trajectory compatibility spike before changing the exact SDK pin.

Maintenance debt remains substantial in the host: 17 of 165 source modules exceed
400 lines, including eight at least 500 lines. The largest are `src/host/loop.ts`
(1,397), `src/host/production-host.ts` (1,080) and `src/host/api.ts` (908). These are
existing pressure points against the repository's size guidance. Keep future
controls in focused modules instead of enlarging those owners; broad refactoring
was outside this remediation batch.
