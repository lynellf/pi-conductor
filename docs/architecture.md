# Architecture in brief

← [Back to README](../README.md#architecture-in-brief)

## Contents

- [Architecture in brief](#architecture-in-brief)

```
checkpoint + event + def (pinned manifest snapshot)
            │
            ▼
        reduce()  ── pure, deterministic, host-agnostic (src/core)
            │
            ▼
   transition record + new checkpoint
            │
            ▼
   host persists record + snapshot, spawns next role (src/host)
            │
            ▼
   ┌────────┴────────┐
   ▼                 ▼
   bin/conduct    extensions/conduct.ts
   (CLI)          (pi extension /commands)
```

- **`def: MachineDefinition`** is the pinned manifest snapshot. `reduce` /
  `reduceLifecycle` are pure functions of `(checkpoint,
  event, def, meta)` —
  no ambient config, no I/O. `meta.role ===
  checkpoint.current_role` is
  asserted inside `reduce`; a mismatch is thrown, not trusted.
- **Every state change goes through `reduce`.** Cost-cap forced-close
  synthesizes a machine `end` event fed to `reduce`; the checkpoint is never
  mutated to `done` directly.
- **Checkpoint is snapshot-appended, never mutated in place.** Resume reads the
  latest snapshot from the host-owned `run_id`-keyed log. SDK branch scoping is
  not used.
- **`handoff`/`end` tools only validate + record intent** into a capture buffer
  and return a terminating message; they do **not** call `reduce` and do **not**
  persist. The loop owns `reduce` + persistence + spawning.
- **Post-emission sealing:** once a role's first valid `handoff`/`end` capture
  is recorded, the session is sealed — wrapped tools refuse to execute, so
  work-after-handoff cannot mutate the workspace.

The full authority is
[`docs/archive/orchestrator-fsm-spec.md`](archive/orchestrator-fsm-spec.md).
