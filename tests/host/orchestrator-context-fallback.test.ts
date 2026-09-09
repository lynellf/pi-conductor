import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../../src/host/loop.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import {
  createInitialCheckpoint,
  InMemoryRecordLog,
  type PersistedRecord,
  ProductionHost,
} from "../../src/index.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

describe("production retained context with model fallback", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps orchestrator context across a model fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-context-fallback-"));
    roots.push(root);
    await mkdir(join(root, ".pi", "roles"), { recursive: true });
    await writeFile(join(root, ".pi", "roles", "orchestrator.md"), "orchestrator", "utf8");
    const loaded = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    context_retention: run
    models:
      - { model: stub:primary, effort: medium }
      - { model: stub:secondary, effort: high }
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, end]
`);
    const log = new InMemoryRecordLog();
    const checkpoint = createInitialCheckpoint(loaded.def);
    const requests: unknown[] = [];
    const executionVisits: number[] = [];
    const host = new ProductionHost({
      runId: checkpoint.run_id,
      log,
      loadedManifest: loaded,
      cwd: root,
      agentDir: makeAndTrackIsolatedAgentDir("context-fallback-"),
      modelRegistry: makeModelRegistryWithStub(
        [
          {
            kind: "fail",
            errorMessage: "primary failed after assistant output",
            usage: {
              input: 10,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 20,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
            },
          },
          {
            kind: "emit_end",
            reason: "done",
            usage: {
              input: 15,
              output: 15,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 30,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
            },
          },
        ],
        ["primary", "secondary"],
        (request) => requests.push(request),
      ),
    });
    const spawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      if (role === "orchestrator") {
        const executionVisitIndex = options?.executionVisitIndex;
        if (executionVisitIndex === undefined) throw new Error("missing execution visit");
        executionVisits.push(executionVisitIndex);
      }
      return spawn(role, options);
    };
    const result = await runLoop({
      def: loaded.def,
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "retain the initial plan",
    });
    const records = log.records(checkpoint.run_id);
    const orchestratorSessions = records.filter(
      (record): record is Extract<PersistedRecord, { type: "session_started" }> =>
        record.type === "session_started" && record.role === "orchestrator",
    );
    expect(result.exitReason).toBe("done");
    expect(orchestratorSessions).toHaveLength(2);
    const sessionIds = orchestratorSessions
      .map((record) => record.role_session_id)
      .filter((id): id is string => id !== undefined);
    expect(new Set(sessionIds).size).toBe(2);
    const models = orchestratorSessions
      .map((record) => record.model)
      .filter((model): model is string => model !== undefined);
    expect(models).toEqual(["stub:primary", "stub:secondary"]);
    expect(executionVisits).toEqual([executionVisits[0], executionVisits[0]]);
    expect(
      records.find((record) => record.type === "model_fallback" && record.role === "orchestrator"),
    ).toMatchObject({ from_model: "stub:primary", to_model: "stub:secondary" });
    const fallbackRequest = JSON.stringify(requests.at(-1));
    expect(fallbackRequest).toContain("retain the initial plan");
    expect(fallbackRequest.match(/"role":"user"/g)?.length).toBe(2);
    const boundaries = records.filter(
      (record) => record.type === "context_boundary_committed" && record.role === "orchestrator",
    );
    expect(boundaries).toHaveLength(2);
    const terminalUsage = records.filter(
      (record) =>
        (record.type === "session_ended" || record.type === "session_failed") &&
        record.role === "orchestrator" &&
        record.usage !== undefined,
    );
    const terminalCosts = terminalUsage.map((record) => {
      if (record.type !== "session_ended" && record.type !== "session_failed") {
        throw new Error("expected terminal record");
      }
      if (record.usage === undefined) throw new Error("expected terminal usage");
      return record.usage.cost;
    });
    expect(terminalCosts).toEqual([0.02, 0.03]);
    expect(terminalCosts.reduce((total, cost) => total + cost, 0)).toBe(0.05);
  });
});
