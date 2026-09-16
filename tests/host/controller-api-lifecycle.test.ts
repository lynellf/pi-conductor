import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInitialCheckpoint } from "../../src/core/reduce.js";
import type { MachineDefinition } from "../../src/core/types.js";
import type { HostFactoryContext } from "../../src/host/api.js";
import { reconcileCrash, resumeRun, startRun } from "../../src/host/api.js";
import type { RoleSession } from "../../src/host/host.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { StubHost } from "../../src/host/stub-host.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const controllerManifest = `
version: 1
controller:
  protocol_version: 1
  controller_id: repo-controller
  runtime_id: runtime-v1
  executable: /opt/controller
  argv: []
  adapters: []
  delegation:
    allowed_subagents: [worker]
    max_children_per_session: 1
    max_parallel: 1
roles:
  - name: orchestrator
    is_orchestrator: true
subagents:
  - name: worker
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: worker.md
`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("controller public run lifecycle", () => {
  it("rejects operator guidance before an active session on start and resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-controller-api-"));
    roots.push(root);
    const manifestPath = join(root, "conductor.yaml");
    const baseDir = join(root, "runs");
    await writeFile(manifestPath, controllerManifest, "utf8");

    const hostFactory = ({ runId, log, loadedManifest }: HostFactoryContext) =>
      new StubHost({
        runId,
        log,
        loadedManifest,
        steps: [],
        agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-controller-api-agent-"),
      });

    const started = await startRun(manifestPath, { goal: "run", baseDir, hostFactory });
    await expect(started.steer("change course")).rejects.toMatchObject({
      code: "steering_unavailable",
    });
    await expect(started.followUp("do more")).rejects.toMatchObject({
      code: "steering_unavailable",
    });
    await started.abort("prepare resume test");
    await started.completion();

    const resumed = await resumeRun(manifestPath, started.runId, {
      goal: "",
      baseDir,
      hostFactory,
    });
    await expect(resumed.steer("change course")).rejects.toMatchObject({
      code: "steering_unavailable",
    });
    await expect(resumed.followUp("do more")).rejects.toMatchObject({
      code: "steering_unavailable",
    });
    await resumed.abort("test cleanup");
    await resumed.completion();
  });

  it("preserves controller origin without fabricating a Pi conversation on crash", () => {
    const def = Object.freeze({
      manifest_version: "1",
      orchestrator: "orchestrator",
      workers: Object.freeze([]),
      max_visits: Object.freeze({}),
      end_request_roles: null,
    }) as MachineDefinition;
    const initial = createInitialCheckpoint(def);
    const checkpoint = {
      ...initial,
      active_role_session: {
        id: "controller-session",
        role: "orchestrator",
        session_file: "/private/controller-audit.jsonl",
      },
    };
    const log = new InMemoryRecordLog();
    log.append({ type: "checkpoint_snapshot", checkpoint });
    log.append({
      type: "session_started",
      run_id: checkpoint.run_id,
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: null,
      model_effort: "off",
      session_file: "/private/controller-audit.jsonl",
      parent_session: null,
      role_session_id: "controller-session",
      session_origin: "controller",
      controller_id: "repo-controller",
      controller_definition_digest: "a".repeat(64),
      controller_activation_id: "activation-1",
      controller_owner_epoch: 1,
      ts: 1,
    });

    reconcileCrash(checkpoint.run_id, checkpoint, def, log);

    const failed = log
      .records(checkpoint.run_id)
      .find((record) => record.type === "session_failed");
    expect(failed).toMatchObject({
      failure_reason: "crashed",
      role_session_id: "controller-session",
      session_origin: "controller",
      controller_id: "repo-controller",
      controller_definition_digest: "a".repeat(64),
      controller_activation_id: "activation-1",
      controller_owner_epoch: 1,
    });
    expect(failed).not.toHaveProperty("conversation_id");
  });

  it("records controller driver failure without SDK model fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-controller-failure-"));
    roots.push(root);
    const manifestPath = join(root, "conductor.yaml");
    const baseDir = join(root, "runs");
    await writeFile(manifestPath, controllerManifest, "utf8");

    const handle = await startRun(manifestPath, {
      goal: "run",
      baseDir,
      hostFactory: ({ runId, log, loadedManifest }) => {
        const host = new StubHost({
          runId,
          log,
          loadedManifest,
          steps: [],
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-controller-failure-agent-"),
        });
        const session: RoleSession = {
          role: "orchestrator",
          sessionId: "controller-session",
          sessionFile: join(root, "controller-audit.jsonl"),
          sessionOrigin: {
            kind: "controller",
            controllerId: "repo-controller",
            definitionDigest: "a".repeat(64),
            activationId: "activation-1",
            ownerEpoch: 1,
          },
          model: null,
          effort: "off",
          readCaptureBuffer: () => [],
          resetCaptureBuffer: () => undefined,
          subscribe: () => () => undefined,
          prompt: async () => {
            throw new Error("controller driver failed");
          },
          dispose: async () => undefined,
        };
        host.spawnRole = async () => session;
        return host;
      },
    });

    await expect(handle.completion()).resolves.toMatchObject({ exitReason: "session_failed" });
    const records = new FileRecordLog({ baseDir }).records(handle.runId);
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "session_failed",
        failure_reason: "controller_failed",
        session_origin: "controller",
      }),
    );
    expect(records.some((record) => record.type === "model_fallback")).toBe(false);
    expect(records.some((record) => record.type === "model_retry")).toBe(false);
  });
});
