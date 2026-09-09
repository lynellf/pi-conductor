# Reconciliation observation diagnostics

Repair the diagnostic surface of the existing approved executable-tool recovery
contract in `open-issues-september/spec.md` §76 and FSM §11–12. Preserve the
same-host observation and explicit confirmation rules described in
`execution-controls.md`.

## Evidence and scope

- Reproduced the reported run's inspection failure: the scanner throws
  `ProcessObservationError` with `read_environ`, `EACCES`, and numeric process
  identity evidence. The CLI prints only `error.message` and usage.
- Report only allowlisted operation/errno and validated PID, start ticks, and
  process-group ID. Do not print raw errors, stacks, environment contents,
  owner tokens, command lines, or other attached properties.
- Runtime observation failure should explain the failing `/proc` access,
  identity-only inspection steps, and how to restore visibility and retry.
  A process encountered during a scan is not proven to belong to the run.
- Usage belongs to argument errors and help. Runtime errors should not imply
  that the command syntax was wrong.
- No scanner, ownership, lease, confirmation, or persistence behavior changes.
  Observation failure continues to refuse confirmation and preserve log bytes.

## Work and verification

- [x] Reproduce the CLI diagnostic loss with permission, enumeration, and
  unavailable-identity cases; prove raw attached data stays out of diagnostics.
- [x] Render safe observation details and actionable, read-only recovery steps;
  preserve syntax help and separate it from runtime failures.
- [x] Verify failed inspection and failed explicit confirmation append nothing;
  verify a subsequent successful inspection can reacquire the lease.
- [x] Update recovery documentation and changelog.
- [x] Run focused tests, typecheck, build, full tests, lint/format, and audit;
  review the change and rebuild the linked CLI.
- [x] Rerun the original inspection, report its actionable diagnostics, and
  verify the run-log bytes remain unchanged.
- [x] Commit the reviewed repair.

## Verification evidence

- Six CLI regressions initially failed against the old error handling. The
  focused suite now passes 49 cases across CLI dispatch, reconciliation, and
  recovery APIs, including malformed-identity redaction and lease reacquisition.
- All 2,158 tests passed across 205 files. Independent review identified two
  refinements: use platform-defined errno names rather than character validation,
  and remove the entire confirmation argument group when retrying inspection.
  Both regressions were observed before repair; the final focused 49 tests,
  typecheck, build, lint/format, and bounded rereview passed afterward.
- Typecheck, build, lint, and format checks passed. Audit reports two moderate
  and one low existing development-dependency advisories; no high or critical
  advisories. No dependencies changed.
- Rebuilt the locally linked executable and reran the reported read-only
  inspection. It reports the denied `read_environ` operation, `EACCES`, PID,
  start ticks, process group, failed procfs path, and recovery steps. Comparing
  the complete log bytes before and after confirmed no changes.
- Metadata-only inspection showed the candidate runs under the current user's
  UID while its environment pseudo-file is root-owned and owner-readable only.
  No environment contents were printed, no processes were stopped, and no
  cleanup was confirmed. The visibility issue requires authorized host-side
  investigation; formatting diagnostics does not establish process ownership.
