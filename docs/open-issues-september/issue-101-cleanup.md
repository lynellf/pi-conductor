# Issue #101 cleanup observation checklist

Issue #101 covers cleanup-observation failures from concurrent read-only file
workers. The underlying historical OS race is not treated as established until
the follow-up trace identifies it; the documented behavior remains fail closed.

## Acceptance mapping

- [x] `package.json` and `CHANGELOG.md` target release `0.21.5` and describe
  the intended read-only observation, child settlement, usage, lease, and
  reconciliation fixes without claiming an exact historical cause.
- [x] `docs/execution-controls.md` explains detailed OS observation errors,
  actual observations, empty-observation semantics, finished-record semantics,
  unresolved barriers, lease boundaries, and explicit original-host
  reconciliation.
- [x] Runtime preserves the detailed observation error and actual observation
  for concurrent read/ls/find worker-exit races, with one permission-only
  retry after 5 ms using fresh evidence; persistent failure remains
  unconfirmed. The initial reproduction was one permission-denied `/proc`
  observation among 72 ordinary concurrent file calls; the current stress
  reproduction is EACCES, while the exact historical errno is unavailable.
  Follow-up stress recorded zero failures across 144 calls.
- [x] Runtime settles a failed child after known SDK settlement while retaining
  usage and unresolved cleanup, cancels siblings safely, and prevents unsafe
  admission or resume. Parent lifecycle/lease settlement waits for all child
  SDK sessions and durable terminals; unknown SDK or persistence state remains
  fail closed, and late cleanup failure during cost-cap close emits
  `session_failed` rather than false `done`.
- [x] Focused process and child-settlement review is complete. Scoped child
  sessions forward the parent registry model runtime for Pi 0.84+; the
  compatibility matrix is verified below.
- [x] Runtime releases the shutdown lease at the safe boundary and supports
  documented reconciliation without force deletion or false confirmation.

The packed delegation regression uses a test-owned `/proc` view that excludes
only PIDs proven older than the original test runner. Unrelated protected
same-UID processes remain visible to the fail-closed production observation
path; the test does not weaken that guard or signal those processes.

## Verification gates

- [x] Root confirms issue #101 runtime, packed regression, lease, and
  reconciliation suites: full suite green with 2,124 tests across 202 files.
- [x] Packed delegation matrix: Node 26 with the repository Pi 0.80.6 host,
  and Node 22.19 with Pi 0.85.1. Both packed delegation cases passed,
  including fresh-process reconciliation, lease release, and no-replay
  resume. The existing packed file/bash smoke tests also passed on Node 22.19
  with Pi 0.85.1.
- [x] Root confirms `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm lint`,
  `pnpm format:check`, and `pnpm audit --prod`.
