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
 * Isolated RPC spawning, shared SDK spawning, and run-scoped state live in
 * dedicated helpers. The remaining class stays below the 500-LOC exception
 * ceiling because it owns the Host policy and lifecycle API as one seam.
 *
 * **Host-agnosticism:** this module imports from
 * `@earendil-works/pi-coding-agent` (it's in `src/host/` — the
 * grep-guard test allows pi imports here). The pure core
 * (`src/core`, `src/manifest`, `src/seam`, `src/cost`) is
 * untouched and remains host-agnostic.
 */

import type { RunMemory } from "../core/run-memory.js";
import type { Checkpoint, MachineDefinition, Role, UsageRecord } from "../core/types.js";
import type { RoleConfig } from "../manifest/types.js";

import type { PersistedRecord } from "../persistence/log.js";
import type { HandoffTransportSelectedRecord } from "../persistence/trajectory-records.js";
import { ProductionDelegationCoordinator } from "./delegation/production-delegation.js";
import type { EndGuardRunRequest, EndGuardRunResult } from "./end-guard-runner.js";
import type {
  ArtifactRouteSource,
  Host,
  RoleSession,
  SessionTerminalReason,
  SpawnRoleOptions,
} from "./host.js";
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
import { notifyListeners } from "./record-emitter.js";

export type { ProductionHostOptions } from "./production-host-options.js";

import { ProductionHostContext } from "./production-host-context.js";
import { DelegateBridgeConfigError, type DelegateBridgeResult } from "./rpc/delegate-bridge.js";

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
export class ProductionHost extends ProductionHostContext implements Host {
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
      sessionState: this.sessionState,
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
      sessionState: this.sessionState,
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
      sessionStates: this.sessionStates,
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
      sessionState: this.sessionState,
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
