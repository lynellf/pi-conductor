/** Issue #110 regression — accepted structured handoffs reach the returning orchestrator. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAcceptedHandoffEnvelope,
  incomingAcceptedHandoff,
  readAcceptedHandoffEnvelope,
  recipientHandoffPayload,
} from "../../src/core/accepted-handoff.js";
import type {
  AcceptedHandoffEnvelope,
  ContinuityEvidenceResolution,
  TransitionAccepted,
} from "../../src/core/types.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { runLoop } from "../../src/host/loop.js";
import { StubHost } from "../../src/host/stub-host.js";
import {
  createInitialCheckpoint,
  InMemoryRecordLog,
  type MachineDefinition,
  resumeRun,
  startRun,
} from "../../src/index.js";
import type { ContinuityPacketV1 } from "../../src/seam/continuity.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

function makeDef(): MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze(["worker"]),
    max_visits: Object.freeze({ worker: 3 }),
    end_request_roles: null,
  }) as MachineDefinition;
}

function parseAcceptedPayload(seed: string): Record<string, unknown> {
  const marker = seed.includes("    payload: ") ? "    payload: " : "handoff payload:\n";
  const start = seed.indexOf(marker);
  if (start < 0) throw new Error("expected accepted_handoff payload section");
  const end = seed.indexOf("\n", start + marker.length);
  const json = seed.slice(start + marker.length, end < 0 ? seed.length : end);
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("accepted_handoff payload is not an object");
  }
  return parsed as Record<string, unknown>;
}

describe("issue #110 — accepted handoff transport", () => {
  it("delivers the worker's structured public dispatch envelope to the returning orchestrator", async () => {
    const checkpoint = createInitialCheckpoint(makeDef());
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: checkpoint.run_id,
      log,
      steps: [
        { kind: "emit_handoff", target_role: "worker", reason: "begin public packet work" },
        { kind: "emit_text", text: `private-worker-transcript-${"x".repeat(12_000)}` },
        {
          kind: "emit_tool_calls",
          calls: [
            {
              name: "handoff",
              arguments: {
                target_role: "orchestrator",
                status: "ready",
                objective: "Dispatch independent workers from the public packet.",
                summary: "Public packet is ready at /example/epoch/inputs/dispatch-v1.json.",
                requested_action: "dispatch-public-packet",
                public_dispatch: {
                  path: "/example/epoch/inputs/dispatch-v1.json",
                  sha256: "a".repeat(64),
                },
                reason: "The public packet is ready; reservation work is complete.",
                context_ref: { source_session_file: "model-supplied-private-session" },
                artifacts: [{ path: "model-declared-unverified-artifact.txt" }],
              },
            },
          ],
        },
        { kind: "emit_end", reason: "dispatch complete" },
      ],
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-issue-110-"),
    });

    const orchestratorPrompts: string[] = [];
    const originalSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await originalSpawn(role, options);
      const originalPrompt = session.prompt.bind(session);
      session.prompt = async (text) => {
        if (role === "orchestrator") orchestratorPrompts.push(text);
        await originalPrompt(text);
      };
      return session;
    };

    const result = await runLoop({
      def: makeDef(),
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "Prepare the public dispatch packet.",
    });

    expect(result.exitReason).toBe("done");
    expect(orchestratorPrompts).toHaveLength(2);
    const returningSeed = orchestratorPrompts[1];
    if (returningSeed === undefined) throw new Error("expected returning orchestrator seed");

    const payload = parseAcceptedPayload(returningSeed);
    expect(payload).toMatchObject({
      target_role: "orchestrator",
      objective: "Dispatch independent workers from the public packet.",
      summary: "Public packet is ready at /example/epoch/inputs/dispatch-v1.json.",
      requested_action: "dispatch-public-packet",
      public_dispatch: {
        path: "/example/epoch/inputs/dispatch-v1.json",
        sha256: "a".repeat(64),
      },
    });
    expect(returningSeed).not.toContain("private-worker-transcript-");
    expect(returningSeed).not.toContain("model-supplied-private-session");
    expect(returningSeed).not.toContain("model-declared-unverified-artifact.txt");
    expect(payload).not.toHaveProperty("context_ref");
    expect(payload).not.toHaveProperty("artifacts");
  });

  it("delivers an accepted orchestrator handoff envelope to its worker recipient", async () => {
    const checkpoint = createInitialCheckpoint(makeDef());
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: checkpoint.run_id,
      log,
      steps: [
        {
          kind: "emit_tool_calls",
          calls: [
            {
              name: "handoff",
              arguments: {
                target_role: "worker",
                status: "ready",
                objective: "Inspect the public packet.",
                summary: "The coordinator prepared a packet for inspection.",
                requested_action: "inspect-public-packet",
                public_dispatch: {
                  path: "/example/epoch/inputs/dispatch-v2.json",
                  sha256: "b".repeat(64),
                },
                reason: "The packet is ready for the worker.",
              },
            },
          ],
        },
        { kind: "emit_handoff", target_role: "orchestrator", reason: "inspection complete" },
        { kind: "emit_end", reason: "done" },
      ],
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-issue-110-forward-"),
    });

    const workerPrompts: string[] = [];
    const originalSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await originalSpawn(role, options);
      const originalPrompt = session.prompt.bind(session);
      session.prompt = async (text) => {
        if (role === "worker") workerPrompts.push(text);
        await originalPrompt(text);
      };
      return session;
    };

    const result = await runLoop({
      def: makeDef(),
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "Prepare the public dispatch packet.",
    });

    expect(result.exitReason).toBe("done");
    expect(workerPrompts).toHaveLength(1);
    const workerSeed = workerPrompts[0];
    if (workerSeed === undefined) throw new Error("expected worker recipient seed");

    expect(workerSeed).toContain("Inspect the public packet.");
    expect(workerSeed).toContain("The coordinator prepared a packet for inspection.");
    expect(workerSeed).toContain("inspect-public-packet");
    expect(workerSeed).toContain("/example/epoch/inputs/dispatch-v2.json");
    expect(workerSeed).toContain("b".repeat(64));
  });

  it.each([
    "orchestrator",
    "worker",
  ] as const)("reloads accepted %s handoff metadata from disk before a public resumeRun recipient prompt", async (recipientRole) => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-issue-110-resume-"));
    const baseDir = join(workdir, "runs");
    const manifestPath = join(workdir, ".pi", "conductor.yaml");
    await mkdir(join(workdir, ".pi"), { recursive: true });
    await writeFile(
      manifestPath,
      [
        "version: 1",
        "roles:",
        "  - name: orchestrator",
        "    is_orchestrator: true",
        "    system_prompt: .pi/roles/orchestrator.md",
        "    tools: [handoff, end]",
        "  - name: worker",
        "    max_visits: 3",
        "    system_prompt: .pi/roles/worker.md",
        "    tools: [handoff, end]",
        "",
      ].join("\n"),
      "utf8",
    );

    let runId: string | null = null;
    try {
      const started = await startRun(manifestPath, {
        goal: "Prepare the public dispatch packet.",
        baseDir,
        hostFactory: ({ runId: factoryRunId, log }) => {
          runId = factoryRunId;
          const host = new StubHost({
            runId: factoryRunId,
            log,
            steps:
              recipientRole === "worker"
                ? [
                    {
                      kind: "emit_tool_calls" as const,
                      calls: [
                        {
                          name: "handoff",
                          arguments: {
                            target_role: "worker",
                            status: "ready",
                            objective: "Inspect the public packet.",
                            summary: "The coordinator prepared a packet for inspection.",
                            requested_action: "inspect-public-packet",
                            public_dispatch: {
                              path: "/example/epoch/inputs/dispatch-v2.json",
                              sha256: "b".repeat(64),
                            },
                            reason: "The packet is ready for the worker.",
                          },
                        },
                      ],
                    },
                  ]
                : [
                    {
                      kind: "emit_handoff" as const,
                      target_role: "worker",
                      reason: "begin public packet work",
                    },
                    {
                      kind: "emit_text" as const,
                      text: `private-worker-transcript-${"x".repeat(12_000)}`,
                    },
                    {
                      kind: "emit_tool_calls" as const,
                      calls: [
                        {
                          name: "handoff",
                          arguments: {
                            target_role: "orchestrator",
                            status: "ready",
                            objective: "Dispatch independent workers from the public packet.",
                            summary:
                              "Public packet is ready at /example/epoch/inputs/dispatch-v1.json.",
                            requested_action: "dispatch-public-packet",
                            public_dispatch: {
                              path: "/example/epoch/inputs/dispatch-v1.json",
                              sha256: "a".repeat(64),
                            },
                            reason: "The public packet is ready; reservation work is complete.",
                          },
                        },
                      ],
                    },
                  ],
            agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-issue-110-resume-start-"),
          });
          const originalSpawn = host.spawnRole.bind(host);
          host.spawnRole = async (role, options) => {
            if (
              role === recipientRole &&
              host.log
                .records(factoryRunId)
                .some((record) => record.type === "session_ended" && record.role === "worker")
            ) {
              throw new Error("simulated restart after accepted handoff");
            }
            return originalSpawn(role, options);
          };
          return host;
        },
      });
      if (recipientRole === "orchestrator") {
        await expect(started.completion()).rejects.toThrow("simulated restart");
      } else {
        expect((await started.completion()).exitReason).toBe("session_failed");
      }
      if (runId === null) throw new Error("startRun did not expose a run id");

      const beforeResume = new FileRecordLog({ baseDir });
      const acceptedBeforeResume = beforeResume
        .records(runId)
        .filter((record) => record.type === "transition_accepted");
      expect(acceptedBeforeResume).toHaveLength(recipientRole === "worker" ? 1 : 2);
      const persistedEnvelope = acceptedBeforeResume.find(
        (record) => record.type === "transition_accepted" && record.to === recipientRole,
      );
      expect(persistedEnvelope?.accepted_handoff?.payload).toMatchObject(
        recipientRole === "worker"
          ? {
              public_dispatch: {
                path: "/example/epoch/inputs/dispatch-v2.json",
                sha256: "b".repeat(64),
              },
            }
          : {
              public_dispatch: {
                path: "/example/epoch/inputs/dispatch-v1.json",
                sha256: "a".repeat(64),
              },
            },
      );

      const resumedPrompts: string[] = [];
      const resumed = await resumeRun(manifestPath, runId, {
        goal: "",
        baseDir,
        hostFactory: ({ runId: resumedRunId, log }) => {
          const host = new StubHost({
            runId: resumedRunId,
            log,
            steps:
              recipientRole === "worker"
                ? [
                    {
                      kind: "emit_handoff" as const,
                      target_role: "orchestrator",
                      reason: "inspection complete",
                    },
                    { kind: "emit_end" as const, reason: "dispatch complete" },
                  ]
                : [{ kind: "emit_end" as const, reason: "dispatch complete" }],
            agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-issue-110-resume-reload-"),
          });
          const originalSpawn = host.spawnRole.bind(host);
          host.spawnRole = async (role, options) => {
            const session = await originalSpawn(role, options);
            const originalPrompt = session.prompt.bind(session);
            session.prompt = async (text) => {
              if (role === recipientRole) resumedPrompts.push(text);
              await originalPrompt(text);
            };
            return session;
          };
          return host;
        },
      });
      const result = await resumed.completion();
      expect(result.exitReason).toBe("done");
      expect(resumedPrompts).toHaveLength(1);
      const resumedSeed = resumedPrompts[0];
      if (resumedSeed === undefined) throw new Error("expected resumed orchestrator seed");
      const payload = parseAcceptedPayload(resumedSeed);
      expect(payload).toMatchObject(
        recipientRole === "worker"
          ? {
              objective: "Inspect the public packet.",
              summary: "The coordinator prepared a packet for inspection.",
              requested_action: "inspect-public-packet",
              public_dispatch: {
                path: "/example/epoch/inputs/dispatch-v2.json",
                sha256: "b".repeat(64),
              },
            }
          : {
              objective: "Dispatch independent workers from the public packet.",
              summary: "Public packet is ready at /example/epoch/inputs/dispatch-v1.json.",
              requested_action: "dispatch-public-packet",
              public_dispatch: {
                path: "/example/epoch/inputs/dispatch-v1.json",
                sha256: "a".repeat(64),
              },
            },
      );
      if (recipientRole === "orchestrator")
        expect(resumedSeed).not.toContain("private-worker-transcript-");
      const acceptedAfterResume = new FileRecordLog({ baseDir })
        .records(runId)
        .filter((record) => record.type === "transition_accepted");
      expect(acceptedAfterResume).toHaveLength(
        acceptedBeforeResume.length + (recipientRole === "worker" ? 2 : 1),
      );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});

// ─── Durable continuity §8 — additive metadata over issue #110 transport ──────────────
//
// These tests target the pure envelope/seed pipeline; they exercise only
// the production write-owned paths. The integration tests in the existing
// describe block cover the full loop, which the parent wires with the
// materializer/renderer.

function minimalContinuityPacket(): ContinuityPacketV1 {
  return {
    schema_version: 1,
    summary: "minimal continuity summary",
    findings: [],
    evaluations: [],
    open_questions: [],
    next_steps: [],
    okf_candidate_ids: [],
  };
}

function verifiedResolution(): ContinuityEvidenceResolution {
  return Object.freeze({
    ref_key: "findings:f1:0",
    kind: "repository",
    status: "verified",
    resolved_path: "docs/example.md",
    resolved_commit: "a".repeat(40),
  }) as ContinuityEvidenceResolution;
}

function buildAcceptedWithContinuity(): TransitionAccepted {
  const packet = minimalContinuityPacket();
  const packetBytes = Buffer.byteLength(JSON.stringify(packet));
  // Spec §8: packet lives in payload.continuity (model-authored); host
  // adds only the flat siblings `continuity_packet_utf8_bytes` and
  // `continuity_evidence`. The packet is NOT duplicated as a sibling.
  const envelope = createAcceptedHandoffEnvelope(
    {
      target_role: "orchestrator",
      status: "ready",
      objective: "Continue.",
      summary: "Public summary.",
      requested_action: "act",
      continuity: packet,
    },
    "orchestrator",
    {
      packet_utf8_bytes: packetBytes,
      evidence_resolutions: [verifiedResolution()],
    },
  );
  if (envelope.kind !== "ok") throw new Error("valid envelope rejected");
  return {
    type: "transition_accepted",
    run_id: "run-1",
    from: "worker",
    to: "orchestrator",
    event: "handoff",
    target_role: "orchestrator",
    role: "worker",
    request_end: false,
    end_authority: null,
    end_requested_by: null,
    suggests_next: null,
    payload_summary: { field_names: ["continuity"] },
    guard: null,
    effect: [],
    session_file: "/worker.jsonl",
    ts: 1,
    context_ref: {
      run_id: "run-1",
      source_role: "worker",
      source_session_file: "/worker.jsonl",
    },
    accepted_handoff: envelope.envelope,
  };
}

describe("durable-continuity §8 — additive envelope metadata over issue #110 transport", () => {
  it("round-trips continuity metadata across readAcceptedHandoffEnvelope for a fresh-log replay", () => {
    const record = buildAcceptedWithContinuity();
    const incoming = incomingAcceptedHandoff([record], "run-1", "orchestrator");
    if (incoming === null || incoming.envelope === null) {
      throw new Error("expected an incoming envelope");
    }
    const packetBytes = Buffer.byteLength(JSON.stringify(minimalContinuityPacket()));
    expect(incoming.envelope.continuity_packet_utf8_bytes).toBe(packetBytes);
    expect(incoming.envelope.continuity_evidence).toEqual([verifiedResolution()]);
  });

  it("strips continuity from the recipient payload so raw packet prose never reaches the recipient seed", () => {
    const record = buildAcceptedWithContinuity();
    const incoming = incomingAcceptedHandoff([record], "run-1", "orchestrator");
    if (incoming === null || incoming.envelope === null) {
      throw new Error("expected an incoming envelope");
    }
    const projection = recipientHandoffPayload(incoming.envelope);
    expect(Object.keys(projection)).not.toContain("continuity");
    expect(projection).toMatchObject({
      target_role: "orchestrator",
      status: "ready",
      objective: "Continue.",
      summary: "Public summary.",
      requested_action: "act",
    });
  });

  it("re-reads byte-integrity of the embedded packet so a tampered round-trip is rejected", () => {
    const record = buildAcceptedWithContinuity();
    const tampered = {
      ...record,
      accepted_handoff: {
        ...(record.accepted_handoff as AcceptedHandoffEnvelope),
        continuity_packet_utf8_bytes: 999,
      },
    } as TransitionAccepted;
    expect(() => incomingAcceptedHandoff([tampered], "run-1", "orchestrator")).toThrow();
  });

  it("preserves legacy envelopes without continuity so old runs parse unchanged", () => {
    const created = createAcceptedHandoffEnvelope(
      { target_role: "orchestrator", value: "legacy" },
      "orchestrator",
    );
    if (created.kind !== "ok") throw new Error("valid envelope rejected");
    const record: TransitionAccepted = {
      type: "transition_accepted",
      run_id: "run-legacy",
      from: "worker",
      to: "orchestrator",
      event: "handoff",
      target_role: "orchestrator",
      role: "worker",
      request_end: false,
      end_authority: null,
      end_requested_by: null,
      suggests_next: null,
      payload_summary: { field_names: ["value"] },
      guard: null,
      effect: [],
      session_file: "/worker.jsonl",
      ts: 1,
      context_ref: {
        run_id: "run-legacy",
        source_role: "worker",
        source_session_file: "/worker.jsonl",
      },
      accepted_handoff: created.envelope,
    };
    const incoming = incomingAcceptedHandoff([record], "run-legacy", "orchestrator");
    if (incoming === null || incoming.envelope === null) {
      throw new Error("expected an incoming envelope");
    }
    expect(incoming.envelope.continuity_packet_utf8_bytes).toBeUndefined();
    expect(
      readAcceptedHandoffEnvelope(created.envelope, "orchestrator").continuity_packet_utf8_bytes,
    ).toBeUndefined();
  });
});

describe("durable-continuity §11 — restart reconstruction is byte-identical", () => {
  it("a fresh log read yields a byte-identical bounded seed (host log round-trip)", () => {
    const record = buildAcceptedWithContinuity();
    // First read (initial host run): serialize, then re-parse via
    // JSON.parse(JSON.stringify(...)) to simulate a fresh-log replay
    // where the host materializer sees only durable records.
    const firstIncoming = incomingAcceptedHandoff([record], "run-1", "orchestrator");
    if (firstIncoming === null || firstIncoming.envelope === null) {
      throw new Error("expected an incoming envelope");
    }

    // Round-trip via the JSON serialization used by the durable log.
    const json = JSON.stringify(firstIncoming.envelope);
    const rehydrated = JSON.parse(json) as unknown;
    const reread = readAcceptedHandoffEnvelope(rehydrated, "orchestrator");

    // The rehydrated envelope must be byte-identical to the original
    // envelope on the JSON shape used by the host log reader. The
    // materializer downstream operates over records alone (not the
    // live envelope), but its inputs are stable.
    expect(JSON.stringify(reread)).toBe(json);
    expect(reread.continuity_packet_utf8_bytes).toBe(
      firstIncoming.envelope.continuity_packet_utf8_bytes,
    );
    expect(reread.continuity_evidence).toEqual(firstIncoming.envelope.continuity_evidence);
  });
});
