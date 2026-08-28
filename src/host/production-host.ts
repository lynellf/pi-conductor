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

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import {
  type ExtensionContext,
  type ExtensionUIContext,
  getAgentDir,
  type ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RunMemory } from "../core/run-memory.js";
import { buildRunMemory } from "../core/run-memory.js";
import type {
  Checkpoint,
  MachineDefinition,
  ModelEffort,
  Role,
  UsageRecord,
} from "../core/types.js";
import { DEFAULT_MODEL_EFFORT } from "../core/types.js";
import { modeFor } from "../manifest/handoffs.js";
import type { ModelConfig, RoleConfig, WorkspaceSource } from "../manifest/types.js";

import {
  type ArtifactCollectedRecord,
  type ArtifactRejectedRecord,
  type PersistedRecord,
  type RecordLog,
  type SnapshotPinnedRecord,
  snapshotPinned,
} from "../persistence/log.js";
import {
  type HandoffTransportSelectedRecord,
  sha256Canonical,
  TrajectoryResumeError,
} from "../persistence/trajectory-records.js";
import { collectTerminalArtifacts as collectTerminalArtifactsFromWorkspace } from "./artifacts/lifecycle.js";
import { formatArtifactsSeedSection, materializeArtifacts } from "./artifacts/route.js";
import type { SessionState } from "./cost.js";
import { DelegationManager } from "./delegation/manager.js";
import type { DisplaySink } from "./display-sink.js";
import { NoMoreModelsError, RoleEscalationError } from "./errors.js";
import type {
  ArtifactRouteSource,
  Host,
  RoleSession,
  SessionTerminalReason,
  SpawnRoleOptions,
} from "./host.js";
import { spawnIsolatedRoleSession } from "./isolated-role-spawn.js";
import type { LoadedManifest } from "./manifest.js";
import {
  buildToolsAllowlist,
  loadSystemPrompt,
  resolveModel,
  selectModelEntry,
} from "./production-host-resolve.js";
import { notifyListeners } from "./record-emitter.js";
import {
  DelegateBridgeConfigError,
  type DelegateBridgeHandler,
  type DelegateBridgeResult,
} from "./rpc/delegate-bridge.js";
import type { NodeRoleSession } from "./rpc/node-role-session.js";
import { createNodeRoleSession } from "./rpc/node-role-session-factory.js";
import type { NodeRoleSessionOptions } from "./rpc/protocol.js";
import type { SessionEventSource } from "./session-event-handler.js";
import { spawnSharedSdkRoleSession } from "./shared-sdk-role-spawn.js";
import { admitTrajectory, TrajectoryHandoffError } from "./trajectory-admission.js";
import {
  assertPersistedSnapshotPinResolves,
  assertSupportedWorkspaceBackend,
  readPersistedSnapshotPin,
  resolvePinnedCommit,
} from "./workspace/index.js";

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
  /** Optional extension UI handle threaded into role sessions. */
  readonly uiContext?: ExtensionUIContext;
  /**
   * Live guard for the captured UI context. When an extension session is
   * replaced, role startup must skip binding the stale context (issue #44).
   * Non-extension callers omit this and retain the normal binding behavior.
   */
  readonly isUiContextCurrent?: () => boolean;
  /** Optional display sink for streamed role output. */
  readonly displaySink?: DisplaySink;
  /** Host-owned `run_id`-keyed append-only log (Task 13.5). */
  readonly log: RecordLog;
  /** Pinned manifest snapshot (def + role configs + warnings). */
  readonly loadedManifest: LoadedManifest;
  /** The run this host is bound to. */
  readonly runId: string;
  /**
   * Optional: directory for SDK `SessionManager` files. The plan
   * calls for the file-backed `SessionManager` to be "rooted under
   * the conductor run log directory" — i.e., NOT in pi's own
   * session tree (~/.pi/agent/sessions/<encoded-cwd>/). Default:
   * `<cwd>/.pi-conductor/runs/<runId>/sessions`. Created on
   * construction (`mkdirSync({ recursive: true })`).
   */
  readonly sessionDir?: string;
  /**
   * Optional: directory for the SDK's `DefaultResourceLoader` agent
   * config (auth.json, models.json, extensions, etc.). Default:
   * `<cwd>/.pi-conductor/agent`. An explicit value also configures an
   * isolated RPC child; otherwise isolated children use Pi's configured
   * agent directory so roles without `models:` retain Pi defaults.
   */
  readonly agentDir?: string;
  /** Test seam for the otherwise direct isolated Node RPC role-session constructor. */
  readonly nodeRoleSessionFactory?: (options: NodeRoleSessionOptions) => Promise<NodeRoleSession>;
}

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
  private readonly nodeRoleSessionFactory: (
    options: NodeRoleSessionOptions,
  ) => Promise<NodeRoleSession>;

  constructor(opts: ProductionHostOptions) {
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
    this.nodeRoleSessionFactory = opts.nodeRoleSessionFactory ?? createNodeRoleSession;
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
  private readonly delegationManager = new DelegationManager();

  // ─── Host methods ──────────────────────────────────────────────────
  // `spawnRole` is wired (7A.3). The remaining methods throw a
  // phase-tagged "not yet implemented" error so 7A.4 fills them
  // in (one task at a time, per the plan's slice structure).

  async spawnRole(role: Role, opts: SpawnRoleOptions = {}): Promise<RoleSession> {
    // ── Task 18: model-fallback policy (parity with StubHost) ──
    // §9.4 v1 default: hand to orchestrator once, then escalate.
    // The "unavailable" marker is set when the role's models were
    // just exhausted; the next spawnRole for the same role
    // surfaces as a typed error. Different-role spawns clear the
    // marker (unless the different role is the orchestrator and
    // the unavailable role was a non-orchestrator, in which case
    // the marker persists so a same-role re-dispatch escalates).
    if (this.unavailableRole === role) {
      this.unavailableRole = null; // consume the escalation
      throw new RoleEscalationError(role);
    }
    if (this.unavailableRole !== null && this.unavailableRole !== role) {
      const orchestrator = this.loadedManifest.def.orchestrator;
      if (role !== orchestrator) {
        this.unavailableRole = null;
      }
    }

    const roleConfig = this.lookupRoleConfig(role);
    const resumedTransport = this.latestTrajectoryTransport(role);
    if (resumedTransport?.type === "failed") {
      throw new TrajectoryResumeError(
        `trajectory handoff ${resumedTransport.record.from} → ${resumedTransport.record.to} previously failed: ${resumedTransport.record.code}`,
      );
    }
    if (resumedTransport?.type === "selected") {
      return this.resumeTrajectoryRole(role, roleConfig, resumedTransport.record);
    }
    const roleWorkspaceConfig = roleConfig?.workspace;
    const workspaceBackend = roleWorkspaceConfig?.backend ?? "shared";
    if (workspaceBackend === "container") {
      assertSupportedWorkspaceBackend(workspaceBackend);
    }
    const modelIndex = opts.modelIndex ?? 0;

    // ── Task 18: resolve the model from the role's models[] list.
    // The "logical" model is the `provider:id` string the
    // lifecycle record will carry; the SDK model is resolved via
    // `resolveModel` against `this.modelRegistry`. On a registry
    // miss (`NoMoreModelsError` for out-of-range index), the role
    // is marked unavailable so the next re-dispatch escalates
    // (§9.4 v1 default).
    let entry: ModelConfig | null = null;
    try {
      entry = selectModelEntry(role, roleConfig, modelIndex);
    } catch (e) {
      if (e instanceof NoMoreModelsError) {
        this.unavailableRole = role;
      }
      throw e;
    }
    let model: Model<never> | undefined;
    let logical: string | null = null;
    const effort: ModelEffort = entry?.effort ?? DEFAULT_MODEL_EFFORT;
    const retries = entry?.retries ?? 0;
    const retryDelayMs = entry?.retry_delay_ms ?? 0;
    if (entry !== null) {
      const resolved = resolveModel(role, entry.model, this.modelRegistry);
      model = resolved.model;
      logical = resolved.logical;
    }

    // 2. Load the role's system prompt. `loadSystemPrompt` returns
    //    null when the role has no `system_prompt` field; the
    //    `systemPromptOverride` then leaves the SDK default in
    //    place.
    //
    //    Phase 7D: thread the manifest's directory + version
    //    through so the §8.1 prompt resolver can pick the right
    //    resolution root. v1 (existing manifests) keeps
    //    cwd-relative resolution; v2 (HOME-sourced and
    //    self-contained manifests) resolves against
    //    `manifestDir`. Both fields ride on `LoadedManifest` —
    //    added in Task 7D.2, populated by `loadManifest` /
    //    `loadManifestFromString`.
    const rolePrompt = await loadSystemPrompt(
      role,
      roleConfig?.system_prompt,
      this.cwd,
      this.loadedManifest.manifestDir,
      this.loadedManifest.manifestVersion,
    );

    if (workspaceBackend === "worktree" || workspaceBackend === "copy") {
      if (roleWorkspaceConfig === undefined) {
        throw new Error("isolated role requires a workspace configuration");
      }
      if (opts.visitIndex === undefined) {
        throw new Error("isolated role spawning requires the loop-owned visitIndex");
      }
      const snapshotPin = await this.getOrCreateSnapshotPin(
        roleWorkspaceConfig.source ?? "snapshot",
      );
      return spawnIsolatedRoleSession({
        role,
        roleConfig,
        workspaceConfig: roleWorkspaceConfig,
        backend: workspaceBackend,
        snapshotCommit: snapshotPin.commit,
        model: logical,
        effort,
        retries,
        retryDelayMs,
        systemPrompt: rolePrompt,
        cwd: this.cwd,
        runId: this.runId,
        sessionDir: this.sessionDir,
        agentDir: this.isolatedAgentDir,
        nodeRoleSessionFactory: this.nodeRoleSessionFactory,
        ...(hasDelegateConfiguration(roleConfig)
          ? {
              createDelegateBridgeHandler: (primaryCheckout: string) =>
                this.createDelegateBridgeHandler(
                  role,
                  roleConfig,
                  primaryCheckout,
                  opts.visitIndex,
                ),
            }
          : {}),
        visitIndex: opts.visitIndex,
        persistRecord: (record) => this.persistRecord(record),
        sessionStates: this.sessionStates,
        agentsBySessionId: this.agentsBySessionId,
        ...(this.displaySink !== undefined && { displaySink: this.displaySink }),
      });
    }

    const delegateTool = hasDelegateConfiguration(roleConfig)
      ? await this.createDelegateTool(role, roleConfig, this.cwd, opts.visitIndex)
      : null;

    return spawnSharedSdkRoleSession({
      role,
      roleConfig,
      model,
      logicalModel: logical,
      effort,
      retries,
      retryDelayMs,
      systemPrompt: rolePrompt,
      modelRegistry: this.modelRegistry,
      cwd: this.cwd,
      agentDir: this.agentDir,
      sessionDir: this.sessionDir,
      runId: this.runId,
      machineDefinition: this.loadedManifest.def,
      disableAutoCompaction:
        this.loadedManifest.manifest.handoffs?.some(
          (policy) => policy.from === role && policy.mode === "trajectory",
        ) === true,
      ...(opts.handoffContextRef !== undefined && { handoffContextRef: opts.handoffContextRef }),
      delegateTool,
      ...(this.uiContext !== undefined && { uiContext: this.uiContext }),
      ...(this.isUiContextCurrent !== undefined && {
        isUiContextCurrent: this.isUiContextCurrent,
      }),
      ...(this.displaySink !== undefined && { displaySink: this.displaySink }),
      persistRecord: (record) => this.persistRecord(record),
      sessionStates: this.sessionStates,
      agentsBySessionId: this.agentsBySessionId,
    });
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
  ): Promise<RoleSession> {
    if (
      selected.schema_version !== 1 ||
      selected.target.system_prompt.length === 0 ||
      selected.target.active_tool_names.length === 0
    ) {
      throw new TrajectoryResumeError(
        "trajectory selector has incomplete persisted target environment",
      );
    }
    const resolved = resolveModel(role, selected.target.model, this.modelRegistry);
    const session = await spawnSharedSdkRoleSession({
      role,
      roleConfig,
      model: resolved.model,
      logicalModel: selected.target.model,
      effort: selected.target.requested_effort,
      retries: 0,
      retryDelayMs: 0,
      systemPrompt: selected.target.system_prompt,
      modelRegistry: this.modelRegistry,
      cwd: this.cwd,
      agentDir: this.agentDir,
      sessionDir: this.sessionDir,
      sessionManager: SessionManager.open(
        selected.source_conversation.file,
        this.sessionDir,
        this.cwd,
      ),
      roleSessionId: randomUUID(),
      isTrajectory: true,
      disableAutoCompaction:
        this.loadedManifest.manifest.handoffs?.some(
          (policy) => policy.from === role && policy.mode === "trajectory",
        ) === true,
      runId: this.runId,
      machineDefinition: this.loadedManifest.def,
      delegateTool: null,
      ...(this.uiContext !== undefined && { uiContext: this.uiContext }),
      ...(this.isUiContextCurrent !== undefined && {
        isUiContextCurrent: this.isUiContextCurrent,
      }),
      ...(this.displaySink !== undefined && { displaySink: this.displaySink }),
      persistRecord: (record) => this.persistRecord(record),
      sessionStates: this.sessionStates,
      agentsBySessionId: this.agentsBySessionId,
    });
    const actual = session.getTrajectoryContext?.().registeredToolNames ?? [];
    if (
      actual.length === 0 ||
      selected.target.active_tool_names.some((name) => !actual.includes(name))
    ) {
      await session.dispose();
      throw new TrajectoryResumeError("trajectory selector references unavailable target tools");
    }
    return session;
  }

  /** Build the existing delegation operation with the caller's constrained Git base. */
  private async createDelegateTool(
    role: Role,
    roleConfig: RoleConfig | undefined,
    primaryCheckout: string,
    parentVisitIndex: number | undefined,
  ): Promise<
    ReturnType<typeof import("./delegation/delegate-tool-factory.js").createDelegateTool>
  > {
    if (!hasDelegateConfiguration(roleConfig)) {
      throw new DelegateBridgeConfigError(`role '${String(role)}' is not authorized to delegate`);
    }
    if (parentVisitIndex === undefined) {
      throw new Error("delegation requires the loop-owned parent visitIndex");
    }
    const manifest = this.loadedManifest.manifest;
    const { createDelegateTool } = await import("./delegation/delegate-tool-factory.js");
    return createDelegateTool({
      role: roleConfig,
      subagents: manifest.subagents ?? [],
      remainingChildren: roleConfig.delegation.max_children_per_session,
      runId: this.runId,
      parentRole: role,
      parentVisitIndex,
      primaryCheckout,
      runStateDir: join(this.cwd, ".pi-conductor", "runs", this.runId),
      persistRecord: (record) => this.persistRecord(record),
      agentDir: this.agentDir,
      systemPromptRoot: delegationPromptRoot(this.loadedManifest, this.cwd),
      modelRegistry: this.modelRegistry,
      ...(this.displaySink !== undefined && { displaySink: this.displaySink }),
      sessionDir: this.sessionDir,
      manager: this.delegationManager,
    });
  }

  /** Adapt the existing delegate tool to the isolated role's RPC bridge. */
  private async createDelegateBridgeHandler(
    role: Role,
    roleConfig: RoleConfig | undefined,
    primaryCheckout: string,
    parentVisitIndex: number | undefined,
  ): Promise<DelegateBridgeHandler> {
    const delegateTool = await this.createDelegateTool(
      role,
      roleConfig,
      primaryCheckout,
      parentVisitIndex,
    );
    return async (args) =>
      adaptDelegateToolResult(
        await delegateTool.execute(
          "isolated-delegate-bridge",
          args,
          undefined,
          undefined,
          {} as ExtensionContext,
        ),
      );
  }

  /** Get or create this host's run-scoped immutable isolated-workspace pin. */
  private getOrCreateSnapshotPin(source: WorkspaceSource): Promise<SnapshotPinnedRecord> {
    if (this.snapshotPin !== null) return this.snapshotPin;

    // Register the promise before its callback resolves a moving source, so
    // concurrent isolated spawns share one read/validate-or-persist operation.
    this.snapshotPin = Promise.resolve().then(async () => {
      const persistedPin = readPersistedSnapshotPin(this.log.records(this.runId), this.runId);
      if (persistedPin !== null) {
        await assertPersistedSnapshotPinResolves(this.cwd, persistedPin);
        return persistedPin;
      }

      const commit = await resolvePinnedCommit(this.cwd, source);
      const pinned = snapshotPinned({ run_id: this.runId, source, commit });
      this.persistRecord(pinned);
      return pinned;
    });
    return this.snapshotPin;
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

  captureUsage(session: RoleSession): UsageRecord {
    // Read the session's cumulative §11.4 normalized usage from
    // the per-session `SessionState`. Returns zeros for a session
    // with no state (e.g., never registered, or already disposed).
    const state = this.sessionStates.get(session.sessionId);
    return (
      state?.usage() ?? { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 }
    );
  }

  sessionTerminalReason(session: RoleSession): SessionTerminalReason {
    // Read the host-set terminal reason (cap exceeded, model
    // error, or null if the session ended normally). The loop
    // uses this to set `session_failed.failure_reason`.
    const state = this.sessionStates.get(session.sessionId);
    return state?.terminalReason ?? null;
  }

  sessionFailureDetail(session: RoleSession): string | null {
    return this.sessionStates.get(session.sessionId)?.failureDetail ?? null;
  }

  persistRecord(record: PersistedRecord): void {
    // Append-only: the host is the sole writer (the loop and delegated
    // child lifecycle callbacks use this seam for durable records).
    this.log.append(record);
    notifyListeners(record); // spec §4.1 — fan-out after durable append
  }

  seedRunMemory(args: {
    readonly checkpoint: Checkpoint;
    readonly def: MachineDefinition;
    readonly goal: string;
    readonly runCostCap: number | null;
  }): RunMemory {
    // Delegate to the core's `buildRunMemory` so the
    // orchestrator's seed reflects the actual persisted record
    // history (visit_history, per_role_cost, next_candidates).
    // The host owns its log; this is the canonical seam for
    // the loop's orchestrator-seed injection (Task 16.5, §8.4
    // single-writer rule).
    const records = this.log.records(this.runId);
    return buildRunMemory(args.checkpoint, records, args.def, {
      goal: args.goal,
      runCostCap: args.runCostCap,
    });
  }

  nextVisitIndex(role: Role): number {
    // Count terminals (session_ended + session_failed) for the
    // role. A model retry (Task 18) is the SAME visit with a
    // different model — the role didn't transition, it re-ran.
    // Counting session_started would inflate visit_index on
    // every model retry within the same visit. The visit ends
    // when the role transitions away or is abandoned.
    return (
      this.log
        .records(this.runId)
        .filter(
          (r) => (r.type === "session_ended" || r.type === "session_failed") && r.role === role,
        ).length + 1
    );
  }

  getNextModel(role: Role, currentModelIndex: number): string | null {
    // Read the role's `models[]` list and return the entry at
    // `currentModelIndex + 1`, or `null` if exhausted (or the
    // role has no `models` field). The loop uses this to
    // populate the `model_fallback` record's `to_model` field.
    const roleConfig = this.lookupRoleConfig(role);
    if (roleConfig?.models === undefined) return null;
    const next = roleConfig.models[currentModelIndex + 1];
    return next?.model ?? null;
  }

  /** Select and prepare a policy-declared shared-session continuation (Issue #63). */
  async selectAcceptedHandoffTransport(args: {
    readonly from: Role;
    readonly to: Role;
    readonly source: RoleSession;
    readonly targetSeed: string;
    readonly targetVisitIndex: number;
  }): Promise<
    { readonly mode: "fresh" } | { readonly mode: "trajectory"; readonly session: RoleSession }
  > {
    if (modeFor(this.loadedManifest.manifest.handoffs, args.from, args.to) === "fresh") {
      return { mode: "fresh" };
    }

    const sourceConversation = {
      id: args.source.conversationId ?? args.source.sessionId,
      file: args.source.sessionFile,
    };
    try {
      const sourceContext = args.source.getTrajectoryContext?.();
      if (sourceContext === undefined || args.source.continueTrajectory === undefined) {
        throw new TrajectoryHandoffError(
          "trajectory_environment_unsupported",
          "trajectory source is not a shared SDK session with a rebindable host bridge",
        );
      }
      const sourceRole = this.lookupRoleConfig(args.from);
      const targetRole = this.lookupRoleConfig(args.to);
      if (
        (sourceRole?.workspace?.backend ?? "shared") !== "shared" ||
        (targetRole?.workspace?.backend ?? "shared") !== "shared" ||
        hasDelegateConfiguration(sourceRole) ||
        hasDelegateConfiguration(targetRole) ||
        sourceRole?.workspace?.progressive_disclosure !== undefined ||
        targetRole?.workspace?.progressive_disclosure !== undefined
      ) {
        throw new TrajectoryHandoffError(
          "trajectory_environment_unsupported",
          "trajectory requires shared workspaces and no role-specific custom-tool bridge",
        );
      }
      const modelEntry = targetRole?.models?.[0];
      if (modelEntry === undefined) {
        throw new TrajectoryHandoffError(
          "trajectory_target_environment_invalid",
          `trajectory target '${args.to}' has no explicit model`,
        );
      }
      const resolved = resolveModel(args.to, modelEntry.model, this.modelRegistry);
      const targetPrompt = await loadSystemPrompt(
        args.to,
        targetRole?.system_prompt,
        this.cwd,
        this.loadedManifest.manifestDir,
        this.loadedManifest.manifestVersion,
      );
      if (targetPrompt === null) {
        throw new TrajectoryHandoffError(
          "trajectory_target_environment_invalid",
          `trajectory target '${args.to}' has no explicit system prompt`,
        );
      }
      const activeToolNames = buildToolsAllowlist(targetRole?.tools, false);
      const missingTool = activeToolNames.find(
        (name) => !sourceContext.registeredToolNames.includes(name),
      );
      if (missingTool !== undefined) {
        throw new TrajectoryHandoffError(
          "trajectory_environment_unsupported",
          `trajectory target tool '${missingTool}' is unavailable in the source registry`,
        );
      }
      const activeToolDefinitions = activeToolNames.map((name) => {
        const definition = sourceContext.toolDefinitions[name];
        if (definition === undefined) {
          throw new TrajectoryHandoffError(
            "trajectory_environment_unsupported",
            `trajectory target tool '${name}' has no provider-visible definition`,
          );
        }
        return definition;
      });
      const admission = admitTrajectory({
        source: sourceContext,
        targetModel: resolved.model,
        targetModelName: resolved.logical,
        systemPrompt: targetPrompt,
        activeToolNames,
        activeToolDefinitions,
        targetSeed: args.targetSeed,
      });
      const environmentSha = sha256Canonical({
        system_prompt: targetPrompt,
        model: resolved.logical,
        effort: modelEntry.effort,
        active_tool_names: activeToolNames,
        active_tool_definitions: activeToolDefinitions,
      });
      this.persistRecord({
        type: "handoff_transport_selected",
        schema_version: 1,
        run_id: this.runId,
        source_role_session_id: args.source.sessionId,
        from: args.from,
        to: args.to,
        mode: "trajectory",
        source_conversation: sourceConversation,
        target: {
          model: resolved.logical,
          requested_effort: modelEntry.effort,
          system_prompt: targetPrompt,
          active_tool_names: activeToolNames,
          environment_sha256: environmentSha,
        },
        admission,
        ts: Date.now(),
      });
      const session = await args.source.continueTrajectory({
        role: args.to,
        model: resolved.model,
        logicalModel: resolved.logical,
        effort: modelEntry.effort,
        systemPrompt: targetPrompt,
        activeToolNames,
        visitIndex: args.targetVisitIndex,
        maxSessionCostUsd: targetRole?.max_session_cost_usd ?? null,
      });
      return { mode: "trajectory", session };
    } catch (error) {
      const code =
        error instanceof TrajectoryHandoffError ? error.code : "trajectory_environment_unsupported";
      const message = error instanceof Error ? error.message : String(error);
      this.persistRecord({
        type: "trajectory_handoff_failed",
        schema_version: 1,
        run_id: this.runId,
        from: args.from,
        to: args.to,
        source_conversation: sourceConversation,
        code,
        message,
        ts: Date.now(),
      });
      if (error instanceof TrajectoryHandoffError) throw error;
      throw new TrajectoryHandoffError(code, message);
    }
  }

  runCostSoFar(): number {
    // Sum `usage.cost` across all terminal records in the run:
    // - Parent lifecycle terminals: session_ended + session_failed (§11.4).
    // - Delegation lite §7: child terminals also cost against the run cap.
    //   Both subagent_completed and subagent_failed contribute.
    let total = 0;
    for (const r of this.log.records(this.runId)) {
      if ((r.type === "session_ended" || r.type === "session_failed") && r.usage) {
        total += r.usage.cost;
      }
      if ((r.type === "subagent_completed" || r.type === "subagent_failed") && r.usage) {
        total += r.usage.cost;
      }
    }
    return total;
  }

  async abortSession(session: RoleSession, _reason: string): Promise<void> {
    await this.delegationManager.abortAll();
    const state = this.sessionStates.get(session.sessionId);
    const agent = this.agentsBySessionId.get(session.sessionId);
    if (state === undefined || agent === undefined) return;
    if (state.terminalReason !== null) return;
    state.markAborted();
    state.setTerminalReason("user_aborted");
    await agent.abort();
  }

  sealSession(_session: RoleSession): void {
    // No-op: sealing is owned by the handoff/end tool wrapper
    // (Task 15.5) flipping `SessionSeam.isSealed`. This method
    // is reserved for external consumers.
  }

  /** Route declared handoff artifacts before the receiver's first prompt (Issue #48 R4.a). */
  async routeAcceptedHandoffArtifacts(
    source: ArtifactRouteSource,
    receiver: RoleSession,
  ): Promise<string | null> {
    const records = this.log.records(this.runId);
    const collected = records.filter(
      (record): record is ArtifactCollectedRecord =>
        record.type === "artifact_collected" &&
        record.kind === "declared" &&
        record.role === source.role &&
        record.visit_index === source.visitIndex &&
        record.session_id === source.sessionId,
    );
    const rejected = records.filter(
      (record): record is ArtifactRejectedRecord =>
        record.type === "artifact_rejected" &&
        record.role === source.role &&
        record.session_id === source.sessionId,
    );
    const routed = await materializeArtifacts({
      artifactsDir: join(this.cwd, ".pi-conductor", "runs", this.runId, "artifacts", this.runId),
      emittingRole: source.role,
      emittingVisitIndex: source.visitIndex,
      receiverWorkspace: receiver.workspace?.path_or_image ?? this.cwd,
      isReceiverIsolated: receiver.workspace !== undefined,
      collected,
    });
    return formatArtifactsSeedSection({
      emittingRole: source.role,
      emittingVisitIndex: source.visitIndex,
      routed,
      rejected,
    });
  }

  /** Collect isolated-session artifacts before the loop can spawn a successor (§7.2). */
  async collectTerminalArtifacts(
    session: RoleSession,
    args: {
      readonly role: Role;
      readonly visitIndex: number;
      readonly terminal: "session_ended" | "session_failed";
      readonly handoff?: import("../seam/schema.js").HandoffArgs;
    },
  ): Promise<void> {
    const context = session.artifactCollection;
    if (context === undefined) return;
    if (session.role !== args.role) {
      throw new Error(
        `artifact collection session role '${String(session.role)}' does not match loop role '${String(args.role)}'`,
      );
    }
    const priorPatchCount = this.log
      .records(this.runId)
      .filter(
        (record) =>
          record.type === "artifact_collected" &&
          record.kind === "auto_patch" &&
          record.role === args.role &&
          record.visit_index === args.visitIndex,
      ).length;
    const patchFileName =
      priorPatchCount === 0
        ? undefined
        : `patch-${args.role}-v${args.visitIndex}-${priorPatchCount}-${createHash("sha256")
            .update(session.sessionId)
            .digest("hex")
            .slice(0, 12)}.patch`;
    await collectTerminalArtifactsFromWorkspace({
      context,
      artifactsDir: join(this.cwd, ".pi-conductor", "runs", this.runId, "artifacts", this.runId),
      runId: this.runId,
      role: args.role,
      visitIndex: args.visitIndex,
      sessionId: session.sessionId,
      ...(args.handoff !== undefined && { handoff: args.handoff }),
      ...(patchFileName !== undefined && { patchFileName }),
      persistRecord: (record) => this.persistRecord(record),
    });
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

function hasDelegateConfiguration(
  roleConfig: RoleConfig | undefined,
): roleConfig is RoleConfig & { readonly delegation: NonNullable<RoleConfig["delegation"]> } {
  return roleConfig?.delegation !== undefined && roleConfig.tools?.includes("delegate") === true;
}

function delegationPromptRoot(loaded: LoadedManifest, cwd: string): string {
  if (loaded.manifestVersion < 2) return cwd;
  if (loaded.manifestDir === null) {
    throw new Error("delegation requires a manifest directory for v2 profile system prompts");
  }
  return loaded.manifestDir;
}
