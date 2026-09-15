/** Issue #113: an SDK-retried partial tool call stays audited but never re-enters retained context. */
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

it("retains a retried partial call as audit history without executing or restoring it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "conductor-113-retry-"));
  try {
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }),
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
    const requests: string[] = [];
    const log = new InMemoryRecordLog();
    const checkpoint = createInitialCheckpoint(loaded.def);
    const host = new ProductionHost({
      runId: checkpoint.run_id,
      log,
      loadedManifest: loaded,
      cwd,
      agentDir: makeAndTrackIsolatedAgentDir(),
      modelRegistry: makeModelRegistryWithStub(
        [
          {
            kind: "fail",
            errorMessage: "WebSocket idle timeout after 300000ms",
            partialToolCalls: [
              { name: "delegate", arguments: { mode: "nonblocking", tasks: [{ id: "miner" }] } },
            ],
            usage: {
              input: 7,
              output: 3,
              totalTokens: 10,
              cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
            },
          },
          {
            kind: "emit_tool_calls",
            calls: [{ name: "read", arguments: { path: "fixture.txt" } }],
          },
          { kind: "emit_handoff", target_role: "worker", reason: "read succeeded" },
          { kind: "emit_handoff", target_role: "orchestrator", reason: "reviewed" },
          { kind: "emit_end", reason: "complete" },
        ],
        ["stub-model"],
        (request) => requests.push(JSON.stringify(request)),
      ),
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
    expect(records.filter((record) => record.type === "tool_execution_started")).toHaveLength(1);
    expect(records.some((record) => record.type === "delegation_submission_accepted")).toBe(false);
    expect(
      records.filter((record) => record.type === "session_started" && record.role === "worker"),
    ).toHaveLength(1);
    expect(
      records.filter((record) => record.type === "session_ended" && record.role === "orchestrator"),
    ).toContainEqual(expect.objectContaining({ usage: expect.objectContaining({ cost: 0.02 }) }));
    expect(
      records.reduce(
        (total, record) =>
          record.type === "session_ended" || record.type === "session_failed"
            ? total + (record.usage?.cost ?? 0)
            : total,
        0,
      ),
    ).toBe(0.02);
    const firstBoundary = records.find(
      (record) => record.type === "context_boundary_committed" && record.role === "orchestrator",
    );
    if (firstBoundary?.type !== "context_boundary_committed") {
      throw new Error("expected retained context boundary");
    }
    expect(await readFile(firstBoundary.session_file, "utf8")).toContain("partial-1-0");
    expect(requests).toHaveLength(5);
    expect(requests.slice(3).every((request) => !request.includes("partial-1-0"))).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 15_000);
