/** Durable scheduler request/authority fingerprints — Issue #106 §3. */

import { sandboxBoundFingerprint } from "../../persistence/subagent-sandbox.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { DelegateSubmissionArgs } from "../../seam/schema.js";
import type { PreparedDelegateChild } from "./admission.js";

/** Hash the raw request, preserving the legacy scheduler fingerprint contract. */
export function requestFingerprint(
  input: DelegateSubmissionArgs,
  sourceWorkspaceRef?: string,
  tasks?: readonly PreparedDelegateChild[],
): string {
  const raw =
    sourceWorkspaceRef === undefined
      ? sha256Canonical(input)
      : sha256Canonical({ input, source_workspace_ref: sourceWorkspaceRef });
  if (tasks === undefined || !tasks.some(hasPinnedAuthority)) return raw;
  return sha256Canonical({
    request_fingerprint: raw,
    effective_tools: tasks.map((task) => task.effectiveTools ?? null),
    verification_recipes: tasks.map((task) => task.verificationRecipe ?? null),
  });
}

function hasPinnedAuthority(task: PreparedDelegateChild): boolean {
  return task.effectiveTools !== undefined || task.verificationRecipe !== undefined;
}

/** Bind sandbox policy/runtime digests in task order, excluding random IDs. */
export function acceptedFingerprint(
  input: DelegateSubmissionArgs,
  tasks: readonly PreparedDelegateChild[],
  sourceWorkspaceRef?: string,
): string {
  const request = requestFingerprint(input, sourceWorkspaceRef, tasks);
  if (tasks.some((task) => task.resolvedSourceWorkspace !== undefined)) {
    return sha256Canonical({
      request_fingerprint: request,
      sandbox: tasks.map((task) => task.sandbox),
      source_workspaces: tasks.map((task) =>
        task.resolvedSourceWorkspace === undefined ? null : sourceIdentity(task),
      ),
    });
  }
  return sandboxBoundFingerprint(
    request,
    tasks.map((task) => task.sandbox),
  );
}

function sourceIdentity(task: PreparedDelegateChild) {
  const source = task.resolvedSourceWorkspace;
  if (source === undefined) return null;
  return {
    ref: source.ref,
    source_id: source.sourceId,
    head_commit: source.headCommit,
    tree_id: source.treeId,
    inventory_digest: source.inventoryDigest,
    policy_digest: source.policyDigest,
    audience: source.audience,
  };
}
