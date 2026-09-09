# Issue #97: resume after supervised-process cleanup

Repair against the approved [#76 contract](../open-issues-september/spec.md#76-executable-tool-deadlines)
and archived FSM §8.2/§11.1/§11.4. Issue #97 supplies the recovery acceptance
criteria. Implementation is assigned to Luna; the primary agent owns review.

## Assumptions and boundaries

- Unknown process ownership continues to stop execution. Background processes
  do not receive an implicit ownership transfer.
- Choose the issue's operator verification option: inspect execution identities,
  stop remaining processes independently, then explicitly confirm cleanup on
  the original Linux host, PID/network namespaces, and canonical run storage
  after inspecting partial effects. This includes all unmarked descendants.
- Confirmation combines operator attestation with an owner-marker absence
  check. The marker is an identity aid, not a sandbox or proof against processes
  that deliberately remove it. Legacy 0.21.1 logs have the marker but no PID.
- Preserve historical start/failure records. Append a correlated confirmation;
  never replay the original tool or mutate the machine checkpoint.
- Reconciliation holds the run lease. Live ownership, unreadable observations,
  malformed records, and ambiguous persistence continue to block execution.
- Preserve command references (tool-call/execution/supervision/session IDs),
  without copying raw arguments or output into execution records.

## Ordered tasks

- [x] Reproduce intentional `nohup ... &` and leaked descendants with real
  subprocess fixtures; verify they remain unconfirmed until processes stop.
- [x] Preserve host tool failure reason/detail against SDK abort errors; verify
  lifecycle output and absence of retry/fallback with regression tests.
- [x] Add a validated append-only cleanup-confirmation record and timeline
  reconstruction; verify legacy logs, correlation, ordering, and duplicate
  rejection with persistence tests.
- [x] Wire every execution admission/resume guard to the reconciled timeline;
  verify unresolved work still blocks and confirmation permits fresh work.
- [x] Add operator inspection/reconciliation API and CLI under the run lease;
  verify live-process refusal, operator termination, already-exited processes,
  active-lease refusal, restart/resume, and no automatic replay.
- [x] Document recovery commands and limitations in executable-tool guidance.

## Final verification

- [x] Reconcile independent design/code review findings.
- [x] Focused regression tests demonstrate the original failures and repair.
- [x] `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`, and
  `pnpm format:check` pass.
- [x] `pnpm audit` has no unaddressed high/critical findings.
- [x] Commit the reviewed fix on `fix/97-process-reconciliation`.

## Evidence and open items

The real-process reproductions retain a descendant after its leader exits.
The cleanup helper refuses group signaling without the original leader's
identity. Separately, SDK `message_end(stopReason=error)` overwrites the host's
cleanup failure with `model_error`, incorrectly enabling model fallback.

The incident run `bc041a97-f659-4cfb-aea0-4b5a45cab983` was not found in the
available local run locations. Verification uses isolated fixtures; no incident
process or log is modified.

Linux process identity fields and visibility constraints are documented in
[the kernel procfs reference](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

### Design review reconciliation

- Actionable: an empty marker scan cannot prove that unmarked descendants are
  stopped. Require explicit operator confirmation of all original processes;
  name the verification as operator confirmation plus marker absence evidence.
- Actionable: the TCP lease is scoped to the network namespace. Include original
  network namespace and canonical storage in the operator acknowledgment.
- Actionable: `/proc` enumeration is not atomic. Document its bounded evidence;
  never claim that a repeated scan alone proves the complete process tree gone.
- Actionable: all admission filters must retain the new record, including
  delegation and trajectory paths. Require reopened-log resume integration.

Dependency audit: `pnpm audit` found two moderate Vitest advisories and one low
esbuild advisory, all in development dependencies; no high/critical findings.
Dependency changes are outside this process-recovery repair.
`pnpm audit --prod` is clean. `pnpm install --frozen-lockfile` confirmed the
committed dependency tree and ran the build successfully.

### Implementation review reconciliation

- Actionable: validate the complete candidate execution timeline before append,
  so timestamp or identity failures cannot corrupt a valid run log.
- Actionable: refuse a torn trailing log record before confirmation writes and
  preserve its bytes. Repairing existing log damage is a separate operation.
- Accepted bounded trade-off: unconfirmed write/edit calls retain poisoned
  mutation locks in the original pi process. Require restarting pi after
  confirmation in that case; do not broadly clear in-memory ownership locks.
  The reported bash/nohup case does not use the file-mutation lock.

Final independent review found no remaining substantive issues in the recovery
path after these corrections. The integration fixture begins from a failed,
non-done checkpoint and verifies a fresh operation inside the resumed role
spawn path, alongside preservation of the original tool-call history.

The API process lifecycle test reads real PID identities for its test-owned
child through a scanner test seam. This avoids unrelated non-inspectable
same-user host processes while testing live refusal and termination/confirmation.
The production scanner still fails closed on insufficient process visibility;
the real subprocess supervision regressions separately exercise owner discovery.

Full-suite verification initially caught an ineffective hoisted test mock under
the repository's `isolate: false` runner. A per-test spy with cleanup now isolates
the restart fixture. No production process-visibility check was weakened.

Final gates: 194 test files / 2,080 tests passed, strict typecheck, build, lint,
and format checks passed. The built `conduct reconcile-tools --help` command
also passed without loading a manifest or creating a model registry.
