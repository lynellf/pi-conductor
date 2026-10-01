# #165 verification and open acceptance gates

## Native configuration

- macOS 26.5.2, build 25F84; arm64; SIP enabled.
- Node 25.6.0; Pi SDK 0.80.6; installed full Xcode.
- No new npm dependency, lockfile change, CI change, privilege escalation, or SIP change.
- Draft review is authorized; implementation is not accepted for merge or release.

## Approved real-UID boundary

The overseer approved matching Linux's existing **real-UID** foreground trust
scope. The native observer now retains effective `uid` and independent `realUid`,
and rechecks both credentials around observations. The installed public SDK
`sys/sysctl.h` defines `e_pcred.p_ruid` as real UID and `e_ucred.cr_uid` as effective
UID; Apple's `fill_user64_eproc` fills them from separate credential getters.
The closed protocol requires both fields, rejects missing/malformed real UID, and
does not default it to effective UID. This unreleased wire protocol remains v1;
its source-keyed native cache rebuilds for the changed packaged C source.

Only unknown-marker global-scan candidates with a freshly validated different
real UID receive the same-account exclusion. Positive markers always win.
Same-real-UID setuid candidates remain unknown without original exclusion proof;
effective UID alone never exempts them. Group and originally owned session checks
still retain all members regardless of UID. Privileged out-of-session workloads,
service activation and deliberately unmarked escapes remain unsupported, not
contained by this boundary. Same-real-UID restricted processes can still stop a
run conservatively.

Regression tests distinguish both credential directions, reject missing metadata,
retain positive ownership and foreign-UID group/session members, and check actual
native Node real/effective UIDs. The credential-change cases are validated protocol
fixtures, not privileged native setuid experiments; no privilege escalation was used.
The new policy tests failed before implementation, then passed.

## Verified behavior and remaining native failures

Native runs exercise the public-SDK observer, marker redaction versus positive
Node ownership, all six confined packed file tools, real guard cancellation,
timeout and abort cleanup, an actually running CPU loop, pipelines, TERM-resistant
descendants, output bounds, broken stdin pipes, and no late writes after confirmed
cleanup. Restricted escaped Apple executables remain cleanup-unconfirmed. Node
preload effects are withheld until admission; workload flags survive release.

Native admission retains boot/UID, original Mach boundary and original session
witnesses. Tests cover explicit append-only reconciliation, foreign boot and Linux
origin rejection, malformed witnesses, and blocked guard resume. Production
preflight covers later workers, guard-only workflows, unused profiles, required
Bubblewrap rejection, and controller sandbox rejection before native preparation.
Cache tests cover signed warning-clean compilation, digest changes, symlink/ACL
rejection, missing compiler, unavailable API visibility and uncertain build locks.

Before alignment, the strict cross-UID policy produced 1/40 and 2/40 uncertain
ordinary desktop commands; warmed runs sometimes passed. These are historical
failures, not discarded evidence. After the approved real-UID change, the unchanged
40-command campaign passed in the focused and full-suite runs.

The first aligned focused run passed 126/127 tests, with one end-guard timeout
reporting cleanup unconfirmed. Twenty reduced timeout reproductions passed, and
an instrumented focused run passed 127/127. This does not establish the first
failure's root cause or authorize suppressing future observation failures.

The latest packed subset passed all six file tools, supervised tool integration
and isolated RPC read, but failed packed bash fixture cleanup with `read_environ
EACCES`. The completed full suite reproduced that packed failure with bounded PID,
Mach birth and group evidence. A later vanished PID is not cleanup proof. Keep
this gate open; do not skip the test or reinterpret its unknown marker as absent.

During triage, shared cleanup was found to compare births without checking their
representations. It now age-compares only matching representations, refuses an
identity whose representation changed, and preserves the failed observation's
time kind. Three regression cases failed before that fix. Historical Linux
identities without a time-kind field retain their comparisons and equality.
The latest post-fix focused native run passed **149/149 tests across 22 files**,
including the unchanged 40-command campaign. Separate Linux-contract/cleanup tests
passed 68/68, and representation contract tests passed 6/6. These do not erase the
packed failure or establish Linux runtime compatibility.

## Peer-review follow-up and draft checkpoint

The scoped peer review found two material keeper defects: self-signaling SIGPIPE
returned exit 0, and self-signaling SIGUSR1 activated the inspector and returned
exit 0. Native file-mode regressions reproduced both. The keeper now writes one
bounded private terminal frame, never re-raises the workload signal, and starts
with `--disable-sigusr1` (documented since Node 22.14, below the package minimum).
Only a closed valid frame establishes the workload outcome; missing, malformed,
duplicate, oversized or failed transport remains a spawn failure after required
cleanup checks. Shared deadline/abort/cleanup ownership is unchanged. Native
SIGPIPE/SIGUSR1/SIGTERM and pre-release keeper-death tests pass; protocol tests cover
split frames, absence, malformed fields and inherited-field substitution. A
focused signal/shared-supervisor/guard run passed 64/64 tests across seven files;
subsequent outcome hardening passed 29/29 across two files.

A separate **200/200** ordinary-command campaign ran with **1,118** scoped file
updates in an owned workspace directory. It recorded **0 native EAGAIN identity
races**, **0 other native invocation failures**, and **0 terminal unreadable-marker
failures**. Instrumentation forwards the actual native call unchanged and counts
errors before the production retry. This is file churn, not proof that a newly
created same-real-UID restricted service session can be safely excluded. No service
controls, privileged/system-wide reindexing or process-name exemptions were used.
The unchanged 40-command campaign remains in place and passed the signal-focused run.

Packed bash passed alongside the new campaign and in **five further isolated
runs**. A read-only live-candidate watcher was prepared, retaining identity metadata
only, but no failing candidate recurred to inspect. These green runs do not explain
or erase the earlier `read_environ EACCES` failures. Packed root cause and the
same-real-UID/new-session feasibility risk remain open. A vanished PID alone does
not prove cleanup; a complete fresh scan using original scope plus the required
group checks is a different observation, not a replacement baseline.

The initial peer review covered native observation, Darwin identity and transport,
not the cache/runtime, shared settlement, reconciliation or Linux extraction line
by line. Remaining split safety reviews are required. Native `apple[]` parsing
compatibility across OS revisions and an actual no-CLT host remain unverified;
the non-triggering `xcode-select` failure path already has a compiler-shim test.

## Full suite and Linux status

A full native `TMPDIR=/private/tmp pnpm test` run completed in 768.37 seconds:
**370 passed / 59 failed / 1 skipped files; 4,191 passed / 332 failed / 5 skipped
tests** (430 files, 4,528 tests). No new blanket skips were introduced. This run
preceded the final shared time-representation fix; the affected focused tests were
rerun afterward. It is a completed failed run, not a green gate.

Triage identifies Linux-only procfs/Bubblewrap fixtures, older-Git projection
requirements, Darwin admission/keeper assumptions in existing fixtures, and the
packed ownership failure. In particular, a fixture waiting for command exit before
identity admission cannot naturally complete behind Darwin's pre-release keeper;
legacy no-origin reconciliation must not be made permissive just to pass Linux
expectations on a Mac. Portability triage is still incomplete.

A detached baseline worktree at v0.22.1 reproduced 12 failures across three suites:
`workspace.test.ts` (2), `controller-child-output-store.test.ts` (8), and
`bubblewrap-bootstrap.test.ts` (2). The temporary worktree was removed. Only these
reproductions establish baseline failures; do not classify all 332 that way.

Procfs identity/scope/admission tests explicitly exercise Linux contracts on the
Mac, and the extracted procfs function body matched baseline text. Neither replaces
Linux runtime verification. Docker discovery still times out; no usable local Linux
runtime is established. Existing Ubuntu CI remains unchanged. Its triggers are
pushes to `main` and PRs targeting `main`, not ordinary feature-branch pushes.
The draft review must be checked for an actual Linux CI task/result; PR creation
alone is not Linux verification. Intel, Rosetta and
older macOS are unverified; dedicated macOS CI remains deferred as requested.

## Quality and review status

- Draft-checkpoint focused verification passed **241/241 tests across 31 files**,
  including the unchanged 40-command campaign and a second **200/200** scoped-churn
  campaign (1,294 file updates; zero recorded identity races or terminal marker
  failures), packed file tools, RPC read, and Linux-contract fixtures on the Mac.
- Latest typecheck, build, full-repository Biome lint and format checks passed.
- Latest `pnpm audit --prod` passed: no known vulnerabilities on the unchanged
  dependency graph. The earlier registry-`ETIMEDOUT` retry remains a failed retry,
  not retroactively a successful audit.
- `git diff --check` passed. The overseer authorized a commit/push/draft PR checkpoint;
  this does not waive failed tests or authorize merge/release.
- A read-only fresh-context native/UID review was attempted using the configured
  model but timed out after 240 seconds without a result. It is not a completed
  independent review. The later scoped peer review is completed, but cache,
  corrected signal transport, cleanup/recovery and remaining ownership reviews
  are still open. Jev supplied advisory time-representation triage only;
  deterministic regression tests established that issue and its fix.

## Repeatable checks

Use a canonical temporary root on this Mac:

```sh
TMPDIR=/private/tmp pnpm exec vitest run tests/host/macos-*.test.ts \
  tests/host/supervised-process.test.ts tests/host/supervised-process-regression.test.ts \
  tests/host/local-effect-supervision.test.ts tests/host/end-guard*.test.ts \
  tests/host/supervised-cleanup-diagnostics.test.ts tests/host/process-identity-contract.test.ts
TMPDIR=/private/tmp pnpm exec vitest run tests/packed-file-tools.test.ts \
  tests/packed-bash-supervision.test.ts tests/host/supervised-tools.test.ts \
  tests/host/rpc/production-host-rpc-execution.test.ts
TMPDIR=/private/tmp pnpm test
pnpm typecheck
pnpm build
pnpm lint
pnpm format:check
pnpm audit --prod
git diff --check
```

Record uncertainty under ordinary desktop activity, not only warmed idle runs.
Acceptance remains blocked on packed uncertainty, complete failure triage, Linux
runtime verification and detailed independent safety review.
