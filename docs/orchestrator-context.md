# Retained orchestrator context

An orchestrator can retain its own conversation across role invocations within
one run. Enable it explicitly on the designated orchestrator:

```yaml
roles:
  - name: orchestrator
    is_orchestrator: true
    context_retention: run
    system_prompt: orchestrator.md
  - name: worker
    system_prompt: worker.md
```

The default is `none`. Each invocation still receives current run memory. With
`run`, it also receives the orchestrator's earlier messages and settled tool
results. Worker conversations and other runs are not imported. Old tool calls
are conversation history; restoring them does not execute them again.

Each attempt has a new logical role-session identity. The current model, thinking
level, system prompt and tool permissions apply to that attempt, including model
fallback. History does not restore old permissions or reset child allowances.

## Compaction and cost

The run pins Pi's effective compaction settings before its first retained
invocation. Resume and context reset preserve those settings without changing
your Pi settings files. Compaction uses the active model and records new summary
request usage, including failed requests. Restored historical usage is not
charged again.

Context admission includes the incoming seed. Disabled compaction, failed
compaction, and history that remains too large produce an actionable error.
Compaction cannot guarantee that an arbitrarily large seed will fit.

Run statistics expose context status, epoch, conversation/file references and
compaction outcomes. The extension status line shows the context status without
printing conversation contents. Session files remain available for deliberate
inspection; retention and reset do not delete them.

A compaction request that started before a crash but has no durable outcome has
unknown cost. That uncertainty remains visible and blocks further budgeted
execution. Resetting history does not turn an unknown charge into zero.

## Resume and reset

Resume selects the exact committed conversation file and history tip. It verifies
the recorded integrity hash and complete tool exchanges before prompting. It does
not search for a newer session file when the expected history is missing.

To discard retained history for an idle run:

```text
/conduct:resume --reset-orchestrator-context <run_id>
```

Library callers pass `resetOrchestratorContext: true` to `resumeRun`. Reset starts
a new empty context epoch; current run memory remains available. FSM progress,
visits, accepted work, incurred costs and delegation allowances are preserved.
If a worker is current, the reset affects the next orchestrator invocation.

The run lease prevents reset during active execution. Cleanup checks still apply
after a crash: reset cannot certify an unfinished tool or process as settled.
It can replace missing or corrupt conversation history when the durable run log
and pinned context policy remain valid.

When the SDK recovers from a provider error during tool-call generation, the
failed assistant response remains in the original session file for auditing and
cost accounting. A superseding assistant response with no intervening user or
tool result allows that unexecuted failed response to be omitted from effective
retained context. Durable execution or delegation-admission evidence prevents
this omission. Exhausted retries and unresolved executed calls still fail the
boundary check; restoration never executes or fabricates tool results.

If boundary capture, session disposal, or boundary commit fails after a handoff,
the accepted transition remains saved and the receiver does not start. A durable
`run_finalization_failed` record identifies the phase, code, bounded diagnostic,
role session, and recovery path. Status and run listings report the failure.
Capture and commit failures require explicit `--reset-orchestrator-context`
before resuming from the accepted checkpoint. A disposal failure blocks resume,
including context reset: inspect and stop remaining resources on the original
host before starting a fresh run. Reset cannot prove that disposal completed.

## Supported combinations

Both shared SDK sessions and isolated RPC sessions support retention. Local
source checkouts need `pnpm build` before using the compiled RPC child bootstrap.

Only the designated orchestrator may declare `context_retention`, including
`none`. A manifest with retention enabled cannot use trajectory handoffs.
Prewalk has been rolled back for all roles due to Pi extension-loading
compatibility (issue #94).
Existing runs whose
pinned manifests omit retention continue with `none`; current YAML cannot enable
retention retroactively for a historical run without a manifest snapshot.

See the [approved contract](orchestrator-context/spec.md) and
[lifecycle decisions](orchestrator-context/lifecycle-design.md) for persistence
and recovery details.
