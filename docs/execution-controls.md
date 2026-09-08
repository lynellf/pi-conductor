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
policy for the run. A model's explicit bash timeout may shorten that deadline,
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
An explicit operator resume starts a fresh invocation budget while preserving
the workspace and any materialized artifact inventory.

If process ownership or cleanup cannot be confirmed, the invocation stops with
`tool_cleanup_unconfirmed`. Do not assume a timed-out write or edit was rolled
back: inspect the affected workspace before continuing. A file whose mutation
has unconfirmed cleanup remains unavailable to other mutations in that host.

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

See the [approved specification](open-issues-september/spec.md) for the complete
execution and restart contract.
