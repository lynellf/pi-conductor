/** Bounded delegated-child cohort fingerprints — Issue #57 §9.1. */

import { createHash } from "node:crypto";

import type { ChildProjectionFingerprint } from "../../persistence/child-completion.js";

/** Hash the canonical task identity without retaining a second raw task card. */
export function taskFingerprint(
  objective: string,
  expectedOutput: string,
  baseCommit: string,
  materializedPaths: readonly string[],
): string {
  return sha256(
    JSON.stringify({
      objective,
      expected_output: expectedOutput,
      base_commit: baseCommit,
      materialized_paths: sortedUnique(materializedPaths),
    }),
  );
}

/** Fingerprint a resolved exact or full-materialized projection without storing raw roots. */
export function projectionFingerprint(
  kind: ChildProjectionFingerprint["kind"],
  paths: readonly string[],
): ChildProjectionFingerprint {
  const sorted = sortedUnique(paths);
  return { kind, path_count: sorted.length, sha256: sha256(JSON.stringify(sorted)) };
}

function sortedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
