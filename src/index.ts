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

// Reducer signatures (`reduce`, `reduceLifecycle`, `createInitialCheckpoint`)
// are declared via `declare function` so they have no runtime presence
// here. Their implementations land in Phase 2 (Task 6) and Phase 3
// (Tasks 9–10). Once implemented, this barrel will re-export them so
// consumers can `import { reduce } from "pi-conductor"`.

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
