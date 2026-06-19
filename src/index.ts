/**
 * pi-conductor public entrypoint.
 *
 * Phase 1 (foundation): re-exports the pure FSM types from `src/core`.
 * Host-agnosticism invariant (spec §12): `src/core` and `src/manifest`
 * import nothing from `@earendil-works/pi-coding-agent`; enforced by
 * `tests/grep-guard.test.ts`.
 */

export const PACKAGE_NAME = "pi-conductor";

// ─── Pure FSM types (spec §5, §7, §11, §12) ────────────────────────────
// Type-only re-exports. `verbatimModuleSyntax` keeps these out of the
// runtime JS bundle while giving consumers a single import surface.

export type {
  ActiveRoleSession,
  Checkpoint,
  Effect,
  LegalTargets,
  MachineDefinition,
  MachineEvent,
  ModelFallback,
  PayloadSummary,
  RejectReason,
  Role,
  SessionLifecycleEvent,
  State,
  TransitionAccepted,
  TransitionRejected,
  TransitionResult,
  UsageRecord,
} from "./core/types.js";

// Reducer signatures are declared via `declare function` so they have
// no runtime presence here. Their implementations land in Phase 2
// (Task 6) and Phase 3 (Tasks 9–10). Re-exported so consumers can
// `import { reduce } from "pi-conductor"`; calling before Phase 2 is a
// runtime no-op failure (the declaration has no body).
export { createInitialCheckpoint, reduce, reduceLifecycle } from "./core/types.js";
