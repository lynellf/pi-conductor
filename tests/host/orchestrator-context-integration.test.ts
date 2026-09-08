/** Production shared-SDK continuity proof for retained orchestrator context. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../../src/host/loop.js";
import type {
  Checkpoint,
  LoadedManifest,
  MachineDefinition,
  RoleSession,
} from "../../src/index.js";
import { createInitialCheckpoint, InMemoryRecordLog, ProductionHost } from "../../src/index.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const def: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["worker"]),
  max_visits: Object.freeze({ worker: 2 }),
  end_request_roles: null,
}) as MachineDefinition;

function loadedManifest(): LoadedManifest {
  return {
    def,
    manifest: {
      version: 1,
      roles: [
        {
          name: "orchestrator",
          is_orchestrator: true,
          context_retention: "run",
          models: [{ model: "stub:stub-model", effort: "off" }],
          system_prompt: ".pi/roles/orchestrator.md",
          tools: ["read", "handoff", "end"],
        },
        {
          name: "worker",
          max_visits: 2,
          models: [{ model: "stub:stub-model", effort: "off" }],
          system_prompt: ".pi/roles/worker.md",
          tools: ["read", "handoff", "end"],
        },
      ],
    },
    manifestDir: null,
    manifestVersion: 1,
    warnings: [],
  };
}

async function makeWorkdir(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-context-integration-"));
  await mkdir(join(cwd, ".pi", "roles"), { recursive: true });
  await writeFile(join(cwd, ".pi/roles/orchestrator.md"), "You are the orchestrator.", "utf8");
  await writeFile(join(cwd, ".pi/roles/worker.md"), "You are the worker.", "utf8");
  await writeFile(join(cwd, "worker-private.txt"), "WORKER_PRIVATE_MARKER", "utf8");
  return cwd;
}

describe("ProductionHost retained context continuity", () => {
  const workdirs: string[] = [];

  afterEach(async () => {
    await Promise.all(workdirs.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
  });

  it("keeps three logical turns connected while each role gets a fresh physical session", async () => {
    const cwd = await makeWorkdir();
    workdirs.push(cwd);
    const log = new InMemoryRecordLog();
    const initialCheckpoint: Checkpoint = createInitialCheckpoint(def);
    const prompts: Array<{ role: string; seed: string }> = [];
    const providerRequests: unknown[] = [];
    const host = new ProductionHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loadedManifest(),
      cwd,
      agentDir: makeAndTrackIsolatedAgentDir(),
      modelRegistry: makeModelRegistryWithStub(
        [
          { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
          {
            kind: "emit_tool_calls",
            calls: [{ name: "read", arguments: { path: "worker-private.txt" } }],
          },
          {
            kind: "emit_handoff",
            target_role: "orchestrator",
            reason: "worker result",
          },
          { kind: "emit_end", reason: "complete" },
        ],
        ["stub-model"],
        (request) => providerRequests.push(request),
      ),
    });
    const spawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await spawn(role, options);
      const prompt = session.prompt.bind(session);
      const wrapped: RoleSession = {
        ...session,
        prompt: async (seed) => {
          prompts.push({ role, seed });
          await prompt(seed);
        },
      };
      return wrapped;
    };

    const result = await runLoop({
      def,
      initialCheckpoint,
      host,
      initialGoal: "retain the prior plan while completing the task",
    });

    expect(result.exitReason).toBe("done");
    expect(prompts).toHaveLength(3);
    expect(prompts.map((entry) => entry.role)).toEqual(["orchestrator", "worker", "orchestrator"]);
    expect(
      new Set(
        log
          .records(initialCheckpoint.run_id)
          .filter((record) => record.type === "session_started")
          .map((record) => record.session_file),
      ).size,
    ).toBe(3);

    const invocations = log
      .records(initialCheckpoint.run_id)
      .filter((record) => record.type === "context_invocation_started");
    expect(invocations).toHaveLength(2);
    expect(new Set(invocations.map((record) => record.role_session_id)).size).toBe(2);
    expect(prompts[0]?.seed).toContain("retain the prior plan");
    expect(prompts[1]?.seed).toContain("plan ready");
    expect(prompts[2]?.seed).toContain("worker result");
    expect(providerRequests).toHaveLength(4);
    expect(JSON.stringify(providerRequests[2])).toContain("WORKER_PRIVATE_MARKER");
    expect(JSON.stringify(providerRequests[3])).toContain("plan ready");
    expect(JSON.stringify(providerRequests[3])).toContain("worker result");
    expect(JSON.stringify(providerRequests[3])).not.toContain("WORKER_PRIVATE_MARKER");

    const independentRequests: unknown[] = [];
    const independentLog = new InMemoryRecordLog();
    const independentCheckpoint = createInitialCheckpoint(def);
    const independentHost = new ProductionHost({
      runId: independentCheckpoint.run_id,
      log: independentLog,
      loadedManifest: loadedManifest(),
      cwd,
      agentDir: makeAndTrackIsolatedAgentDir(),
      modelRegistry: makeModelRegistryWithStub(
        [{ kind: "emit_end", reason: "independent" }],
        ["stub-model"],
        (request) => independentRequests.push(request),
      ),
    });
    await runLoop({
      def,
      initialCheckpoint: independentCheckpoint,
      host: independentHost,
      initialGoal: "fresh independent run",
    });
    expect(JSON.stringify(independentRequests)).not.toContain("plan ready");
    expect(JSON.stringify(independentRequests)).not.toContain("WORKER_PRIVATE_MARKER");
  });
});
