import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const TRAJECTORY_MANIFEST = `
version: 1
handoffs:
  - from: orchestrator
    to: worker
    mode: trajectory
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [stub:orchestrator]
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: worker
    max_visits: 1
    models: [stub:worker]
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
`;

const FRESH_MANIFEST = `
version: 1
handoffs:
  - from: orchestrator
    to: worker
    mode: fresh
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [stub:orchestrator]
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: worker
    max_visits: 1
    models: [stub:worker]
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
`;

describe("ProductionHost trajectory SDK preflight", () => {
  const workdirs: string[] = [];

  afterEach(async () => {
    vi.doUnmock("@earendil-works/pi-coding-agent");
    vi.resetModules();
    await Promise.all(
      workdirs.splice(0).map((workdir) => rm(workdir, { recursive: true, force: true })),
    );
  });

  async function loadModules() {
    vi.resetModules();
    vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
      return { ...actual, VERSION: "0.84.4" };
    });
    const sdk = await import("@earendil-works/pi-coding-agent");
    const conductor = await import("../../src/index.js");
    const { TrajectoryHandoffError } = await import("../../src/host/trajectory-admission.js");
    return { ...sdk, ...conductor, TrajectoryHandoffError };
  }

  it("rejects a trajectory manifest before creating session work when the SDK version is unsupported", async () => {
    const {
      AuthStorage,
      ModelRegistry,
      InMemoryRecordLog,
      loadManifestFromString,
      createProductionHost,
      TrajectoryHandoffError,
    } = await loadModules();
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-trajectory-preflight-"));
    workdirs.push(cwd);
    const sessionDir = join(cwd, "sessions");

    expect(() =>
      createProductionHost({
        extension: { modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()), cwd },
        run: {
          log: new InMemoryRecordLog(),
          loadedManifest: loadManifestFromString(TRAJECTORY_MANIFEST),
          runId: "trajectory-preflight",
          sessionDir,
        },
      }),
    ).toThrow(TrajectoryHandoffError);
    expect(() =>
      createProductionHost({
        extension: { modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()), cwd },
        run: {
          log: new InMemoryRecordLog(),
          loadedManifest: loadManifestFromString(TRAJECTORY_MANIFEST),
          runId: "trajectory-preflight",
          sessionDir,
        },
      }),
    ).toThrow("trajectory requires @earendil-works/pi-coding-agent 0.80.6; loaded 0.84.4");
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("keeps fresh-only manifests constructible on an unsupported SDK version", async () => {
    const {
      AuthStorage,
      ModelRegistry,
      InMemoryRecordLog,
      loadManifestFromString,
      createProductionHost,
    } = await loadModules();
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-fresh-preflight-"));
    workdirs.push(cwd);

    const host = createProductionHost({
      extension: { modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()), cwd },
      run: {
        log: new InMemoryRecordLog(),
        loadedManifest: loadManifestFromString(FRESH_MANIFEST),
        runId: "fresh-preflight",
      },
    });

    expect(host.runId).toBe("fresh-preflight");
  });
});
