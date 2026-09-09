import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryRecordLog, loadManifestFromString, ProductionHost } from "../../src/index.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    context_retention: run
    models: [{ model: stub:stub-model, effort: off }]
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
`;

async function makeHost() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-context-startup-cleanup-"));
  await mkdir(join(cwd, ".pi", "roles"), { recursive: true });
  await writeFile(join(cwd, ".pi/roles/orchestrator.md"), "orchestrator", "utf8");
  const log = new InMemoryRecordLog();
  const requests: unknown[] = [];
  const host = new ProductionHost({
    modelRegistry: makeModelRegistryWithStub([], ["stub-model"], (request) =>
      requests.push(request),
    ),
    cwd,
    agentDir: makeAndTrackIsolatedAgentDir("context-startup-agent-"),
    log,
    loadedManifest: loadManifestFromString(MANIFEST, cwd),
    runId: "startup-cleanup-run",
  });
  return { cwd, host, log, requests };
}

describe("shared SDK startup cleanup", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    vi.restoreAllMocks();
  });

  it("disposes and unregisters when invocation persistence fails before prompting", async () => {
    const startupError = new Error("context invocation persistence failed");
    const context = await makeHost();
    const append = context.log.append.bind(context.log);
    const appendSpy = vi.spyOn(context.log, "append").mockImplementation((record) => {
      if (record.type === "context_invocation_started") throw startupError;
      append(record);
    });
    roots.push(context.cwd);
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");

    const result = context.host.spawnRole("orchestrator");
    await expect(result).rejects.toBe(startupError);
    expect(appendSpy).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(
      (context.host as unknown as { sessionStates: Map<string, unknown> }).sessionStates.size,
    ).toBe(0);
    expect(
      (context.host as unknown as { agentsBySessionId: Map<string, unknown> }).agentsBySessionId
        .size,
    ).toBe(0);
    expect(
      context.log
        .records("startup-cleanup-run")
        .some((record) => record.type === "context_invocation_started"),
    ).toBe(false);
    expect(context.requests).toHaveLength(0);
  });

  it("disposes and unregisters when live event binding fails before prompting", async () => {
    const context = await makeHost();
    roots.push(context.cwd);
    const bindingError = new Error("live event binding failed");
    const subscribe = vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation(() => {
      throw bindingError;
    });
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");

    await expect(context.host.spawnRole("orchestrator")).rejects.toBe(bindingError);
    expect(subscribe).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(
      (context.host as unknown as { sessionStates: Map<string, unknown> }).sessionStates.size,
    ).toBe(0);
    expect(
      (context.host as unknown as { agentsBySessionId: Map<string, unknown> }).agentsBySessionId
        .size,
    ).toBe(0);
    expect(context.requests).toHaveLength(0);
  });
});
