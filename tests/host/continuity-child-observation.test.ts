import { describe, expect, it } from "vitest";
import type { ContinuityEvidenceResolution } from "../../src/core/types.js";
import { createReportCapture } from "../../src/host/delegation/child-observation.js";
import { buildReportResultTool } from "../../src/host/delegation/child-sdk-tools.js";
import type { EvidenceRef } from "../../src/seam/continuity.js";

const packet = {
  schema_version: 1 as const,
  summary: "child result",
  findings: [],
  evaluations: [],
  open_questions: [],
  next_steps: [],
  okf_candidate_ids: [],
};

function requiredContext() {
  return {
    knownItemIds: new Set<string>(),
    verifiedExecutionIds: new Set<string>(),
    evidenceVerifiedByKey: new Map(),
    policy: {
      require_handoff: false,
      require_delegated_result: true,
      seed_max_utf8_bytes: 32_768,
    },
  };
}

const repositoryPacket = {
  ...packet,
  findings: [
    {
      id: "repository-finding",
      kind: "fact" as const,
      confidence: "verified" as const,
      statement: "repository evidence is available",
      evidence: [
        {
          kind: "repository" as const,
          commit: "a".repeat(40),
          path: "fixture.txt",
        },
      ],
      supersedes: [],
    },
  ],
};

function asyncRepositoryContext() {
  return {
    ...requiredContext(),
    resolveEvidenceAsync: async (
      key: string,
      ref: EvidenceRef,
    ): Promise<ContinuityEvidenceResolution> => ({
      ref_key: key,
      kind: ref.kind,
      status: "verified",
    }),
  };
}

describe("delegated report_result continuity", () => {
  it("rejects a successful required result without a packet before capture", async () => {
    const capture = createReportCapture({ continuityValidation: requiredContext });
    const tool = buildReportResultTool(capture);

    const result = await tool.execute(
      "call",
      { status: "completed", summary: "done" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("continuity_packet_required") },
    ]);
    expect(capture.protocolDiagnostic()).toBe("continuity_packet_required");
    expect(capture.report()).toBeNull();
  });

  it("binds a validated packet as a host-owned completion sibling", async () => {
    const capture = createReportCapture({ continuityValidation: requiredContext });
    const tool = buildReportResultTool(capture);

    const result = await tool.execute(
      "call",
      { status: "completed", summary: "done", continuity: packet },
      undefined,
      undefined,
      {} as never,
    );

    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()).toMatchObject({ packet, evidence_resolutions: [] });
    expect(capture.continuity()?.packet_utf8_bytes).toBeGreaterThan(0);
  });

  it("awaits host repository evidence resolution before accepting a child packet", async () => {
    const capture = createReportCapture({ continuityValidation: asyncRepositoryContext });
    const tool = buildReportResultTool(capture);

    const result = await tool.execute(
      "call",
      { status: "completed", summary: "done", continuity: repositoryPacket },
      undefined,
      undefined,
      {} as never,
    );

    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toEqual([
      {
        ref_key: "findings:repository-finding:0",
        kind: "repository",
        status: "verified",
      },
    ]);
  });

  it("preserves failed-result compatibility when delegated continuity is required", async () => {
    const capture = createReportCapture({ continuityValidation: requiredContext });
    const tool = buildReportResultTool(capture);

    const result = await tool.execute(
      "call",
      { status: "failed", summary: "provider failure" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result).not.toMatchObject({ isError: true });
    expect(capture.report()?.status).toBe("failed");
    expect(capture.continuity()).toBeNull();
  });
});
