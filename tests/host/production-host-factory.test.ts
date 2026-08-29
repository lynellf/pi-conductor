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
 * keys and runs outside CI. Phase 7A.5 real-model smoke is
 * structurally deferred; not yet run. The factory is validated
 * by the unit tests + the parity tests in
 * `production-host-parity.test.ts` (which drive a real
 * `runLoop` via the stub provider and exercise the same code
 * paths the factory constructs).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AuthStorage, getAgentDir, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createProductionHost,
  InMemoryRecordLog,
  type LoadedManifest,
  loadManifestFromString,
  ProductionHost,
  RoleTurnConfigurationError,
  type RoleTurnTelemetryOptions,
  StubHost,
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

  it("defaults `sessionDir` and the shared SDK `agentDir` to conductor-isolated paths", () => {
    const host = createProductionHost({
      extension: { modelRegistry: makeModelRegistry(), cwd: workdir },
      run: { log: makeLog(), loadedManifest: makeLoadedManifest(), runId: "test-run-1" },
    });
    // Shared SDK state stays conductor-owned while isolated children inherit
    // the configured Pi agent directory.
    expect(host.sessionDir).toBe(join(workdir, ".pi-conductor", "runs", "test-run-1", "sessions"));
    expect(host.agentDir).toBe(join(workdir, ".pi-conductor", "agent"));
    expect(host.isolatedAgentDir).toBe(resolve(getAgentDir()));
    expect(host.uiContext).toBeUndefined();
  });

  it("derives Pi's configured agent directory for the extension/CLI production factory", () => {
    const configuredAgentDir = join(workdir, "configured-pi-agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = configuredAgentDir;
    try {
      const host = createProductionHost({
        extension: { modelRegistry: makeModelRegistry(), cwd: workdir },
        run: { log: makeLog(), loadedManifest: makeLoadedManifest(), runId: "test-run-1" },
      });

      expect(host.agentDir).toBe(join(workdir, ".pi-conductor", "agent"));
      expect(host.isolatedAgentDir).toBe(configuredAgentDir);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("forwards an explicit `uiContext` override and its live guard", () => {
    const uiContext = { notify: () => {}, setStatus: () => {} } as never;
    const isUiContextCurrent = () => false;
    const host = createProductionHost({
      extension: {
        modelRegistry: makeModelRegistry(),
        cwd: workdir,
        uiContext,
        isUiContextCurrent,
      },
      run: { log: makeLog(), loadedManifest: makeLoadedManifest(), runId: "test-run-1" },
    });
    expect(host.uiContext).toBe(uiContext);
    expect(host.isUiContextCurrent).toBe(isUiContextCurrent);
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
    expect(host.isolatedAgentDir).toBe(explicitDir);
  });

  it("forwards a valid `roleTurnTelemetry` config to the run-owned producer", () => {
    // The factory threads roleTurnTelemetry into the producer's limit resolution
    // (spec §5.1 / §7.5). A valid partial overlay constructs without error.
    const host = createProductionHost({
      extension: { modelRegistry: makeModelRegistry(), cwd: workdir },
      run: {
        log: makeLog(),
        loadedManifest: makeLoadedManifest(),
        runId: "test-run-rt",
        roleTurnTelemetry: { limits: { max_block_utf8_bytes: 100 } },
      },
    });
    expect(host).toBeInstanceOf(ProductionHost);
  });

  it("rejects an invalid `roleTurnTelemetry` config at construction (bounded-chain fails closed)", () => {
    // The option must reach resolveRoleTurnLimits so a malformed config is a typed
    // error before any role session is spawned or prompted (spec §5.1). A partial
    // config that violates max_block_utf8_bytes <= max_turn_utf8_bytes is rejected.
    expect(() =>
      createProductionHost({
        extension: { modelRegistry: makeModelRegistry(), cwd: workdir },
        run: {
          log: makeLog(),
          loadedManifest: makeLoadedManifest(),
          runId: "test-run-rt-bad",
          roleTurnTelemetry: { limits: { max_block_utf8_bytes: 999_999 } },
        },
      }),
    ).toThrow(RoleTurnConfigurationError);
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

/** A non-plain-object class used to prove runtime class instances are rejected. */
class FakeConfig {}

/** ProductionHost built with every required field plus a (possibly malformed) option. */
function makeProductionHostWithTelemetry(cwd: string, roleTurnTelemetry: unknown): ProductionHost {
  return new ProductionHost({
    modelRegistry: makeModelRegistry(),
    cwd,
    log: makeLog(),
    loadedManifest: makeLoadedManifest(),
    runId: "test-run-rt",
    roleTurnTelemetry: roleTurnTelemetry as RoleTurnTelemetryOptions,
  });
}

/** StubHost built with every required field plus a (possibly malformed) option. */
function makeStubHostWithTelemetry(roleTurnTelemetry: unknown): StubHost {
  return new StubHost({
    runId: "test-run-rt",
    log: makeLog(),
    steps: [],
    loadedManifest: makeLoadedManifest(),
    roleTurnTelemetry: roleTurnTelemetry as RoleTurnTelemetryOptions,
  });
}

/** Factory passthrough with a (possibly malformed) telemetry option. */
function makeFactoryWithTelemetry(cwd: string, roleTurnTelemetry: unknown): ProductionHost {
  return createProductionHost({
    extension: { modelRegistry: makeModelRegistry(), cwd },
    run: {
      log: makeLog(),
      loadedManifest: makeLoadedManifest(),
      runId: "test-run-rt",
      // The factory carries `undefined` only as the default; any other value (including
      // a runtime `null`) is threaded through to the host's strict resolver.
      ...(roleTurnTelemetry !== undefined && {
        roleTurnTelemetry: roleTurnTelemetry as RoleTurnTelemetryOptions,
      }),
    },
  });
}

describe("roleTurnTelemetry runtime rejection (spec §5.1)", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-prod-host-factory-rt-"));
    // The production host constructor `mkdirSync`s `sessionDir`, which requires cwd
    // to exist. (Only reached for the accepted boundary limit, not the rejected cases.)
    await writeFile(join(workdir, ".gitkeep"), "", "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  // Public host + factory paths must pass `undefined` only as the default and reject
  // everything else (a `null` must never silently become the default-enabled /
  // default-limits behavior). Each malformed value is rejected at construction before
  // any role session is spawned or prompted (spec §5.1).
  const malformed: readonly [string, unknown][] = [
    ["null", null],
    ["an array", []],
    ["a Date instance", new Date()],
    ["a class instance", new FakeConfig()],
    ["an unknown top-level key", { bogus: true }],
    ["a wrong-typed `enabled`", { enabled: "yes" }],
    ["a wrong-typed `limits`", { limits: "nope" }],
    ["an unknown limit key", { limits: { unknown_limit: 1 } }],
    ["a nonpositive limit", { limits: { max_block_utf8_bytes: 0 } }],
    ["a negative limit", { limits: { max_run_turns: -1 } }],
    ["an unsafe (non-safe-integer) limit", { limits: { max_session_turns: 1e21 } }],
    ["a max_block > max_turn relationship", { limits: { max_block_utf8_bytes: 999_999 } }],
    [
      "a max_session_turns > max_run_turns relationship",
      { limits: { max_session_turns: 400, max_run_turns: 200 } },
    ],
  ];

  it.each(
    malformed,
  )("rejects %s through ProductionHost, StubHost, and the factory", (_label, value) => {
    expect(() => makeProductionHostWithTelemetry(workdir, value)).toThrow(
      RoleTurnConfigurationError,
    );
    expect(() => makeStubHostWithTelemetry(value)).toThrow(RoleTurnConfigurationError);
    expect(() => makeFactoryWithTelemetry(workdir, value)).toThrow(RoleTurnConfigurationError);
  });

  it("accepts a safe-integer boundary limit through all three paths", () => {
    const boundary: RoleTurnTelemetryOptions = {
      limits: { max_turn_blocks: Number.MAX_SAFE_INTEGER },
    };
    expect(() => makeProductionHostWithTelemetry(workdir, boundary)).not.toThrow();
    expect(() => makeStubHostWithTelemetry(boundary)).not.toThrow();
    expect(() => makeFactoryWithTelemetry(workdir, boundary)).not.toThrow();
  });
});
