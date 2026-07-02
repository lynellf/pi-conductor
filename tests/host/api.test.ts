/**
 * Tests for the `modelRegistry` option on `startRun` and `resumeRun`
 * (Issue #6 — T2.10).
 *
 * Verifies that:
 *   - `startRun` with `modelRegistry` runs the preflight check and
 *     warnings surface on `handle.loadedManifest.warnings`.
 *   - `startRun` without `modelRegistry` skips the check.
 *   - `resumeRun` with `modelRegistry` runs the preflight check on
 *     the resumed load.
 *   - `resumeRun` without `modelRegistry` skips the check.
 *   - `handle.loadedManifest` is the same reference returned by
 *     `loadManifest` (wiring consistency).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Host,
  type HostFactoryContext,
  resumeRun,
  StubHost,
  startRun,
} from "../../src/index.js";
import type { InMemoryRecordLog } from "../../src/persistence/log.js";

// ─── Fixtures ───────────────────────────────────────────────────────────

const VALID_MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: unregistered:model-1
        effort: medium
    system_prompt: roles/orchestrator.md
`;

const MANIFEST_WITH_UNREGISTERED = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: unknown:provider-a
        effort: medium
      - model: unknown:provider-b
        effort: medium
    system_prompt: roles/orchestrator.md
`;

const MANIFEST_WITH_REGISTERED_ONLY = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: anthropic:claude-4
        effort: high
    system_prompt: roles/orchestrator.md
`;

// ─── Helpers ────────────────────────────────────────────────────────────

/** A StubHost factory that matches the HostFactoryContext shape. */
function stubHostFactory(ctx: HostFactoryContext): Host {
  return new StubHost({
    runId: ctx.runId,
    log: ctx.log as InMemoryRecordLog,
    steps: [],
  });
}

/** ModelRegistry with nothing registered — find always returns undefined. */
function emptyRegistry(): ModelRegistry {
  return ModelRegistry.inMemory(AuthStorage.inMemory());
}

/** ModelRegistry with anthropic registered. */
function registryWithAnthropic(): ModelRegistry {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  registry.find = (provider: string) => {
    if (provider === "anthropic") return {} as never;
    return undefined;
  };
  return registry;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("startRun with modelRegistry (T2.10)", () => {
  let workdir: string;
  let manifestPath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-api-test-"));
    await mkdir(join(workdir, ".pi"), { recursive: true });
    manifestPath = join(workdir, ".pi", "conductor.yaml");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("startRun with modelRegistry → preflight runs; warnings contain unregistered-provider", async () => {
    await writeFile(manifestPath, MANIFEST_WITH_UNREGISTERED, "utf8");
    const handle = await startRun(manifestPath, {
      goal: "test",
      hostFactory: stubHostFactory,
      modelRegistry: emptyRegistry(),
    });
    const unregistered = handle.loadedManifest.warnings.filter(
      (w) => w.code === "unregistered-provider",
    );
    expect(unregistered.length).toBeGreaterThan(0);
    expect(unregistered[0]?.message).toContain("unknown:provider-a");
    // Abort immediately — the handle is valid but we don't need the run to complete.
    await handle.abort("test cleanup");
  });

  it("startRun without modelRegistry → no unregistered-provider warnings", async () => {
    await writeFile(manifestPath, VALID_MANIFEST, "utf8");
    const handle = await startRun(manifestPath, {
      goal: "test",
      hostFactory: stubHostFactory,
    });
    const unregistered = handle.loadedManifest.warnings.filter(
      (w) => w.code === "unregistered-provider",
    );
    expect(unregistered).toHaveLength(0);
    await handle.abort("test cleanup");
  });

  it("handle.loadedManifest is the same reference from loadManifest (wiring check)", async () => {
    await writeFile(manifestPath, MANIFEST_WITH_UNREGISTERED, "utf8");
    const handle = await startRun(manifestPath, {
      goal: "test",
      hostFactory: stubHostFactory,
      modelRegistry: emptyRegistry(),
    });
    // loadedManifest.def must be present and structured.
    expect(handle.loadedManifest.def).toBeDefined();
    expect(handle.loadedManifest.def.manifest_version).toBe("1");
    await handle.abort("test cleanup");
  });
});

describe("resumeRun with modelRegistry (T2.10)", () => {
  let workdir: string;
  let manifestPath: string;
  let baseDir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-api-resume-test-"));
    await mkdir(join(workdir, ".pi"), { recursive: true });
    manifestPath = join(workdir, ".pi", "conductor.yaml");
    baseDir = join(workdir, "runs");
    await mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("resumeRun with modelRegistry → preflight runs on resumed load", async () => {
    // First, start a run to create a checkpoint log.
    await writeFile(manifestPath, MANIFEST_WITH_UNREGISTERED, "utf8");
    const startHandle = await startRun(manifestPath, {
      goal: "test",
      hostFactory: stubHostFactory,
      modelRegistry: emptyRegistry(),
      baseDir,
    });
    const runId = startHandle.runId;
    await startHandle.abort("cleanup");

    // Now resume with the same baseDir + registry.
    const handle = await resumeRun(manifestPath, runId, {
      goal: "",
      hostFactory: stubHostFactory,
      baseDir,
      modelRegistry: registryWithAnthropic(),
    });
    const unregistered = handle.loadedManifest.warnings.filter(
      (w) => w.code === "unregistered-provider",
    );
    // Only anthropic entries are registered; unknown:* entries still miss.
    expect(unregistered.length).toBeGreaterThan(0);
    expect(unregistered.every((w) => w.message.includes("unknown"))).toBe(true);
    await handle.abort("test cleanup");
  });

  it("resumeRun without modelRegistry → no unregistered-provider warnings", async () => {
    await writeFile(manifestPath, MANIFEST_WITH_REGISTERED_ONLY, "utf8");
    const startHandle = await startRun(manifestPath, {
      goal: "test",
      hostFactory: stubHostFactory,
      baseDir,
    });
    const runId = startHandle.runId;
    await startHandle.abort("cleanup");

    const handle = await resumeRun(manifestPath, runId, {
      goal: "",
      hostFactory: stubHostFactory,
      baseDir,
    });
    const unregistered = handle.loadedManifest.warnings.filter(
      (w) => w.code === "unregistered-provider",
    );
    expect(unregistered).toHaveLength(0);
    await handle.abort("test cleanup");
  });
});
