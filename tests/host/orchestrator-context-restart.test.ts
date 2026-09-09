import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileRecordLog,
  type HostFactoryContext,
  ProductionHost,
  resumeRun,
  startRun,
} from "../../src/index.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const manifest = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    context_retention: run
    models: [{ model: stub:stub-model, effort: off }]
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: worker
    max_visits: 1
    models: [{ model: stub:stub-model, effort: off }]
    system_prompt: .pi/roles/worker.md
    tools: [read, handoff, end]
`;

describe("public orchestrator context restart", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("starts with a real SDK session, resumes, and resets retained history", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-context-restart-"));
    roots.push(root);
    await mkdir(join(root, ".pi", "roles"), { recursive: true });
    await writeFile(
      join(root, ".pi", "roles", "orchestrator.md"),
      "You are the orchestrator.",
      "utf8",
    );
    await writeFile(join(root, ".pi", "roles", "worker.md"), "You are the worker.", "utf8");
    const manifestPath = join(root, "conductor.yaml");
    await writeFile(manifestPath, manifest, "utf8");
    const baseDir = join(root, "runs");
    const hostFactory = (ctx: HostFactoryContext) =>
      new ProductionHost({
        ...ctx,
        cwd: root,
        agentDir: makeAndTrackIsolatedAgentDir("restart-orchestrator-"),
        modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end", reason: "done" }]),
      });
    const started = await startRun(manifestPath, {
      goal: "retain this goal",
      baseDir,
      hostFactory,
    });
    expect((await started.completion()).exitReason).toBe("done");
    const before = new FileRecordLog({ baseDir });
    const runId = started.runId;
    const priorEpochs = before
      .records(runId)
      .filter((record) => record.type === "context_epoch_started");
    const priorInvocations = before
      .records(runId)
      .filter((record) => record.type === "context_invocation_started");
    expect(priorEpochs).toHaveLength(1);
    expect(priorInvocations.length).toBeGreaterThan(0);
    const leaseOwner = await before.acquireRunLease(runId);
    const lockedRecords = before.records(runId);
    await expect(
      resumeRun(manifestPath, runId, {
        goal: "",
        baseDir,
        hostFactory,
        resetOrchestratorContext: true,
      }),
    ).rejects.toMatchObject({ code: "run-in-progress" });
    expect(before.records(runId)).toEqual(lockedRecords);
    await leaseOwner.release();
    const committedBoundary = before
      .records(runId)
      .find((record) => record.type === "context_boundary_committed");
    if (committedBoundary?.type === "context_boundary_committed") {
      await unlink(committedBoundary.session_file);
    }
    before.close();

    const resumed = await resumeRun(manifestPath, runId, {
      goal: "",
      baseDir,
      hostFactory,
      resetOrchestratorContext: true,
    });
    expect((await resumed.completion()).exitReason).toBe("done");
    const after = new FileRecordLog({ baseDir });
    const epochs = after.records(runId).filter((record) => record.type === "context_epoch_started");
    expect(epochs).toHaveLength(2);
    expect(epochs[1]).toMatchObject({ epoch: 2, previous_epoch: 1, reason: "reset" });
    after.close();
  });

  it.each([false, true])("resumes a nonterminal run with reset=%s", async (reset) => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-context-continuation-"));
    roots.push(root);
    await mkdir(join(root, ".pi", "roles"), { recursive: true });
    await writeFile(
      join(root, ".pi", "roles", "orchestrator.md"),
      "You are the orchestrator.",
      "utf8",
    );
    await writeFile(join(root, ".pi", "roles", "worker.md"), "You are the worker.", "utf8");
    const manifestPath = join(root, "conductor.yaml");
    await writeFile(manifestPath, manifest, "utf8");
    const baseDir = join(root, "runs");
    const firstRequests: unknown[] = [];
    const first = await startRun(manifestPath, {
      goal: "preserve the initial plan",
      baseDir,
      hostFactory: (ctx) => {
        const host = new ProductionHost({
          ...ctx,
          cwd: root,
          agentDir: makeAndTrackIsolatedAgentDir("restart-continuation-first-"),
          modelRegistry: makeModelRegistryWithStub(
            [
              {
                kind: "emit_handoff",
                target_role: "worker",
                reason: "plan ready",
                usage: {
                  input: 10,
                  output: 10,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 20,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
                },
              },
            ],
            ["stub-model"],
            (request) => firstRequests.push(request),
          ),
        });
        const spawn = host.spawnRole.bind(host);
        host.spawnRole = async (role, options) => {
          if (role === "worker") throw new Error("controlled worker stop");
          return spawn(role, options);
        };
        return host;
      },
    });
    await expect(first.completion()).rejects.toThrow("controlled worker stop");
    const interrupted = new FileRecordLog({ baseDir });
    const runId = interrupted.listRunIds()[0];
    if (runId === undefined) throw new Error("expected interrupted run");
    expect(
      interrupted.records(runId).some((record) => record.type === "context_boundary_committed"),
    ).toBe(true);
    const priorCheckpoint = interrupted.latestCheckpoint(runId);
    const priorBoundary = interrupted
      .records(runId)
      .find(
        (record) => record.type === "context_boundary_committed" && record.role === "orchestrator",
      );
    if (reset && priorBoundary?.type === "context_boundary_committed") {
      await unlink(priorBoundary.session_file);
    }
    interrupted.close();

    const resumedRequests: unknown[] = [];
    const resumed = await resumeRun(manifestPath, runId, {
      goal: "",
      baseDir,
      hostFactory: (ctx) =>
        new ProductionHost({
          ...ctx,
          cwd: root,
          agentDir: makeAndTrackIsolatedAgentDir("restart-continuation-resumed-"),
          modelRegistry: makeModelRegistryWithStub(
            [
              { kind: "emit_handoff", target_role: "orchestrator", reason: "worker result" },
              { kind: "emit_end", reason: "done" },
            ],
            ["stub-model"],
            (request) => resumedRequests.push(request),
          ),
        }),
      resetOrchestratorContext: reset,
    });
    expect((await resumed.completion()).exitReason).toBe("done");
    expect(resumedRequests.length).toBeGreaterThanOrEqual(2);
    const finalRequest = JSON.stringify(resumedRequests.at(-1));
    expect(finalRequest).toContain("preserve the initial plan");
    expect(finalRequest).toContain("worker result");
    expect(finalRequest.match(/"role":"user"/g)?.length).toBe(reset ? 1 : 2);
    const after = new FileRecordLog({ baseDir });
    expect(after.latestCheckpoint(runId)?.visit_count.worker).toBe(
      priorCheckpoint?.visit_count.worker,
    );
    expect(
      after.records(runId).filter((record) => record.type === "context_epoch_started"),
    ).toHaveLength(reset ? 2 : 1);
    after.close();
  });
});
