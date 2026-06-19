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
