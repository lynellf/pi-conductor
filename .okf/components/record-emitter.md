---
title: Record Emitter
type: component
status: active
source_files:
  - src/host/record-emitter.ts
  - src/host/api.ts
tags:
  - telemetry
  - records
  - streaming
  - contracts
updated_at: 2026-07-01
---
# Summary

In-process fan-out of every `PersistedRecord` the host persists to a
run log. Process-global registry with FIFO delivery, fire-and-forget
async, and error isolation. The comprehensive contract lives in
`docs/record-emitter-spec.md`; this doc captures only the durable
cross-cutting architectural facts.

# Durable knowledge

- **System of record vs best-effort fan-out:** The durable JSONL log
  (per-run file, appended by `RecordLog.append`) is the system of
  record. The emitter is an in-process convenience layer for consumer
  extensions (telemetry, analytics, TUI bridges). Missed records are
  recoverable by walking the log directory — the emitter makes no
  delivery guarantee.
- **Scoping:** The emitter covers `host.persistRecord` calls only.
  Direct `log.append` calls (initial checkpoint snapshot in `startRun`,
  crash reconciliation records, recovery snapshots) bypass the emitter.
  Documented in `docs/record-emitter-spec.md §4.1`.
- **Process-global, not per-host:** One `Set<Listener>` for the entire
  pi process. A consumer extension subscribes once at load time and
  receives records from all hosts. Per-host isolation would be an
  additive change.
- **Thread-safe for Node.js single-threaded model:** Listeners are
  fire-and-forget — the host does not await async listeners, so there
  is no concurrent mutation risk from interleaved promises.
- **Zero I/O, zero pi imports:** The emitter is pure in-process fan-out.
  Even though `src/host/` is allowed to import pi, this component does
  not need to.
- **Error isolation:** Sync throws are caught by `try/catch`; async
  rejections are suppressed via `.catch()`. Neither affects the engine
  or other listeners (§4.4).
- **Re-entrant subscribe/unsubscribe:** `notifyListeners` snapshots
  the listener set before iterating. Subscriptions made inside a
  listener fire on the NEXT record; unsubscribes take effect on the
  NEXT record (§4.5).

# Evidence

- `docs/record-emitter-spec.md` — full spec contract (§1–§7).
- `src/host/record-emitter.ts` — implementation (~130 LOC including JSDoc).
- `tests/host/record-emitter.test.ts` — 9 test cases pinning every
  contract clause.
- `docs/archive/issues-5-and-6/phase-1-record-emitter-spec.md` — task
  list and verification for the spec consolidation.

# Related

- `.okf/concepts/manifest-validation-boundary.md` — another example of
  a clearly bounded contract surface in this repo.