/**
 * Phase 1 contract repair: the unified host-side `validateContinuityPacket`
 * API performs TypeBox structural validation, UTF-8 byte measurement, and
 * semantic validation in one call. The throwing variant is the canonical
 * seam entry point; the non-throwing variant `tryValidateContinuityPacket`
 * is for hosts that prefer the rejected branch returned as a value.
 */

import { describe, expect, it } from "vitest";
import type { PacketValidationContext } from "../../src/persistence/continuity.js";
import {
  ContinuityValidationError,
  tryValidateContinuityPacket,
  validateContinuityPacket,
} from "../../src/persistence/continuity.js";

const baseContext: PacketValidationContext = {
  knownItemIds: new Set(),
  verifiedExecutionIds: new Set(),
  evidenceVerifiedByKey: new Map(),
};

function minimalPacket(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    summary: "Phase 1 validate test packet",
    findings: [],
    evaluations: [],
    open_questions: [],
    next_steps: [],
    okf_candidate_ids: [],
    ...extra,
  };
}

describe("validateContinuityPacket (Phase 1 contract repair)", () => {
  it("accepts a minimal valid packet and returns packet + bytes", () => {
    const result = validateContinuityPacket(minimalPacket(), baseContext);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.packet.summary).toBe("Phase 1 validate test packet");
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.compact.length).toBeGreaterThan(0);
  });

  it("throws ContinuityValidationError on a non-object packet", () => {
    expect(() => validateContinuityPacket("not-an-object", baseContext)).toThrow(
      ContinuityValidationError,
    );
  });

  it("rejects an array packet with continuity_packet_not_object", () => {
    const result = tryValidateContinuityPacket([], baseContext);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.diagnostics[0]?.code).toBe("continuity_packet_not_object");
  });

  it("rejects an unsupported schema version", () => {
    const result = tryValidateContinuityPacket(
      {
        schema_version: 999,
        summary: "wrong version",
        findings: [],
        evaluations: [],
        open_questions: [],
        next_steps: [],
        okf_candidate_ids: [],
      },
      baseContext,
    );
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(
      result.diagnostics.some((d) => d.code === "continuity_packet_wrong_schema_version"),
    ).toBe(true);
  });

  it("rejects an oversized packet", () => {
    const huge = "x".repeat(33 * 1024);
    const packet = minimalPacket({ summary: huge });
    const result = tryValidateContinuityPacket(packet, baseContext);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.diagnostics.some((d) => d.code === "continuity_packet_too_large")).toBe(true);
    expect(result.bytes).not.toBeNull();
    expect(result.bytes).toBeGreaterThan(32 * 1024);
  });

  it("rejects a structurally invalid packet via TypeBox errors", () => {
    const packet = minimalPacket({ findings: "not-an-array" });
    const result = tryValidateContinuityPacket(packet, baseContext);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(
      result.diagnostics.some((d) => d.code === "continuity_packet_wrong_schema_version"),
    ).toBe(true);
  });

  it("rejects a packet with duplicate IDs via semantic validation", () => {
    const packet = minimalPacket({
      findings: [
        {
          id: "dup-1",
          kind: "fact",
          confidence: "inferred",
          statement: "first",
          evidence: [],
          supersedes: [],
        },
        {
          id: "dup-1",
          kind: "fact",
          confidence: "inferred",
          statement: "second",
          evidence: [],
          supersedes: [],
        },
      ],
    });
    const result = tryValidateContinuityPacket(packet, baseContext);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.diagnostics.some((d) => d.code === "continuity_packet_duplicate_ids")).toBe(true);
  });

  it("throws ContinuityValidationError when missing summary", () => {
    const packet = {
      schema_version: 1,
      findings: [],
      evaluations: [],
      open_questions: [],
      next_steps: [],
      okf_candidate_ids: [],
    };
    expect(() => validateContinuityPacket(packet, baseContext)).toThrow(ContinuityValidationError);
  });

  it("preserves byte measurement for a legacy 4096-byte-ish packet", () => {
    const packet = minimalPacket({ summary: "a".repeat(2048) });
    const result = validateContinuityPacket(packet, baseContext);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.bytes).toBeGreaterThan(2048);
  });

  it("accepts a packet whose evidence references are declared-only (no resolved authority)", () => {
    const packet = minimalPacket({
      findings: [
        {
          id: "f-1",
          kind: "fact",
          confidence: "inferred",
          statement: "test",
          evidence: [{ kind: "external", url: "https://example.com/x", title: "x" }],
          supersedes: [],
        },
      ],
    });
    const result = validateContinuityPacket(packet, baseContext);
    expect(result.kind).toBe("ok");
  });
});
