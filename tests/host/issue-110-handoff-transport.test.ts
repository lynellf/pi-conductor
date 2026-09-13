/** Issue #110 regression — accepted structured handoffs reach the returning orchestrator. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
