# Issue #105: terminal status and post-admission service observation

Existing contracts: [FSM specification](archive/orchestrator-fsm-spec.md),
§5.2 and §11–12; [executable tool controls](open-issues-september/spec.md), #76;
[execution controls](execution-controls.md), #102–104 ownership safeguards.

## Scope and assumptions

Repair terminal CLI status independently from process ownership. Preserve the
existing rule that unknown ownership stops the invocation without replay.
A process's current system-manager association is not proof that its lifecycle
is external to the tool: an ordinary foreground client may activate a service.
No executable-name or blanket permission-denial exemptions are authorized.
The issue explicitly permits actionable fail-closed handling when safe external
provenance cannot be established. This repair follows that path unless the
investigation establishes a stronger proof using existing evidence.

The reproduction uses only controlled fixture processes. Historical campaign
records, real authentication daemons, compiler behavior, and host security
settings remain outside mutation scope. No production campaign restart is part
of verification.

## Evidence

The preserved run contains 35 records. Its final records include
`session_failed` with `failure_reason: tool_cleanup_unconfirmed`, followed by a
checkpoint snapshot and a context boundary. Checking only the last record for
failure therefore loses the terminal status.

The failing execution's denied process starts at tick `101005613`, newer than
its persisted admission boundary `101005231`. The recorded identity matches the
issue's independent observation. The service journal reports activation at
04:38:51 UTC; the foreground setup tool started at 04:38:50.865 UTC. Setup's
first external operation fetches a Git remote over SSH. The service exposes an
SSH-agent socket. This supports socket activation as a plausible path, but no
historical socket-client trace establishes which client triggered it.

Original event-log SHA-256 before investigation:
`3049af247e6046690c54c499581151498ab592ff37264537465cc283fb5b9fbc`.
Raw sessions and command output are not copied into this document.

## Increment 1: terminal CLI results (Luna)

- [x] Reproduce failure followed by checkpoint/context records in a focused test.
- [x] Return nonzero on terminal session failure; retain zero for successful
      completion and existing explicit-abort semantics. The first signal requests graceful abort; a second signal forces
      130 (SIGINT) or 143 (SIGTERM).
- [x] Keep final top-level and nested exit reasons consistent without treating
      an ongoing recovery as terminal.
- [x] Verify focused lifecycle and built/installed CLI tests.

## Increment 2: service visibility and recovery (Terra)

Independent of increment 1; preserve ownership admission and persisted schemas.

- [x] Review the provenance decision with a fresh Luna reviewer.
- [x] Reproduce post-admission same-UID inaccessible service activation with a
      controlled foreground tool and fixture-owned process manager.
- [x] Keep unresolved ownership closed and expose actionable runtime and CLI
      guidance distinguishing service visibility from verified descendants.
- [x] Verify fixture identities, diagnostics, and cleanup of test-owned resources.

## Integration and verification

Depends on both increments.

- [x] Review the complete diff and regression coverage across Luna/Terra.
- [x] Run typecheck, build, full tests, lint, format check, and production audit.
- [x] Verify the linked CLI resolves to this rebuilt checkout.
- [x] Verify the original event log remains unchanged.
- [x] Record results, limitations, and accurate operator next steps.

## Ownership limitation

A cgroup path is mutable process placement: Linux permits process migration
between cgroups. A matching systemd `MainPID` is useful identity correlation,
but alone cannot distinguish an externally managed shared service from a
workload launched through the manager by the tool. Automatic continuation would
need a separately defined provenance/lifecycle contract; it cannot be inferred
from a service name or permission error.

Source: [Linux cgroup v2 process organization](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#processes).


The fresh Luna review found no safe exemption from the existing observations.
The implementation therefore preserves the ownership rules, including `EPERM`
as well as `EACCES`, strict inequality at the admission boundary, and the
existing boot/namespace/PID-reuse checks. Current manager placement is useful
for inspection but is not substituted for provenance. This is an actionable
failure repair, not automatic support for manager-launched service lifecycles.


## Controlled systemd reproduction

A private probe used the built supervisor and `captureToolAdmission`. The
foreground command requested a uniquely named transient user service running
only a fixture Python process, waited for its readiness, wrote
`foreground-settled`, and exited normally. The fixture disabled dumpability
only for itself to produce the same environment-access denial.

The probe completed in approximately 199 ms with
`supervised-process-spawn-failed`, cleanup `unconfirmed`, and
`cleanup_observation_failed/read_environ/EACCES`. This was not a timeout.
The diagnostic PID/start identity matched the fixture and remained stable
around inspection. Its start tick `104156141` was newer than the captured
boundary `104156115`; UID matched the observer. The system manager reported
that same `MainPID` in the fixture's service cgroup. The service was still
active at observation and was stopped by fixture teardown; its PID was gone
before the probe returned. A finite service runtime was also configured as a
backup cleanup bound.

This controlled command demonstrably caused its service to start. It proves
that manager association and a settled foreground command can coexist with
unresolved ownership, not which client activated the historical authentication
service. No real authentication daemon was changed or signalled.


## Focused verification

- Before the CLI fix, two regressions failed because failure returned 0.
- Before the diagnostic change, two regressions failed because service
  association/cutoff guidance was absent.
- Diagnostic, CLI reconciliation, observation-scope, and portable activation
  checks passed: 44 tests across four files. The portable manager fixture
  completed in 211 ms and checked that its protected process had stopped.
- Fresh Terra review found no blocking CLI correctness issue. Fresh Luna review
  found no sound additional service exemption and confirmed the diagnostic
  policy. Review corrections improved fixture socket closure, child reaping,
  error-path settlement, and test identity fidelity before final validation.


The final focused CLI batch passed 51 tests across three files, including the
actual packed `conduct` entrypoint invoked with `--non-interactive --json`.
A controlled orchestration-result stub supplies terminal outcomes; the real
bootstrap, CLI rendering, and process exit path remain in use. It verifies
`done` → 0, `session_failed` → 1, explicit `aborted` → 0, and matching JSON
statuses. The RunHandle regression separately exercises a cleanup-unconfirmed
failure followed by a checkpoint, and a pending recovery followed by settlement.
This is credential-free installed-CLI coverage, not a provider-backed campaign.

Typecheck, build, lint, and formatting passed. The linked executable resolves
to this checkout's rebuilt `dist/bin/conduct.js`. The original event-log digest
is unchanged. Production audit is clean; the full audit retains the existing
two moderate Vitest advisories and one low esbuild advisory, with no high or
critical findings. Dependencies were not changed.


Full verification passed: **2,207 tests across 211 files** (209.11 seconds),
including the portable post-admission service-activation test and prior
admission, namespace, ownership, and restart guards. No production campaign was
started. The CLI and diagnostics are available in the rebuilt linked checkout;
a running Pi process must be restarted to reload extension code.

The historical campaign remains unconfirmed. This repair fixes its misleading
terminal CLI result and supplies the issue's permitted actionable fail-closed
behavior; it does not make post-admission service ownership automatically
provable. Before resuming or starting overlapping work, preserve the setup
receipt, inspect its partial effects and original process ownership, and use
the existing read-only reconciliation and explicit confirmation procedure.
Current service association alone cannot clear the barrier.
