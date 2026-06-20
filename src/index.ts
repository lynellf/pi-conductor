/**
 * pi-conductor public entrypoint.
 *
 * Phase 1 (foundation): re-exports the pure FSM types from `src/core`.
 * Phase 2 adds the pure reducer (`reduce` / `createInitialCheckpoint`) +
 *   cap-aware legal-target helpers.
 * Phase 3 adds: the seam (TypeBox schemas + `validateEmission`),
 *   `reduceLifecycle`, pure cost roll-up + cap predicates (`src/cost`),
 *   the `RecordLog` interface + in-memory impl (`src/persistence`), and
 *   the run-memory builder (`src/core/run-memory.ts`).
 * Host-agnosticism invariant (spec §12): `src/core`, `src/manifest`,
 * `src/seam`, and `src/cost` import nothing from
 * `@earendil-works/pi-coding-agent`; enforced by `tests/grep-guard.test.ts`.
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
  ReduceLifecycleMeta,
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
// Phase 2 (Tasks 6–7, src/core/reduce.ts). `reduceLifecycle` lands in
// Phase 3 (Task 10, src/core/reduce-lifecycle.ts).

export { createInitialCheckpoint, ReduceInvariantError, reduce } from "./core/reduce.js";
export { ReduceLifecycleError, reduceLifecycle } from "./core/reduce-lifecycle.js";

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

// ─── Seam: TypeBox schemas + validateEmission (§3, §11.3) ─────────────
// Phase 3 Task 9. The TypeBox schemas are the single source of truth
// for `handoff`/`end` payload shape — they are reused as `defineTool`
// param schemas in Phase 4 (no second-schema double truth). The
// `HandoffArgs` / `EndArgs` types are the host's typed view of a
// validated payload (for seeding the next session); the reducer never
// sees them (§3/§12: payload is `unknown`).

export type { EndArgs, HandoffArgs } from "./seam/schema.js";
export { endArgsSchema, handoffArgsSchema } from "./seam/schema.js";
export type {
  BreachFailureReason,
  EmissionCapture,
  ValidatedEmission,
} from "./seam/validate-emission.js";
export { validateEmission } from "./seam/validate-emission.js";

// ─── Cost: pure usage roll-up + cap predicates (§11.6, §11.7) ─────────
// Phase 3 Task 11. The host calls these on every `turn_end` (session
// cap) and every terminal usage capture (run cap). Reducer does NOT
// own cost-cap enforcement (§11.7); these are the deterministic
// building blocks.
//
// Rollup is keyed by `run_id` and takes the orchestrator role name
// (the manifest's `is_orchestrator: true` entry) for the §11.6
// orchestrator-overhead isolation. Cache caveat (§11.6): the rollup
// exposes raw `cache_read` / `cache_write` sums; it does NOT
// synthesize a per-run cache hit rate.

export { runCapExceeded, sessionCapExceeded } from "./cost/caps.js";
export type { RunRollup, UsageAggregate } from "./cost/rollup.js";
export { rollup, SYSTEM_DEFAULT_MODEL_KEY } from "./cost/rollup.js";

// ─── Persistence: RecordLog interface + InMemoryRecordLog (§11.1) ──────
// Phase 3 Task 12. The pure core ships the interface and an in-memory
// implementation for unit tests; the Phase 4 host driver owns the
// file-backed implementation (append-only JSONL keyed by run_id; no
// SDK branch scoping, §11.1).
//
// CheckpointSnapshot (§11.1) wraps a full Checkpoint so `latestCheckpoint`
// reads the last snapshot — never replays records. The host's resume
// path (§11.9) reconstructs from this single read.

export type { CheckpointSnapshot, PersistedRecord, RecordLog } from "./persistence/log.js";
export { InMemoryRecordLog } from "./persistence/log.js";

// ─── Run memory artifact (§8.4) ───────────────────────────────────────
// Phase 3 Task 12. The orchestrator's externalized memory: a single
// structured record seeded into every fresh orchestrator session.
// Pure builder; no I/O. The host calls this before each orchestrator
// session starts to compose the seed context.

export type {
  BuildRunMemoryOptions,
  RoleCostEntry,
  RunMemory,
  VisitHistoryEntry,
} from "./core/run-memory.js";
export { buildRunMemory } from "./core/run-memory.js";

// ─── Host (SDK driver) — spec §8, §12, §15.3 ──────────────────────────
// Phase 4 (Tasks 13–16.5). This is the ONLY entrypoint that imports the
// pi SDK (`@earendil-works/pi-coding-agent`). The pure core above is
// host-agnostic; the host programs against it.
//
// Task 13 ships the manifest loader + the `Host` seam. The actual
// SDK-backed `Host` implementation, the file-backed `RecordLog`,
// `startRun` / `resumeRun` / `listRuns` / `RunHandle`, the orchestration
// loop, the post-emission sealing wrapper, the stub provider, and the
// orchestrator run-memory seeding land in subsequent tasks (13.5, 14,
// 15, 15.5, 16, 16.5).
//
// The grep-guard test (`tests/grep-guard.test.ts`) scans source as text
// for the SDK package name in `src/core` + `src/manifest` + `src/seam` +
// `src/cost`; `src/host/` is by exclusion the only allowed home.

// ─── Run lifecycle entry points (Task 13.5, §11.1, §11.9) ───────────
export type {
  applyRunConfigOverride,
  CreateProductionHostInputs,
  DefaultBundle,
  DisplayEvent,
  DisplayEventKind,
  DisplaySink,
  ExtensionContextInputs,
  getDefaultBundle,
  getDefaultConductorYaml,
  getDefaultOrchestratorPrompt,
  getDefaultWorkerPrompt,
  Host,
  HostFactoryContext,
  LoadedManifest,
  ProductionHostOptions,
  ResumeRunOptions,
  RoleSession,
  RunConfigError,
  RunConfigOverride,
  RunContextInputs,
  RunExecutionStatus,
  RunStats,
  runStats,
  SeedRunMemoryArgs,
  SpawnRoleOptions,
  StartRunOptions,
  StubHostOptions,
  TransitionRecord,
} from "./host/index.js";
export {
  buildToolsAllowlist,
  createProductionHost,
  FileRecordLog,
  formatRunMemorySeed,
  HostManifestError,
  listRuns,
  loadManifest,
  loadManifestFromString,
  loadSystemPrompt,
  MalformedModelEntryError,
  ModelNotFoundError,
  NoMoreModelsError,
  ProductionHost,
  RoleEscalationError,
  RunHandle,
  resolveModel,
  resumeRun,
  StubHost,
  SystemPromptNotFoundError,
  selectModelEntry,
  startRun,
} from "./host/index.js";
