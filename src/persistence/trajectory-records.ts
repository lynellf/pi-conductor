/** Issue #63 durable host-owned trajectory records. No Pi runtime imports. */

import { createHash } from "node:crypto";

import type { MachineDefinition, ModelEffort, Role } from "../core/types.js";
import type { Manifest } from "../manifest/types.js";

/** Typed rejection of a corrupt or unsupported pinned manifest snapshot. */
export class ManifestSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestSnapshotError";
  }
}

/** Typed rejection of a trajectory selector that cannot be resumed exactly. */
export class TrajectoryResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrajectoryResumeError";
  }
}

/** Exact admission inputs retained with a trajectory selection (Issue #63 §5). */
export interface TrajectoryAdmission {
  readonly schema_version: 1;
  readonly observed_context_tokens: number;
  readonly role_envelope_tokens: number;
  readonly target_max_tokens: number;
  readonly safety_reservation_tokens: 8192;
  readonly required_tokens: number;
  readonly target_context_window: number;
  readonly target_model: string;
}

/** Immutable normalized manifest snapshot used instead of re-reading YAML on resume. */
export interface ManifestSnapshotRecord {
  readonly type: "manifest_snapshot";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly manifest_version: string;
  readonly normalized_manifest: Manifest;
  readonly definition: MachineDefinition;
  readonly sha256: string;
  readonly ts: number;
}

/** Persisted selection for one successfully admitted trajectory handoff. */
export interface HandoffTransportSelectedRecord {
  readonly type: "handoff_transport_selected";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly source_role_session_id: string;
  readonly from: Role;
  readonly to: Role;
  readonly mode: "trajectory";
  readonly source_conversation: { readonly id: string; readonly file: string };
  readonly target: {
    readonly model: string;
    readonly requested_effort: ModelEffort;
    readonly system_prompt: string;
    readonly active_tool_names: readonly string[];
    readonly environment_sha256: string;
  };
  readonly admission: TrajectoryAdmission;
  readonly ts: number;
}

/** Observable fail-closed result for a trajectory preflight/reconfiguration failure. */
export interface TrajectoryHandoffFailedRecord {
  readonly type: "trajectory_handoff_failed";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly from: Role;
  readonly to: Role;
  readonly source_conversation: { readonly id: string; readonly file: string };
  readonly code: string;
  readonly message: string;
  readonly ts: number;
}

/** Create the canonical manifest snapshot written before a policy-bearing run spawns. */
export function createManifestSnapshot(args: {
  readonly runId: string;
  readonly manifest: Manifest;
  readonly definition: MachineDefinition;
  readonly ts: number;
}): ManifestSnapshotRecord {
  const source = {
    schema_version: 1,
    normalized_manifest: args.manifest,
    definition: args.definition,
  } as const;
  return Object.freeze({
    type: "manifest_snapshot",
    schema_version: 1,
    run_id: args.runId,
    manifest_version: args.definition.manifest_version,
    normalized_manifest: args.manifest,
    definition: args.definition,
    sha256: sha256Canonical(source),
    ts: args.ts,
  }) as ManifestSnapshotRecord;
}

/** Verify that a persisted snapshot's hash and pinned definition agree. */
export function verifyManifestSnapshot(record: ManifestSnapshotRecord): ManifestSnapshotRecord {
  if (record.schema_version !== 1) {
    throw new ManifestSnapshotError(
      `unsupported manifest snapshot schema ${record.schema_version}`,
    );
  }
  if (record.manifest_version !== record.definition.manifest_version) {
    throw new ManifestSnapshotError(
      "manifest snapshot version does not match its pinned definition",
    );
  }
  const expected = sha256Canonical({
    schema_version: record.schema_version,
    normalized_manifest: record.normalized_manifest,
    definition: record.definition,
  });
  if (record.sha256 !== expected) {
    throw new ManifestSnapshotError("manifest snapshot sha256 does not match canonical content");
  }
  return record;
}

/** Deterministic JSON hash independent of object insertion order. */
export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
