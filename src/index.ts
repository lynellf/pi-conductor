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

// ─── Cap-aware legal-target helpers (§7.2 / §7.4) ─────────────────────
// Phase 2 Task 5. Pure; used by the reducer for `legal_targets` on a
// `transition_rejected` record (§11.3) and by anything else that wants
// to surface the topology / cap state.

export { availableTargets, declaredTargets } from "./core/targets.js";

// Reducer signatures: `reduce` + `createInitialCheckpoint` are implemented in
// Phase 2 (Tasks 6–7, src/core/reduce.ts). `reduceLifecycle` remains a
// `declare function` until Phase 3 (Tasks 9–10).

export { createInitialCheckpoint, ReduceInvariantError, reduce } from "./core/reduce.js";

// ─── Manifest types + parser (spec §8) ────────────────────────────────
// Type-only re-exports for the on-disk shape; runtime values for the
// parser + the typed error so consumers can `import { parseManifest }`
// and `catch (e) { if (e instanceof ManifestParseError) ... }`.

export { parseManifest } from "./manifest/parse.js";
export type { Manifest, RoleConfig } from "./manifest/types.js";
export { ManifestParseError } from "./manifest/types.js";

// ─── Manifest validation + derivation (§13, §12) ──────────────────────
// validateManifest surfaces hard errors vs soft warnings; toMachineDefinition
// throws on hard errors and produces the frozen MachineDefinition snapshot
// the reducer (Phase 2) consumes as `def`.

export { toMachineDefinition } from "./manifest/definition.js";
export type {
  ManifestError,
  ManifestErrorCode,
  ManifestReport,
  ManifestWarning,
  ManifestWarningCode,
} from "./manifest/validate.js";
export { validateManifest } from "./manifest/validate.js";
