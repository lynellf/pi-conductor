import { describe, expect, it } from "vitest";
import {
  type ContinuityEvidenceAuthority,
  resolveSingleEvidence,
} from "../../src/host/continuity-evidence.js";

const audience = { run_id: "run-1", role: "worker", visit_index: 1 } as const;

function authority(
  repository: ContinuityEvidenceAuthority["repository"],
): ContinuityEvidenceAuthority {
  return {
    audience,
    toolExecutions: { belongsToRun: () => true },
    contextArtifacts: { canRead: () => true },
    repository,
  };
}

describe("resolveSingleEvidence", () => {
  it("forwards repository digest and line-range authority to the host lookup", async () => {
    const calls: unknown[] = [];
    const resolution = await resolveSingleEvidence(
      authority({
        resolveCommit: async (input) => {
          calls.push(input);
          return {
            status: "verified",
            head_commit: input.commit,
            resolved_path: input.path,
          };
        },
      }),
      {
        kind: "repository",
        path: "src/seam/continuity.ts",
        commit: "a".repeat(40),
        sha256: "b".repeat(64),
        line_start: 4,
        line_end: 8,
      },
    );

    expect(calls).toEqual([
      {
        run_id: "run-1",
        audience,
        commit: "a".repeat(40),
        path: "src/seam/continuity.ts",
        sha256: "b".repeat(64),
        line_start: 4,
        line_end: 8,
      },
    ]);
    expect(resolution).toMatchObject({ kind: "repository", status: "verified" });
  });
});
