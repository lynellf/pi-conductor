/** Issue #114 — run-memory routing must distinguish FSM topology from delegation. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runLoop } from "../../src/host/loop.js";
import {
  createInitialCheckpoint,
  InMemoryRecordLog,
  loadManifestFromString,
  ProductionHost,
} from "../../src/index.js";
import { asFull, makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Issue #114 — coordinator run-memory routing", () => {
  it("does not report FSM exhaustion when nonblocking delegation is available", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-issue-114-"));
    tempDirectories.push(cwd);
    const loaded = loadManifestFromString(
      `version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [stub:stub-model]
    max_run_cost_usd: 5
    tools: [handoff, end, delegate]
    delegation:
      mode: nonblocking
      allowed_subagents: [focused]
      max_children_per_session: 1
      max_parallel: 1
subagents:
  - name: focused
    models: [stub:stub-model]
    max_session_cost_usd: 1
    system_prompt: focused.md
`,
      cwd,
    );
    const log = new InMemoryRecordLog();
    const checkpoint = createInitialCheckpoint(loaded.def);
    const host = new ProductionHost({
      cwd,
      runId: checkpoint.run_id,
      log,
      loadedManifest: loaded,
      modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end", reason: "complete" }]),
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-issue-114-agent-"),
    });
    let coordinatorSeed = "";
    let coordinatorTools: readonly string[] = [];
    const spawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await spawn(role, options);
      if (role === loaded.def.orchestrator) {
        coordinatorTools = asFull(session).getActiveToolNames();
        const prompt = session.prompt.bind(session);
        session.prompt = async (text) => {
          coordinatorSeed = text;
          await prompt(text);
        };
      }
      return session;
    };

    const result = await runLoop({
      def: loaded.def,
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "coordinate the requested change",
      runCostCap: 5,
    });

    expect(result.exitReason).toBe("done");
    expect(coordinatorTools).toContain("delegate");
    expect(coordinatorSeed).toContain("next_candidates:");
    expect(coordinatorSeed).toContain("$5.0000 remaining");
    expect(coordinatorSeed).not.toMatch(/all workers are .*run budget is exhausted/i);
    expect(coordinatorSeed).toMatch(/no .*fsm.*workers.*configured|no configured .*workers/i);
  });

  it("does not imply delegation is enabled when the coordinator lacks the tool", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-issue-114-disabled-"));
    tempDirectories.push(cwd);
    const loaded = loadManifestFromString(
      `version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [stub:stub-model]
    max_run_cost_usd: 5
    tools: [handoff, end]
subagents:
  - name: focused
    models: [stub:stub-model]
    max_session_cost_usd: 1
    system_prompt: focused.md
`,
      cwd,
    );
    const checkpoint = createInitialCheckpoint(loaded.def);
    const host = new ProductionHost({
      cwd,
      runId: checkpoint.run_id,
      log: new InMemoryRecordLog(),
      loadedManifest: loaded,
      modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end", reason: "complete" }]),
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-issue-114-disabled-agent-"),
    });
    let coordinatorSeed = "";
    let coordinatorTools: readonly string[] = [];
    const spawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await spawn(role, options);
      if (role === loaded.def.orchestrator) {
        coordinatorTools = asFull(session).getActiveToolNames();
        const prompt = session.prompt.bind(session);
        session.prompt = async (text) => {
          coordinatorSeed = text;
          await prompt(text);
        };
      }
      return session;
    };

    const result = await runLoop({
      def: loaded.def,
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "coordinate the requested change",
      runCostCap: 5,
    });

    expect(result.exitReason).toBe("done");
    expect(coordinatorTools).not.toContain("delegate");
    expect(coordinatorSeed).toContain("If delegate is available in your toolset");
    expect(coordinatorSeed).not.toMatch(/delegate (?:is )?enabled/i);
  });
});
