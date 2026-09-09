import { createHash, randomUUID } from "node:crypto";

import {
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Role } from "../core/types.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import type {
  ContextBoundaryCommittedRecord,
  ContextBoundaryReference,
  ContextEpochStartedRecord,
  ContextInvocationStartedRecord,
} from "../persistence/orchestrator-context.js";
import {
  assertRestorableOrchestratorContext,
  queryOrchestratorContext,
} from "../persistence/orchestrator-context-query.js";
import {
  captureOrchestratorContextBoundary,
  restoreOrchestratorContextBoundary,
} from "./orchestrator-context-files.js";
import {
  type CompactionSettingsSnapshot,
  captureCompactionSettings,
  createPinnedCompactionSettings,
} from "./orchestrator-context-settings.js";

/** Prepared durable context and the pinned SDK managers for one invocation. */
export interface PreparedOrchestratorContext {
  readonly sessionManager: SessionManager;
  readonly settingsManager: ReturnType<typeof createPinnedCompactionSettings>;
  readonly sourceBoundary: ContextBoundaryReference | null;
  readonly epoch: number;
}

/** Host-owned inputs for selecting and recording retained context. */
export interface OrchestratorContextCoordinatorOptions {
  readonly log: RecordLog;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly runId: string;
  readonly role: Role;
  readonly sessionDir: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly compaction?: CompactionSettingsSnapshot;
  readonly now?: () => number;
}

/** Coordinates durable context provenance around one retained role invocation. */
export class OrchestratorContextCoordinator {
  private readonly now: () => number;
  private readonly options: OrchestratorContextCoordinatorOptions;

  constructor(options: OrchestratorContextCoordinatorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Select an exact committed boundary or create a durable empty epoch. */
  async prepare(): Promise<PreparedOrchestratorContext> {
    const records = this.options.log.records(this.options.runId);
    const existing = queryOrchestratorContext(records, this.options.runId, this.options.role);
    let epoch = existing.epoch;
    if (epoch === null) {
      const executed = records.some(
        (record) =>
          record.type.startsWith("context_") ||
          record.type === "session_started" ||
          record.type === "session_ended" ||
          record.type === "session_failed",
      );
      if (executed) {
        throw new Error(
          `retained context epoch is missing for executed run ${this.options.runId}/${this.options.role}`,
        );
      }
      const settings = this.effectiveSettings();
      epoch = {
        schema_version: 1,
        type: "context_epoch_started",
        run_id: this.options.runId,
        role: this.options.role,
        epoch: 1,
        reason: "start",
        previous_epoch: null,
        compaction: {
          enabled: settings.enabled,
          reserve_tokens: settings.reserveTokens,
          keep_recent_tokens: settings.keepRecentTokens,
        },
        ts: this.now(),
      } satisfies ContextEpochStartedRecord;
      this.options.persistRecord(epoch);
    } else {
      assertRestorableOrchestratorContext(records, this.options.runId, this.options.role);
    }

    const settings = createPinnedCompactionSettings(
      this.options.cwd,
      this.options.agentDir,
      toSnapshot(epoch.compaction),
    );
    if (existing.boundary === null) {
      return {
        sessionManager: SessionManager.create(this.options.cwd, this.options.sessionDir),
        settingsManager: settings,
        sourceBoundary: null,
        epoch: epoch.epoch,
      };
    }
    const restored = await restoreOrchestratorContextBoundary({
      boundary: existing.boundary,
      destinationSessionDir: this.options.sessionDir,
      cwd: this.options.cwd,
    });
    return {
      sessionManager: restored.manager,
      settingsManager: settings,
      sourceBoundary: existing.boundary === null ? null : toBoundaryReference(existing.boundary),
      epoch: epoch.epoch,
    };
  }

  /** Persist invocation identity after the SDK has selected its physical session. */
  attach(
    prepared: PreparedOrchestratorContext,
    identity: {
      readonly roleSessionId: string;
      readonly conversationId: string;
      readonly sessionFile: string;
      readonly model: string | null;
    },
  ): RetainedContextAttachment {
    const invocation = {
      schema_version: 1,
      type: "context_invocation_started",
      run_id: this.options.runId,
      role: this.options.role,
      epoch: prepared.epoch,
      role_session_id: identity.roleSessionId,
      conversation_id: identity.conversationId,
      session_file: identity.sessionFile,
      model: identity.model,
      source_boundary: prepared.sourceBoundary,
      ts: this.now(),
    } satisfies ContextInvocationStartedRecord;
    this.options.persistRecord(invocation);
    let beforePromptLeaf = prepared.sessionManager.getLeafId();
    let deliveryLeaf: string | null = null;
    let deliveredSeed: string | null = null;
    const attachment: RetainedContextAttachment = {
      delivered: false,
      prompt: async (text, invoke) => {
        let failure: unknown;
        try {
          await invoke(text);
        } catch (error) {
          failure = error;
        }
        if (!attachment.delivered) {
          const deliveredLeaf = findDeliveredUserEntry(
            prepared.sessionManager,
            beforePromptLeaf,
            text,
          );
          if (deliveredLeaf === null) {
            if (failure !== undefined) throw failure;
            throw new Error("retained context prompt did not append its seed message");
          }
          this.options.persistRecord({
            schema_version: 1,
            type: "context_delivery_committed",
            run_id: this.options.runId,
            role: this.options.role,
            epoch: prepared.epoch,
            role_session_id: identity.roleSessionId,
            conversation_id: identity.conversationId,
            session_file: identity.sessionFile,
            delivery_id: randomUUID(),
            seed_sha256: createHash("sha256").update(text).digest("hex"),
            leaf_id: deliveredLeaf,
            ts: this.now(),
          });
          attachment.delivered = true;
          deliveryLeaf = deliveredLeaf;
          deliveredSeed = text;
          beforePromptLeaf = prepared.sessionManager.getLeafId();
        }
        if (failure !== undefined) throw failure;
        return;
      },
      retainedContext: {
        captureBoundary: async () => {
          if (!attachment.delivered)
            throw new Error("retained context has no committed seed delivery");
          const leafId = prepared.sessionManager.getLeafId();
          if (leafId === null) throw new Error("retained context has no durable history tip");
          const captured = await captureOrchestratorContextBoundary({
            roleSessionId: identity.roleSessionId,
            sessionFile: identity.sessionFile,
            conversationId: identity.conversationId,
            leafId,
          });
          assertSeedDeliveryAtBoundary(captured.entries, leafId, deliveryLeaf, deliveredSeed);
          return captured.reference;
        },
        commitBoundary: async (reference) => {
          if (
            reference.role_session_id !== identity.roleSessionId ||
            reference.conversation_id !== identity.conversationId ||
            reference.session_file !== identity.sessionFile
          ) {
            throw new Error("retained context boundary does not belong to this invocation");
          }
          const candidate = {
            schema_version: 1,
            type: "context_boundary_committed",
            run_id: this.options.runId,
            role: this.options.role,
            epoch: prepared.epoch,
            role_session_id: identity.roleSessionId,
            conversation_id: identity.conversationId,
            session_file: identity.sessionFile,
            leaf_id: reference.leaf_id,
            history_sha256: reference.history_sha256,
            ts: this.now(),
          } satisfies ContextBoundaryCommittedRecord;
          queryOrchestratorContext(
            [...this.options.log.records(this.options.runId), candidate],
            this.options.runId,
            this.options.role,
          );
          this.options.persistRecord(candidate);
        },
      },
    };
    return attachment;
  }

  private effectiveSettings(): CompactionSettingsSnapshot {
    if (this.options.compaction !== undefined) return this.options.compaction;
    return captureCompactionSettings(
      SettingsManager.create(this.options.cwd, this.options.agentDir),
    );
  }
}

/** Prompt and boundary operations bound to one retained context invocation. */
export interface RetainedContextAttachment {
  readonly prompt: (text: string, invoke: (text: string) => Promise<void>) => Promise<void>;
  readonly retainedContext: NonNullable<
    import("./role-session-contract.js").RoleSession["retainedContext"]
  >;
  delivered: boolean;
}

function findDeliveredUserEntry(
  manager: SessionManager,
  beforeLeaf: string | null,
  prompt: string,
): string | null {
  const branch = manager.getBranch();
  const beforeIndex =
    beforeLeaf === null ? -1 : branch.findIndex((entry) => entry.id === beforeLeaf);
  if (beforeLeaf !== null && beforeIndex < 0) return null;
  const start = beforeIndex + 1;
  for (let index = Math.max(0, start); index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    return text === prompt ? entry.id : null;
  }
  return null;
}

function assertSeedDeliveryAtBoundary(
  entries: readonly SessionEntry[],
  leafId: string,
  deliveryLeaf: string | null,
  deliveredSeed: string | null,
): void {
  if (deliveryLeaf === null || deliveredSeed === null) {
    throw new Error("retained context has no recorded seed delivery at its boundary");
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = byId.get(leafId);
  const visited = new Set<string>();
  while (current !== undefined) {
    if (visited.has(current.id)) {
      throw new Error("retained context boundary has a cyclic delivery ancestry");
    }
    visited.add(current.id);
    if (current.id === deliveryLeaf) {
      if (current.type !== "message" || current.message.role !== "user") {
        throw new Error("retained context boundary delivery entry is not a user message");
      }
      const content = current.message.content;
      const text =
        typeof content === "string"
          ? content
          : content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      if (text !== deliveredSeed) {
        throw new Error("retained context boundary seed does not match the delivered seed");
      }
      return;
    }
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  throw new Error("retained context boundary does not descend from its delivered seed");
}

function toBoundaryReference(record: ContextBoundaryCommittedRecord): ContextBoundaryReference {
  return {
    role_session_id: record.role_session_id,
    conversation_id: record.conversation_id,
    session_file: record.session_file,
    leaf_id: record.leaf_id,
    history_sha256: record.history_sha256,
  };
}

function toSnapshot(value: ContextEpochStartedRecord["compaction"]): CompactionSettingsSnapshot {
  return {
    enabled: value.enabled,
    reserveTokens: value.reserve_tokens,
    keepRecentTokens: value.keep_recent_tokens,
  };
}
