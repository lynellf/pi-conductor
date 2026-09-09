import { assertKnownCompactionUsage } from "../cost/context-compaction.js";
import type { Manifest } from "../manifest/types.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import {
  assertRestorableOrchestratorContext,
  queryOrchestratorContext,
} from "../persistence/orchestrator-context-query.js";
import type { LoadedManifest } from "./manifest.js";
import { captureOrchestratorContextBoundary } from "./orchestrator-context-files.js";

/** Admission inputs for a resumed orchestrator context. */
export interface OrchestratorContextResumeOptions {
  readonly runId: string;
  readonly records: readonly PersistedRecord[];
  readonly log: RecordLog;
  readonly loadedManifest: LoadedManifest;
  readonly reset: boolean;
}

/** Validate retained context and any exact source file before crash reconciliation. */
export async function admitOrchestratorContextResume(
  options: OrchestratorContextResumeOptions,
): Promise<LoadedManifest> {
  const loaded = effectiveHistoricalManifest(options.loadedManifest, options.records);
  const role = contextRole(loaded);
  if (role === null) {
    if (options.reset) throw new Error("reset-orchestrator-context requires an orchestrator role");
    return loaded;
  }

  assertKnownCompactionUsage(options.records, options.runId);
  const retention = loaded.manifest.roles.find((entry) => entry.name === role)?.context_retention;
  if (retention !== "run") {
    if (options.reset) {
      throw new Error(
        `reset-orchestrator-context is unavailable because orchestrator '${role}' has context_retention: none`,
      );
    }
    return loaded;
  }

  const contextRecords = options.records.filter(
    (record) =>
      record.type.startsWith("context_") && "run_id" in record && record.run_id === options.runId,
  );
  const state = queryOrchestratorContext(options.records, options.runId, role);
  if (state.epoch === null) {
    const hasLifecycle = options.records.some(
      (record) =>
        "run_id" in record &&
        record.run_id === options.runId &&
        (record.type === "session_started" ||
          record.type === "session_ended" ||
          record.type === "session_failed"),
    );
    if (options.reset || contextRecords.length > 0 || hasLifecycle) {
      throw new Error("context epoch is missing from an executed retained-context run");
    }
    return loaded;
  }
  if (options.reset) return loaded;
  const restorable = assertRestorableOrchestratorContext(options.records, options.runId, role);
  if (restorable.boundary !== null) {
    const captured = await captureOrchestratorContextBoundary({
      roleSessionId: restorable.boundary.role_session_id,
      conversationId: restorable.boundary.conversation_id,
      sessionFile: restorable.boundary.session_file,
      leafId: restorable.boundary.leaf_id,
    });
    if (captured.reference.history_sha256 !== restorable.boundary.history_sha256) {
      throw new Error(
        "orchestrator context boundary history hash does not match the persisted boundary",
      );
    }
  }
  return loaded;
}

/** Append a fresh empty epoch after crash reconciliation for an explicit reset. */
export function resetOrchestratorContext(options: {
  readonly runId: string;
  readonly records: readonly PersistedRecord[];
  readonly log: RecordLog;
  readonly loadedManifest: LoadedManifest;
}): void {
  const role = contextRole(options.loadedManifest);
  if (role === null) throw new Error("reset-orchestrator-context requires an orchestrator role");
  const retention = options.loadedManifest.manifest.roles.find(
    (entry) => entry.name === role,
  )?.context_retention;
  if (retention !== "run") {
    throw new Error(
      `reset-orchestrator-context is unavailable because orchestrator '${role}' has context_retention: none`,
    );
  }
  assertKnownCompactionUsage(options.records, options.runId);
  const previous = queryOrchestratorContext(options.records, options.runId, role).epoch;
  if (previous === null) {
    throw new Error(`reset-orchestrator-context cannot proceed: context epoch is missing`);
  }
  options.log.append({
    schema_version: 1,
    type: "context_epoch_started",
    run_id: options.runId,
    role,
    epoch: previous.epoch + 1,
    reason: "reset",
    previous_epoch: previous.epoch,
    compaction: previous.compaction,
    ts: Date.now(),
  });
}

function contextRole(loaded: LoadedManifest): string | null {
  return loaded.manifest.roles.some((entry) => entry.name === loaded.def.orchestrator)
    ? loaded.def.orchestrator
    : null;
}

function effectiveHistoricalManifest(
  loaded: LoadedManifest,
  records: readonly PersistedRecord[],
): LoadedManifest {
  if (records.some((record) => record.type === "manifest_snapshot")) {
    return loaded;
  }
  const roleName = loaded.def.orchestrator;
  const role = loaded.manifest.roles.find((entry) => entry.name === roleName);
  if (role?.context_retention !== "run") return loaded;
  const manifest: Manifest = {
    ...loaded.manifest,
    roles: loaded.manifest.roles.map((entry) =>
      entry.name === roleName ? { ...entry, context_retention: "none" } : entry,
    ),
  };
  return {
    ...loaded,
    manifest,
    warnings: Object.freeze([
      ...loaded.warnings,
      {
        code: "legacy-context-retention-unproven",
        message:
          "run has no durable manifest snapshot proving context_retention; preserving legacy no-retention semantics for this resume",
        role: roleName,
      },
    ]),
  };
}
