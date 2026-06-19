/**
 * `PersistedRecord` — the union of every record type the host appends
 * to its `run_id`-keyed log (§11.2–§11.5).
 *
 * Pure type module. The `RecordLog` interface + `InMemoryRecordLog`
 * implementation land in Task 12 (`src/persistence/log.ts` will be
 * expanded; this file holds the shared record-union type so other
 * modules can reference it without a circular import).
 *
 * Every member of the union is `readonly` end-to-end (spec §11):
 * the host's log is append-only and the reducer never mutates
 * inputs.
 *
 * Host-agnostic. No pi imports.
 */

import type {
  ModelFallback,
  SessionLifecycleEvent,
  TransitionAccepted,
  TransitionRejected,
} from "../core/types.js";

export type PersistedRecord =
  | TransitionAccepted
  | TransitionRejected
  | SessionLifecycleEvent
  | ModelFallback;
