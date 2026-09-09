import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { FileToolWorkerError } from "../../src/host/execution/file-tool-worker.js";
import { InMemoryRecordLog, loadManifestFromString, ProductionHost } from "../../src/index.js";

const directories: string[] = [];
const originalPiPackageDir = process.env.PI_PACKAGE_DIR;

afterEach(async () => {
  if (originalPiPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
  else process.env.PI_PACKAGE_DIR = originalPiPackageDir;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function registry(): ModelRegistry {
  return ModelRegistry.inMemory(AuthStorage.inMemory());
}

function manifest(tools: string, delegation = ""): ReturnType<typeof loadManifestFromString> {
  return loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [${tools}]
    system_prompt: orchestrator.md
${delegation}  - name: worker
    max_visits: 1
    tools: [handoff, end]
    system_prompt: worker.md
subagents:
  - name: child
    models: [stub:model]
    system_prompt: child.md
    max_session_cost_usd: 1
`);
}

describe("ProductionHost supervised file-tool preflight", () => {
  it.each([
    ["read role", manifest("read, handoff, end")],
    [
      "delegation-only parent",
      manifest(
        "delegate, handoff, end",
        "    delegation:\n      allowed_subagents: [child]\n      max_children_per_session: 1\n      max_parallel: 1\n",
      ),
    ],
  ])("rejects %s before creating its session directory", async (_name, loadedManifest) => {
    const invalidPackageDir = await mkdtemp(join(tmpdir(), "pi-conductor-invalid-pi-"));
    directories.push(invalidPackageDir);
    process.env.PI_PACKAGE_DIR = invalidPackageDir;
    const sessionDir = join(invalidPackageDir, "sessions");

    expect(
      () =>
        new ProductionHost({
          modelRegistry: registry(),
          cwd: invalidPackageDir,
          log: new InMemoryRecordLog(),
          loadedManifest,
          runId: "preflight",
          sessionDir,
        }),
    ).toThrow(FileToolWorkerError);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("does not require the worker runtime for a manifest without file tools", async () => {
    const invalidPackageDir = await mkdtemp(join(tmpdir(), "pi-conductor-no-file-tools-"));
    directories.push(invalidPackageDir);
    process.env.PI_PACKAGE_DIR = join(invalidPackageDir, "missing");
    const sessionDir = join(invalidPackageDir, "sessions");

    expect(
      () =>
        new ProductionHost({
          modelRegistry: registry(),
          cwd: invalidPackageDir,
          log: new InMemoryRecordLog(),
          loadedManifest: manifest("handoff, end"),
          runId: "no-file-tools",
          sessionDir,
        }),
    ).not.toThrow();
    expect(existsSync(sessionDir)).toBe(true);
  });
});
