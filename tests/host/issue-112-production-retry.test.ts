/** Issue #112: real SDK retry and retained-parent invocation boundaries (§8.2/§11.4). */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runLoop } from "../../src/host/loop.js";
import {
  createInitialCheckpoint,
  InMemoryRecordLog,
  loadManifestFromString,
  ProductionHost,
} from "../../src/index.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

it("blocks real SDK ordinary tool effects after a non-retrying terminal failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "conductor-112-terminal-"));
  try {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ retry: { enabled: false } }));
    await writeFile(join(cwd, "fixture.txt"), "original");
    const loaded = loadManifestFromString(
      `version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [stub:stub-model]
    tools: [write, end]
`,
      cwd,
    );
    const host = new ProductionHost({
      runId: "terminal-test",
      log: new InMemoryRecordLog(),
      loadedManifest: loaded,
      cwd,
      agentDir: makeAndTrackIsolatedAgentDir(),
      modelRegistry: makeModelRegistryWithStub([
        { kind: "fail", errorMessage: "provider refused request" },
        {
          kind: "emit_tool_calls",
          calls: [{ name: "write", arguments: { path: "fixture.txt", content: "must not write" } }],
        },
        { kind: "emit_end", reason: "must not capture" },
      ]),
    });
    const session = await host.spawnRole("orchestrator", { visitIndex: 1 });
    try {
      await session.prompt("fail without retry");
      expect(host.sessionTerminalReason(session)).toBe("model_error");
      const results: unknown[] = [];
      session.subscribe?.((event) => {
        if (event.type === "tool_execution_end") results.push(event.result);
      });
      // Simulate erroneous continued SDK work; the registered wrapper must still
      // enforce the logical host terminal before an executable tool starts.
      await session.prompt("attempt more work");
      expect(await readFile(join(cwd, "fixture.txt"), "utf8")).toBe("original");
      expect(results).toContainEqual(
        expect.objectContaining({
          details: expect.objectContaining({ reason: "host_terminated", cause: "model_error" }),
        }),
      );
      expect(session.readCaptureBuffer()).toEqual([]);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 15_000);

it("recovers through SDK retry, reads a file, hands off, and returns to a fresh retained invocation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "conductor-112-retry-"));
  try {
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
        compaction: { enabled: false },
      }),
    );
    await writeFile(join(cwd, "fixture.txt"), "retry recovered");
    const loaded = loadManifestFromString(
      `version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    context_retention: run
    models: [stub:stub-model]
    tools: [read, handoff, end]
  - name: worker
    max_visits: 2
    models: [stub:stub-model]
    tools: [handoff, end]
`,
      cwd,
    );
    const registry = makeModelRegistryWithStub([
      {
        kind: "fail",
        errorMessage: "WebSocket idle timeout after 300000ms",
        usage: {
          input: 7,
          output: 3,
          totalTokens: 10,
          cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
        },
      },
      { kind: "emit_tool_calls", calls: [{ name: "read", arguments: { path: "fixture.txt" } }] },
      { kind: "emit_handoff", target_role: "worker", reason: "read succeeded" },
      { kind: "emit_handoff", target_role: "orchestrator", reason: "reviewed" },
      { kind: "emit_end", reason: "complete" },
    ]);
    const log = new InMemoryRecordLog();
    const checkpoint = createInitialCheckpoint(loaded.def);
    const host = new ProductionHost({
      runId: checkpoint.run_id,
      log,
      loadedManifest: loaded,
      cwd,
      agentDir: makeAndTrackIsolatedAgentDir(),
      modelRegistry: registry,
    });
    const result = await runLoop({
      def: loaded.def,
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "repair",
    });
    expect(result.exitReason).toBe("done");
    const records = log.records(checkpoint.run_id);
    expect(records.filter((record) => record.type === "session_failed")).toEqual([]);
    const parents = records.filter(
      (record) => record.type === "session_ended" && record.role === "orchestrator",
    );
    expect(parents).toHaveLength(2);
    expect(parents[0]).toMatchObject({ usage: { cost: 0.02 } });
    expect(parents[1]).toMatchObject({ usage: { cost: 0 } });
    const invocations = records.filter((record) => record.type === "context_invocation_started");
    const boundaries = records.filter((record) => record.type === "context_boundary_committed");
    expect(invocations).toHaveLength(2);
    expect(boundaries).toHaveLength(2);
    expect(new Set(invocations.map((record) => record.role_session_id)).size).toBe(2);
    for (const invocation of invocations) {
      expect(boundaries).toContainEqual(
        expect.objectContaining({ role_session_id: invocation.role_session_id }),
      );
      expect(parents).toContainEqual(
        expect.objectContaining({ role_session_id: invocation.role_session_id }),
      );
    }
    const read = records.find(
      (record) => record.type === "tool_execution_finished" && record.tool_name === "read",
    );
    expect(read).toBeDefined();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 15_000);
