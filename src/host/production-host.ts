/**
 * `ProductionHost` — Phase 7A scaffold (Task 7A.1).
 *
 * Production `Host` implementation that resolves
 * `role.models[modelIndex]` (`provider:id`) against a real
 * `ModelRegistry`, loads `role.system_prompt` from disk, and
 * wires a real `DefaultResourceLoader` for each role session.
 * Reuses the host-owned `run_id`-keyed append-only log and
 * `LoadedManifest` the loop already programs against.
 *
 * **Status:** scaffold only. 7A.1 delivers the constructor +
 * `Host` interface conformance + the three boundary errors
 * (`ModelNotFoundError`, `MalformedModelEntryError`,
 * `SystemPromptNotFoundError`). 7A.2 fills in model + prompt
 * resolution. 7A.3 wires `DefaultResourceLoader` and the
 * `SessionManager`. 7A.4 matches `StubHost`'s event-handling
 * semantics (usage capture, terminal reason, model fallback,
 * visit index, abort, seal, persistence, run-memory seeding).
 *
 * Until 7A.4 lands, every `Host` method throws
 * `Error("not yet implemented (Phase 7A.X)")`. The class is
 * constructible and type-conformant; it is not yet runnable.
 *
 * **Host-agnosticism:** this module imports from
 * `@earendil-works/pi-coding-agent` (it's in `src/host/` — the
 * grep-guard test allows pi imports here). The pure core
 * (`src/core`, `src/manifest`, `src/seam`, `src/cost`) is
 * untouched and remains host-agnostic.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { RunMemory } from "../core/run-memory.js";
import type { Role, UsageRecord } from "../core/types.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import type { Host, RoleSession, SessionTerminalReason, SpawnRoleOptions } from "./host.js";
import type { LoadedManifest } from "./manifest.js";

/**
 * Constructor options for `ProductionHost`. Mirrors the production
 * context the orchestration loop needs to pass through: the
 * `ModelRegistry` (typically the extension's
 * `ExtensionCommandContext.modelRegistry`, shared with pi's
 * configured providers), the working directory (typically
 * `ctx.cwd`), and the run-scoped state (`log`, `loadedManifest`,
 * `runId`) the loop already gives `StubHost`.
 */
export interface ProductionHostOptions {
  /** Real `ModelRegistry` from the host's environment (extension
   *  `ExtensionCommandContext.modelRegistry` or
   *  `ModelRegistry.create(authStorage, modelsPath)` in standalone). */
  readonly modelRegistry: ModelRegistry;
  /** Working directory for prompt-path resolution and session cwd. */
  readonly cwd: string;
  /** Host-owned `run_id`-keyed append-only log (Task 13.5). */
  readonly log: RecordLog;
  /** Pinned manifest snapshot (def + role configs + warnings). */
  readonly loadedManifest: LoadedManifest;
  /** The run this host is bound to. */
  readonly runId: string;
}

/**
 * Production `Host` — `Phase 7A` scaffold.
 *
 * `implements Host` enforces compile-time conformance to the
 * seam the loop programs against. Adding/removing/renaming a
 * `Host` method in `host.ts` will fail typecheck here, which
 * is the right shape for a scaffold: any drift between the
 * seam and the implementation is caught at the boundary, not
 * at runtime.
 */
export class ProductionHost implements Host {
  // ─── Stored production context ────────────────────────────────────
  /** See {@link ProductionHostOptions.modelRegistry}. */
  readonly modelRegistry: ModelRegistry;
  /** See {@link ProductionHostOptions.cwd}. */
  readonly cwd: string;
  /** See {@link ProductionHostOptions.log}. */
  readonly log: RecordLog;
  /** See {@link ProductionHostOptions.loadedManifest}. */
  readonly loadedManifest: LoadedManifest;
  /** See {@link ProductionHostOptions.runId}. */
  readonly runId: string;

  constructor(opts: ProductionHostOptions) {
    this.modelRegistry = opts.modelRegistry;
    this.cwd = opts.cwd;
    this.log = opts.log;
    this.loadedManifest = opts.loadedManifest;
    this.runId = opts.runId;
  }

  // ─── Host methods (scaffold — not yet implemented) ────────────────
  // 7A.1 deliverable is the surface only. Each method throws a
  // typed, phase-tagged error so any accidental use is loud and
  // traceable to the task that will fill it in.

  async spawnRole(_role: Role, _opts: SpawnRoleOptions = {}): Promise<RoleSession> {
    throw new Error("ProductionHost.spawnRole: not yet implemented (Phase 7A.2 / 7A.3)");
  }

  captureUsage(_session: RoleSession): UsageRecord {
    throw new Error("ProductionHost.captureUsage: not yet implemented (Phase 7A.4)");
  }

  persistRecord(_record: PersistedRecord): void {
    throw new Error("ProductionHost.persistRecord: not yet implemented (Phase 7A.4)");
  }

  seedRunMemory(_args: {
    readonly checkpoint: import("../core/types.js").Checkpoint;
    readonly def: import("../core/types.js").MachineDefinition;
    readonly goal: string;
    readonly runCostCap: number | null;
  }): RunMemory {
    throw new Error("ProductionHost.seedRunMemory: not yet implemented (Phase 7A.4)");
  }

  async abortSession(_session: RoleSession, _reason: string): Promise<void> {
    throw new Error("ProductionHost.abortSession: not yet implemented (Phase 7A.4)");
  }

  sealSession(_session: RoleSession): void {
    throw new Error("ProductionHost.sealSession: not yet implemented (Phase 7A.4)");
  }

  nextVisitIndex(_role: Role): number {
    throw new Error("ProductionHost.nextVisitIndex: not yet implemented (Phase 7A.4)");
  }

  sessionTerminalReason(_session: RoleSession): SessionTerminalReason {
    throw new Error("ProductionHost.sessionTerminalReason: not yet implemented (Phase 7A.4)");
  }

  getNextModel(_role: Role, _currentModelIndex: number): string | null {
    throw new Error("ProductionHost.getNextModel: not yet implemented (Phase 7A.4)");
  }

  runCostSoFar(): number {
    throw new Error("ProductionHost.runCostSoFar: not yet implemented (Phase 7A.4)");
  }
}
