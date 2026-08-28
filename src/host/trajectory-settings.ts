/**
 * Ephemeral Pi settings for an exact trajectory conversation (Issue #63 §5.2).
 * Pi 0.80.6's public `AgentSession.setAutoCompactionEnabled()` writes through
 * its settings manager, so this host-owned public `SettingsManager.fromStorage`
 * snapshot is the non-persistent, project-override-proof seam.
 */

import { SettingsManager } from "@earendil-works/pi-coding-agent";

/** Create an isolated settings snapshot whose only override is disabled compaction. */
export function createTrajectorySettingsManager(args: {
  readonly cwd: string;
  readonly agentDir: string;
}): SettingsManager {
  const persisted = SettingsManager.create(args.cwd, args.agentDir);
  const project = persisted.getProjectSettings();
  const storage = new SettingsSnapshotStorage(persisted.getGlobalSettings(), {
    ...project,
    compaction: {
      ...project.compaction,
      enabled: false,
    },
  });
  const settings = SettingsManager.fromStorage(storage);
  if (settings.getCompactionEnabled()) {
    throw new Error("trajectory settings did not disable automatic compaction");
  }
  return settings;
}

/** Public `SettingsStorage`-shaped object that never writes caller-owned Pi configuration. */
class SettingsSnapshotStorage {
  private global: string;
  private project: string;

  constructor(
    global: ReturnType<SettingsManager["getGlobalSettings"]>,
    project: ReturnType<SettingsManager["getProjectSettings"]>,
  ) {
    this.global = JSON.stringify(global);
    this.project = JSON.stringify(project);
  }

  withLock(
    scope: "global" | "project",
    fn: (current: string | undefined) => string | undefined,
  ): void {
    const current = scope === "global" ? this.global : this.project;
    const next = fn(current);
    if (next === undefined) return;
    if (scope === "global") {
      this.global = next;
    } else {
      this.project = next;
    }
  }
}
