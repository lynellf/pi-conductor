/**
 * `ProductionHost` — Phase 7A production `Host` (Tasks 7A.1–7A.4).
 *
 * Production `Host` implementation that resolves the normalized
 * `role.models[modelIndex]` entry (`model` + `effort`) against a real
 * `ModelRegistry`, loads `role.system_prompt` from disk, wires
 * a real `DefaultResourceLoader` + file-backed `SessionManager`
 * for each role session, and matches `StubHost`'s event-handling
 * semantics (usage capture, terminal reason, model fallback,
 * visit index, abort, seal, persistence, run-memory seeding).
 *
 * **Status (Phase 7A):** 7A.1 — constructor + `Host` interface
 * conformance + three boundary errors. 7A.2 — pure resolution
 * pieces (`selectModelEntry`, `resolveModel`, `loadSystemPrompt`).
 * 7A.3 — `DefaultResourceLoader` + `SessionManager` wiring +
 * `buildToolsAllowlist`. 7A.4 — full `Host` method parity with
 * `StubHost` (every method now implemented; the event-handler
 * logic is shared via `session-event-handler.ts`).
 *
 * Isolated RPC spawning and shared SDK spawning live in dedicated helpers.
 * The remaining class stays below the 500-LOC exception ceiling because it
 * owns the Host's policy plus its shared per-session state and lifecycle API.
 *
 * **Host-agnosticism:** this module imports from
 * `@earendil-works/pi-coding-agent` (it's in `src/host/` — the
 * grep-guard test allows pi imports here). The pure core
 * (`src/core`, `src/manifest`, `src/seam`, `src/cost`) is
 * untouched and remains host-agnostic.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ExtensionUIContext,
  getAgentDir,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { RunMemory } from "../core/run-memory.js";
import type { Checkpoint, MachineDefinition, Role, UsageRecord } from "../core/types.js";
import type { RoleConfig } from "../manifest/types.js";

import type { PersistedRecord, RecordLog, SnapshotPinnedRecord } from "../persistence/log.js";
import type { HandoffTransportSelectedRecord } from "../persistence/trajectory-records.js";
import type { SessionState } from "./cost.js";
import { ProductionDelegationCoordinator } from "./delegation/production-delegation.js";
import type { DisplaySink } from "./display-sink.js";
import {
  EndGuardRunner,
  type EndGuardRunRequest,
  type EndGuardRunResult,
} from "./end-guard-runner.js";
import { isSupervisedProcessSupported } from "./execution/supervised-process.js";
import type {
  ArtifactRouteSource,
  Host,
  RoleSession,
  SessionTerminalReason,
  SpawnRoleOptions,
} from "./host.js";
import type { LoadedManifest } from "./manifest.js";
import {
  type ArtifactHostContext,
  collectTerminalArtifacts as collectTerminalArtifactsInModule,
  routeAcceptedHandoffArtifacts as routeAcceptedHandoffArtifactsInModule,
} from "./production-host-artifacts.js";
import {
  abortSession as abortSessionInModule,
  type ControlHostContext,
  pendingDelegationTasks as pendingDelegationTasksInModule,
  runEndGuard as runEndGuardInModule,
  sealSession as sealSessionInModule,
  settleDelegation as settleDelegationInModule,
} from "./production-host-control.js";
import {
  createDelegateBridgeHandler as createDelegateBridgeHandlerInModule,
  createDelegateTool as createDelegateToolInModule,
  type DelegateHostContext,
  getOrCreateSnapshotPin as getOrCreateSnapshotPinInModule,
} from "./production-host-delegation.js";
import { type SpawnRoleContext, spawnRole as spawnRoleInModule } from "./production-host-spawn.js";
import {
  captureUsage as captureUsageInModule,
  getNextModel as getNextModelInModule,
  nextVisitIndex as nextVisitIndexInModule,
  persistRecord as persistRecordInModule,
  runCostSoFar as runCostSoFarInModule,
  type StateHostContext,
  seedRunMemory as seedRunMemoryInModule,
  sessionFailureDetail as sessionFailureDetailInModule,
  sessionTerminalReason as sessionTerminalReasonInModule,
} from "./production-host-state.js";
import { resumeTrajectoryRole as resumeTrajectoryRoleInModule } from "./production-host-trajectory.js";
import { selectAcceptedHandoffTransport as selectAcceptedHandoffTransportInModule } from "./production-host-trajectory-select.js";
import { ProductionPrewalkHost } from "./production-prewalk-host.js";
import { notifyListeners } from "./record-emitter.js";
import { RoleTurnProducer } from "./role-turn-producer.js";

export type { ProductionHostOptions } from "./production-host-options.js";

import type { ProductionHostOptions } from "./production-host-options.js";
import { DelegateBridgeConfigError, type DelegateBridgeResult } from "./rpc/delegate-bridge.js";
import type { NodeRoleSession } from "./rpc/node-role-session.js";
import { createNodeRoleSession } from "./rpc/node-role-session-factory.js";
import type { NodeRoleSessionOptions } from "./rpc/protocol.js";
import type { SessionEventSource } from "./session-event-handler.js";
import { assertTrajectorySdkSupportedForHandoffs } from "./trajectory-sdk-capability.js";

/**
 * Production `Host` — `Phase 7A` scaffold + role-session spawn
 * (Tasks 7A.1, 7A.2, 7A.3).
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
  /** See {@link ProductionHostOptions.uiContext}. */
  readonly uiContext: ExtensionUIContext | undefined;
  /** See {@link ProductionHostOptions.isUiContextCurrent}. */
  readonly isUiContextCurrent: (() => boolean) | undefined;
  /** See {@link ProductionHostOptions.displaySink}. */
  readonly displaySink: DisplaySink | undefined;
  /** See {@link ProductionHostOptions.sessionDir}. */
  readonly sessionDir: string;
  /** See {@link ProductionHostOptions.agentDir}. */
  readonly agentDir: string;
  /** Pi configuration inherited by isolated RPC children. */
  readonly isolatedAgentDir: string;
  /** Issue #68: run-owned bounded role-turn telemetry producer/ledger. */
  private readonly roleTurnProducer: RoleTurnProducer;
  private readonly nodeRoleSessionFactory: (
    options: NodeRoleSessionOptions,
  ) => Promise<NodeRoleSession>;
  private readonly endGuardRunner: EndGuardRunner;

  constructor(opts: ProductionHostOptions) {
    assertTrajectorySdkSupportedForHandoffs(opts.loadedManifest.manifest.handoffs);
    this.modelRegistry = opts.modelRegistry;
    this.cwd = resolve(opts.cwd);
    this.log = opts.log;
    this.loadedManifest = opts.loadedManifest;
    this.runId = opts.runId;
    this.uiContext = opts.uiContext;
    this.isUiContextCurrent = opts.isUiContextCurrent;
    this.displaySink = opts.displaySink;
    this.sessionDir =
      opts.sessionDir === undefined
        ? join(this.cwd, ".pi-conductor", "runs", opts.runId, "sessions")
        : resolve(opts.sessionDir);
    this.agentDir =
      opts.agentDir === undefined
        ? join(this.cwd, ".pi-conductor", "agent")
        : resolve(opts.agentDir);
    this.isolatedAgentDir = opts.agentDir === undefined ? resolve(getAgentDir()) : this.agentDir;
    this.roleTurnProducer = new RoleTurnProducer({
      runId: this.runId,
      log: this.log,
      telemetry: opts.roleTurnTelemetry,
    });
    this.nodeRoleSessionFactory = opts.nodeRoleSessionFactory ?? createNodeRoleSession;
    if (this.loadedManifest.manifest.end_guard !== undefined && !isSupervisedProcessSupported()) {
      throw new Error("end_guard requires a platform with supervised process cleanup");
    }
    this.endGuardRunner = new EndGuardRunner(this.cwd);
    // The SessionManager writes JSONL files directly into `sessionDir`
    // without creating parent directories. Ensure the dir exists so
    // the first `SessionManager.create(cwd, this.sessionDir)` call
    // in `spawnRole` doesn't ENOENT.
    mkdirSync(this.sessionDir, { recursive: true });
  }

  // ─── Per-session state (Task 17 / 7A.4) ────────────────────────
  // The host tracks the `SessionState` + the live `AgentSession`
  // for each spawned role so the `Host` methods (`captureUsage`,
  // `sessionTerminalReason`, `dispose`) can read the per-session
  // cap/usage/terminal-reason state and clean up on dispose.
  // Mirrors `StubHost.sessionStates` / `agentsBySessionId`.
  private readonly sessionStates: Map<string, SessionState> = new Map();
  private readonly agentsBySessionId: Map<string, SessionEventSource> = new Map();
  private readonly prewalk = new ProductionPrewalkHost(this.sessionStates, this.agentsBySessionId);
  private snapshotPin: Promise<SnapshotPinnedRecord> | null = null;

  /**
   * Tracks the most-recent role that exhausted its model fallback
   * (Task 18, §9.4 v1 default). The next `spawnRole` for this
   * role throws `RoleEscalationError`; a `spawnRole` for any
   * other role clears the marker (so a different re-dispatch
   * doesn't trip the guard, only the same-role re-dispatch
   * does). Identical semantics to `StubHost.unavailableRole` —
   * kept as per-class state rather than extracted (the 15-line
   * policy doesn't cross a "real duplication" threshold).
   */
  private unavailableRole: Role | null = null;
  private readonly delegation = new ProductionDelegationCoordinator();
  private readonly delegationSessionKeys = new Map<string, string>();
  private readonly inactiveDelegationSessions = new Set<string>();

  // ─── Host methods ──────────────────────────────────────────────────
  // `spawnRole` is wired (7A.3). The remaining methods throw a
  // phase-tagged "not yet implemented" error so 7A.4 fills them
  // in (one task at a time, per the plan's slice structure).

  async spawnRole(role: Role, opts: SpawnRoleOptions = {}): Promise<RoleSession> {
    const context: SpawnRoleContext = {
      modelRegistry: this.modelRegistry,
      cwd: this.cwd,
      loadedManifest: this.loadedManifest,
      log: this.log,
      runId: this.runId,
      sessionDir: this.sessionDir,
      agentDir: this.agentDir,
      isolatedAgentDir: this.isolatedAgentDir,
      displaySink: this.displaySink,
      uiContext: this.uiContext,
      isUiContextCurrent: this.isUiContextCurrent,
      nodeRoleSessionFactory: this.nodeRoleSessionFactory,
      roleTurnProducer: this.roleTurnProducer,
      sessionStates: this.sessionStates,
      agentsBySessionId: this.agentsBySessionId,
      delegationSessionKeys: this.delegationSessionKeys,
      inactiveDelegationSessions: this.inactiveDelegationSessions,
      unavailableRole: this.unavailableRole,
      prewalk: this.prewalk,
      lookupRoleConfig: (targetRole) => this.lookupRoleConfig(targetRole),
      latestTrajectoryTransport: (targetRole) => this.latestTrajectoryTransport(targetRole),
      resumeTrajectoryRole: (targetRole, config, selected, executionVisitIndex) =>
        this.resumeTrajectoryRole(targetRole, config, selected, executionVisitIndex),
      getOrCreateSnapshotPin: (source) =>
        getOrCreateSnapshotPinInModule(
          {
            ...this.delegateContext(),
            snapshotPin: this.snapshotPin,
            setSnapshotPin: (pin) => {
              this.snapshotPin = pin;
            },
          },
          source,
        ),
      createDelegateBridgeHandler: (...args) => this.createDelegateBridgeHandler(...args),
      createDelegateTool: (...args) => this.createDelegateTool(...args),
      persistRecord: (record) => {
        this.log.append(record);
        notifyListeners(record);
      },
    };
    try {
      return await spawnRoleInModule(context, role, opts);
    } finally {
      // Preserve fallback exhaustion and escalation consumption even when
      // spawnRole rejects before returning a session.
      this.unavailableRole = context.unavailableRole;
    }
  }

  /** Return the last durable transport outcome targeting this receiver. */
  private latestTrajectoryTransport(role: Role):
    | { readonly type: "selected"; readonly record: HandoffTransportSelectedRecord }
    | {
        readonly type: "failed";
        readonly record: Extract<PersistedRecord, { readonly type: "trajectory_handoff_failed" }>;
      }
    | null {
    const records = this.log.records(this.runId);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record?.type === "trajectory_handoff_failed" && record.to === role) {
        return { type: "failed", record };
      }
      if (record?.type === "handoff_transport_selected" && record.to === role) {
        return { type: "selected", record };
      }
      if (
        record?.type === "transition_accepted" &&
        record.event === "handoff" &&
        record.to === role
      ) {
        return null;
      }
    }
    return null;
  }

  /** Reopen the selected conversation with the persisted target environment (Issue #63 §4.5). */
  private async resumeTrajectoryRole(
    role: Role,
    roleConfig: RoleConfig | undefined,
    selected: HandoffTransportSelectedRecord,
    executionVisitIndex: number,
  ): Promise<RoleSession> {
    return resumeTrajectoryRoleInModule(
      {
        modelRegistry: this.modelRegistry,
        cwd: this.cwd,
        agentDir: this.agentDir,
        sessionDir: this.sessionDir,
        runId: this.runId,
        loadedManifest: this.loadedManifest,
        log: this.log,
        uiContext: this.uiContext,
        isUiContextCurrent: this.isUiContextCurrent,
        displaySink: this.displaySink,
        sessionStates: this.sessionStates,
        agentsBySessionId: this.agentsBySessionId,
        roleTurnProducer: this.roleTurnProducer,
        persistRecord: (record) => this.persistRecord(record),
      },
      role,
      roleConfig,
      selected,
      executionVisitIndex,
    );
  }

  /**
   * Look up the role's `RoleConfig` from the loaded manifest.
   * Returns `undefined` for an undeclared role (which the loop
   * shouldn't ask for; surfaced as a "use system model" fallback
   * downstream, matching `StubHost`'s tolerance). Internal helper.
   */
  private lookupRoleConfig(role: Role): RoleConfig | undefined {
    return this.loadedManifest.manifest.roles.find((r) => r.name === role);
  }

  private delegateContext(): DelegateHostContext {
    return {
      loadedManifest: this.loadedManifest,
      runId: this.runId,
      cwd: this.cwd,
      agentDir: this.agentDir,
      sessionDir: this.sessionDir,
      modelRegistry: this.modelRegistry,
      displaySink: this.displaySink,
      log: this.log,
      delegation: this.delegation,
      runCostSoFar: () => this.runCostSoFar(),
      persistRecord: (record) => this.persistRecord(record),
      adaptDelegateToolResult,
    };
  }

  private createDelegateTool(
    ...args: Parameters<typeof createDelegateToolInModule> extends [
      DelegateHostContext,
      ...infer Rest,
    ]
      ? Rest
      : never
  ): ReturnType<typeof createDelegateToolInModule> {
    return createDelegateToolInModule(this.delegateContext(), ...args);
  }

  private createDelegateBridgeHandler(
    ...args: Parameters<typeof createDelegateBridgeHandlerInModule> extends [
      DelegateHostContext,
      ...infer Rest,
    ]
      ? Rest
      : never
  ): ReturnType<typeof createDelegateBridgeHandlerInModule> {
    return createDelegateBridgeHandlerInModule(this.delegateContext(), ...args);
  }

  private stateContext(): StateHostContext {
    return {
      prewalk: this.prewalk,
      delegationSessionKeys: this.delegationSessionKeys,
      delegation: this.delegation,
      loadedManifest: this.loadedManifest,
      log: this.log,
      runId: this.runId,
      persistRecord: (record) => {
        this.log.append(record);
        notifyListeners(record);
      },
      lookupRoleConfig: (role) => this.lookupRoleConfig(role),
    };
  }

  captureUsage(session: RoleSession): UsageRecord {
    return captureUsageInModule(this.stateContext(), session);
  }

  sessionTerminalReason(session: RoleSession): SessionTerminalReason {
    return sessionTerminalReasonInModule(this.stateContext(), session);
  }

  sessionFailureDetail(session: RoleSession): string | null {
    return sessionFailureDetailInModule(this.stateContext(), session);
  }

  persistRecord(record: PersistedRecord): void {
    persistRecordInModule(this.stateContext(), record);
  }

  seedRunMemory(args: {
    readonly checkpoint: Checkpoint;
    readonly def: MachineDefinition;
    readonly goal: string;
    readonly runCostCap: number | null;
  }): RunMemory {
    return seedRunMemoryInModule(this.stateContext(), args);
  }

  nextVisitIndex(role: Role): number {
    return nextVisitIndexInModule(this.stateContext(), role);
  }

  getNextModel(role: Role, currentModelIndex: number): string | null {
    return getNextModelInModule(this.stateContext(), role, currentModelIndex);
  }

  runCostSoFar(): number {
    return runCostSoFarInModule(this.stateContext());
  }

  /** Select and prepare a policy-declared shared-session continuation (Issue #63). */
  selectAcceptedHandoffTransport(args: {
    readonly from: Role;
    readonly to: Role;
    readonly source: RoleSession;
    readonly targetSeed: string;
    readonly targetVisitIndex: number;
    readonly targetExecutionVisitIndex?: number;
  }): Promise<
    { readonly mode: "fresh" } | { readonly mode: "trajectory"; readonly session: RoleSession }
  > {
    return selectAcceptedHandoffTransportInModule(
      {
        modelRegistry: this.modelRegistry,
        cwd: this.cwd,
        runId: this.runId,
        loadedManifest: this.loadedManifest,
        persistRecord: (record) => this.persistRecord(record),
        lookupRoleConfig: (role) => this.lookupRoleConfig(role),
      },
      args,
    );
  }

  private controlContext(): ControlHostContext {
    return {
      endGuardRunner: this.endGuardRunner,
      delegation: this.delegation,
      delegationSessionKeys: this.delegationSessionKeys,
      inactiveDelegationSessions: this.inactiveDelegationSessions,
      prewalk: this.prewalk,
    };
  }

  async abortSession(session: RoleSession, reason: string): Promise<void> {
    return abortSessionInModule(this.controlContext(), session, reason);
  }

  pendingDelegationTasks(session: RoleSession): readonly string[] {
    return pendingDelegationTasksInModule(this.controlContext(), session);
  }

  async settleDelegation(session: RoleSession, reason: string): Promise<void> {
    return settleDelegationInModule(this.controlContext(), session, reason);
  }

  runEndGuard(request: EndGuardRunRequest): Promise<EndGuardRunResult> {
    return runEndGuardInModule(this.controlContext(), request);
  }

  sealSession(session: RoleSession): void {
    sealSessionInModule(this.controlContext(), session);
  }

  routeAcceptedHandoffArtifacts(
    source: ArtifactRouteSource,
    receiver: RoleSession,
  ): Promise<string | null> {
    const context: ArtifactHostContext = {
      cwd: this.cwd,
      runId: this.runId,
      log: this.log,
      persistRecord: (record) => this.persistRecord(record),
    };
    return routeAcceptedHandoffArtifactsInModule(context, source, receiver);
  }

  /** Collect isolated-session artifacts before the loop can spawn a successor (§7.2). */
  collectTerminalArtifacts(
    session: RoleSession,
    args: {
      readonly role: Role;
      readonly visitIndex: number;
      readonly terminal: "session_ended" | "session_failed";
      readonly handoff?: import("../seam/schema.js").HandoffArgs;
    },
  ): Promise<void> {
    const context: ArtifactHostContext = {
      cwd: this.cwd,
      runId: this.runId,
      log: this.log,
      persistRecord: (record) => this.persistRecord(record),
    };
    return collectTerminalArtifactsInModule(context, session, args);
  }
}

function adaptDelegateToolResult(result: {
  readonly content: readonly { readonly type: string }[];
  readonly details: unknown;
  readonly terminate?: boolean;
}): DelegateBridgeResult {
  const content = result.content.map((block) => {
    if (block.type !== "text" || !("text" in block) || typeof block.text !== "string") {
      throw new DelegateBridgeConfigError("existing delegate operation returned a non-text result");
    }
    return { type: "text" as const, text: block.text };
  });
  if (!isRecord(result.details)) {
    throw new DelegateBridgeConfigError("existing delegate operation returned non-object details");
  }
  const isError = "isError" in result && result.isError === true;
  return {
    content,
    details: result.details,
    ...(typeof result.terminate === "boolean" ? { terminate: result.terminate } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function _hasDelegateConfiguration(
  roleConfig: RoleConfig | undefined,
): roleConfig is RoleConfig & { readonly delegation: NonNullable<RoleConfig["delegation"]> } {
  return roleConfig?.delegation !== undefined && roleConfig.tools?.includes("delegate") === true;
}

function _delegationPromptRoot(loaded: LoadedManifest, cwd: string): string {
  if (loaded.manifestVersion < 2) return cwd;
  if (loaded.manifestDir === null) {
    throw new Error("delegation requires a manifest directory for v2 profile system prompts");
  }
  return loaded.manifestDir;
}
