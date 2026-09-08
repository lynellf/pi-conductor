/** Delegation tool construction with explicit ProductionHost dependencies. */
import { join } from "node:path";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Role } from "../core/types.js";
import type { RoleConfig, WorkspaceSource } from "../manifest/types.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import { type SnapshotPinnedRecord, snapshotPinned } from "../persistence/log.js";
import type { PoolChildResult } from "./delegation/pool.js";
import type { ProductionDelegationCoordinator } from "./delegation/production-delegation.js";
import type { DisplaySink } from "./display-sink.js";
import type { LoadedManifest } from "./manifest.js";
import type { DelegateBridgeHandler, DelegateBridgeResult } from "./rpc/delegate-bridge.js";
import { DelegateBridgeConfigError } from "./rpc/delegate-bridge.js";
import {
  assertPersistedSnapshotPinResolves,
  readPersistedSnapshotPin,
  resolvePinnedCommit,
} from "./workspace/index.js";
/** Dependencies for constructing and adapting delegation tools. */
export interface DelegateHostContext {
  readonly loadedManifest: LoadedManifest;
  readonly runId: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly modelRegistry: ModelRegistry;
  readonly displaySink: DisplaySink | undefined;
  readonly log: RecordLog;
  readonly delegation: ProductionDelegationCoordinator;
  readonly runCostSoFar: () => number;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly adaptDelegateToolResult: (result: {
    readonly content: readonly { readonly type: string }[];
    readonly details: unknown;
    readonly terminate?: boolean;
  }) => DelegateBridgeResult;
}

/** Reuse or persist the run's immutable workspace snapshot pin. */
export async function getOrCreateSnapshotPin(
  ctx: DelegateHostContext & {
    snapshotPin: Promise<SnapshotPinnedRecord> | null;
    setSnapshotPin: (pin: Promise<SnapshotPinnedRecord>) => void;
  },
  source: WorkspaceSource,
): Promise<SnapshotPinnedRecord> {
  if (ctx.snapshotPin !== null) return ctx.snapshotPin;
  const pin = Promise.resolve().then(async () => {
    const persistedPin = readPersistedSnapshotPin(ctx.log.records(ctx.runId), ctx.runId);
    if (persistedPin !== null) {
      await assertPersistedSnapshotPinResolves(ctx.cwd, persistedPin);
      return persistedPin;
    }
    const commit = await resolvePinnedCommit(ctx.cwd, source);
    const pinned = snapshotPinned({ run_id: ctx.runId, source, commit });
    ctx.persistRecord(pinned);
    return pinned;
  });
  ctx.setSnapshotPin(pin);
  return pin;
}
/** Create the loop-owned delegate tool for a role session. */
export async function createDelegateTool(
  ctx: DelegateHostContext,
  role: Role,
  roleConfig: RoleConfig | undefined,
  primaryCheckout: string,
  parentVisitIndex: number | undefined,
  executionVisitIndex: number,
  getRunCostCap?: () => number | null,
  getCurrentParentUsage?: () => number,
  onTaskTerminal?: (result: PoolChildResult) => void,
  onFatal?: (cause: unknown) => void,
): Promise<ReturnType<typeof import("./delegation/delegate-tool-factory.js").createDelegateTool>> {
  if (!hasDelegateConfiguration(roleConfig)) {
    throw new DelegateBridgeConfigError(`role '${String(role)}' is not authorized to delegate`);
  }
  if (parentVisitIndex === undefined) {
    throw new Error("delegation requires the loop-owned parent visitIndex");
  }
  const manifest = ctx.loadedManifest.manifest;
  const factoryOptions = {
    role: roleConfig,
    subagents: manifest.subagents ?? [],
    remainingChildren: roleConfig.delegation.max_children_per_session,
    runId: ctx.runId,
    parentRole: role,
    parentVisitIndex,
    primaryCheckout,
    runStateDir: join(ctx.cwd, ".pi-conductor", "runs", ctx.runId),
    persistRecord: (record: PersistedRecord) => ctx.persistRecord(record),
    agentDir: ctx.agentDir,
    systemPromptRoot: delegationPromptRoot(ctx.loadedManifest, ctx.cwd),
    modelRegistry: ctx.modelRegistry,
    ...(ctx.displaySink !== undefined && { displaySink: ctx.displaySink }),
    sessionDir: ctx.sessionDir,
    records: () => ctx.log.records(ctx.runId),
    isBudgetExhausted: () => {
      const cap = getRunCostCap?.();
      if (cap === null || cap === undefined) return false;
      return ctx.runCostSoFar() + (getCurrentParentUsage?.() ?? 0) >= cap;
    },
    ...(onTaskTerminal === undefined ? {} : { onTaskTerminal }),
    ...(onFatal === undefined ? {} : { onFatal }),
  };
  return ctx.delegation.createTool(
    factoryOptions,
    JSON.stringify([ctx.runId, role, executionVisitIndex]),
  );
}

/** Adapt the existing delegate tool to the isolated role's RPC bridge. */
/** Adapt the delegate tool to the isolated role-session bridge. */
export async function createDelegateBridgeHandler(
  ctx: DelegateHostContext,
  role: Role,
  roleConfig: RoleConfig | undefined,
  primaryCheckout: string,
  parentVisitIndex: number | undefined,
  executionVisitIndex: number,
  getRunCostCap?: () => number | null,
  getCurrentParentUsage?: () => number,
  onTaskTerminal?: (result: PoolChildResult) => void,
  onFatal?: (cause: unknown) => void,
): Promise<DelegateBridgeHandler> {
  const delegateTool = await createDelegateTool(
    ctx,
    role,
    roleConfig,
    primaryCheckout,
    parentVisitIndex,
    executionVisitIndex,
    getRunCostCap,
    getCurrentParentUsage,
    onTaskTerminal,
    onFatal,
  );
  return async (args, toolCallId) =>
    ctx.adaptDelegateToolResult(
      await delegateTool.execute(toolCallId, args, undefined, undefined, {} as ExtensionContext),
    );
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
