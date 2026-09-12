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

Read-only `read`, `ls`, and `find` workers use the same fail-closed cleanup
barrier as mutating tools. Concurrent worker exit can make process observation
fail; the host makes one permission-only retry after 5 ms, with the retry
bounded by the cleanup operation rather than promising a wall-clock duration.
Preserve the detailed OS error and actual observation when available;
persistent failure remains unconfirmed unless a call-scoped pre-spawn PID/start
snapshot, or a freshly verified pre-existing session, proves the inaccessible
process is unrelated. Genuinely unresolved or owned candidates remain
unconfirmed. The snapshot exists only for the live invocation; restart has no
original snapshot and remains conservative. An `observation_error` may include the
actual operation, errno, and optional target PID, observed start ticks, and
process group. Namespace failures may have no PID. An empty
`observed_members` list is not cleanup confirmation, and a finished execution
record with `cleanup_unconfirmed` does not clear the cleanup barrier.
After a failed child has settled, preserve its usage and expose the unresolved
cleanup state so sibling cancellation and new admission cannot silently bypass
the barrier.

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

The spinner renders every 250 ms using the latest status snapshot. Durable
stats refreshes use one validated log snapshot, then wait at least 250 ms or
nine times their measured duration before refreshing again (#104). Expensive
refreshes therefore leave time for process observation instead of repeatedly
occupying the event loop. Transition/counter updates can lag by that cooldown;
elapsed-tool time continues updating between snapshots.

Admission capture consumes the original tool deadline. Once capture returns,
the controller arms cancellation for only the remaining budget; expired
admission cannot launch an operation. Capture itself remains a read-only
observation that must settle before operation admission. Timers and cleanup
observations still depend on host scheduling, so the deadline is not a promise
that terminal recording finishes at that exact wall-clock instant.

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
New executable-tool start records retain identity-only admission evidence for
later `reconcile-tools` inspection (issue #103). Before launching the tool, the
host saves a conservative start-tick boundary from a completed process snapshot,
bound to the original boot, PID namespace and its init process, observer time
namespace, and network namespace. Recovery validates that origin before using
the evidence; it never substitutes a snapshot taken at recovery time.

After an environment permission denial, a freshly stable process whose own
start ticks are strictly older than the saved boundary is proven unrelated and
does not block reconciliation. A readable positive ownership marker always wins.
Equal/newer ticks and uncertain identities still fail closed; the age of a
session leader alone does not grant the durable exemption. Live supervision
retains its separate exact pre-spawn snapshot checks.

Legacy records without admission evidence retain conservative observation.
Restarting Pi does not retrofit evidence into those logs. Corrupt evidence or a
different boot/PID/time/network namespace refuses inspection with repair
guidance. Do not edit old records to manufacture a boundary. Use intact
canonical storage and the original observation context. A permission denial is
not evidence that a process exited.

Observation failures report `operation`, `code`, and the observed `pid`,
`start_time` (ticks since boot), and `process_group_id` when available. They
identify the failed `/proc` path and provide `ps`/`ls` commands restricted to
metadata. These diagnostics omit command lines, environment contents, owner
markers, raw errors, and stack traces. Runtime failures do not print syntax
usage; use `conduct reconcile-tools --help` for argument help.

For `read_environ code=EACCES`, the scanner could not read a process's
environment to check its marker. The PID may be unrelated to the run; its
ownership is unverified. Inspect the suggested metadata, then check the
observing account and procfs/process inspection restrictions with the original
host's administrator when no saved admission evidence proves it unrelated.
Restore the required visibility without weakening host
security settings or dumping environment contents. Repeat the inspection
form `conduct reconcile-tools --log-dir <path> <run-id>`, omitting `--execution`,
`--confirm-cleanup`, and `--note`. Only after inspection succeeds and all
original processes and partial effects have been checked should an operator
confirm an execution. A missing PID or a successful `ps`/`ls` alone does not
establish cleanup. See the [Linux procfs reference](https://www.kernel.org/doc/html/latest/filesystems/proc.html#process-specific-subdirectories)
for process metadata and access constraints.

### Services activated after tool admission (#105)

A foreground command can contact a socket or service manager and cause a
service to start outside its process group. The service may not inherit the
execution marker. Its PPID, cgroup, and a matching systemd `MainPID` describe
current association; they do not prove that its lifecycle or effects are
independent of the command. The host does not exempt processes by service or
executable name.

For a denied environment read, compare the diagnostic `start_time` with the
correlated `tool_execution_started.admission.preexisting_before`. Equal or
newer start ticks cannot use the durable pre-existing-process exemption.
Inspect the process metadata and service activation evidence on the original
host, along with the command's partial effects. A successful foreground exit or
written setup receipt does not establish descendant cleanup. Keep receipts and
workspace changes; do not repeat setup automatically.

When this evidence cannot resolve ownership, the invocation remains
`tool_cleanup_unconfirmed`. Automatic continuation for manager-launched
services is unsupported by the current ownership contract. Run the read-only
`reconcile-tools` inspection before considering confirmation; current service
association, process age measured at recovery time, and a vanished PID cannot
replace original admission evidence or bypass a failed scan. The existing
operator attestation still requires every original process and partial effect
to be checked. Do not stop a shared authentication service or weaken host
security settings to suppress the diagnostic.

### Headless terminal status (#105)

The CLI uses the orchestration loop's settled result for both `exit_reason`
and `run_stats.exitReason`, even when checkpoint or context records follow a
session failure. Terminal `session_failed`, including
`tool_cleanup_unconfirmed`, exits 1 so a shell or service manager sees failure.
Successful `done` exits 0. An explicit application abort retains exit 0;
the first SIGINT/SIGTERM requests that graceful abort. A second signal forces
exit 130 (SIGINT) or 143 (SIGTERM). A live
recovery is not made terminal merely because a previous session failed.

Do not trust a historical PID by itself: correlate the run ID, execution ID,
tool-call ID and tool name, then verify the current process start ticks, process
group and ownership in the original host namespace. Stop only processes that
are currently verified as belonging to that execution, including verified
descendants. Never blind-kill a reused PID, kill the whole conductor, elevate
privileges merely to suppress an observation error, or hide a failed check.
If a read-only `/proc` or namespace observation is denied, perform the same
actionable observation from the original host with sufficient visibility and
leave reconciliation unconfirmed until it succeeds.

Wait for the active run lease to end through its normal completion or abort
boundary before reconciling; do not force-delete the lease or claim cleanup to
make resume available. Inspect the correlated execution and child state, then
use `reconcile-tools` with an explicit operator attestation from the original
host and namespaces. If a write or edit remains uncertain, restart pi after
confirmed cleanup before resuming. A permanent permission failure remains
closed until observations are possible.

Reconciliation refuses a log with an incomplete trailing record and leaves its
bytes untouched; repair that persistence issue separately.

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
