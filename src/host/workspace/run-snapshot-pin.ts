/** Immutable per-run snapshot-pin lookup — Issue #48 remediation R2a. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PersistedRecord } from "../../persistence/log.js";
import type { SnapshotPinnedRecord } from "../../persistence/workspace-artifact-records.js";
import { WorkspaceError } from "./manager.js";

const execFileAsync = promisify(execFile);

/**
 * Returns this run's sole valid persisted snapshot pin or null before the first isolated spawn.
 * Issue #48 remediation R2a: a persisted pin wins over all later moving source resolution.
 */
export function readPersistedSnapshotPin(
  records: readonly PersistedRecord[],
  runId: string,
): SnapshotPinnedRecord | null {
  const pins = records.filter(
    (record): record is SnapshotPinnedRecord => record.type === "snapshot_pinned",
  );

  if (pins.length === 0) return null;
  if (pins.length !== 1) {
    throw invalidSnapshotPin(runId, "found multiple snapshot_pinned records");
  }

  const pin = pins[0];
  if (pin === undefined) {
    throw invalidSnapshotPin(runId, "could not read the snapshot_pinned record");
  }
  if (pin.run_id !== runId) {
    throw invalidSnapshotPin(runId, `record belongs to run '${pin.run_id}'`);
  }
  if (!isValidSource(pin.source)) {
    throw invalidSnapshotPin(runId, `source '${String(pin.source)}' is invalid`);
  }
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) {
    throw invalidSnapshotPin(runId, `commit '${String(pin.commit)}' is not a 40-character SHA-1`);
  }

  return pin;
}

/** Reject a saved pin whose syntactically valid SHA no longer resolves in its source repository. */
export async function assertPersistedSnapshotPinResolves(
  primaryCheckout: string,
  pin: SnapshotPinnedRecord,
): Promise<void> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${pin.commit}^{commit}`], {
      cwd: primaryCheckout,
    });
  } catch (cause) {
    throw invalidSnapshotPin(
      pin.run_id,
      `commit '${pin.commit}' does not resolve in '${primaryCheckout}'`,
      cause,
    );
  }
}

function isValidSource(source: unknown): source is "snapshot" | `ref:${string}` {
  return source === "snapshot" || (typeof source === "string" && /^ref:.+/.test(source));
}

function invalidSnapshotPin(runId: string, reason: string, cause?: unknown): WorkspaceError {
  return new WorkspaceError(
    `run '${runId}' has an invalid persisted snapshot pin: ${reason}`,
    "snapshot-pin-invalid",
    cause === undefined ? undefined : { cause },
  );
}
