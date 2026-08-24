/**
 * Artifact routing — spec §7.3.
 *
 * On an accepted handoff transition, the host materializes the emitting
 * role's accepted artifacts into the **receiving role's** workspace under
 * `artifacts/<emitting-role>-v<visitIndex>/` (read-only for read-only
 * roles, writable otherwise).
 *
 * `formatArtifactsSeedSection` builds the host-generated artifacts
 * section that runs alongside the `context_ref` block in the seed:
 * the stored artifact names + descriptions, and for each rejected/failed
 * collection, an explicit "not available" note.
 *
 * For **shared-mode receivers** (no projection), the host provides
 * absolute run-state paths in the seed instead of materializing files
 * (they can read the host filesystem; materializing into the integration
 * workspace would be a host write the feature never makes).
 *
 * @module host/artifacts/route
 * @see spec §7.3 (routing and materialization)
 */

import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactCollectedRecord, ArtifactRejectedRecord } from "../../persistence/log.js";

// ─── Materialization ────────────────────────────────────────────────────

/**
 * Materialize collected artifacts into the receiving role's workspace.
 *
 * For isolated roles: copies artifact files into
 * `<receiverWorkspace>/artifacts/<emittingRole>-v<visitIndex>/`.
 * For shared-mode receivers: returns absolute run-state paths instead
 * (they have filesystem access to the integration workspace).
 *
 * @param options - materialization parameters.
 * @param options.artifactsDir - the base artifacts directory
 *   (`<runStateDir>/artifacts/<runId>/`).
 * @param options.emittingRole - the role that emitted the handoff.
 * @param options.emittingVisitIndex - the emitting role's visit index.
 * @param options.receiverWorkspace - the receiving role's workspace root
 *   (for isolated roles) or the integration workspace (for shared).
 * @param options.isReceiverIsolated - whether the receiver has a projection.
 * @param options.collected - the collected artifact records.
 * @returns the materialized artifact descriptors (paths the receiver sees).
 */
export async function materializeArtifacts(options: {
  artifactsDir: string;
  emittingRole: string;
  emittingVisitIndex: number;
  receiverWorkspace: string;
  isReceiverIsolated: boolean;
  collected: ArtifactCollectedRecord[];
}): Promise<Array<{ name: string; description?: string; localPath: string }>> {
  const {
    artifactsDir,
    emittingRole,
    emittingVisitIndex,
    receiverWorkspace,
    isReceiverIsolated,
    collected,
  } = options;

  if (collected.length === 0) {
    return [];
  }

  const sourceDir = join(artifactsDir, `${emittingRole}-v${emittingVisitIndex}`);

  // List stored files in the source directory.
  let storedFiles: string[];
  try {
    storedFiles = (await readdir(sourceDir)).filter((f) => !f.endsWith(".tmp-*"));
  } catch {
    // Source directory doesn't exist — skip.
    return [];
  }

  const materialized: Array<{ name: string; description?: string; localPath: string }> = [];

  for (const file of storedFiles) {
    const sourcePath = join(sourceDir, file);

    if (isReceiverIsolated) {
      // For isolated roles: copy into the receiver's workspace.
      const receiverArtifactDir = join(
        receiverWorkspace,
        "artifacts",
        `${emittingRole}-v${emittingVisitIndex}`,
      );
      await mkdir(dirname(receiverArtifactDir), { recursive: true });
      await copyFile(sourcePath, join(receiverArtifactDir, file));

      const collectedRecord = collected.find((r) => r.stored_path === sourcePath);
      const entry: { name: string; localPath: string } = {
        name: file,
        localPath: join(receiverArtifactDir, file),
      };
      if (collectedRecord?.description) {
        (entry as { description?: string }).description = collectedRecord.description;
      }
      materialized.push(entry);
    } else {
      // Shared-mode receiver: provide absolute run-state path.
      const collectedRec = collected.find((r) => r.stored_path === sourcePath);
      const entry2: { name: string; localPath: string } = {
        name: file,
        localPath: sourcePath,
      };
      if (collectedRec?.description) {
        (entry2 as { description?: string }).description = collectedRec.description;
      }
      materialized.push(entry2);
    }
  }

  return materialized;
}

// ─── Seed section ───────────────────────────────────────────────────────

/**
 * Build the host-generated artifacts section for the seed.
 *
 * Parallel to the `context_ref` block: lists the stored artifact names
 * + descriptions, and for each rejected/failed collection, an explicit
 * "not available" note so the recipient (and the orchestrator) can see
 * the gap and route accordingly.
 *
 * @param options - seed section parameters.
 * @param options.artifactsDir - the base artifacts directory.
 * @param options.emittingRole - the role that emitted the handoff.
 * @param options.emittingVisitIndex - the emitting role's visit index.
 * @param options.collected - collected artifact records.
 * @param options.rejected - rejected artifact records.
 * @param options.isReceiverIsolated - whether the receiver has a projection.
 * @param options.receiverWorkspace - the receiving role's workspace root.
 * @returns the artifacts section string for the seed, or null if empty.
 *
 * @see spec §7.3 (routing and materialization)
 */
export function formatArtifactsSeedSection(options: {
  artifactsDir: string;
  emittingRole: string;
  emittingVisitIndex: number;
  collected: ArtifactCollectedRecord[];
  rejected: ArtifactRejectedRecord[];
  isReceiverIsolated: boolean;
  receiverWorkspace: string;
}): string | null {
  const {
    artifactsDir,
    emittingRole,
    emittingVisitIndex,
    collected,
    rejected,
    isReceiverIsolated,
    receiverWorkspace,
  } = options;

  // Collect available artifact names from the source store.
  const sourceDir = join(artifactsDir, `${emittingRole}-v${emittingVisitIndex}`);

  // Build the available section.
  const availableEntries: string[] = [];
  for (const rec of collected) {
    // Only include non-patch files in the available list.
    if (rec.kind === "auto_patch") continue;
    availableEntries.push(
      `  - ${rec.source_path}${rec.description ? ` (${rec.description})` : ""}`,
    );
  }

  // Build the unavailable section (rejected/failed).
  const unavailableEntries: string[] = [];
  for (const rec of rejected) {
    unavailableEntries.push(`  - ${rec.path}: ${rec.reason}`);
  }

  if (availableEntries.length === 0 && unavailableEntries.length === 0) {
    return null;
  }

  // Build the section string.
  const lines: string[] = [];
  lines.push(`## Artifacts from ${emittingRole}-v${emittingVisitIndex}`);

  if (availableEntries.length > 0) {
    lines.push("\nAvailable:");
    lines.push(...availableEntries);
  }

  if (unavailableEntries.length > 0) {
    lines.push("\nNot available:");
    lines.push(...unavailableEntries);
  }

  return lines.join("\n");
}

// ─── Orchestrator re-routing ────────────────────────────────────────────

/**
 * Build the artifacts descriptor for orchestrator re-routing.
 *
 * When an orchestrator (even with a projected/no-repo workspace) needs
 * to route prior artifacts between workers, it declares them in its own
 * handoff `artifacts` (paths within its workspace). The same
 * collect→materialize pipeline applies, so the orchestrator needs no
 * repository mount to move deliverables between workers (AC-004).
 *
 * @param options - re-routing parameters.
 * @param options.artifactsDir - the base artifacts directory.
 * @param options.receiverWorkspace - the orchestrator's workspace root.
 * @param routes - array of {emittingRole, emittingVisitIndex, targetRole}
 *   pairs describing which artifacts to route to which target.
 * @returns array of {artifactPath, targetRole} descriptors for the
 *   orchestrator's handoff declaration.
 *
 * @see spec §7.3.4 (orchestrator re-routing, REQ-004)
 */
export async function buildOrchestratorReroute(
  options: {
    artifactsDir: string;
    receiverWorkspace: string;
  },
  routes: Array<{ emittingRole: string; emittingVisitIndex: number }>,
): Promise<Array<{ name: string; localPath: string }>> {
  const { artifactsDir, receiverWorkspace } = options;
  const all: Array<{ name: string; localPath: string }> = [];

  for (const route of routes) {
    const sourceDir = join(artifactsDir, `${route.emittingRole}-v${route.emittingVisitIndex}`);

    try {
      const files = await readdir(sourceDir);
      for (const file of files) {
        if (file.endsWith(".tmp-*")) continue;
        const destDir = join(
          receiverWorkspace,
          "artifacts",
          `${route.emittingRole}-v${route.emittingVisitIndex}`,
        );
        await mkdir(dirname(destDir), { recursive: true });
        const sourcePath = join(sourceDir, file);
        const destPath = join(destDir, file);
        await copyFile(sourcePath, destPath);
        all.push({ name: file, localPath: destPath });
      }
    } catch {
      // Source directory doesn't exist — skip this route.
    }
  }

  return all;
}
