# Executable tool controls

Roles and subagent profiles can configure `tool_execution`:

```yaml
tool_execution:
  timeout_seconds: 300
  max_recoverable_timeouts: 2
  termination_grace_seconds: 2
```

These are the defaults when the block is omitted. Values must be positive safe
integers; `timeout_seconds` cannot exceed 3,600. The manifest snapshot pins the
policy for the run, including resolved defaults for every role and subagent.
New runs retain that snapshot across resume even if current YAML changes.
A model's explicit bash timeout may shorten that deadline,
but cannot extend it. Output and CPU activity do not reset the clock.

The deadline includes file-path confinement and any wait for an earlier mutation
of the same file. Bash processes run in owned process groups. File tools run in
separate Node workers so synchronous file processing cannot block the host's
deadline timer. This currently requires Linux. Fresh workers add approximately
0.6 seconds per file call on the development host; the exact cost depends on the
machine and installed SDK.

A timeout first requests graceful termination, then escalates if necessary.
After confirmed cleanup, the model receives a structured `tool_timeout` error
and can inspect or repair the workspace. The host never replays the tool call.
Two timeouts are recoverable by default; the third stops the invocation with
`tool_timeout_exhausted`. Recovery counts survive model fallback.

The bash tool tells the model to keep the complete workload in the foreground.
Detached or background jobs (`nohup`, `&`, `setsid`, and `disown`) are
unsupported because they evade the owned deadline and process-group cleanup.
The model may set a timeout up to the pinned limit, including raising a shorter
per-call timeout, but it cannot exceed that limit. This guidance does not
enforce background-job behavior; a background launch may still end with
cleanup unconfirmed. An owner must configure a finite higher limit for a new
run, or the model should split the work into bounded foreground calls. After a
timeout, inspect partial effects before manually retrying. The host does not
automatically replay a timed-out command.
An explicit operator resume starts a fresh invocation budget while preserving
the workspace and any materialized artifact inventory.

If process ownership or cleanup cannot be confirmed, the invocation stops with
`tool_cleanup_unconfirmed`. Do not assume a timed-out write or edit was rolled
back: inspect the affected workspace before continuing. A file whose mutation
has unconfirmed cleanup remains unavailable to other mutations in that host.

A finished execution may include an optional persisted diagnostic, with a
model-visible copy, containing `cleanup_cause` and an `observed_members`
snapshot. The cause distinguishes a surviving process group, escaped
descendants, lost identity, and process-observation or termination-signal
failures. `leader_observed` means only that the leader identity was admitted
historically; it does not mean the leader is alive now. Each observation
contains a Linux PID, `start_time` in Linux start ticks, and process group ID.
At most 32 members are recorded, with no command arguments, environment values,
marker contents, or output. Observations can age, and group membership alone
does not prove execution ownership. Before operator action, revalidate the
current start ticks, owner marker and process group.

Intentional owner waits through `ask_user` and delegation result waits are
exempt. Isolated roles and delegated children retain their existing file
confinement; executable controls do not grant them a shell.

The append-only log records execution identities, tool names, effective
deadlines, elapsed time, recovery counts, and cleanup outcomes. These records
exclude tool arguments, environment values, and raw tool output. Resume stops
before starting new work if a previous execution has no terminal record or has
unconfirmed cleanup. It does not trust a remembered PID or automatically replay
an ambiguous side effect.

Run status includes the active tool, elapsed time, deadline, active execution
count, and timeout recovery state. Completed execution records remain available
for diagnosis after the invocation stops.

Operators can inspect and reconcile unresolved executable tools with:

```text
conduct reconcile-tools --log-dir <path> <run-id>
conduct reconcile-tools --log-dir <path> <run-id> --execution <execution-id> --confirm-cleanup --note "<operator note>"
```

The confirmation command never kills a process or replays a tool. The explicit
acknowledgment attests that the operator ran the command on the original Linux
host and PID/network namespaces and canonical storage, stopped all original
processes (including unmarked descendants), and inspected workspace partial
effects. Owner-marker absence supports the attestation but is not independent
proof. Live marked processes, unsupported or
unreadable observations, malformed requests, and an active run lease refuse
confirmation. Original records remain unchanged; a correlated confirmation is
appended only after verification. Then use `/conduct:resume <run-id>` (with the
usual manifest resolution), repeating reconciliation for each unresolved ID.
The production marker scan requires sufficient `/proc` visibility in the
original host and PID/network namespaces; a permission denial while inspecting
any process is not evidence that it exited and causes reconciliation to fail
closed. Resolve that visibility issue before confirming cleanup.

Do not trust a historical PID by itself: correlate the run ID, execution ID,
tool-call ID and tool name, then verify the current process start ticks, process
group and ownership in the original host namespace. Stop only processes that
are currently verified as belonging to that execution, including verified
descendants. Never blind-kill a reused PID, kill the whole conductor, elevate
privileges merely to suppress an observation error, or hide a failed check.
If a read-only `/proc` or namespace observation is denied, perform the same
actionable observation from the original host with sufficient visibility and
leave reconciliation unconfirmed until it succeeds.

Reconciliation refuses a log with an incomplete trailing record and leaves its
bytes untouched; repair that persistence issue separately. After confirming
cleanup for a write or edit, restart pi before resuming so stale in-process
mutation admission state cannot retain the old ownership decision.

See the [approved specification](open-issues-september/spec.md) for the complete
execution and restart contract.

## Pi and Node compatibility

The worker resolves the public Pi SDK from the package directory owned by the
running Pi host. This supports npm-installed extensions where Pi and
`pi-conductor` use separate package trees; it does not search for or install a
second SDK. The verified ordinary file-tool matrix is Linux, with Pi and
`pi-conductor` in separate npm package trees and no local peer SDK in the
packed package:

| Node | Pi 0.80.6 | Pi 0.85.1 |
| --- | --- | --- |
| 22.19.0 | Pass | Pass |
| 26.5.0 | Pass | Pass |

The credential-free packed smoke uses Pi's real extension loader and exercises
all six confined shared file tools through the supervised child path. It does
not cover provider-backed campaigns or trajectory workflows. Run it with
`pnpm exec vitest run tests/packed-file-tools.test.ts`;
`CONDUCTOR_SMOKE_NODE` and `CONDUCTOR_SMOKE_PI_ROOT` optionally select the Node
binary and host Pi package root.

The supported runtime is a Node npm installation with an importable, on-disk
Pi SDK. Linux is required for supervised workers. Preflight validates the host
package name, version, export, and file-tool factories before a file-tool or
delegation campaign starts. Repair the Pi installation or `PI_PACKAGE_DIR`
override and restart Pi when preflight fails. Standalone bundled installations
without an importable on-disk SDK fail preflight; Bun is not covered by this
matrix.

The historical extension-relative resolver produced `ERR_MODULE_NOT_FOUND` in
the published npm layout, although the current Pi 0.80.6 and 0.85.1 loaders
also pass with the prior worker implementation. The packed smoke validates
those current installations; the host-root resolver removes dependence on
extension-relative loader resolution.
