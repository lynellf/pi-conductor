/** Canonical JSON materialization and workspace-guarantee checks for persisted records. */

import type { WorkspaceGuarantee } from "../core/types.js";
import { verifyManifestSnapshot, type ManifestSnapshotRecord } from "./trajectory-records.js";

/** Typed rejection of an unavailable workspace guarantee at the persistence boundary. */
export class WorkspaceGuaranteeError extends Error {
  constructor(guarantee: unknown) {
    super(
      `workspace guarantee '${String(guarantee)}' is unavailable; expected 'none' or 'confined'`,
    );
    this.name = "WorkspaceGuaranteeError";
  }
}

/** Typed rejection of workspace metadata on a terminal lifecycle record. */
export class LifecycleWorkspaceMetadataError extends Error {
  constructor(lifecycle: "session_ended" | "session_failed") {
    super(`workspace metadata is only allowed on session_started, not ${lifecycle}`);
    this.name = "LifecycleWorkspaceMetadataError";
  }
}

/** Canonical JSON form of one persisted record. */
export interface MaterializedPersistedRecord<T extends object> {
  readonly json: string;
  readonly record: T;
}

/** Reject workspace guarantees that this host cannot provide honestly. */
export function assertWorkspaceGuarantee(
  guarantee: unknown,
): asserts guarantee is WorkspaceGuarantee {
  if (guarantee !== "none" && guarantee !== "confined") {
    throw new WorkspaceGuaranteeError(guarantee);
  }
}

/** Reject unavailable guarantee claims in a JSON-materialized persisted record. */
export function assertPersistedRecordGuarantees(record: unknown): void {
  assertNoSandboxGuarantee(record);

  if (!isRecord(record)) return;

  if (record.type === "manifest_snapshot") {
    verifyManifestSnapshot(record as unknown as ManifestSnapshotRecord);
  }

  if (record.type === "workspace_provisioned") {
    assertWorkspaceGuarantee(record.guarantee);
  }

  if (record.type === "session_ended" || record.type === "session_failed") {
    if (record.workspace !== undefined) {
      throw new LifecycleWorkspaceMetadataError(record.type);
    }
    return;
  }

  if (record.type === "session_started") {
    const workspace = record.workspace;
    if (workspace !== undefined) {
      const guarantee = isRecord(workspace) ? workspace.guarantee : undefined;
      assertWorkspaceGuarantee(guarantee);
    }
  }
}

/** Materialize and validate the exact JSON representation retained or written by a log. */
export function materializePersistedRecord<T extends object>(
  record: T,
): MaterializedPersistedRecord<T> {
  const json = JSON.stringify(record);
  if (json === undefined) {
    throw new TypeError("persisted record must serialize to a JSON object");
  }

  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new TypeError("persisted record must serialize to a JSON object");
  }

  assertPersistedRecordGuarantees(parsed);
  return { json, record: parsed as unknown as T };
}

function assertNoSandboxGuarantee(record: unknown): void {
  const pending: unknown[] = [record];

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }

    for (const [key, item] of Object.entries(value)) {
      if (key === "guarantee" && item === "sandbox") {
        throw new WorkspaceGuaranteeError(item);
      }
      pending.push(item);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
