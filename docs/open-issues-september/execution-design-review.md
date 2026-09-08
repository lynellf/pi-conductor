# Executable tool boundary review

## Decision under review

The #76 deadline must be enforced outside any tool event loop that can block.
Use fresh supervised Node workers for all six built-in file tools and a direct
supervised public `BashOperations.exec` adapter for shell execution. Preserve
existing confinement, mutation serialization and one host-owned lifecycle.

Pinned API evidence: Pi 0.80.6 public package root exports tool factories; the
package has no public tool-factory subpath. `read` consumes only optional model
metadata from execution context; other file tools do not consume context.
Default `find` and `grep` children inherit the worker group; default SDK bash
creates its own detached group and must be replaced, not wrapped as a worker.

Sources: [Pi bash](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/src/core/tools/bash.ts),
[Pi tools](https://github.com/earendil-works/pi/blob/v0.80.6/packages/coding-agent/src/core/tools/index.ts),
[Node child processes](https://nodejs.org/api/child_process.html).
Exact-version API behavior was also inspected in the installed package.

## Reconciled findings

- Actionable: ordinary file tools perform synchronous decode/split/sort/diff
  work. A parent promise timer cannot interrupt that work. Keep it in workers.
- Actionable: confinement can resolve after a timeout. The inner spawn boundary
  must recheck closed/aborted admission, and confinement consumes the original
  deadline rather than resetting it.
- Actionable: fresh workers lose the SDK's module-global file mutation queue.
  Serialize mutations in the parent through confirmed settlement, including
  overlapping physical paths across shared sessions.
- Actionable: native session disposal currently precedes host cleanup, and the
  loop swallows disposal errors. Execution/child settlement must precede accepted
  machine emissions, fallback, replacement and native disposal.
- Actionable: a worker result is insufficient cleanup evidence. Wait for owned
  process termination and confirmed descendant cleanup; partial writes can remain
  after a timeout, so diagnostics require inspection and never automatic replay.
- Misread corrected: SDK edit/write already await in-flight filesystem operations;
  read/ls have early abort rejection. Do not suppress all signals based on a
  blanket assumption about cancellation.
- Accepted tradeoff: five fresh-worker read samples took 568–598 ms (mean 583 ms),
  versus 0.35–0.57 ms after in-process import. The public package import dominates.
  This adds about 58 seconds per 100 sequential file calls. A persistent worker
  pool would require a separate lifecycle and is deferred until correctness holds.
- API correction: `createRequire(...).resolve()` fails for the package's
  import-only exports. Use the public ESM `import.meta.resolve()` path.
- API correction: the pinned SDK marks a resolved tool result as successful even
  when it contains `isError: true`. Supervised failures throw a bounded JSON
  message so the public SDK emits an actual error result with cleanup identity
  and repair guidance. Ordinary failures retain their bounded cause diagnostic.
- Resume correction: workspace visits and executable invocation budgets have
  distinct identities. Reopening a materialized artifact workspace must preserve
  its path while an explicit operator resume receives a fresh timeout allowance.
  Reconstruct invocation indexes from durable executions as well as lifecycle
  starts; physical model fallback retains the current invocation identity.
- Queue correction: uncertain cleanup poisons already queued aliases as well as
  later submissions. Waiting callers must receive a fatal cleanup error before
  any worker can start on the affected path.

## Verification still required

- [x] Delayed confinement cannot launch after timeout (controller regression).
- [x] CPU-heavy child work times out while the host remains responsive.
- [x] Overlapping mutations retain serialization.
- [x] Cleanup precedes fallback, transition and native disposal.
- [x] Fast exits, spawn failures, callback delays and abort/timeout races settle
  once, clear timers, and retain bounded valid UTF-8 diagnostics.
- [x] Shell leader exit with TERM-resistant descendants leaves no live owned work.

The external-review preference was offered asynchronously; no external CLI or
provider was invoked. The independent built-in review and concrete regression
failures guide the implementation.

The process foundation received independent approval after 23 tests across four
suites and scoped strict TypeScript verification. New review tests reproduced a
successful leader exit leaving a detached descendant and a delayed ownership
scan rejecting before timeout cleanup settled. Both now reject or wait as
required. Permission errors remain conservative; only an observed vanished or
zombie PID is treated as absent. Controller and production integration have
separate gates and are not covered by that foundation approval.

The final integration review approved shared/RPC/child boundaries and Prewalk
ownership after reproducing and fixing validation after provider/cost-cap
termination, overlapping validation settlement, and phase admission after abort.
Four real ProductionHost regressions cover native/projection execution and
reopened executors. Repeated artifact resume reads the same delivered file with
durable execution identities 2 then 3. The RPC shutdown regression fails when its
post-await admission check is removed and passes with the check restored.

One full-suite run exposed an intermittent existing snapshot-worktree creation
race in `production-host-snapshot.test.ts`: concurrent spawns can observe the same
checkout while another `git worktree add` is still establishing it. Snapshot
provisioning source is unchanged by #76, and the focused nine-test suite passed
on rerun. This remains an assessment follow-up, not a timeout-control fix or a
reason to weaken that concurrency assertion.

The pre-push suite also exposed a fast-process admission race: `/proc` could
lose a child's identity before Node delivered its queued close event. A real
`/bin/true` regression with deliberately held close delivery reproduces the
false unconfirmed-cleanup failure against the previous implementation. Admission
now reconciles close, abort and the fixed deadline before classification, then
checks group and escaped-descendant evidence. Unknown identities are never
signaled by PID alone. The regression also covers missing executables and
control changes during ownership scans.

The permission-race fixture also needed explicit module isolation: the suite's
shared module cache could bypass its filesystem mock and falsely pass against a
nonexistent real PID. The test now checks its three intended reads and releases
the mock, with valid `/proc` stat fields.
