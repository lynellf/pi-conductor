---
title: Delegated Child Observability and Lifecycle Recovery
type: concept
status: active
source_files:
  - src/host/display-sink.ts
  - src/host/stats.ts
  - src/host/api.ts
  - src/host/delegation/delegate-tool-factory.ts
  - src/extension/conduct-message-renderer.ts
tags:
  - delegation
  - observability
  - lifecycle
  - tui
  - records
updated_at: 2026-08-06
---
# Summary

Delegated child sessions are host-owned subagent runs spawned by the
`delegate` tool (§4/§6/§7). Since Issue #40, child activity is observable
end-to-end: display events carry explicit child identity, `RunStats`
projects the child lifecycle, and resume recovery of unmatched starts is
emitted through the live record bridge.

# Durable knowledge

- **Child display origin (`ChildDisplayOrigin`):** Display events emitted
  from a delegated child session carry `origin: { child_id, task_id,
  subagent }` (`src/host/display-sink.ts`). `role` on the event remains
  the *parent* role; `origin` is the explicit identity for the child. The
  extension renderer formats the label as `subagent: <name> · <task_id>`
  when `origin` is present (`formatDisplayLabel` in
  `src/extension/conduct-message-renderer.ts`), so concurrent delegated
  tasks are never identified by their parent role. The origin is wired at
  child-session creation via `attachSessionEventHandler({ ..., origin })`
  in `src/host/delegation/delegate-tool-factory.ts` and forwarded through
  the display-sink seam in `src/extension/display-sink-wiring.ts`.

- **Subagent lifecycle projection (`RunStats.subagents`):** Pure projection
  over the record log (`projectSubagentLifecycle`, `src/host/stats.ts`).
  Scans in append order and counts `active` / `completed` / `noChanges` /
  `failed` / `cancelled` per unique started child. Rules: a terminal record
  before its start is an orphan and must not suppress recovery of the later
  start; duplicate starts and terminals reduce to the first lifecycle for
  that child ID; `active = unique started − unique terminal`. `completed`
  vs `noChanges` is decided by the terminal `status` field
  (`"completed"` vs `"no_changes"`); `failed` vs `cancelled` by
  `subagent_failed.status`.

- **Resume recovery of unmatched child starts:** `reconcileLostChildren`
  (`src/host/api.ts`) applies the same orphan/duplicate rules and
  synthesizes exactly one `subagent_failed(status: "cancelled",
  failure_reason: "recovered_child_lost")` per unmatched start — resume
  never relaunches a child (§7). Since Issue #40 the synthesized terminal
  is appended through a host-owned `persistRecord` seam
  (`log.append` + `notifyListeners`), so live record consumers receive it
  exactly once; direct callers of the function retain the in-memory
  log-only default.

- **Delegate tool factory is intentionally cohesive:** the parent-tool
  construction, child-session setup, terminal detection, and
  lifecycle-record emission callbacks live in one module because they share
  the same SDK session and cancellation/cleanup invariants
  (`src/host/delegation/delegate-tool-factory.ts` top-of-file rationale;
  retained just above the ~400 LOC guideline, below the 500 exception
  ceiling per AGENTS.md).

# Evidence

- `src/host/display-sink.ts` — `ChildDisplayOrigin` type and
  `DisplayEvent.origin`.
- `src/host/stats.ts` — `projectSubagentLifecycle` + `SubagentLifecycleStats`.
- `src/host/api.ts` — `reconcileLostChildren` with the `persistRecord` seam.
- `src/extension/conduct-message-renderer.ts` — `formatDisplayLabel`
  producing `subagent: <name> · <task_id>`.
- `src/host/delegation/delegate-tool-factory.ts` — `origin` wiring at
  `attachSessionEventHandler` call site + top-of-file cohesion rationale.
- `src/extension/display-sink-wiring.ts` — `origin` forwarding in
  `createConductDisplaySink`.
- `tests/host/display-forwarding.test.ts` — "preserves delegated child
  identity on assistant and tool display events".
- `tests/extension/conduct-message-renderer.test.ts` — label assertion
  `toContain("subagent: implementer · task-a")`.
- `tests/host/stats.test.ts` — "counts unique started children by their
  first terminal status" (orphan/duplicate semantics).
- `tests/host/resume.test.ts` — cancelled terminal delivered exactly once
  through the emitter.
- `tests/host/delegation.test.ts` — "terminalizes each unmatched child
  start once as recovered_child_lost".
- `docs/record-emitter-spec.md §4.1` — scoping update for the child
  lifecycle + recovery seam.

# Related

- `.okf/components/record-emitter.md` — the fan-out seam used by
  `persistRecord`; §4.1 scoping now includes child lifecycle records.