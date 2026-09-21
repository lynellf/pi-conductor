/**
 * Issue #135, Phase 3: production-host wiring for host-observed handoff
 * evidence collection.
 *
 * Bridges the read-only collection service (`./index.js`) to the live role
 * session. The module is pure over its inputs (aside from the git I/O
 * delegated to the collection service) and performs no workspace mutation.
 *
 * Responsibilities:
 *
 *   - {@link workspaceEvidenceArgs} extracts the provisioned workspace path from
 *     a live {@link RoleSession} — the only surface the seams touch; it never
 *     reads model state.
 *   - {@link collectEvidenceRecord} turns extracted inputs into a
 *     {@link HandoffEvidenceRecord} (a snapshot facet, or an explicit
 *     `unavailable` marker for a non-git / uncollectable worktree).
 *   - The production seams {@link captureRunEvidenceBaselineInModule} and
 *     {@link collectHandoffEvidenceInModule} operate over an
 *     {@link EvidenceHostContext} passed by the host, so the run-scoped baseline
 *     cache and the loop-owned persist never cross into host-private state.
 */

import { randomUUID } from "node:crypto";
import type { HandoffEvidencePolicy } from "../../core/types.js";
import type { HandoffEvidenceRecord } from "../../persistence/handoff-evidence-schema.js";
import type { RoleSession } from "../role-session-contract.js";
import {
  collectHandoffEvidence,
  collectRunStartBaseline as readRunStartBaseline,
} from "./index.js";

/**
 * Run-scoped state the evidence seams mutate: the per-workspace dirty-path
 * baseline cache and the loop-owned persist callback. Held on the host, not in
 * this module, so the seams stay pure over their context.
 */
export interface EvidenceHostContext {
  /** Cached run-scoped baseline keyed by provisioned workspace path. */
  readonly evidenceBaseline: Map<string, readonly string[] | null>;
  /** Loop-owned persist for the produced {@link HandoffEvidenceRecord}. */
  readonly persistRecord: (record: HandoffEvidenceRecord) => void;
}

/**
 * Worktree inputs extracted from a live role session. `null` means the session
 * has no provisioned workspace descriptor (e.g. a shared SDK session) — the
 * collection service then resolves the worktree to an `unavailable` marker via
 * the non-git backend probe rather than a fabricated snapshot.
 */
export interface WorkspaceEvidenceArgs {
  /** Absolute worktree path for the read-only git queries, or `null`. */
  readonly workspace_path: string | null;
  /** Provisioned worktree backend, or `null`. */
  readonly workspace_backend: string | null;
}

/**
 * Extract the provisioned workspace path + backend from a live role session.
 * Read-only: this never touches model state or the workspace contents.
 */
export function workspaceEvidenceArgs(session: RoleSession): WorkspaceEvidenceArgs {
  const workspace = session.workspace;
  return {
    workspace_path: workspace?.path_or_image ?? null,
    workspace_backend: workspace?.backend ?? null,
  };
}

/**
 * Inputs for building one {@link HandoffEvidenceRecord} from a live handoff.
 * The production host supplies these from the session + the run-scoped
 * baseline cache.
 */
export interface EvidenceRecordInputs {
  /** Absolute worktree path, or `null` (no provisioned workspace). */
  readonly workspace_path: string | null;
  /** Run-scoped baseline (dirty paths at run start), or `null`. */
  readonly baseline: readonly string[] | null;
  readonly policy: HandoffEvidencePolicy;
  readonly run_id: string;
  readonly handoff_id: string;
  readonly ts: number;
}

/**
 * Build the {@link HandoffEvidenceRecord} for one accepted handoff from the
 * extracted workspace inputs and the run-scoped baseline. The returned record
 * is either a snapshot facet (`{ head, dirty_paths }`) or an explicit
 * `unavailable` marker — never a fabricated state. The host loop persists the
 * record so the single persist-owner rule (persist only in the loop) holds.
 */
export function collectEvidenceRecord(inputs: EvidenceRecordInputs): HandoffEvidenceRecord {
  // A `null` workspace_path is normalized to the empty string so the read-only
  // non-git backend probe resolves to `unavailable` rather than crashing; the
  // empty cwd cannot satisfy `git rev-parse --git-dir`.
  const workspace_path = inputs.workspace_path ?? "";
  return collectHandoffEvidence({
    run_id: inputs.run_id,
    handoff_id: inputs.handoff_id,
    workspace_path,
    policy: inputs.policy,
    ts: inputs.ts,
    baseline: inputs.baseline ?? null,
  });
}

/**
 * Read-only helper that reads the run-start dirty-path baseline for a workspace
 * via the collection service. Shared by the host baseline seam so the git I/O
 * lives with the collection service only (no duplicated query path).
 */
export function collectRunStartBaseline(workspace_path: string): readonly string[] | null {
  return readRunStartBaseline(workspace_path);
}

/**
 * Production seam: run-scoped baseline capture (Issue #135, Phase 3). Extracts
 * the workspace path from the session and, on the first call for a given
 * workspace, reads the initial repo-relative dirty paths (run start) and caches
 * them keyed by workspace path. Idempotent: cached paths skip re-capture. A
 * non-git backend or a shared session with no workspace descriptor is a no-op
 * (the baseline stays absent, so every path is flagged new on collection).
 */
export async function captureRunEvidenceBaselineInModule(
  context: EvidenceHostContext,
  session: RoleSession,
): Promise<void> {
  const { workspace_path } = workspaceEvidenceArgs(session);
  if (workspace_path === null || context.evidenceBaseline.has(workspace_path)) return;
  // Read-only at run start: the workspace is provisioned but the orchestrator
  // has not prompted, so the dirty paths are the genuine run-start state.
  context.evidenceBaseline.set(workspace_path, collectRunStartBaseline(workspace_path) ?? null);
}

/**
 * Production seam: collect + persist one handoff-evidence record (Issue #135,
 * Phase 3). Extracts the workspace, reads the cached run-scoped baseline,
 * builds the record with a host-generated `handoff_id`, and persists it so the
 * loop owns the persist. Never throws: a non-git or uncollectable worktree
 * becomes an explicit `unavailable` marker (plan invariant: no silent
 * fallbacks, never a fabricated snapshot).
 */
export async function collectHandoffEvidenceInModule(
  context: EvidenceHostContext,
  session: RoleSession,
  args: {
    readonly policy: HandoffEvidencePolicy;
    readonly run_id: string;
    readonly ts: number;
  },
): Promise<HandoffEvidenceRecord> {
  const { workspace_path } = workspaceEvidenceArgs(session);
  const baseline =
    workspace_path === null ? null : (context.evidenceBaseline.get(workspace_path) ?? null);
  const record = collectEvidenceRecord({
    workspace_path,
    baseline,
    policy: args.policy,
    run_id: args.run_id,
    handoff_id: randomUUID(),
    ts: args.ts,
  });
  context.persistRecord(record);
  return record;
}
