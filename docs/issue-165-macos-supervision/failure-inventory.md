# #165 native failure inventory

This is an inventory, **not a green gate or completed root-cause triage**. No test
was skipped or weakened to produce it. A classification of “needs investigation”
is intentional; a shared symptom does not prove a shared cause or baseline status.

## Runs and counting

- Historical full native run: **332 failed tests / 59 failed files**, 4,191 passed
  tests, 5 skipped tests; 430 files total, 768.37 seconds. It preceded the final
  time-representation fix.
- Draft checkpoint `869d82d` full native run: **334 failed tests / 60 failed files**,
  **4,228 passed / 5 skipped tests**; **373 passed / 1 skipped files**, 434 files
  total, **847.38 seconds**. It preceded the follow-up settlement/status hardening.
- Counts below come from failed assertion results, not the JSON reporter's nested
  `numFailedTestSuites` (which counts describe blocks as well as files). All 60
  failed files are listed; their draft counts sum to 334. Historical counts sum to
  332. The changes are one additional E2E-workspace failure and the new churn test.
- Local raw evidence: `pi-conductor-165-realuid-full.log`,
  `pi-conductor-165-draft-full.log`, `pi-conductor-165-draft-full.json`, and
  `pi-conductor-165-realuid-baseline-triage.log` under the native runner's temporary
  directory. Logs are not committed; summaries retain no environments or tokens.

## Classification and evidence keys

- **B — baseline reproduced:** these exact failed case titles were reproduced at
  v0.22.1 (`00f09c8c795836d579df73122537dcefe0f9257e`). Only **12 tests in three
  files** have this evidence. It does not establish baseline status for similar
  failures elsewhere.
- **L — explicit Linux confinement/feature fixture:** the exercised path requires
  Linux descriptors, the Linux sandbox/probe, or controller sandbox admission.
  Preserve its Linux assertions. A narrowly scoped platform guard may be
  appropriate after case-level review; no guard was added here.
- **D — platform-dependent dependency; needs investigation:** a concrete protected
  Git, descriptor, credential or storage dependency is implicated, but portability
  expectations and baseline equivalence are not established. Do not blanket-skip
  these files: some consumers are otherwise non-sandboxed.
- **G — Git-toolchain fixture; needs investigation:** sparse-index options are
  unavailable in the invoked Git. This is not a reproduced baseline result.
- **R — origin/platform fixture; needs investigation:** Darwin rejects Linux,
  sandbox or no-origin recovery evidence. Do not make origin checks permissive to
  satisfy a Linux fixture; check each case's intended host and rejection contract.
- **A — admission/observation fixture; needs investigation:** a Linux fast-exit or
  cleanup assumption conflicts with the Darwin release barrier/original-evidence
  requirement. Keep portable lifecycle behavior covered rather than skipping it.
- **M — native ownership feasibility failure:** actual unknown-marker uncertainty;
  design review is required, not a process-name exemption or a vanished-PID shortcut.
- **U — needs investigation:** no sufficiently verified classification yet.

Evidence pointers:

1. **B:** detached baseline reproduction recorded the same two workspace cases,
   eight child-output-store cases and two bootstrap cases. Current titles match.
2. **Linux descriptors:** `src/host/execution/sandbox/anchored-file-handles.ts:36`
   opens `/proc/self/fd/${root.fd}`; its contract explicitly says Linux descriptor
   primitives. Failed access/materialization/storage paths reach that boundary.
3. **Protected Git:** `src/host/execution/sandbox/trusted-git-validation.ts:verifyTrustedGitBinary`
   rejects an executable with `nlink !== 1`. Native inspection found the fixed
   `/usr/bin/git` is root-owned, regular, mode 100755, with **78 links**. This
   explains that immediate rejection, not every downstream assertion or a safe
   relaxation of the protection rule. No rule was changed.
4. **Sparse Git:** the full-run errors explicitly reject `--sparse-index` and
   `--no-sparse-index`. Do not infer a portable implementation regression solely
   from that toolchain error.
5. **Linux preflight/origin:** `production-capabilities.ts` explicitly rejects
   controller sandbox requirements; `tool-execution-reconciliation.ts` rejects
   non-Linux Bubblewrap recovery and legacy records without Darwin admission.
6. **Admission fixture:** `supervised-process-admission-review.test.ts:delayedClose`
   waits for child close inside identity observation. Darwin's keeper waits for
   identity admission before workload release, so the fixture needs case-level
   portability work; weakening the barrier is not a fix.
7. **Native ownership:** see the live-candidate evidence below and
   [verification.md](verification.md). Packed and churn failures are not baseline.
8. **Fast-exit cleanup fixture:** `supervised-process-fast-exit-evidence.test.ts`
   fails in `killOwned`/`findObservedProcesses` before the intended evidence
   assertion; its scan/original-scope assumptions need investigation.
9. **Storage dependencies:** `controller/artifact-store-files.ts:readArtifactPayload`
   uses `withSandboxDirectory`; several controller storage/credential failures
   are downstream of protected descriptor operations. Their portability scope
   still needs review.

## Per-file counts

Paths are repository-relative. “Historical” and “Draft” are failed **test counts**,
not total cases in the file. Evidence numbers refer to the definitions above.

| File | Historical | Draft | Classification / evidence |
| --- | ---: | ---: | --- |
| `tests/bin/cli-reconcile.test.ts` | 10 | 10 | R; 5; mixed origin/sandbox cases require individual review |
| `tests/bin/cli-sandbox-approval.test.ts` | 2 | 2 | D; 2/5; approval fixture does not reach expected factory |
| `tests/extension/tui-bridge.test.ts` | 3 | 3 | D; 2/5; sandbox approval forwarding needs case-level review |
| `tests/host/bubblewrap-admission-store.test.ts` | 12 | 12 | L; 2; prepared-runtime capture fails |
| `tests/host/bubblewrap-bootstrap.test.ts` | 2 | 2 | B; 1; bootstrap closes READY before expected frame |
| `tests/host/bubblewrap-file-access.test.ts` | 16 | 16 | L; 2; direct `/proc/self/fd` access |
| `tests/host/bubblewrap-file-tools.test.ts` | 11 | 11 | L; 2; sandbox project materialization |
| `tests/host/bubblewrap-host-approval.test.ts` | 2 | 2 | L; 2; descriptor-confined sandbox approval access |
| `tests/host/bubblewrap-ingestion.test.ts` | 13 | 13 | L; 2; sandbox project materialization |
| `tests/host/bubblewrap-materialization.test.ts` | 7 | 7 | L; 2; sandbox project materialization |
| `tests/host/bubblewrap-output-spool.test.ts` | 5 | 5 | L; 2; descriptor-confined retained output |
| `tests/host/bubblewrap-probe-pipes.test.ts` | 5 | 5 | U; probe channel failures/timeouts need investigation |
| `tests/host/bubblewrap-probe-report.test.ts` | 1 | 1 | L; Linux sandbox probe does not compile on native SDK |
| `tests/host/bubblewrap-project-file-view.test.ts` | 6 | 6 | L; 2; descriptor-confined sandbox view |
| `tests/host/bubblewrap-projection-capture.test.ts` | 5 | 5 | G; 4; sparse-index option errors |
| `tests/host/bubblewrap-runtime-capture.test.ts` | 23 | 23 | L; 2; prepared Linux runtime capture |
| `tests/host/bubblewrap-trusted-git.test.ts` | 10 | 10 | L; Linux fixture invokes absent `/usr/bin/chmod` |
| `tests/host/context-artifact-delegation.test.ts` | 4 | 4 | U; missing child spawn/promisor behavior needs investigation |
| `tests/host/continuity-record-authority.test.ts` | 1 | 1 | U; canonical repository evidence is not verified |
| `tests/host/controller-adapter-recovery.test.ts` | 6 | 6 | D; 9; artifact-storage-failure |
| `tests/host/controller-artifact-store.test.ts` | 9 | 9 | D; 9; artifact-storage-failure |
| `tests/host/controller-child-output-capture.test.ts` | 9 | 9 | D; 3; protected Git rejection |
| `tests/host/controller-child-output-publication.test.ts` | 4 | 4 | D; 3; protected Git rejection |
| `tests/host/controller-child-output-store.test.ts` | 8 | 8 | B; 1; exact child-output-store cases reproduced |
| `tests/host/controller-delivery-example.test.ts` | 1 | 1 | D; 3; protected Git rejection |
| `tests/host/controller-git-effect-source-bridge.public.test.ts` | 1 | 1 | D; 3; protected Git rejection |
| `tests/host/controller-git-effect-source-bridge.test.ts` | 14 | 14 | D; 3; protected Git rejection |
| `tests/host/controller-git-effect.test.ts` | 8 | 8 | D; 3; protected Git rejection |
| `tests/host/controller-host-approval.test.ts` | 1 | 1 | D; 2; protected descriptor access |
| `tests/host/controller-invocation-files.test.ts` | 2 | 2 | L; 2; Linux controller invocation mounts |
| `tests/host/controller-local-effect-runtime.test.ts` | 9 | 9 | D; 3; protected Git rejection |
| `tests/host/controller-local-effects-example.test.ts` | 11 | 11 | D; 3; protected Git rejection |
| `tests/host/controller-output-resolver.test.ts` | 1 | 1 | D; 9; artifact-storage-failure |
| `tests/host/controller-production-effects.test.ts` | 4 | 4 | D; 3; protected Git rejection |
| `tests/host/controller-production-sources.test.ts` | 4 | 4 | D; 3; protected Git rejection |
| `tests/host/controller-remote-effect.test.ts` | 7 | 7 | D; 9; protected credential unavailable |
| `tests/host/controller-runtime.test.ts` | 8 | 8 | L; 2; Linux controller runtime descriptors |
| `tests/host/controller-source-capacity.test.ts` | 3 | 3 | D; 3; protected Git rejection |
| `tests/host/delegation-sandbox-admission.test.ts` | 8 | 8 | L; 3/5; Linux sandbox admission |
| `tests/host/delegation.test.ts` | 3 | 3 | D; 3; source checkout/verification needs investigation |
| `tests/host/e2e-workspaces.test.ts` | 1 | 2 | U; artifact workflow timeout plus concurrent snapshot ENOENT |
| `tests/host/executable-controller-host.test.ts` | 4 | 4 | L; 2; Linux controller runtime descriptors |
| `tests/host/issue-107-projection-admission.test.ts` | 4 | 4 | D; 3; protected Git rejection |
| `tests/host/issue-51-initial-projection.test.ts` | 6 | 6 | U; RPC projection details mismatch; needs investigation |
| `tests/host/issue-55-delegation-policy.test.ts` | 3 | 3 | U; missing subagent-start records; needs investigation |
| `tests/host/issue-57-minimal-child-protocol.test.ts` | 7 | 7 | U; child terminal mismatch; needs investigation |
| `tests/host/issue-97-restart-resume.test.ts` | 1 | 1 | R; 5; legacy execution lacks Darwin origin |
| `tests/host/macos-desktop-churn.test.ts` | 0 | 1 | M; 7; 198/200 commands, two unreadable-marker failures |
| `tests/host/production-host-controller.test.ts` | 1 | 1 | L; 5; controller sandbox rejected before model work |
| `tests/host/protected-run-layout.test.ts` | 9 | 9 | L; 2; Linux descriptor-confined sandbox run layout |
| `tests/host/record-emitter.test.ts` | 1 | 1 | U; child terminal record mismatch; needs investigation |
| `tests/host/rpc/production-host-rpc-spawn.test.ts` | 3 | 3 | U; missing isolated child spawn; needs investigation |
| `tests/host/source-workspace.test.ts` | 16 | 16 | D; 3; protected Git rejection; non-sandbox consumers need review |
| `tests/host/supervised-process-admission-review.test.ts` | 7 | 7 | A; 6; fixture waits for exit before identity admission |
| `tests/host/supervised-process-fast-exit-evidence.test.ts` | 2 | 2 | A; 8; cleanup observation fails before assertion |
| `tests/host/tool-execution-reconciliation.test.ts` | 3 | 3 | R; 5; sandbox/origin cases require individual review |
| `tests/host/workspace.test.ts` | 2 | 2 | B; 1; exact progressive projection cases reproduced |
| `tests/packed-bash-supervision.test.ts` | 1 | 1 | M; 7; native `read_environ EACCES` reproduced |
| `tests/packed-delegation-cleanup.test.ts` | 1 | 1 | A; fixture reads `/proc/<pid>/stat`; intended lifecycle still needs review |
| `tests/packed-delegation-completion.test.ts` | 1 | 1 | U; session_failed instead of done; needs investigation |

## Live native ownership evidence

The full draft run reproduced the packed failure and two churn failures. Unlike
an after-the-fact vanished PID, all three candidates were still alive when
inspected. Fresh native observation matched the failed **PID, Mach birth and time
kind**; effective and real UIDs were both **501**; each was its own group/session
leader. A private nonempty marker probe still returned **unknown**, not absent.

| Failure | PID | Mach birth | Group/session | Real/effective UID | Marker |
| --- | ---: | --- | ---: | --- | --- |
| Packed | 77780 | `171257542372638` | 77780 | 501 / 501 | unknown |
| Churn command 90 | 79812 | `171257937073327` | 79812 | 501 / 501 | unknown |
| Churn command 198 | 82067 | `171258383224680` | 82067 | 501 / 501 | unknown |

Local inspection classified these as system programs with parent PID 1. No
executable names, candidate paths, arguments, environments or marker values were
persisted. **That classification and current parentage are not ownership proof
and were not used as exemptions or authority to signal.** The new-session,
same-real-UID, unknown-marker case is a demonstrated feasibility blocker, not
merely a packed assertion problem. Original proof was insufficient, so production
correctly retained uncertainty. The design must be revisited before acceptance;
do not enable a weaker interpretation to make this campaign green.

The failed campaign made 1,226 scoped file updates. Counters recorded **0 native
EAGAIN races**, **0 other native invocation errors**, and **2 terminal
unreadable-marker failures**. The older counters lacked the later explicit
native-call coverage assertion; zero recorded errors is not independently proven
complete instrumentation. Earlier 200/200 campaigns and six green packed runs
remain historical evidence, not a replacement for this failure.

## Follow-up verification limitations

A scoped fresh-context transport review found a close-versus-cancellation
settlement race and acceptance of duplicate JSON members. Four deterministic race
cases and two duplicate-member cases failed before the fixes. The close branches
now honor an already-claimed terminal after cleanup; private status must match the
trusted emitter's canonical form. Subsequent targeted tests pass, but this full
suite predates those changes.

The first follow-up combined run timed out after a new unit-test mock leaked into
native suites under the repository's `isolate:false` configuration. Test factories
are now explicitly unregistered and consumers reloaded; the native tracing mock is
installed only inside the Darwin test and restored afterward. Positively marked
leftover test processes were individually reverified and killed, without process
name/group shortcuts or production cleanup attestation. A subsequent combined run
completed **119/122** tests, retaining two cleanup-unconfirmed failures and one
cold-admission not-started timeout for investigation. These are not a green gate.
No production deadline or ownership rule was relaxed.

After instrumented consumers were reloaded explicitly, one run passed **38/38**
including 200/200 commands, 1,302 updates and **1,110 actual native calls**. The
final keeper/settlement hardening passes **42/42 targeted tests**. The later broader
run is **155/156 across 21 files**, retaining another packed production timeout
that returned cleanup-unconfirmed EACCES (PID 6646, Mach birth
`171499176442717`, group 6646). Fresh inspection found that PID gone; no relationship
or cleanup proof follows. This run's campaign passed 200/200, 1,018 updates,
**1,027 native calls**, with zero recorded races/native/marker failures. Both
instrumented campaigns require more than 200 real invocations; green runs do not
erase the full-run 198/200 failure. Further scoped reviews found open bootstrap,
cleanup and session issues; see [review-findings.md](review-findings.md).

## Remaining work

- Investigate every U/D/G/A/R case rather than assuming all failures are baseline
  or Linux-only. Keep Linux-only and portable cases separated within mixed files.
- Obtain an actual Linux runtime/CI result. A queued PR check is not a pass.
- Revisit same-real-UID restricted new-session provenance with the overseer before
  advancing native feasibility or advertising support.
- Finish the remaining cache, cleanup/recovery, observation-race and extraction
  safety reviews; the scoped transport review is not whole-feature approval.
