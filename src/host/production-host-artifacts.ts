/** Artifact routing and collection operations for ProductionHost. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Role } from "../core/types.js";
import type {
  ArtifactCollectedRecord,
  ArtifactRejectedRecord,
  PersistedRecord,
  RecordLog,
} from "../persistence/log.js";
import { collectTerminalArtifacts as collectTerminalArtifactsFromWorkspace } from "./artifacts/lifecycle.js";
import { formatArtifactsSeedSection, materializeArtifacts } from "./artifacts/route.js";
import type { ArtifactRouteSource, RoleSession } from "./host.js";
/** Dependencies for host-owned artifact routing and collection. */
export interface ArtifactHostContext {
  readonly cwd: string;
  readonly runId: string;
  readonly log: RecordLog;
  readonly persistRecord: (record: PersistedRecord) => void;
}
/** Route artifacts selected by an accepted handoff. */
export async function routeAcceptedHandoffArtifacts(
  host: ArtifactHostContext,
  source: ArtifactRouteSource,
  receiver: RoleSession,
): Promise<string | null> {
  const records = host.log.records(host.runId);
  const collected = records.filter(
    (record): record is ArtifactCollectedRecord =>
      record.type === "artifact_collected" &&
      record.kind === "declared" &&
      record.role === source.role &&
      record.visit_index === source.visitIndex &&
      record.session_id === source.sessionId,
  );
  const rejected = records.filter(
    (record): record is ArtifactRejectedRecord =>
      record.type === "artifact_rejected" &&
      record.role === source.role &&
      record.session_id === source.sessionId,
  );
  const routed = await materializeArtifacts({
    artifactsDir: join(host.cwd, ".pi-conductor", "runs", host.runId, "artifacts", host.runId),
    emittingRole: source.role,
    emittingVisitIndex: source.visitIndex,
    receiverWorkspace: receiver.workspace?.path_or_image ?? host.cwd,
    isReceiverIsolated: receiver.workspace !== undefined,
    collected,
  });
  return formatArtifactsSeedSection({
    emittingRole: source.role,
    emittingVisitIndex: source.visitIndex,
    routed,
    rejected,
  });
}

/** Collect isolated-session artifacts before the loop can spawn a successor (§7.2). */
/** Collect artifacts after a role reaches a terminal state. */
export async function collectTerminalArtifacts(
  host: ArtifactHostContext,
  session: RoleSession,
  args: {
    readonly role: Role;
    readonly visitIndex: number;
    readonly terminal: "session_ended" | "session_failed";
    readonly handoff?: import("../seam/schema.js").HandoffArgs;
  },
): Promise<void> {
  const context = session.artifactCollection;
  if (context === undefined) return;
  if (session.role !== args.role) {
    throw new Error(
      `artifact collection session role '${String(session.role)}' does not match loop role '${String(args.role)}'`,
    );
  }
  const priorPatchCount = host.log
    .records(host.runId)
    .filter(
      (record) =>
        record.type === "artifact_collected" &&
        record.kind === "auto_patch" &&
        record.role === args.role &&
        record.visit_index === args.visitIndex,
    ).length;
  const patchFileName =
    priorPatchCount === 0
      ? undefined
      : `patch-${args.role}-v${args.visitIndex}-${priorPatchCount}-${createHash("sha256")
          .update(session.sessionId)
          .digest("hex")
          .slice(0, 12)}.patch`;
  await collectTerminalArtifactsFromWorkspace({
    context,
    artifactsDir: join(host.cwd, ".pi-conductor", "runs", host.runId, "artifacts", host.runId),
    runId: host.runId,
    role: args.role,
    visitIndex: args.visitIndex,
    sessionId: session.sessionId,
    ...(args.handoff !== undefined && { handoff: args.handoff }),
    ...(patchFileName !== undefined && { patchFileName }),
    persistRecord: (record) => host.persistRecord(record),
  });
}
