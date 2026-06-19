/**
 * Task 7A.5 — `createProductionHost` factory tests.
 *
 * Covers Task 7A.5's acceptance criteria (the parts that are
 * automatable; the real-model smoke is manual and gated on the
 * developer's `~/.pi/agent/auth.json`):
 *   - The factory is extension-agnostic: `src/host` does not
 *     import extension types or `extensions/*`. (Asserted by the
 *     grep guard, plus a code-level check below.)
 *   - The factory passes `modelRegistry`, `cwd`, `runId`, `log`,
 *     and `loadedManifest` through to `ProductionHost`.
 *
 * **What this test does NOT do.** The plan's 7A.5 acceptance
 * also lists "A real-model run against the developer's pi
 * auth/config reaches a terminal state" — that requires API
 * keys, runs outside CI, and produces a transcript under
 * `docs/dev-run-transcripts/`. Until those land, the factory is
 * validated by the unit tests + the parity tests in
 * `production-host-parity.test.ts` (which drive a real
 * `runLoop` via the stub provider and exercise the same code
 * paths the factory constructs).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createProductionHost,
  InMemoryRecordLog,
  type LoadedManifest,
  loadManifestFromString,
  ProductionHost,
} from "../../src/index.js";

const VALID_MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [stub:stub-model]
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, handoff, end]
  - name: worker
    max_visits: 3
    models: [stub:stub-model]
    system_prompt: .pi/roles/worker.md
    tools: [read, edit, handoff, end]
`;

function makeLoadedManifest(): LoadedManifest {
  return loadManifestFromString(VALID_MANIFEST);
}

function makeModelRegistry(): ModelRegistry {
  return ModelRegistry.inMemory(AuthStorage.inMemory());
}

function makeLog(): InMemoryRecordLog {
  return new InMemoryRecordLog();
}

describe("createProductionHost — Task 7A.5", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-prod-host-factory-"));
    // Some tests assert the derived `sessionDir`; the host
    // constructor `mkdirSync`s it, which requires cwd to exist.
    await writeFile(join(workdir, ".gitkeep"), "", "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("returns a `ProductionHost` instance", () => {
    const host = createProductionHost({
      extension: { modelRegistry: makeModelRegistry(), cwd: workdir },
      run: { log: makeLog(), loadedManifest: makeLoadedManifest(), runId: "test-run-1" },
    });
    expect(host).toBeInstanceOf(ProductionHost);
  });

  it("forwards `modelRegistry`, `cwd`, `runId`, `log`, and `loadedManifest` to the host", () => {
    const modelRegistry = makeModelRegistry();
    const log = makeLog();
    const loadedManifest = makeLoadedManifest();
    const runId = "test-run-factory-1";

    const host = createProductionHost({
      extension: { modelRegistry, cwd: workdir },
      run: { log, loadedManifest, runId },
    });

    expect(host.modelRegistry).toBe(modelRegistry);
    expect(host.cwd).toBe(workdir);
    expect(host.runId).toBe(runId);
    expect(host.log).toBe(log);
    expect(host.loadedManifest).toBe(loadedManifest);
  });

  it("defaults `sessionDir` and `agentDir` to the conductor-isolated paths", () => {
    const host = createProductionHost({
      extension: { modelRegistry: makeModelRegistry(), cwd: workdir },
      run: { log: makeLog(), loadedManifest: makeLoadedManifest(), runId: "test-run-1" },
    });
    // Same defaults as `ProductionHostOptions.sessionDir` /
    // `agentDir` when omitted. The factory's job is to pass
    // through; the production host's job is to derive.
    expect(host.sessionDir).toBe(join(workdir, ".pi-conductor", "runs", "test-run-1", "sessions"));
    expect(host.agentDir).toBe(join(workdir, ".pi-conductor", "agent"));
  });

  it("forwards an explicit `sessionDir` override", () => {
    const explicitDir = join(workdir, "explicit-sessions");
    const host = createProductionHost({
      extension: { modelRegistry: makeModelRegistry(), cwd: workdir },
      run: {
        log: makeLog(),
        loadedManifest: makeLoadedManifest(),
        runId: "test-run-1",
        sessionDir: explicitDir,
      },
    });
    expect(host.sessionDir).toBe(explicitDir);
  });

  it("forwards an explicit `agentDir` override", () => {
    const explicitDir = join(workdir, "explicit-agent");
    const host = createProductionHost({
      extension: { modelRegistry: makeModelRegistry(), cwd: workdir },
      run: {
        log: makeLog(),
        loadedManifest: makeLoadedManifest(),
        runId: "test-run-1",
        agentDir: explicitDir,
      },
    });
    expect(host.agentDir).toBe(explicitDir);
  });
});

describe("createProductionHost — extension-agnostic (Task 7A.5 acceptance)", () => {
  it("does not import `ExtensionCommandContext` from `@earendil-works/pi-coding-agent`", async () => {
    // The grep guard on `src/core` + `src/manifest` + `src/seam` +
    // `src/cost` covers the pure-core side. The factory lives in
    // `src/host/` (allowed for pi imports) but should not pull
    // the extension's type surface into the host layer. This
    // static check ensures that — match only on actual import
    // statements (lines starting with `import`), not on
    // JSDoc/comment mentions.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const factorySrc = readFileSync(
      fileURLToPath(new URL("../../src/host/production-host-factory.ts", import.meta.url)),
      "utf8",
    );
    // Only check import lines, not JSDoc or comments.
    const importLines = factorySrc.split("\n").filter((line) => /^\s*import\b/.test(line));
    const imports = importLines.join("\n");
    expect(imports).not.toMatch(/ExtensionCommandContext/);
    expect(imports).not.toMatch(/from\s+["'].*extensions\//);
  });
});
