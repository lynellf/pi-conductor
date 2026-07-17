# Record Emitter Contract

> **Authority:** This document is the single source of truth for the
> `subscribeToRecords` contract. The source file
> (`src/host/record-emitter.ts`) is the implementation; this spec is
> the contract surface. The test file (`tests/host/record-emitter.test.ts`)
> exercises every clause herein.

## §1 — Purpose

The record emitter provides in-process, best-effort fan-out of every
`PersistedRecord` the host driver appends to a run log. It is a
read-side extension point for consumer extensions that need to observe
run records as they are produced (e.g. telemetry, analytics, logging,
or TUI bridges).

The durable JSONL log (one file per run) remains the system of record;
the emitter is an in-process convenience layer that avoids polling.

### File-mutation telemetry (issue #22)

Successful `write` and `edit` calls append a `file_mutation` record through
`Host.persistRecord`. Subscribers receive it after the JSONL append, just as
with every other persisted record. The record includes `run_id`, `ts`, `role`,
`session_id`, `session_file`, `tool_name`, and `files`; each file carries its
path, char-count additions/deletions, and optional structured hunks. Failed
calls and calls without valid file metadata do not emit this record.

## §2 — Module-level design

- **Process-global registry.** One `Set<Listener>` for the entire pi
  process. A consumer extension subscribes once (at extension load) and
  receives records from all hosts in the process. If per-host isolation
  is needed in the future, it is an additive change.
- **Thread-safety.** Node.js is single-threaded; the `Set` is safe to
  read and mutate from the same event-loop turn. Listeners are
  fire-and-forget (§4.3) — the host does not `await` async listeners,
  so there is no concurrent mutation risk from interleaved promises.
- **Zero I/O, zero pi imports.** The emitter is pure in-process fan-out.
  It lives in `src/host/` (which the grep-guard allows to import pi,
  but this module does not need to).

## §3 — Public API

### `subscribeToRecords(listener: Listener): () => void`

Subscribe to every record the host driver persists to a run log.

- **Parameters:** `listener` — a callback invoked for every persisted record.
- **Returns:** An idempotent unsubscribe handle (a function). Calling the
  handle a second time is a no-op.
- **Fire-and-forget:** The host calls `listener(record)` and moves on;
  async listeners are NOT awaited.
- **Consumer responsibility:** The consumer owns its own auth, retry,
  batching, and watermark state. The emitter does not provide any of these.

### `type Listener = (record: PersistedRecord) => void | Promise<void>`

A callback that receives every `PersistedRecord` the host persists.

May be sync or async. The host fires listeners fire-and-forget — async
rejections are caught and suppressed (§4.4).

## §4 — Contract

### §4.1 Scoping

The emitter covers loop-time `host.persistRecord` calls only — both
`ProductionHost.persistRecord` and `StubHost.persistRecord` call
`notifyListeners` after `log.append`.

Direct `log.append` calls that bypass `persistRecord` are **outside**
the emitter's scope:

- The initial checkpoint snapshot in `startRun` (`src/host/api.ts`).
- Crash reconciliation records (`session_failed("crashed")` and the
  snapshot that follows).
- The crash snapshot that follows reconciliation.

The durable JSONL log is the system of record; the emitter is
best-effort fan-out.

### §4.2 FIFO delivery

Listeners fire in subscription order. The `Set` data structure preserves
insertion order per ES2015; `notifyListeners` iterates a snapshot of
the set in iteration order.

### §4.3 Fire-and-forget async

Async listeners are NOT awaited. The host calls `listener(record)` and
continues immediately. Async rejections are caught via `.catch()` for
suppression (§4.4) but the host never awaits the returned promise.

### §4.4 Sync-throw / async-rejection isolation

- **Sync throws:** A `try/catch` wraps each listener call. A thrown error
  is silently suppressed; it does not affect the engine or other listeners.
- **Async rejections:** When the return value is a thenable (has a `.catch`
  method), a `.catch()` handler is attached to suppress rejections. A
  rejected promise does not propagate to the host or crash the loop.

Neither a sync throw nor an async rejection prevents any other listener
from receiving the current record or future records.

### §4.5 Re-entrant subscribe / unsubscribe

`notifyListeners` snapshots the listener set before iterating. This means:

- **Re-entrant subscribe:** A listener that calls `subscribeToRecords`
  inside its handler registers the new listener for the NEXT record, not
  the current one. The current record's dispatch is unaffected.
- **Re-entrant unsubscribe:** A listener that calls another listener's
  unsubscribe handle removes that listener from the registry for the
  NEXT record, not the current one. The current record's snapshot
  already includes the sibling, so the sibling still fires for the
  current record.

### §4.6 Idempotent unsubscribe

The unsubscribe handle returned by `subscribeToRecords` closes over a
`called` boolean flag:

- The first call removes the listener from the registry.
- Subsequent calls are no-ops (the guard returns immediately).
- Calling the handle after the listener already self-unsubscribed via
  re-entrant unsubscribe is a no-op (the flag ensures the guard is
  hit before attempting `listeners.delete`).

### §4.7 Empty-set fast path

`notifyListeners` checks `listeners.size === 0` and returns immediately
when the set is empty. This provides a no-op fast path for host
implementations that never have subscribers.

## §5 — Durable backstop

The system of record is the `RecordLog` (per-run JSONL file). The
emitter is best-effort: missed records (e.g. the consumer process
crashed) are recoverable by walking the log directory.

Consumer extensions own their watermark state; this spec makes no
commitment on cross-process de-duplication.

## §6 — Out of scope

The following are explicitly **not** part of this contract:

- Upload code, network primitives, or server configuration.
- Authentication, authorization, or API key management.
- Retry, backoff, batching, or rate-limiting.
- Cross-process coordination or distributed locks.
- New record types or changes to the orchestrator loop.
- Changes to the reducer, FSM, or checkpoint contract.

## §7 — Authoritative test cases

The test file `tests/host/record-emitter.test.ts` exercises all nine
cases defined by the contract. Each case maps to one or more §4
clauses:

| # | Case | Contract clause(s) |
|---|------|-------------------|
| 1 | Listener fires on every `persistRecord` call | §4.1 (scoping) |
| 2 | Multiple listeners fire in subscription order (FIFO) | §4.2 |
| 3 | Sync throw in one listener is isolated | §4.4 |
| 4 | Async rejection in one listener is isolated | §4.4 |
| 5 | Re-entrant subscribe fires on the NEXT record | §4.5 |
| 6 | Re-entrant unsubscribe takes effect on the NEXT record | §4.5 |
| 7 | Unsubscribe is idempotent | §4.6 |
| 8 | No listeners registered is a no-op | §4.7 |
| 9 | Consumer-side `run_id` filter is correct | §4.1 (scoping, consumer responsibility) |

These nine cases are the authoritative test surface. A tenth case would
be a new enhancement and requires an update to this mapping.
