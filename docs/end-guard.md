# End guard

An optional top-level manifest command verifies the primary checkout before the
orchestrator can complete the run:

```yaml
end_guard:
  command: pnpm test
  timeout_seconds: 60
```

The deadline defaults to 60 seconds and accepts a finite positive number up to
3,600 seconds. The run's manifest snapshot pins both command and deadline. The
host executes trusted repository configuration in the primary checkout with its
environment, using the Linux process supervision described in
[Executable tool controls](execution-controls.md).

The guard runs only after the reducer establishes that a role-issued
orchestrator `end` is legal. It does not run for worker ends or a missing required
end request. Run-cost-cap forced closure bypasses the guard. Omitting `end_guard`
preserves the existing completion behavior.

Exit zero permits completion. A nonzero exit, spawn failure or confirmed timeout
leaves the checkpoint and pending end request intact and sends a bounded
correction to the same role session. Three failed executions exhaust the budget
and stop the invocation resumably. The host does not automatically replay the
command. Cleanup uncertainty stops immediately; operator cancellation follows
the abort path.

In gated completion, the budget belongs to the particular accepted end request.
Model fallback and operator resume retain it; a newly authorized request receives
a new budget even if its physical session file is reused. Without
`end_request_roles`, the budget belongs to the run. An explicit operator resume
resets an exhausted ungated budget through a durable reset record. Successful
guards are never cached: another end attempt runs the command again.

The log records each attempt before spawning and its terminal result before any
accepted end. Results retain at most 4 KiB of combined diagnostic output with an
explicit truncation flag, timing, exit information and cleanup outcome. They do
not retain environment values. Resume refuses an unfinished or uncertain attempt
whose ownership cannot be confirmed; it does not guess from a remembered PID or
start overlapping work.

See the [approved specification](open-issues-september/spec.md) for the complete
execution and restart contract.
