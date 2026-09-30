/**
 * Issue #159: SDK sessions must use the host `agentDir` for Pi settings.
 *
 * `createAgentSession` falls back to the user's global agent dir
 * (`PI_CODING_AGENT_DIR` / `~/.pi/agent`) when `agentDir` is omitted. Role
 * sessions then read the user's global settings, and `setModel` during a
 * trajectory continuation persists the role model as the user's default.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStubModel } from "../../src/host/stub-provider.js";
import { InMemoryRecordLog, loadManifestFromString, ProductionHost } from "../../src/index.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: off }]
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
  - name: worker
    max_visits: 3
    models: [{ model: stub:stub-model, effort: off }]
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
`;

const USER_SETTINGS = `${JSON.stringify({ retry: { enabled: false } }, null, 2)}\n`;

const directories: string[] = [];
let priorAgentDirEnv: string | undefined;
let userAgentDir: string;

beforeEach(async () => {
  priorAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  userAgentDir = await mkdtemp(join(tmpdir(), "pi-conductor-user-agent-"));
  directories.push(userAgentDir);
  await writeFile(join(userAgentDir, "settings.json"), USER_SETTINGS, "utf8");
  // Stand in for the developer's real `~/.pi/agent`.
  process.env.PI_CODING_AGENT_DIR = userAgentDir;
});

afterEach(async () => {
  if (priorAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDirEnv;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SDK role sessions use the host agentDir for settings", () => {
  it("does not write the user's global settings on trajectory continuation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-agent-dir-"));
    directories.push(cwd);
    await mkdir(join(cwd, ".pi", "roles"), { recursive: true });
    await writeFile(join(cwd, ".pi", "roles", "worker.md"), "worker", "utf8");
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub([
        { kind: "emit_text", text: "source complete" },
        { kind: "emit_text", text: "target complete" },
      ]),
      cwd,
      log: new InMemoryRecordLog(),
      loadedManifest: loadManifestFromString(MANIFEST, cwd),
      runId: "agent-dir-run",
      agentDir: makeAndTrackIsolatedAgentDir(),
    });

    const source = await host.spawnRole("worker");
    try {
      await source.prompt("source operation");
      const target = await source.continueTrajectory?.({
        role: "worker",
        model: makeStubModel() as never,
        logicalModel: "stub:stub-model",
        effort: "off",
        systemPrompt: "worker",
        activeToolNames: ["handoff", "end"],
        visitIndex: 2,
        maxSessionCostUsd: null,
      });
      if (target === undefined) throw new Error("trajectory continuation unavailable");
      await target.dispose();
    } finally {
      await source.dispose();
    }

    expect(await readFile(join(userAgentDir, "settings.json"), "utf8")).toBe(USER_SETTINGS);
  });
});
