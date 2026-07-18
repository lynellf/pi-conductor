/**
 * pi-conductor host (SDK driver) — public surface.
 *
 * Phase 4 (Tasks 13–16.5). This is the ONLY module in the repo that
 * imports `@earendil-works/pi-coding-agent` (spec §12, plan invariant 1).
 *
 * What ships in Task 13:
 *   - `loadManifest` / `loadManifestFromString` — disk-backed manifest
 *     loader that returns a pinned `MachineDefinition` plus soft warnings.
 *   - `HostManifestError` — typed error for hard validation failures
 *     (carries structured `ManifestError` codes, not just a message).
 *   - `Host` interface + `RoleSession` + `SpawnRoleOptions` +
 *     `SeedRunMemoryArgs` — the seam the orchestration loop programs
 *     against (Tasks 14/15/15.5/16/16.5 implement it).
 *
 * What does NOT ship yet (subsequent tasks):
 *   - The SDK-backed `Host` implementation (`spawnRole` against
 *     `createAgentSession`, Task 14/15).
 *   - The file-backed `RecordLog` (Task 13.5).
 *   - The `startRun` / `resumeRun` / `listRuns` / `RunHandle` API
 *     (Task 13.5).
 *   - The orchestration loop itself (Task 15).
 *   - Post-emission sealing wrapper (Task 15.5).
 *   - The stub provider for in-CI E2E (Task 16).
 *
 * The grep-guard test in `tests/grep-guard.test.ts` does NOT scan
 * `src/host/` — this is the only directory allowed to import the
 * pi SDK, and the guard's GUARDED_DIRS list (`src/core`,
 * `src/manifest`, `src/seam`, `src/cost`) intentionally excludes it.
 */

export type {
  Host,
  RoleSession,
  SeedRunMemoryArgs,
  SpawnRoleOptions,
} from "./host.js";

export type { LoadedManifest } from "./manifest.js";
export { HostManifestError, loadManifest, loadManifestFromString } from "./manifest.js";

// ─── Per-session seam state (Task 14) ──────────────────────────────
// Mutable host state per role session: the machine-event capture
// buffer + the post-emission sealed flag. The handoff/end tool
// factories (Task 14) write to it; the loop reads from it after
// prompt() resolves; the post-emission tool wrapper (Task 15.5)
// reads the sealed flag.

export { SessionSeam } from "./seam.js";

// ─── Display tap (Phase 2) ────────────────────────────────────────────
// Display-only events from role sessions. The host emits them and the
// extension maps them to custom messages for the TUI.

export type { DisplayEvent, DisplayEventKind, DisplaySink } from "./display-sink.js";

// ─── handoff / end emission tools (Task 14) ────────────────────────
// defineTool() entries registered via customTools. The factory takes
// a SessionSeam and closes over it; the loop does not see these
// tools directly — only their effect on the seam.

// ─── bounded predecessor context (issue #14) ────────────────────────
export type { HandoffContextToolDetails } from "./handoff-context-tool.js";
export { createHandoffContextTool, handoffContextArgsSchema } from "./handoff-context-tool.js";
export type { HandoffContractContext } from "./handoff-contract.js";
export type { EmissionToolDetails } from "./tools.js";
export { createEndTool, createHandoffTool } from "./tools.js";

// ─── ask_user tool (Phase 3) ──────────────────────────────────────────
// Normal, non-terminating tool that asks the user for clarification.

export { askUserArgsSchema, createAskUserTool } from "./ask-user-tool.js";

// ─── Orchestration loop (Task 15) ─────────────────────────────────────
// The synchronous loop over role sessions. Owns `reduce` /
// `reduceLifecycle` / persistence; programs against the `Host` seam
// (Task 13). Tested against a fake host + scripted session factory
// here; Task 16 promotes that into a reusable stub provider for E2E.

export type { RunLoopOptions, RunLoopResult } from "./loop.js";
export { runLoop } from "./loop.js";

// ─── Post-emission tool sealing (Task 15.5, §12.1) ────────────────────
// Wraps every side-effecting tool so that, while the session is
// sealed (i.e., a valid handoff/end capture has been recorded), the
// tool short-circuits to an error result without invoking the
// underlying execute. Prevents work-after-handoff from mutating the
// workspace after the role has declared its exit intent.

export type { SealCheck } from "./tool-wrapper.js";
export { wrapAllToolsWithSeal, wrapToolWithSeal } from "./tool-wrapper.js";

// ─── Stub provider (Task 16, §15.3) ────────────────────────────────────
// Deterministic StreamFunction + Model that drives a real
// createAgentSession without a network or API key. The Phase 4–5
// E2E tests register this on an in-memory ModelRegistry and feed
// scripted steps (handoff, end, no_emission, fail) to drive the
// loop end-to-end in CI.

export type { StubStep, StubStreamOptions, StubToolCall } from "./stub-provider.js";
export { makeStubModel, makeStubStreamFunction } from "./stub-provider.js";

// ─── StubHost (Task 13.5 / Task 16) ───────────────────────────────────
// Minimal real `Host` that wires `createAgentSession` to the stub
// provider. Used by the Phase 4 E2E tests (and the resume tests).

export type { StubHostOptions } from "./stub-host.js";
export { StubHost } from "./stub-host.js";

// ─── File-backed RecordLog (Task 13.5, §11.1) ────────────────────────
// JSONL-per-run log; one file per run_id. Phase 4 test surface
// uses sync writes; production's persistent log (Phase 5) can
// swap to an async tail or external store transparently.

export type { FileRecordLogOptions } from "./log-file.js";
export { FileRecordLog } from "./log-file.js";

// ─── RunHandle (Task 13.5, §11.9) ────────────────────────────────────
// Runtime handle for a run. Returned by startRun / resumeRun;
// exposes completion(), abort(), runStats(), runConfig(),
// buildRunMemory().

export { applyRunConfigOverride, RunConfigError } from "./config.js";
export {
  type DefaultBundle,
  getDefaultBundle,
  getDefaultConductorYaml,
  getDefaultOrchestratorPrompt,
  getDefaultWorkerPrompt,
} from "./defaults.js";
export type {
  ActiveSessionStats,
  ConfigOverrideContainer,
  RunConfigOverride,
  RunExecutionStatus,
  RunStats,
  TransitionRecord,
} from "./run-handle.js";
export { RunHandle } from "./run-handle.js";
export { runStats } from "./stats.js";

// ─── Run lifecycle entry points (Task 13.5, §11.1, §11.9) ───────────
// startRun / resumeRun / listRuns — the canonical CLI / TUI
// surfaces for orchestrating a run end-to-end.

export type {
  HostFactoryContext,
  ResumeRunOptions,
  StartRunOptions,
} from "./api.js";
export { listRuns, resumeRun, startRun } from "./api.js";

// ─── Orchestrator run-memory seed (Task 16.5, §8.4) ─────────────────
// formatRunMemorySeed — formats the Phase 3 buildRunMemory
// artifact as a structured prompt for the next orchestrator session.
// Single-writer rule (§8.4): only orchestrator sessions receive
// the artifact; worker sessions get the handoff payload instead.

export { formatRunMemorySeed } from "./run-memory.js";

// ─── Boundary errors (Phase 7A.1, §8.1) ──────────────────────────────
// Three typed errors used by `ProductionHost` for the §8.1 model
// resolution + prompt loading failure modes. Re-exported here so
// callers and tests can `import { ModelNotFoundError, … }` from
// the host barrel.

export {
  AskUserUnavailableError,
  MalformedModelEntryError,
  ModelNotFoundError,
  NoMoreModelsError,
  RoleEscalationError,
  SystemPromptNotFoundError,
} from "./errors.js";

// ─── ProductionHost (Phase 7A.1+, §8.1) ──────────────────────────────
// Production `Host` implementation: resolves `role.models[]`
// (`provider:id`) against a real `ModelRegistry`, loads
// `role.system_prompt` from disk, wires a real
// `DefaultResourceLoader` per role session. The 7A.1 deliverable
// is the scaffold + boundary errors; 7A.2–7A.4 fill in the wiring.

export type { ProductionHostOptions } from "./production-host.js";
export { ProductionHost } from "./production-host.js";
export {
  buildToolsAllowlist,
  loadSystemPrompt,
  resolveModel,
  selectModelEntry,
} from "./production-host-resolve.js";

// ─── ProductionHost factory (Phase 7A.5) ────────────────────────────
// `createProductionHost` — typed bridge from the extension's
// `ExtensionCommandContext` subset + the run's context to a
// `ProductionHost`. Lives in `src/host/` so it ships with the
// host; Phase 7B's extension entrypoint imports the factory
// from here. Extension-agnostic: the factory's
// `ExtensionContextInputs` interface is a structural subset of
// `ExtensionCommandContext` defined here, not imported.

export type {
  CreateProductionHostInputs,
  ExtensionContextInputs,
  RunContextInputs,
} from "./production-host-factory.js";
export { createProductionHost } from "./production-host-factory.js";

// ─── Record emitter (spec §3, §4) ─────────────────────────────────
// In-process fan-out of every PersistedRecord the host appends.
// Consumers (separately installed extensions) subscribe to receive
// records for shipping to external systems. The host's persistRecord
// is the chokepoint; the loop is unchanged. Fire-and-forget, best-
// effort; the durable JSONL log is the system of record.

export { subscribeToRecords } from "./record-emitter.js";
