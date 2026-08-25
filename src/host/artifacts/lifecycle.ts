/** Terminal artifact collection for isolated role sessions — Issue #48 §7.2. */

import type { ArtifactConfig } from "../../manifest/types.js";
import type { PersistedRecord } from "../../persistence/log.js";
import type { HandoffArgs } from "../../seam/schema.js";
import type { Projection } from "../workspace/mounts.js";
import { collectAutoPatch, collectDeclaredArtifacts } from "./collect.js";

/** Immutable artifact roots captured from the provisioned emitter workspace. */
export interface ArtifactCollectionContext {
  /** Actual provisioned workspace path; never reconstructed from integration cwd. */
  readonly workspacePath: string;
  /** Actual projection used by the emitting isolated session. */
  readonly projection: Projection;
  /** Per-role declared-artifact caps. */
  readonly artifactsConfig: ArtifactConfig | undefined;
  /** Only writable worktrees can produce a host-generated patch. */
  readonly autoPatch: boolean;
}

/** Host-owned terminal artifact collection before a successor role can spawn. */
export async function collectTerminalArtifacts(args: {
  readonly context: ArtifactCollectionContext;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly role: string;
  readonly visitIndex: number;
  readonly sessionId: string;
  /** Present only after a reducer-accepted handoff. */
  readonly handoff?: HandoffArgs;
  /** Retry-terminal filename chosen by the host to preserve prior patch bytes. */
  readonly patchFileName?: string;
  readonly persistRecord: (record: PersistedRecord) => void;
}): Promise<void> {
  const {
    context,
    artifactsDir,
    runId,
    role,
    visitIndex,
    sessionId,
    handoff,
    patchFileName,
    persistRecord,
  } = args;

  if (handoff !== undefined) {
    const result = await collectDeclaredArtifacts(
      {
        runId,
        role,
        visitIndex,
        sessionId,
        workspaceRoot: context.workspacePath,
        projection: context.projection,
        artifactsConfig: context.artifactsConfig,
        artifactsDir,
      },
      handoff,
    );
    for (const record of result.collected) persistRecord(record);
    for (const record of result.rejected) persistRecord(record);
  }

  if (!context.autoPatch) return;
  const patch = await collectAutoPatch({
    workspacePath: context.workspacePath,
    artifactsDir,
    runId,
    role,
    visitIndex,
    sessionId,
    kind: "auto_patch",
    ...(patchFileName !== undefined && { patchFileName }),
  });
  if (patch !== null) persistRecord(patch);
}
