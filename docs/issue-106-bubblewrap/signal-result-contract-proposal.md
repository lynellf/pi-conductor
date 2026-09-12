# Issue #106: command status clarification

Status: Proposed; awaiting overseer acknowledgement. This does not change the
approved specification yet.

## Evidence

The pinned Bubblewrap 0.12.0 `propagate_exit_status` returns the normal exit
status for `WIFEXITED`, or `128 + WTERMSIG` for `WIFSIGNALED`. Its JSON status
channel reports only that normalized number. Consequently, a command that
calls `exit(137)` and one killed by `SIGKILL` both report 137. Node's launcher
signal describes the monitor, not necessarily the command.

Source: [pinned Bubblewrap implementation](https://github.com/containers/bubblewrap/blob/v0.12.0/bubblewrap.c).
The installed test build was verified against this exact upstream release.

Real production-pipe tests against that installed build confirm both cases
report 137 (`tests/host/bubblewrap-command-pipes.real.ts`). The same suite checks
ordinary nonzero exit, stderr, background output, and backpressure.

## Recommended amendment to spec §7

Replace “accurate command exit code/signal” with:

> `bash` returns the normalized command status reported by Bubblewrap, bounded
> stdout/stderr previews, truncation flags, execution identity, and opaque output
> references. The status interface cannot distinguish `exit(128 + N)` from
> termination by signal N. Signal classification remains unknown rather than
> guessed. Host-requested termination is recorded separately from command status.

Replace the “command exit/signal” category with “command status”. Preserve the
existing separate setup failure, timeout, cancellation, unconfirmed cleanup,
and incomplete capture categories. A nonzero status with confirmed cleanup
remains an ordinary tool result for local repair.

Verification must exercise both explicit exit 137 and SIGKILL and confirm that
neither is falsely classified as a known command signal. Cancellation evidence
must identify a host request without claiming which signal ended the command.

## Alternative

Exact signal classification requires a trusted command supervisor and a new
authenticated status protocol. That changes the approved bootstrap/control-FD
boundary in §6 and needs a separate design and real isolation proof. It is
additional scope beyond the current Bubblewrap status interface.

The recommended amendment preserves the established confinement and lifecycle
proof while reporting precisely the information the backend supplies.
