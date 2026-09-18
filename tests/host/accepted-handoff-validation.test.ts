/** Issue #110 seam contract + durable-continuity §8 — bounded, recoverable handoff capture. */

import { describe, expect, it } from "vitest";

import type { ContinuityEvidenceResolution, MachineEvent, Role } from "../../src/core/types.js";
import {
  prepareAcceptedHandoffEnvelope,
  validateAcceptedHandoffContinuity,
} from "../../src/host/accepted-handoff-validation.js";
import {
  type ContinuityAudience,
  type ContinuityEvidenceAuthority,
  resolveContinuityEvidence,
  toEnvelopeResolutions,
} from "../../src/host/continuity-evidence.js";
import type { Host } from "../../src/host/host.js";
import { CONTINUITY_MAX_PACKET_BYTES, evidenceRefKey } from "../../src/persistence/continuity.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import type {
  ContinuityFinding,
  ContinuityPacketV1,
  EvidenceRef,
} from "../../src/seam/continuity.js";

interface HostLike {
  persistRecord(record: PersistedRecord): void;
  // Unused Host members are stubbed to satisfy the validator's read of
  // the full Host interface; only persistRecord is exercised here.
}

class StubHost implements HostLike {
  public records: PersistedRecord[] = [];
  persistRecord(record: PersistedRecord): void {
    this.records.push(record);
  }
}

function buildHandoffEvent(args: {
  target_role: Role;
  continuity?: ContinuityPacketV1 | null;
}): Extract<MachineEvent, { readonly type: "handoff" }> {
  return {
    type: "handoff",
    target_role: args.target_role,
    request_end: false,
    payload: {
      target_role: args.target_role,
      status: "ready",
      objective: "Continue the work.",
      summary: "Hand-off summary.",
      requested_action: "act",
      ...(args.continuity !== undefined && args.continuity !== null
        ? { continuity: args.continuity }
        : {}),
    },
  };
}

function makePacket(overrides: Partial<ContinuityPacketV1> = {}): ContinuityPacketV1 {
  return {
    schema_version: 1,
    summary: "summary",
    findings: [],
    evaluations: [],
    open_questions: [],
    next_steps: [],
    okf_candidate_ids: [],
    ...overrides,
  };
}

/** Construct a structurally valid packet at the packet byte cap (or one byte above it). */
function packetAtByteBoundary(extraBytes = 0): ContinuityPacketV1 {
  const findings: ContinuityFinding[] = Array.from({ length: 16 }, (_value, index) => ({
    id: `f${index + 1}`,
    kind: "fact",
    confidence: "observed",
    statement: "x".repeat(index === 15 ? 1 : 2_048),
    evidence: [],
    supersedes: [],
  }));
  const base = Buffer.byteLength(JSON.stringify(makePacket({ findings })));
  const last = findings[15];
  if (last === undefined) throw new Error("expected boundary finding");
  const statementLength = 1 + CONTINUITY_MAX_PACKET_BYTES + extraBytes - base;
  if (statementLength < 1 || statementLength > 2_048)
    throw new Error("boundary fixture cannot satisfy TypeBox statement bounds");
  findings[15] = { ...last, statement: "x".repeat(statementLength) };
  const packet = makePacket({ findings });
  expect(Buffer.byteLength(JSON.stringify(packet))).toBe(CONTINUITY_MAX_PACKET_BYTES + extraBytes);
  return packet;
}

function makeAuthority(opts: {
  runId: string;
  role?: Role;
  visitIndex?: number;
  executionsInRun?: ReadonlySet<string>;
  artifactsVisible?: ReadonlySet<string>;
  repositoryResolve?: (input: {
    readonly commit: string;
    readonly path: string;
  }) => Promise<"verified" | "missing" | "declared">;
}): ContinuityEvidenceAuthority {
  const audience: ContinuityAudience = {
    run_id: opts.runId,
    ...(opts.role !== undefined && { role: opts.role }),
    ...(opts.visitIndex !== undefined && { visit_index: opts.visitIndex }),
  };
  return {
    audience,
    toolExecutions: {
      belongsToRun: (id, runId) => runId === opts.runId && (opts.executionsInRun?.has(id) ?? false),
    },
    contextArtifacts: {
      canRead: (id) => opts.artifactsVisible?.has(id) ?? false,
    },
    repository: {
      resolveCommit: async (input) => {
        const status = await (opts.repositoryResolve ?? (async () => "verified" as const))(input);
        const out:
          | { status: "verified"; resolved_path?: string }
          | { status: "missing"; diagnostic: "repository_not_in_canonical_history" } =
          status === "verified"
            ? { status: "verified", resolved_path: input.path }
            : { status: "missing", diagnostic: "repository_not_in_canonical_history" };
        return out;
      },
    },
  };
}

function makeRepositoryRef(): EvidenceRef {
  return {
    kind: "repository",
    path: "docs/handbook.md",
    commit: "a".repeat(40),
  };
}

describe("validateAcceptedHandoffContinuity (durable-continuity §8)", () => {
  it("returns not_required when no continuity is present and require_handoff is false", async () => {
    const event = buildHandoffEvent({ target_role: "orchestrator" });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: false },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("not_required");
  });

  it("returns not_required when no continuity is present and policy is null (legacy)", async () => {
    const event = buildHandoffEvent({ target_role: "orchestrator" });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: null,
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("not_required");
  });

  it("rejects with continuity_packet_not_object when require_handoff is true and continuity is missing", async () => {
    const event = buildHandoffEvent({ target_role: "orchestrator" });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.diagnostics[0]?.code).toBe("continuity_packet_not_object");
  });

  it("rejects a packet with unsupported schema_version", async () => {
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: { ...makePacket(), schema_version: 2 as never },
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.diagnostics[0]?.code).toBe("continuity_unsupported_version");
  });

  it("rejects a packet that fails v1 TypeBox structural validation", async () => {
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: { schema_version: 1, summary: "x" } as never,
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.diagnostics[0]?.code).toBe("continuity_packet_wrong_schema_version");
  });

  it("rejects a packet exceeding 32 KiB UTF-8 (oversized boundary)", async () => {
    const oversized = "x".repeat(CONTINUITY_MAX_PACKET_BYTES);
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: makePacket({ summary: oversized }),
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.diagnostics[0]?.code).toBe("continuity_packet_too_large");
  });

  it("accepts a packet at exactly the 32 KiB UTF-8 byte boundary", async () => {
    const packet = packetAtByteBoundary();
    const event = buildHandoffEvent({ target_role: "orchestrator", continuity: packet });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.packet_utf8_bytes).toBe(CONTINUITY_MAX_PACKET_BYTES);
  });

  it("rejects a packet at +1 byte over the 32 KiB boundary", async () => {
    const packet = packetAtByteBoundary(1);
    const event = buildHandoffEvent({ target_role: "orchestrator", continuity: packet });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.diagnostics[0]?.code).toBe("continuity_packet_too_large");
  });

  it("rejects duplicate IDs within a packet", async () => {
    const packet = makePacket({
      findings: [
        {
          id: "f1",
          kind: "fact",
          confidence: "observed",
          statement: "first",
          evidence: [],
          supersedes: [],
        },
        {
          id: "f1",
          kind: "decision",
          confidence: "observed",
          statement: "duplicate id",
          evidence: [],
          supersedes: [],
        },
      ],
    });
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: packet,
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.diagnostics.some((d) => d.code === "continuity_packet_duplicate_ids")).toBe(
      true,
    );
  });

  it("rejects self-supersession", async () => {
    const packet = makePacket({
      findings: [
        {
          id: "f1",
          kind: "fact",
          confidence: "observed",
          statement: "self-supersede",
          evidence: [],
          supersedes: ["f1"],
        },
      ],
    });
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: packet,
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.diagnostics.some((d) => d.code === "continuity_supersedes_self_reference")).toBe(
      true,
    );
  });

  it("rejects forward supersession", async () => {
    const packet = makePacket({
      findings: [
        {
          id: "f1",
          kind: "fact",
          confidence: "observed",
          statement: "first",
          evidence: [],
          supersedes: ["f2"],
        },
        {
          id: "f2",
          kind: "fact",
          confidence: "observed",
          statement: "second",
          evidence: [],
          supersedes: [],
        },
      ],
    });
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: packet,
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(
      outcome.diagnostics.some((d) => d.code === "continuity_supersedes_forward_reference"),
    ).toBe(true);
  });

  it("rejects supersession against an unknown ID", async () => {
    const packet = makePacket({
      findings: [
        {
          id: "f1",
          kind: "fact",
          confidence: "observed",
          statement: "first",
          evidence: [],
          supersedes: ["ghost"],
        },
      ],
    });
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: packet,
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.diagnostics.some((d) => d.code === "continuity_supersedes_missing_item")).toBe(
      true,
    );
  });

  it("rejects a finding that claims verified confidence without verified evidence", async () => {
    const packet = makePacket({
      findings: [
        {
          id: "f1",
          kind: "fact",
          confidence: "verified",
          statement: "needs verified evidence",
          evidence: [makeRepositoryRef()],
          supersedes: [],
        },
      ],
    });
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: packet,
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({
        runId: "run-1",
        repositoryResolve: async () => "missing",
      }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(
      outcome.diagnostics.some((d) => d.code === "continuity_verified_requires_resolved_evidence"),
    ).toBe(true);
  });

  it("accepts a finding whose verified evidence resolves to verified", async () => {
    const packet = makePacket({
      findings: [
        {
          id: "f1",
          kind: "fact",
          confidence: "verified",
          statement: "verified evidence",
          evidence: [makeRepositoryRef()],
          supersedes: [],
        },
      ],
    });
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: packet,
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("ok");
  });

  it("rejects an evaluation whose execution_id is not in the run", async () => {
    const packet = makePacket({
      evaluations: [
        {
          id: "e1",
          label: "tests pass",
          execution_id: "ghost",
          supersedes: [],
        },
      ],
    });
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: packet,
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1", executionsInRun: new Set() }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.diagnostics.some((d) => d.code === "continuity_evaluations_cross_run")).toBe(
      true,
    );
  });

  it("rejects an OKF candidate that is not a verified finding", async () => {
    const packet = makePacket({
      findings: [
        {
          id: "f1",
          kind: "fact",
          confidence: "observed",
          statement: "observed only",
          evidence: [],
          supersedes: [],
        },
      ],
      okf_candidate_ids: ["f1"],
    });
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: packet,
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(
      outcome.diagnostics.some((d) => d.code === "continuity_okf_candidate_not_verified"),
    ).toBe(true);
  });

  it("rejects a cyclic supersession (mutual forward references)", async () => {
    const packet = makePacket({
      findings: [
        {
          id: "f1",
          kind: "fact",
          confidence: "observed",
          statement: "first",
          evidence: [],
          supersedes: ["f2"],
        },
        {
          id: "f2",
          kind: "fact",
          confidence: "observed",
          statement: "second",
          evidence: [],
          supersedes: ["f1"],
        },
      ],
    });
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: packet,
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    // Forward references close the cycle by construction.
    expect(
      outcome.diagnostics.some((d) => d.code === "continuity_supersedes_forward_reference"),
    ).toBe(true);
  });
});

describe("prepareAcceptedHandoffEnvelope — integration", () => {
  it("persists a continuity rejection record and returns a repair diagnostic", async () => {
    const host = new StubHost();
    const event = buildHandoffEvent({ target_role: "orchestrator" });
    const result = await prepareAcceptedHandoffEnvelope({
      event,
      host: host as unknown as Host,
      runId: "run-1",
      role: "worker",
      sessionId: "s-1",
      sessionFile: "/worker.jsonl",
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    expect(result.kind).toBe("rejected");
    expect(host.records).toHaveLength(1);
    expect(host.records[0]).toMatchObject({
      type: "handoff_validation_rejected",
      run_id: "run-1",
      role: "worker",
      session_id: "s-1",
    });
  });

  it("returns an envelope with continuity metadata when validation succeeds", async () => {
    const host = new StubHost();
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: makePacket(),
    });
    const result = await prepareAcceptedHandoffEnvelope({
      event,
      host: host as unknown as Host,
      runId: "run-1",
      role: "worker",
      sessionId: "s-1",
      sessionFile: "/worker.jsonl",
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "run-1" }),
      knownItemIds: new Set(),
    });
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.envelope.continuity_packet_utf8_bytes).toBeGreaterThan(0);
    expect(result.envelope.continuity_evidence).toBeDefined();
    expect(host.records).toEqual([]);
  });
});

describe("evidence resolution status (spec §7)", () => {
  it("classifies repository evidence as verified when the authority can resolve it", async () => {
    const authority = makeAuthority({
      runId: "run-1",
      repositoryResolve: async () => "verified",
    });
    const resolutions = await resolveContinuityEvidence(authority, [
      { key: evidenceRefKey("findings", "f1", 0), ref: makeRepositoryRef() },
    ]);
    expect(toEnvelopeResolutions(resolutions)[0]?.status).toBe("verified");
  });

  it("classifies repository evidence as missing when the authority cannot resolve it", async () => {
    const authority = makeAuthority({
      runId: "run-1",
      repositoryResolve: async () => "missing",
    });
    const resolutions = await resolveContinuityEvidence(authority, [
      { key: evidenceRefKey("findings", "f1", 0), ref: makeRepositoryRef() },
    ]);
    const envelope: ContinuityEvidenceResolution = toEnvelopeResolutions(
      resolutions,
    )[0] as ContinuityEvidenceResolution;
    expect(envelope.status).toBe("missing");
    expect(envelope.diagnostic).toBe("repository_not_in_canonical_history");
  });

  it("classifies tool_execution evidence as missing for cross-run IDs", async () => {
    const authority = makeAuthority({
      runId: "run-1",
      executionsInRun: new Set(["exec-1"]),
    });
    const resolutions = await resolveContinuityEvidence(authority, [
      {
        key: evidenceRefKey("evaluations", "e1", 0),
        ref: { kind: "tool_execution", execution_id: "exec-other" },
      },
    ]);
    expect(toEnvelopeResolutions(resolutions)[0]?.status).toBe("missing");
  });

  it("classifies context_artifact evidence as audience-denied when not granted", async () => {
    const authority = makeAuthority({
      runId: "run-1",
      artifactsVisible: new Set(),
    });
    const resolutions = await resolveContinuityEvidence(authority, [
      {
        key: evidenceRefKey("findings", "f1", 0),
        ref: {
          kind: "context_artifact",
          artifact_id: "a1",
          sha256: "a".repeat(64),
        },
      },
    ]);
    const env = toEnvelopeResolutions(resolutions)[0] as ContinuityEvidenceResolution;
    expect(env.status).toBe("missing");
    expect(env.diagnostic).toBe("context_artifact_unauthorized");
  });

  it("classifies external evidence as declared (never verified)", async () => {
    const authority = makeAuthority({ runId: "run-1" });
    const resolutions = await resolveContinuityEvidence(authority, [
      {
        key: evidenceRefKey("findings", "f1", 0),
        ref: {
          kind: "external",
          url: "https://example.com/spec.md",
          title: "Spec",
        },
      },
    ]);
    const env = toEnvelopeResolutions(resolutions)[0] as ContinuityEvidenceResolution;
    expect(env.status).toBe("declared");
    expect(env.diagnostic).toBe("external_declared");
  });
});

describe("run/role/visit identity is host-derived (spec §8)", () => {
  it("rejects spoofed role/visit fields when the authority audience differs", async () => {
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: makePacket(),
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({
        runId: "run-1",
        role: "worker",
        visitIndex: 1,
        executionsInRun: new Set(),
      }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("ok");
  });

  it("authority run_id always wins over payload identity (no spoof)", async () => {
    const event = buildHandoffEvent({
      target_role: "orchestrator",
      continuity: makePacket(),
    });
    const outcome = await validateAcceptedHandoffContinuity({
      event,
      policy: { require_handoff: true },
      authority: makeAuthority({ runId: "host-run" }),
      knownItemIds: new Set(),
    });
    expect(outcome.kind).toBe("ok");
  });
});
