/** Host-side durable context retention for an isolated RPC role session. */

import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelEffort, Role, UsageRecord } from "../core/types.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import type {
  ContextCompactionRecord,
  ContextCompactionStartedRecord,
} from "../persistence/orchestrator-context.js";
import { assertOrchestratorContextRecord } from "../persistence/orchestrator-context.js";
import { queryOrchestratorContext } from "../persistence/orchestrator-context-query.js";
import { addUsage, normalizeUsage, ZERO_USAGE } from "./cost.js";
import {
  OrchestratorContextCoordinator,
  type RetainedContextAttachment,
} from "./orchestrator-context-coordinator.js";
import {
  type RpcContextOutcomePayload,
  type RpcContextRetentionBridge,
  RpcContextRetentionHost,
  type RpcContextSettledPayload,
  type RpcContextStartPayload,
} from "./rpc/context-retention-bridge.js";

/** Inputs needed to prepare an isolated retained-context child. */
export interface IsolatedContextRetentionOptions {
  readonly log: RecordLog;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly runId: string;
  readonly role: Role;
  readonly visitIndex: number;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly childCwd: string;
  readonly childSessionDir: string;
  readonly childAgentDir: string;
  readonly machineToolsConfigPath: string;
  readonly model: string | null;
  readonly effort: ModelEffort;
  readonly systemPrompt: string | null;
  readonly onUsage?: (requestId: string, usage: UsageRecord | null) => void;
}

/** Prepared bridge/config data consumed by the isolated RPC factory. */
export interface PreparedIsolatedContextRetention {
  readonly contextConfigPath: string;
  readonly contextRetention: RpcContextRetentionBridge;
  readonly attach: (identity: {
    /** Logical host role-session identity persisted in compaction records. */
    readonly roleSessionId: string;
    /** Physical Pi conversation identity emitted by the child settlement frame. */
    readonly physicalSessionId: string;
    readonly conversationId: string;
    readonly sessionFile: string;
  }) => void;
  readonly wrapPrompt: (prompt: (seed: string) => Promise<void>) => (seed: string) => Promise<void>;
  readonly retainedContext: NonNullable<
    import("./role-session-contract.js").RoleSession["retainedContext"]
  >;
  readonly close: () => Promise<void>;
}

/** Prepare a strict isolated context child before the first prompt. */
export async function prepareIsolatedContextRetention(
  options: IsolatedContextRetentionOptions,
): Promise<PreparedIsolatedContextRetention> {
  const coordinator = new OrchestratorContextCoordinator({
    log: options.log,
    persistRecord: options.persistRecord,
    runId: options.runId,
    role: options.role,
    sessionDir: options.childSessionDir,
    cwd: options.childCwd,
    agentDir: options.childAgentDir,
  });
  const prepared = await coordinator.prepare();
  const bridgeDirectory = join(
    options.sessionDir,
    "context-retention",
    `${options.role}-v${options.visitIndex}-${randomUUID()}`,
  );
  await mkdir(bridgeDirectory, { recursive: true, mode: 0o700 });
  await chmod(bridgeDirectory, 0o700);

  let attachment: RetainedContextAttachment | null = null;
  let identity: {
    readonly roleSessionId: string;
    readonly physicalSessionId: string;
    readonly conversationId: string;
    readonly sessionFile: string;
  } | null = null;
  let settled = false;
  let settlementError: Error | undefined;
  let compactionUsage: UsageRecord = ZERO_USAGE;
  let resolveSettled: (() => void) | null = null;
  let settledPromise = Promise.resolve();
  const resetSettlement = (): void => {
    settled = false;
    settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
  };
  resetSettlement();
  const requireAttachment = (): RetainedContextAttachment => {
    if (attachment === null || identity === null) {
      throw new Error("isolated retained context was used before child identity attachment");
    }
    return attachment;
  };
  const persistCompactionStart = (payload: RpcContextStartPayload): void => {
    const current = requireAttachment();
    void current;
    const attachedIdentity = identity;
    if (attachedIdentity === null)
      throw new Error("isolated retained context identity is unavailable");
    const { requestId, beforeTip } = payload;
    const record = {
      schema_version: 1,
      type: "context_compaction_started",
      run_id: options.runId,
      role: options.role,
      epoch: prepared.epoch,
      role_session_id: attachedIdentity.roleSessionId,
      request_id: requestId,
      before_leaf_id: beforeTip,
      ts: Date.now(),
    } satisfies ContextCompactionStartedRecord;
    assertOrchestratorContextRecord(record);
    queryOrchestratorContext(
      [...options.log.records(options.runId), record],
      options.runId,
      options.role,
    );
    options.persistRecord(record);
  };
  const persistCompactionOutcome = (payload: RpcContextOutcomePayload): void => {
    const current = requireAttachment();
    void current;
    const attachedIdentity = identity;
    if (attachedIdentity === null)
      throw new Error("isolated retained context identity is unavailable");
    const { requestId, beforeTip, afterTip = null } = payload;
    const usage = payload.usage;
    const normalizedRawUsages = validateRpcCompactionUsage(payload);
    const record = {
      schema_version: 1,
      type: "context_compaction",
      run_id: options.runId,
      role: options.role,
      epoch: prepared.epoch,
      role_session_id: attachedIdentity.roleSessionId,
      request_id: requestId,
      outcome: payload.error === undefined ? "completed" : "failed",
      usage,
      diagnostic: payload.error ?? null,
      before_leaf_id: beforeTip,
      after_leaf_id: afterTip,
      ts: Date.now(),
    } satisfies ContextCompactionRecord;
    assertOrchestratorContextRecord(record);
    queryOrchestratorContext(
      [...options.log.records(options.runId), record],
      options.runId,
      options.role,
    );
    for (let index = 0; index < normalizedRawUsages.length; index += 1) {
      const rawUsage = normalizedRawUsages[index];
      if (rawUsage === undefined) throw new Error("context compaction raw usage disappeared");
      options.onUsage?.(`${requestId}:${index}`, rawUsage);
    }
    let knownRawUsage = ZERO_USAGE;
    for (const rawUsage of normalizedRawUsages) {
      if (rawUsage !== null) knownRawUsage = addUsage(knownRawUsage, rawUsage);
    }
    compactionUsage = addUsage(compactionUsage, knownRawUsage);
    options.persistRecord(record);
  };
  const failSettlement = (message: string): void => {
    settlementError = new Error(message);
    settled = true;
    resolveSettled?.();
    resolveSettled = null;
  };
  const host = await RpcContextRetentionHost.create(bridgeDirectory, {
    start: persistCompactionStart,
    outcome: persistCompactionOutcome,
    settled: (payload: RpcContextSettledPayload) => {
      const current = requireAttachment();
      void current;
      if (payload.sessionId !== identity?.physicalSessionId) {
        failSettlement("isolated retained context settled physical identity mismatch");
        return;
      }
      if (payload.conversationId !== identity?.conversationId) {
        failSettlement("isolated retained context settled conversation mismatch");
        return;
      }
      if (payload.sessionFile !== identity?.sessionFile) {
        failSettlement("isolated retained context settled file mismatch");
        return;
      }
      if (payload.error !== undefined) {
        failSettlement(`isolated child settlement failed: ${payload.error}`);
        return;
      }
      try {
        prepared.sessionManager.setSessionFile(identity.sessionFile);
        if (prepared.sessionManager.getLeafId() !== payload.leafId) {
          failSettlement("isolated retained context settled leaf mismatch");
          return;
        }
      } catch (error) {
        failSettlement(
          `isolated retained context settled file could not be reloaded: ${String(error)}`,
        );
        return;
      }
      settled = true;
      resolveSettled?.();
      resolveSettled = null;
    },
  });

  const contextConfigPath = join(bridgeDirectory, "child-config.json");
  const sourceSessionFile =
    prepared.sourceBoundary === null ? undefined : prepared.sessionManager.getSessionFile();
  const config = {
    cwd: options.childCwd,
    agentDir: options.childAgentDir,
    sessionDir: options.childSessionDir,
    ...(sourceSessionFile === undefined ? {} : { sessionFile: sourceSessionFile }),
    ...(sourceSessionFile === undefined
      ? {}
      : { conversationId: prepared.sessionManager.getSessionId() }),
    bridgeDirectory,
    ...(options.model === null ? {} : { model: options.model }),
    effort: options.effort,
    ...(options.systemPrompt === null ? {} : { systemPrompt: options.systemPrompt }),
    machineToolsConfigPath: options.machineToolsConfigPath,
    pinnedCompaction: prepared.settingsManager.getCompactionSettings(),
  };
  await writeFile(contextConfigPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });

  return {
    contextConfigPath,
    contextRetention: {
      onStart: () => undefined,
      onUsage: () => undefined,
      onObservation: () => undefined,
      getCompactionUsage: () => compactionUsage,
      settle: async () => {
        if (settled) {
          host.assertHealthy();
          if (settlementError !== undefined) throw settlementError;
          return;
        }
        host.assertHealthy();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            settledPromise,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error("isolated retained context settlement timed out")),
                5_000,
              );
            }),
          ]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
        host.assertHealthy();
        if (settlementError !== undefined) throw settlementError;
      },
      assertHealthy: () => {
        host.assertHealthy();
        if (settlementError !== undefined) throw settlementError;
      },
    },
    attach: (nextIdentity) => {
      if (identity !== null) throw new Error("isolated retained context attached twice");
      identity = Object.freeze({ ...nextIdentity });
      attachment = coordinator.attach(prepared, {
        ...nextIdentity,
        model: options.model,
      });
    },
    wrapPrompt: (prompt) => async (seed) => {
      const current = requireAttachment();
      host.assertHealthy();
      if (settlementError !== undefined) throw settlementError;
      resetSettlement();
      const sessionFile = identity?.sessionFile;
      if (sessionFile === undefined)
        throw new Error("isolated retained context has no session file");
      const promptResult = current.prompt(seed, async (text) => {
        let promptError: unknown;
        try {
          await prompt(text);
        } catch (error) {
          promptError = error;
        }
        try {
          await access(sessionFile);
          prepared.sessionManager.setSessionFile(sessionFile);
        } catch (error) {
          if (promptError === undefined && (error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        if (promptError !== undefined) {
          throw promptError;
        }
      });
      await promptResult;
    },
    get retainedContext() {
      return requireAttachment().retainedContext;
    },
    close: async () => {
      await host.close();
    },
  };
}

function sameUsage(left: UsageRecord, right: UsageRecord): boolean {
  return (Object.keys(left) as (keyof UsageRecord)[]).every((key) => left[key] === right[key]);
}

/** Validate that a child aggregate is consistent with its raw provider observations. */
export function validateRpcCompactionUsage(
  payload: Pick<RpcContextOutcomePayload, "usage" | "rawUsages">,
): readonly (UsageRecord | null)[] {
  const normalized = payload.rawUsages.map((rawUsage) =>
    rawUsage === null ? null : normalizeUsage(rawUsage),
  );
  const known = normalized.filter((rawUsage): rawUsage is UsageRecord => rawUsage !== null);
  if (normalized.some((rawUsage) => rawUsage === null)) {
    if (payload.usage !== null) {
      throw new Error("context compaction aggregate must be unknown when a raw usage is unknown");
    }
  } else if (payload.usage !== null) {
    const aggregate = known.reduce(addUsage, ZERO_USAGE);
    if (!sameUsage(aggregate, payload.usage)) {
      throw new Error("context compaction aggregate does not match raw usages");
    }
  } else if (known.length > 0) {
    throw new Error("context compaction aggregate is unknown despite known raw usages");
  }
  return normalized;
}
