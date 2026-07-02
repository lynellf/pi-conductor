/**
 * Record emitter — in-process fan-out of every `PersistedRecord` the
 * host persists to its run log.
 *
 * The full contract is documented in `docs/record-emitter-spec.md`.
 * This module is the implementation; the spec is the authority.
 *
 * ## Quick summary
 *
 * - **Scoping** (`docs/record-emitter-spec.md §4.1`): covers loop-time
 *   `host.persistRecord` only; direct `log.append` calls bypass.
 * - **Process-global registry.** One `Set<Listener>` for the entire
 *   pi process. A consumer extension subscribes once.
 * - **Thread-safety.** Node.js is single-threaded; the `Set` is safe
 *   to read and mutate from the same event-loop turn.
 * - **Zero I/O, zero pi imports.** Pure in-process fan-out.
 */

import type { PersistedRecord } from "../persistence/log.js";

/**
 * A listener callback for `subscribeToRecords`.
 *
 * May be sync or async.  The host fires listeners fire-and-forget —
 * async listeners are NOT awaited (`docs/record-emitter-spec.md §4.3`).
 */
export type Listener = (record: PersistedRecord) => void | Promise<void>;

/**
 * Module-level listener registry.
 *
 * `Set` preserves insertion order per the ES2015 spec, giving FIFO
 * delivery (`docs/record-emitter-spec.md §4.2`).  Re-entrant mutations (subscribe / unsubscribe
 * inside a listener) are handled by snapshotting the set before
 * iteration (`docs/record-emitter-spec.md §4.5`).
 */
const listeners = new Set<Listener>();

/**
 * Subscribe to every record the host driver persists to a run log.
 *
 * Listeners fire in subscription order (FIFO).  Each listener is
 * invoked exactly once per record the host persists.  Listener
 * errors are isolated: a sync throw or async rejection in one
 * listener does not affect the engine or other listeners (`docs/record-emitter-spec.md §4.4`).
 *
 * Returns an unsubscribe handle.  Calling the handle a second time
 * is a no-op.  The listener is removed from the registry on the
 * first call; subsequent calls return without effect.
 *
 * Listeners may be sync or async.  The host fires listeners
 * fire-and-forget — async listeners are NOT awaited (`docs/record-emitter-spec.md §4.3`).
 *
 * Re-entrant subscribe / unsubscribe from inside a listener is
 * permitted: subscriptions made inside a listener fire on the
 * NEXT record, not the current one; unsubscribes made inside a
 * listener take effect on the next record.  The current record's
 * dispatch is unaffected (`docs/record-emitter-spec.md §4.5`).
 *
 * @param listener  Callback invoked for every persisted record.
 * @returns         An idempotent unsubscribe function.
 */
export function subscribeToRecords(listener: Listener): () => void {
  listeners.add(listener);
  let called = false;
  return () => {
    if (called) return;
    called = true;
    listeners.delete(listener);
  };
}

/**
 * Fan out a record to all registered listeners.
 *
 * Takes a snapshot of the listener set before iterating so
 * re-entrant mutations (subscribe / unsubscribe inside a listener)
 * don't affect the current dispatch (`docs/record-emitter-spec.md §4.5`).  New subscriptions fire
 * on the next record; unsubscribes take effect on the next record.
 *
 * Sync throws are caught; async rejections are caught via `.catch()`.
 * Neither affects the engine or other listeners (`docs/record-emitter-spec.md §4.4`).
 *
 * Fast-path: no-op when the set is empty.
 *
 * Fire-and-forget: async listeners are NOT awaited (`docs/record-emitter-spec.md §4.3`).
 *
 * This is exported as an internal seam for the host implementations
 * (`ProductionHost.persistRecord`, `StubHost.persistRecord`).  It
 * is NOT re-exported from the public barrel — it's host-internal.
 */
export function notifyListeners(record: PersistedRecord): void {
  if (listeners.size === 0) return;
  // Snapshot to handle re-entrant mutations (§4.5).
  const snapshot = [...listeners];
  for (const listener of snapshot) {
    try {
      const result = listener(record);
      // Attach a .catch for async rejections — fire-and-forget
      // means we don't await, but we do suppress rejections (§4.4).
      if (
        result !== undefined &&
        typeof result === "object" &&
        typeof (result as Promise<void>).catch === "function"
      ) {
        (result as Promise<void>).catch(() => {
          // Silently suppress — error isolation §4.4.
          // Future: wire structured logging here (out of scope
          // under this spec; the host's observability seam is a
          // separate concern).
        });
      }
    } catch {
      // Silently suppress sync throws — error isolation §4.4.
    }
  }
}
