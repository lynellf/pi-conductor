/** Pure root-to-exact-set admission for explicit sandbox snapshots (#111). */
import {
  isSafeSnapshotPath,
  validateSubagentSnapshotPolicy,
} from "../../manifest/subagent-snapshot.js";
import type { SubagentSnapshotPolicy } from "../../manifest/types.js";
import type { EffectiveProjection } from "./projection-policy.js";

/** Snapshot failures reject the complete submission before acceptance. */
export type SnapshotAdmissionErrorCode =
  | "invalid-snapshot-policy"
  | "snapshot-requires-sandbox"
  | "snapshot-task-projection-conflict"
  | "snapshot-root-not-materialized"
  | "snapshot-too-large"
  | "projection-authority-unavailable";

/** Typed, task-attributed snapshot admission diagnostic. */
export interface SnapshotAdmissionError {
  readonly code: SnapshotAdmissionErrorCode;
  readonly message: string;
  readonly path?: string;
}

/** Resolve only captured parent files; roots never expand against ambient filesystem state. */
export function resolveSnapshotProjection(
  policy: SubagentSnapshotPolicy,
  runtimePaths: readonly string[] | undefined,
  parentPaths: readonly string[] | undefined,
):
  | { readonly valid: true; readonly projection: EffectiveProjection }
  | { readonly valid: false; readonly errors: readonly SnapshotAdmissionError[] } {
  const errors: SnapshotAdmissionError[] = validateSubagentSnapshotPolicy(policy).map(
    (message) => ({
      code: "invalid-snapshot-policy",
      message,
    }),
  );
  if (runtimePaths !== undefined)
    errors.push({
      code: "snapshot-task-projection-conflict",
      message:
        "snapshot tasks must omit projection_paths; use a projection profile for exact-file tasks",
    });
  if (errors.length > 0) return { valid: false, errors };
  if (parentPaths === undefined || parentPaths.some((path) => !isSafeSnapshotPath(path)))
    return {
      valid: false,
      errors: [
        {
          code: "projection-authority-unavailable",
          message: "snapshot requires a clean, safe materialized-parent path capture",
        },
      ],
    };
  const selected = new Set<string>();
  for (const root of policy.paths) {
    const matches = parentPaths.filter((path) => path === root || path.startsWith(`${root}/`));
    if (matches.length === 0)
      errors.push({
        code: "snapshot-root-not-materialized",
        path: root,
        message: `snapshot root '${root}' has no selectable materialized files; prepare a tracked file beneath it in the clean parent or correct the profile`,
      });
    for (const path of matches) selected.add(path);
  }
  if (selected.size > policy.max_files)
    errors.push({
      code: "snapshot-too-large",
      message: `snapshot selects ${selected.size} files, exceeding max_files ${policy.max_files}; reduce the approved roots or increase the manifest limit for a new run`,
    });
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, projection: Object.freeze({ paths: Object.freeze([...selected].sort()) }) };
}
