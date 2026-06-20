/**
 * `createProductionHost` factory — Phase 7A.5.
 *
 * Bridges the extension / CLI environment to a `ProductionHost`.
 * Shared by Phase 7B (extension entrypoint) and Phase 7C's
 * optional CLI fallback. Lives in `src/host/` so the production
 * host + factory ship together; Phase 7B imports the factory
 * from this module.
 *
 * **Why a factory, not direct construction.** The extension's
 * `ExtensionCommandContext` exposes a wide surface (UI hooks,
 * `newSession`, etc.). `ProductionHost` only needs a small
 * subset (`modelRegistry`, `cwd`) — the run context
 * (`runId`, `log`, `loadedManifest`) comes from the run config
 * + manifest loader, not the extension. A typed factory keeps
 * the call site explicit about which fields flow where and
 * keeps `src/host/` from importing `ExtensionCommandContext`
 * (which would couple the host layer to the extension types).
 *
 * **Extension-agnostic by design.** The factory's `ExtensionContextInputs`
 * interface is a structural subset of `ExtensionCommandContext`
 * — same field names, same types — but it's defined here, in
 * `src/host/`, so the host layer has zero compile-time
 * dependency on the extension's type surface. The extension
 * passes its own context object as `inputs.extension`; the
 * factory only reads the fields it needs. (The grep guard on
 * `src/core` + `src/manifest` + `src/seam` + `src/cost` does
 * not scan `src/host/`, but the invariant is "no extension
 * imports from the pure core" — the same principle applies in
 * reverse: "no host imports from the extension types".)
 */

import type { ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RecordLog } from "../persistence/log.js";
import type { DisplaySink } from "./display-sink.js";
import type { LoadedManifest } from "./manifest.js";
import { ProductionHost } from "./production-host.js";

/**
 * Subset of `ExtensionCommandContext` the factory reads. Structurally
 * compatible with the extension's context so callers can pass
 * `ctx` directly (with `as ExtensionContextInputs` or via a
 * `Pick`). Defining the interface here, in `src/host/`, decouples
 * the host layer from the extension's type surface.
 */
export interface ExtensionContextInputs {
  /** Extension's `ModelRegistry` (shared with pi's configured providers). */
  readonly modelRegistry: ModelRegistry;
  /** Extension's working directory (typically `ctx.cwd`). */
  readonly cwd: string;
  /** Extension UI handle threaded into spawned sessions for the TUI bridge. */
  readonly uiContext?: ExtensionUIContext;
  /** Optional display sink for streamed role output. */
  readonly displaySink?: DisplaySink;
}

/**
 * Run-scoped state. Built by `startRun` from the run config +
 * manifest loader; the factory passes each field through to
 * `ProductionHost`'s constructor.
 */
export interface RunContextInputs {
  /** Host-owned `run_id`-keyed append-only log (Task 13.5). */
  readonly log: RecordLog;
  /** Pinned manifest snapshot (def + role configs + warnings). */
  readonly loadedManifest: LoadedManifest;
  /** Unique run identifier. */
  readonly runId: string;
  /**
   * Optional override for the conductor's session directory. When
   * omitted, the host derives `<cwd>/.pi-conductor/runs/<runId>/sessions`.
   * The extension typically omits this and lets the host pick
   * (consistent with the conductor's run-log location). The CLI
   * fallback (Phase 7C) is expected to pass the same path as
   * `FileRecordLog.baseDir` for full conductor-isolation.
   */
  readonly sessionDir?: string;
  /**
   * Optional override for the SDK's agent directory. When omitted,
   * the host derives `<cwd>/.pi-conductor/agent`. The extension
   * is expected to share its own `~/.pi/agent` by passing the
   * path here so spawned role sessions see the user's pi
   * configuration (auth, models).
   */
  readonly agentDir?: string;
}

/**
 * Composite input for the factory. `extension` is the
 * environment-scoped state; `run` is the run-scoped state.
 * Splitting the inputs by scope keeps the call site explicit
 * about which fields the host reads from where.
 */
export interface CreateProductionHostInputs {
  readonly extension: ExtensionContextInputs;
  readonly run: RunContextInputs;
}

/**
 * Build a `ProductionHost` from extension + run context. Pure
 * passthrough: the factory is a typed wrapper around the
 * `ProductionHost` constructor. Kept as a function (not a class)
 * so the extension can construct one in a single line:
 *
 * ```ts
 * const host = createProductionHost({
 *   extension: { modelRegistry: ctx.modelRegistry, cwd: ctx.cwd, uiContext: ctx.ui },
 *   run: { log, loadedManifest, runId, ... },
 * });
 * ```
 */
export function createProductionHost(inputs: CreateProductionHostInputs): ProductionHost {
  return new ProductionHost({
    modelRegistry: inputs.extension.modelRegistry,
    cwd: inputs.extension.cwd,
    ...(inputs.extension.uiContext !== undefined && { uiContext: inputs.extension.uiContext }),
    ...(inputs.extension.displaySink !== undefined && {
      displaySink: inputs.extension.displaySink,
    }),
    log: inputs.run.log,
    loadedManifest: inputs.run.loadedManifest,
    runId: inputs.run.runId,
    ...(inputs.run.sessionDir !== undefined && { sessionDir: inputs.run.sessionDir }),
    ...(inputs.run.agentDir !== undefined && { agentDir: inputs.run.agentDir }),
  });
}
