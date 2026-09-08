import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeRoleSession } from "../../../src/host/rpc/node-role-session-factory.js";
import type { NodeRoleSessionOptions } from "../../../src/host/rpc/protocol.js";
import { InMemoryRecordLog, loadManifestFromString, ProductionHost } from "../../../src/index.js";
import { makeModelRegistryWithStub } from "../production-host-fixture.js";
import {
  commitFile,
  gitRevision,
  initializeGitFixture,
  isolatedRolesManifest,
} from "../production-host-snapshot-fixture.js";
import { HostFakeRpcChild } from "./host-rpc-fixture.js";

describe("ProductionHost isolated RPC execution bridge", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
  });

  it("provisions a plain read bridge with durable identity and confinement", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-rpc-execution-"));
    directories.push(cwd);
    await initializeGitFixture(cwd);
    await commitFile(cwd, "inside.txt", "inside\n");
    const snapshot = await gitRevision(cwd, "HEAD");
    const log = new InMemoryRecordLog();
    const logicalIdentity = JSON.stringify(["rpc-execution-run", "implementer", 1]);
    log.append({
      type: "tool_execution_started",
      schema_version: 1,
      run_id: "rpc-execution-run",
      execution_id: "prior-timeout-execution",
      supervision_id: "prior-timeout-supervision",
      logical_session_id: logicalIdentity,
      role_session_id: "rpc-prior",
      tool_call_id: "prior-timeout-call",
      tool_name: "read",
      timeout_ms: 1,
      recovery_count: 0,
      ts: Date.now(),
    });
    log.append({
      type: "tool_execution_finished",
      schema_version: 1,
      run_id: "rpc-execution-run",
      execution_id: "prior-timeout-execution",
      supervision_id: "prior-timeout-supervision",
      logical_session_id: logicalIdentity,
      role_session_id: "rpc-prior",
      tool_call_id: "prior-timeout-call",
      tool_name: "read",
      elapsed_ms: 1,
      recovery_count: 0,
      outcome: "timed_out",
      cleanup: "confirmed",
      ts: Date.now(),
    });
    const manifest = loadManifestFromString(isolatedRolesManifest("snapshot"), cwd);
    const captured: NodeRoleSessionOptions[] = [];
    const host = new ProductionHost({
      cwd,
      log,
      runId: "rpc-execution-run",
      loadedManifest: manifest,
      modelRegistry: makeModelRegistryWithStub(),
      nodeRoleSessionFactory: async (options) => {
        captured.push(options);
        const child = new HostFakeRpcChild();
        const starting = createNodeRoleSession({ ...options, spawn: () => child });
        child.success(child.command("get_state"), {
          sessionId: `rpc-${captured.length}`,
          sessionFile: join(options.sessionDir, `rpc-${captured.length}.jsonl`),
        });
        child.stdin.onWrite = (write) => {
          const command = JSON.parse(write) as Record<string, unknown>;
          if (command.type === "abort") child.success(command);
        };
        return starting;
      },
    });
    const session = await host.spawnRole("implementer", {
      visitIndex: 1,
      executionVisitIndex: 2,
    });
    const bridge = captured[0]?.executionBridge;
    expect(snapshot).toMatch(/^[0-9a-f]{40}$/);
    expect(bridge?.tools).toHaveLength(1);
    const read = bridge?.tools[0];
    if (read === undefined || bridge === undefined) throw new Error("missing execution bridge");
    const result = await read.execute(
      "actual-read-call",
      { path: "inside.txt" },
      new AbortController().signal,
      undefined,
    );
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining("inside") }] });
    expect(log.records("rpc-execution-run")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_execution_started",
          tool_call_id: "actual-read-call",
        }),
        expect.objectContaining({
          type: "tool_execution_finished",
          tool_call_id: "actual-read-call",
        }),
      ]),
    );
    expect(log.records("rpc-execution-run")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_execution_started",
          tool_call_id: "actual-read-call",
          recovery_count: 0,
        }),
      ]),
    );
    const escaped = await read.execute(
      "escape-call",
      { path: "../outside.txt" },
      new AbortController().signal,
      undefined,
    );
    expect(escaped).toMatchObject({
      content: [{ text: expect.stringContaining("inside the projection") }],
    });
    await session.dispose();
  });
});
