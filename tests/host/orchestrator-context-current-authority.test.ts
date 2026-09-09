import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { runLoop } from "../../src/host/loop.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import { createInitialCheckpoint, InMemoryRecordLog, ProductionHost } from "../../src/index.js";
import { asFull, makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

describe("retained invocation current authority", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("uses the current default model, prompt, and tools while retaining prior history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orchestrator-context-authority-"));
    roots.push(cwd);
    await mkdir(join(cwd, ".pi", "roles"), { recursive: true });
    const promptPath = join(cwd, ".pi", "roles", "orchestrator.md");
    await writeFile(promptPath, "OLD_SYSTEM_AUTHORITY", "utf8");
    const historicalManifest = loadManifestFromString(
      `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    context_retention: run
    models: [{ model: stub:historical, effort: off }]
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, end]
`,
      cwd,
    );
    const currentManifest = loadManifestFromString(
      `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    context_retention: run
    system_prompt: .pi/roles/orchestrator.md
    tools: [edit, end]
`,
      cwd,
    );
    const log = new InMemoryRecordLog();
    const checkpoint = createInitialCheckpoint(historicalManifest.def);
    const requests: unknown[] = [];
    const historicalHost = new ProductionHost({
      runId: checkpoint.run_id,
      log,
      loadedManifest: historicalManifest,
      cwd,
      agentDir: makeAndTrackIsolatedAgentDir("context-authority-"),
      modelRegistry: makeModelRegistryWithStub(
        [
          { kind: "emit_end", reason: "historical turn" },
          { kind: "emit_end", reason: "current turn" },
        ],
        ["historical", "current"],
        (request) => requests.push(request),
      ),
    });

    const first = await runLoop({
      def: historicalManifest.def,
      initialCheckpoint: checkpoint,
      host: historicalHost,
      initialGoal: "historical seed retained across authority change",
    });
    expect(first.exitReason).toBe("done");

    await writeFile(promptPath, "CURRENT_SYSTEM_AUTHORITY", "utf8");
    const currentAgentDir = makeAndTrackIsolatedAgentDir("context-authority-current-");
    await writeFile(
      join(currentAgentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "stub", defaultModel: "current" }),
      "utf8",
    );
    const currentModelIds: string[] = [];
    const currentRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
    const currentStub = makeStubModel();
    currentRegistry.registerProvider("stub", {
      api: "anthropic-messages",
      apiKey: "stub-key",
      baseUrl: currentStub.baseUrl,
      streamSimple: (model, context, options) => {
        currentModelIds.push(model.id);
        requests.push(context);
        return makeStubStreamFunction({
          steps: [{ kind: "emit_end", reason: "current turn" }],
        })(model, context, options);
      },
      models: ["historical", "current"].map((id) => ({ ...currentStub, id })),
    });
    const currentHost = new ProductionHost({
      runId: checkpoint.run_id,
      log,
      loadedManifest: currentManifest,
      cwd,
      agentDir: currentAgentDir,
      modelRegistry: currentRegistry,
    });

    const resumed = await currentHost.spawnRole("orchestrator", {
      visitIndex: 2,
      executionVisitIndex: 2,
    });
    expect(resumed.model).toBeNull();
    expect(asFull(resumed).getActiveToolNames()).toContain("edit");
    expect(asFull(resumed).getActiveToolNames()).not.toContain("read");
    await resumed.prompt("current authority seed");
    await resumed.dispose();

    expect(currentModelIds).toEqual(["current"]);
    expect(requests).toHaveLength(2);
    const currentRequest = JSON.stringify(requests.at(-1));
    expect(currentRequest).toContain("historical seed retained across authority change");
    expect(currentRequest).toContain("CURRENT_SYSTEM_AUTHORITY");
    expect(currentRequest).not.toContain("OLD_SYSTEM_AUTHORITY");
  });
});
