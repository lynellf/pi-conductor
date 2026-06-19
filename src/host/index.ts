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

// ─── handoff / end emission tools (Task 14) ────────────────────────
// defineTool() entries registered via customTools. The factory takes
// a SessionSeam and closes over it; the loop does not see these
// tools directly — only their effect on the seam.

export type { EmissionToolDetails } from "./tools.js";
export { createEndTool, createHandoffTool } from "./tools.js";

// ─── Orchestration loop (Task 15) ─────────────────────────────────────
// The synchronous loop over role sessions. Owns `reduce` /
// `reduceLifecycle` / persistence; programs against the `Host` seam
// (Task 13). Tested against a fake host + scripted session factory
// here; Task 16 promotes that into a reusable stub provider for E2E.

export type { RunLoopOptions, RunLoopResult } from "./loop.js";
export { runLoop } from "./loop.js";
