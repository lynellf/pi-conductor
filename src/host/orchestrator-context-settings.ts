import { SettingsManager } from "@earendil-works/pi-coding-agent";

/** The three compaction settings pinned with an orchestrator context epoch. */
export interface CompactionSettingsSnapshot {
  readonly enabled: boolean;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
}

/** Build the effective settings manager without writing the pinned policy to disk. */
export function createPinnedCompactionSettings(
  cwd: string,
  agentDir: string,
  pinned: CompactionSettingsSnapshot,
): SettingsManager {
  const persisted = SettingsManager.create(cwd, agentDir);
  const storage = new SnapshotStorage(persisted.getGlobalSettings(), {
    ...persisted.getProjectSettings(),
    compaction: pinned,
  });
  return SettingsManager.fromStorage(storage);
}

/** Capture the strict compaction settings shape used by the host policy record. */
export function captureCompactionSettings(settings: SettingsManager): CompactionSettingsSnapshot {
  const current = settings.getCompactionSettings();
  return {
    enabled: current.enabled,
    reserveTokens: current.reserveTokens,
    keepRecentTokens: current.keepRecentTokens,
  };
}

class SnapshotStorage {
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
    if (scope === "global") this.global = next;
    else this.project = next;
  }
}
