/** Issue #113: finalization failure is durable after an accepted handoff (§11/§12). */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { OrchestratorContextFileError } from "../../src/host/orchestrator-context-file-errors.js";
import { FileRecordLog, ProductionHost, resumeRun, startRun } from "../../src/index.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const yaml = `version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    context_retention: run
    models: [stub:stub-model]
    tools: [handoff, end]
  - name: reviewer
    max_visits: 2
    models: [stub:stub-model]
    tools: [handoff, end]
`;

it.each([
  "context_capture",
  "session_dispose",
  "context_commit",
] as const)("records %s failure and stops before spawning the accepted receiver", async (phase) => {
  const cwd = await mkdtemp(join(tmpdir(), "conductor-113-finalize-"));
  try {
    await mkdir(join(cwd, ".pi"));
    const manifestPath = join(cwd, ".pi/conductor.yaml");
    const baseDir = join(cwd, "runs");
    await writeFile(manifestPath, yaml);
    const registry = makeModelRegistryWithStub([
      {
        kind: "emit_handoff",
        target_role: "reviewer",
        reason: "review ready",
        usage: {
          input: 3,
          output: 2,
          totalTokens: 5,
          cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
        },
      },
    ]);
    const disposed = vi.fn();
    const fail = () => {
      throw new OrchestratorContextFileError("unresolved_tool_call", "injected incomplete context");
    };
    const handle = await startRun(manifestPath, {
      goal: "test finalization",
      baseDir,
      hostFactory: ({ runId, log, loadedManifest }) => {
        const host = new ProductionHost({
          runId,
          log,
          loadedManifest,
          cwd,
          modelRegistry: registry,
          agentDir: makeAndTrackIsolatedAgentDir(),
        });
        const spawn = host.spawnRole.bind(host);
        vi.spyOn(host, "spawnRole").mockImplementation(async (...args) => {
          const session = await spawn(...args);
          if (session.retainedContext === undefined) throw new Error("missing retained fixture");
          return {
            ...session,
            retainedContext: {
              captureBoundary:
                phase === "context_capture"
                  ? async () => fail()
                  : session.retainedContext.captureBoundary,
              commitBoundary:
                phase === "context_commit"
                  ? async () => fail()
                  : session.retainedContext.commitBoundary,
            },
            dispose: async () => {
              await session.dispose();
              disposed();
              if (phase === "session_dispose") fail();
            },
          };
        });
        return host;
      },
    });
    const completion = await handle.completion();
    expect(completion).toMatchObject({
      exitReason: "session_failed",
      finalCheckpoint: { current_role: "reviewer", active_role_session: null },
    });
    expect(handle.runStats().exitReason).toBe("session_failed");
    expect(disposed).toHaveBeenCalledOnce();
    const disk = new FileRecordLog({ baseDir });
    const records = disk.records(handle.runId);
    const starts = records.filter((record) => record.type === "session_started");
    expect(starts).toHaveLength(1);
    expect(records.filter((record) => record.type === "transition_accepted")).toHaveLength(1);
    const terminals = records.filter(
      (record) => record.type === "session_ended" || record.type === "session_failed",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ type: "session_ended", usage: { cost: 0.02 } });
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "run_finalization_failed",
        phase,
        role: "orchestrator",
        code: "unresolved_tool_call",
        diagnostic: "injected incomplete context",
        role_session_id: starts[0]?.role_session_id,
        recovery: phase === "session_dispose" ? "inspect_disposal" : "reset_orchestrator_context",
      }),
    );
    const construct = vi.fn(() => {
      throw new Error("resume must reject before host construction");
    });
    await expect(
      resumeRun(manifestPath, handle.runId, {
        goal: "",
        baseDir,
        hostFactory: construct,
      }),
    ).rejects.toThrow(phase === "session_dispose" ? "disposal" : "reset-orchestrator-context");
    expect(construct).not.toHaveBeenCalled();
    if (phase === "session_dispose") {
      await expect(
        resumeRun(manifestPath, handle.runId, {
          goal: "",
          baseDir,
          resetOrchestratorContext: true,
          hostFactory: construct,
        }),
      ).rejects.toThrow("context reset cannot confirm disposal");
      expect(construct).not.toHaveBeenCalled();
    } else {
      const resumedRegistry = makeModelRegistryWithStub([
        { kind: "emit_handoff", target_role: "orchestrator", reason: "review complete" },
        { kind: "emit_end", reason: "complete" },
      ]);
      const resumed = await resumeRun(manifestPath, handle.runId, {
        goal: "",
        baseDir,
        resetOrchestratorContext: true,
        hostFactory: ({ runId, log, loadedManifest }) =>
          new ProductionHost({
            runId,
            log,
            loadedManifest,
            cwd,
            modelRegistry: resumedRegistry,
            agentDir: makeAndTrackIsolatedAgentDir(),
          }),
      });
      expect((await resumed.completion()).exitReason).toBe("done");
      expect(resumed.runStats().finalizationFailure).toBeUndefined();
      const resumedRecords = new FileRecordLog({ baseDir }).records(handle.runId);
      expect(
        resumedRecords
          .filter((record) => record.type === "session_started")
          .map((record) => record.role),
      ).toEqual(["orchestrator", "reviewer", "orchestrator"]);
      expect(
        resumedRecords.filter((record) => record.type === "run_finalization_failed"),
      ).toHaveLength(1);
      expect(
        resumedRecords.filter((record) => record.type === "context_epoch_started"),
      ).toContainEqual(expect.objectContaining({ reason: "reset", epoch: 2 }));
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
