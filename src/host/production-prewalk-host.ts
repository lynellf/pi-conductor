/** ProductionHost adapter for one logical Prewalk visit backed by phase sessions. */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Role, UsageRecord } from "../core/types.js";
import type { ModelConfig, RoleConfig } from "../manifest/types.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import type { SessionState } from "./cost.js";
import type { DisplaySink } from "./display-sink.js";
import type { RoleSession, SessionTerminalReason } from "./host.js";
import type { LoadedManifest } from "./manifest.js";
import { dispatchProductionPrewalk } from "./production-prewalk-dispatch.js";
import type { RoleTurnProducer } from "./role-turn-producer.js";
import type { SessionEventSource } from "./session-event-handler.js";

interface ProductionPrewalkOwner {
  readonly modelRegistry: ModelRegistry;
  readonly cwd: string;
  readonly log: RecordLog;
  readonly loadedManifest: LoadedManifest;
  readonly runId: string;
  readonly uiContext: ExtensionUIContext | undefined;
  readonly isUiContextCurrent: (() => boolean) | undefined;
  readonly displaySink: DisplaySink | undefined;
  readonly sessionDir: string;
  readonly agentDir: string;
  persistRecord(record: PersistedRecord): void;
}

interface ProductionPrewalkRole {
  readonly role: Role;
  readonly roleConfig: RoleConfig | undefined;
  readonly entry: ModelConfig | null;
  readonly executorModel: Model<never> | undefined;
  readonly executorLogical: string | null;
  readonly baseSystemPrompt: string | null;
  readonly visitIndex: number;
  readonly roleTurnProducer: RoleTurnProducer;
}

interface PrewalkUsageSessions {
  readonly sessionIds: readonly string[];
  readonly priorUsage: UsageRecord;
}

/** Owns Prewalk dispatch and logical-to-phase session state for ProductionHost. */
export class ProductionPrewalkHost {
  private readonly sessions = new WeakMap<RoleSession, PrewalkUsageSessions>();

  constructor(
    private readonly sessionStates: Map<string, SessionState>,
    private readonly agentsBySessionId: Map<string, SessionEventSource>,
  ) {}

  /** Dispatch an eligible fresh or resumed Prewalk visit. */
  async dispatch(
    owner: ProductionPrewalkOwner,
    role: ProductionPrewalkRole,
  ): Promise<RoleSession | null> {
    const prewalk = await dispatchProductionPrewalk({
      runId: owner.runId,
      role: role.role,
      roleConfig: role.roleConfig,
      entry: role.entry,
      executorModel: role.executorModel,
      executorLogical: role.executorLogical,
      baseSystemPrompt: role.baseSystemPrompt,
      visitIndex: role.visitIndex,
      validationContext: owner.loadedManifest.prewalkValidationContext?.prewalk?.[role.role],
      modelRegistry: owner.modelRegistry,
      cwd: owner.cwd,
      agentDir: owner.agentDir,
      sessionDir: owner.sessionDir,
      machineDefinition: owner.loadedManifest.def,
      ...(owner.uiContext !== undefined && { uiContext: owner.uiContext }),
      ...(owner.isUiContextCurrent !== undefined && {
        isUiContextCurrent: owner.isUiContextCurrent,
      }),
      ...(owner.displaySink !== undefined && { displaySink: owner.displaySink }),
      records: () => owner.log.records(owner.runId),
      usageFor: (sessionId) => this.sessionStates.get(sessionId)?.usage() ?? ZERO_USAGE,
      persist: (record) => owner.persistRecord(record),
      sessionStates: this.sessionStates,
      agentsBySessionId: this.agentsBySessionId,
      roleTurnProducer: role.roleTurnProducer,
    });
    if (prewalk === null) return null;
    this.sessions.set(prewalk.session, {
      sessionIds: prewalk.usageSessionIds,
      priorUsage: prewalk.priorUsage ?? ZERO_USAGE,
    });
    return prewalk.session;
  }

  /** Capture aggregate usage across the physical sessions in one logical visit. */
  captureUsage(session: RoleSession): UsageRecord {
    const prewalk = this.sessions.get(session);
    if (prewalk === undefined) {
      return this.sessionStates.get(session.sessionId)?.usage() ?? freshZeroUsage();
    }
    return prewalk.sessionIds.reduce(
      (total, sessionId) =>
        addUsage(total, this.sessionStates.get(sessionId)?.usage() ?? ZERO_USAGE),
      prewalk.priorUsage,
    );
  }

  /** Read the latest terminal reason across the physical phase sessions. */
  sessionTerminalReason(session: RoleSession): SessionTerminalReason {
    const prewalk = this.sessions.get(session);
    if (prewalk === undefined) {
      return this.sessionStates.get(session.sessionId)?.terminalReason ?? null;
    }
    for (let index = prewalk.sessionIds.length - 1; index >= 0; index -= 1) {
      const reason = this.sessionStates.get(prewalk.sessionIds[index] as string)?.terminalReason;
      if (reason !== undefined && reason !== null) return reason;
    }
    return null;
  }

  /** Read failure detail from the active phase session. */
  sessionFailureDetail(session: RoleSession): string | null {
    return this.sessionStates.get(this.activeSessionId(session))?.failureDetail ?? null;
  }

  /** Abort the active physical phase session. */
  async abort(session: RoleSession): Promise<void> {
    const sessionId = this.activeSessionId(session);
    const state = this.sessionStates.get(sessionId);
    const agent = this.agentsBySessionId.get(sessionId);
    if (state === undefined || agent === undefined || state.terminalReason !== null) return;
    state.markAborted();
    state.setTerminalReason("user_aborted");
    await agent.abort();
  }

  private activeSessionId(session: RoleSession): string {
    return this.sessions.get(session)?.sessionIds.at(-1) ?? session.sessionId;
  }
}

const ZERO_USAGE: UsageRecord = Object.freeze(freshZeroUsage());

function freshZeroUsage(): UsageRecord {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
}

function addUsage(left: UsageRecord, right: UsageRecord): UsageRecord {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cache_read: left.cache_read + right.cache_read,
    cache_write: left.cache_write + right.cache_write,
    tokens: left.tokens + right.tokens,
    cost: left.cost + right.cost,
  };
}
