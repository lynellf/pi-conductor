# September issue remediation review

Reviewed source against FSM §§3, 7, 10–12, the existing role-turn contract, and
issues #68, #71, #73 and #74. Implementation used Luna; integration and
review were performed by the main agent. No release publication is part of this
batch. This section records the initial PR #79 review; subsequent implementation
of the acknowledged #75–#77 specification is tracked in [controls-plan.md](controls-plan.md).

## Findings reconciled

- Independent telemetry review reproduced cumulative session/run byte overflow
  across multiple blocks and a missing turn-truncation cause. Both were actionable
  and fixed. Regressions exercise durable append and producer reconstruction.
- Recovery is three prompts per invocation, including when a rejected emission
  or deferred end intervenes. Host failures, caps and aborts retain precedence.
  Exhaustion records the attempt count. Terminal formatting reads durable failure
  records, handles trajectory errors and bounds detail to 512 characters.
- Trajectory version admission now runs first in the production constructor.
  A duplicate factory check was removed on review because construction had no
  preceding side effects. The version-mocked regression is admission evidence,
  not a claim that fresh sessions work on every newer SDK.
- Full-suite testing found four CLI fixtures asserting `{}` was a LoadedManifest.
  They now use an actual parsed manifest. The guard was not weakened to accommodate
  invalid test data.
- Documentation review caught a duplicate heading and one missing record-stream
  bullet. Both were restored/fixed. All seven reference bodies were independently
  compared with the original README, allowing only heading/link relocation and
  whitespace normalization; contribution invariants/supply chain become pointers.
- New-controls design review found five recovery/ownership gaps. The proposed
  spec now includes durable guard starts, guard retry limits, targeted cancellation,
  parent-fallback settlement and durable submission identity. Human acknowledgment
  was pending at that initial review; the subsequent approval is recorded in
  [spec.md](spec.md).

- The first push exposed Git hook environment leakage into temporary repository
  fixtures. The test hook now clears Git repository-local variables using
  `git rev-parse --local-env-vars` before running tests. This follows
  [Git hook guidance](https://git-scm.com/docs/githooks). A fixture isolation check
  and the subsequent real pre-push run passed; all checks remain enabled.

## Verification

In isolated worktree `/tmp/pi-conductor-september-review`, with a frozen install:

- `pnpm test`: **137 files, 1,797 tests passed**.
- `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm format:check`: passed.
- `git diff --check`: passed.
- README: **279 lines**; original 38 section headings accounted for; local links
  across 16 live Markdown files checked; no archived files changed.
- `pnpm audit --prod`: no known vulnerabilities.
- Full audit: **one low esbuild advisory**; `pnpm audit --audit-level high` passes.
  Baseline was 7 high, 6 moderate and 1 low. Targeted lock updates cover
  brace-expansion 5.0.9, nanoid 3.3.18, postcss 8.5.26, protobufjs 7.6.6 and
  Undici 8.9.0. Pi remains exactly 0.80.6. Vite's `esbuild: ^0.27.0` cannot accept
  the patched 0.28.x range without a separate toolchain decision.

The Undici override is confined to the pinned Pi package. Both SDK and patched
Undici require Node >=22.19.0; the SDK-used Client, Pool, EnvHttpProxyAgent,
setGlobalDispatcher and install exports remain present. The patch release is
[Undici 8.9.0](https://github.com/nodejs/undici/releases/tag/v8.9.0).
The remaining finding is [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr).

## Assessment limits

Tests use deterministic/local SDK paths, not paid/live provider trials. Recovery
implements #73's bounded re-nudge and diagnosis proposals; provider-specific
empty-completion classification and optional worker-reason enhancements are not
added. Existing malformed/over-budget historical telemetry is still rejected;
this patch does not rewrite old logs. SDK integration #67 remains blocked by the
public API, as documented in [the SDK assessment](sdk-assessment.md).

Concurrent package.json/pnpm-lock.yaml edits appeared in the original checkout.
Their ownership was not established, so the reviewed patch was assembled in an
isolated worktree from remote main. Those unrelated broad direct dependency
updates are excluded and preserved in the original checkout.
