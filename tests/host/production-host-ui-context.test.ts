/**
 * Phase 1 foundation bridge — `ProductionHost` binds the extension UI context
 * onto spawned role sessions.
 *
 * The local SDK does not accept `uiContext` on `createAgentSession` options.
 * Instead, the session exposes `bindExtensions({ uiContext })`. This test pins
 * the bridge at the actual SDK surface so the host keeps working even if the
 * higher-level plan text lags behind the installed package.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedManifest } from "../../src/index.js";

const agentSessionMocks = {
  createAgentSession: vi.fn(),
};

const MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [read, handoff, end]
    system_prompt: .pi/roles/orchestrator.md
  - name: implementer
    max_visits: 3
    tools: [read, handoff, end]
    system_prompt: .pi/roles/implementer.md
`;

let InMemoryRecordLog: typeof import("../../src/index.js").InMemoryRecordLog;
let LoadedManifestLoad: typeof import("../../src/index.js").loadManifestFromString;
let ProductionHost: typeof import("../../src/index.js").ProductionHost;

function makeLoadedManifest(): LoadedManifest {
  return LoadedManifestLoad(MANIFEST);
}

function makeModelRegistry(): ModelRegistry {
  return ModelRegistry.inMemory(AuthStorage.inMemory());
}

function makeSession() {
  return {
    bindExtensions: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn(),
    sessionFile: undefined,
    sessionId: "session-1",
    subscribe: vi.fn(() => () => {}),
  };
}

describe("ProductionHost — uiContext bridge", () => {
  let cwd: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("@earendil-works/pi-coding-agent", async () => {
      const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
        "@earendil-works/pi-coding-agent",
      );
      return {
        ...actual,
        createAgentSession: agentSessionMocks.createAgentSession,
      };
    });
    const hostModule = await import("../../src/index.js");
    InMemoryRecordLog = hostModule.InMemoryRecordLog;
    LoadedManifestLoad = hostModule.loadManifestFromString;
    ProductionHost = hostModule.ProductionHost;
    agentSessionMocks.createAgentSession.mockReset();
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-ui-context-"));
    await mkdir(join(cwd, ".pi/roles"), { recursive: true });
    await writeFile(join(cwd, ".pi/roles/orchestrator.md"), "orchestrator", "utf8");
    await writeFile(join(cwd, ".pi/roles/implementer.md"), "implementer", "utf8");
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    vi.doUnmock("@earendil-works/pi-coding-agent");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("binds the provided uiContext onto a spawned session", async () => {
    const uiContext = { notify: vi.fn(), setStatus: vi.fn() } as never;
    const session = makeSession();
    agentSessionMocks.createAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    } as never);

    const host = new ProductionHost({
      modelRegistry: makeModelRegistry(),
      cwd,
      uiContext,
      log: new InMemoryRecordLog(),
      loadedManifest: makeLoadedManifest(),
      runId: "run-ui-context-1",
    });

    await host.spawnRole("implementer");

    expect(agentSessionMocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith({ uiContext });
  });

  it("disposes a session when binding the extension context fails", async () => {
    const session = makeSession();
    const staleContextError = new Error("This extension ctx is stale after session replacement");
    session.bindExtensions.mockRejectedValueOnce(staleContextError);
    agentSessionMocks.createAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    } as never);

    const host = new ProductionHost({
      modelRegistry: makeModelRegistry(),
      cwd,
      uiContext: { notify: vi.fn() } as never,
      log: new InMemoryRecordLog(),
      loadedManifest: makeLoadedManifest(),
      runId: "run-ui-context-2",
    });

    await expect(host.spawnRole("implementer")).rejects.toBe(staleContextError);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not bind extensions when uiContext is omitted", async () => {
    const session = makeSession();
    agentSessionMocks.createAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    } as never);

    const host = new ProductionHost({
      modelRegistry: makeModelRegistry(),
      cwd,
      log: new InMemoryRecordLog(),
      loadedManifest: makeLoadedManifest(),
      runId: "run-ui-context-3",
    });

    await host.spawnRole("implementer");

    expect(agentSessionMocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).not.toHaveBeenCalled();
  });

  it("skips stale uiContext binding when a fallback starts after session replacement", async () => {
    const session = makeSession();
    agentSessionMocks.createAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    } as never);
    const uiContext = { notify: vi.fn() } as never;

    const host = new ProductionHost({
      modelRegistry: makeModelRegistry(),
      cwd,
      uiContext,
      isUiContextCurrent: () => false,
      log: new InMemoryRecordLog(),
      loadedManifest: makeLoadedManifest(),
      runId: "run-ui-context-4",
    });

    await host.spawnRole("implementer", { modelIndex: 1 });

    expect(agentSessionMocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).not.toHaveBeenCalled();
  });

  it("forwards the parent registry's exact runtime into the shared spawn seam", async () => {
    // A parent registry (like the local 0.80.6 facade) may own a runtime that
    // carries extension-registered providers. The shared seam must forward that
    // runtime by identity rather than construct a fresh one.
    const sentinelRuntime = Object.freeze({ __sentinelRuntime: true }) as never;
    const registry = makeModelRegistry();
    Object.defineProperty(registry, "runtime", {
      value: sentinelRuntime,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const uiContext = { notify: vi.fn(), setStatus: vi.fn() } as never;
    const session = makeSession();
    agentSessionMocks.createAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    } as never);

    const host = new ProductionHost({
      modelRegistry: registry,
      cwd,
      uiContext,
      log: new InMemoryRecordLog(),
      loadedManifest: makeLoadedManifest(),
      runId: "run-runtime-forward-1",
    });

    await host.spawnRole("implementer");

    const callArgs = agentSessionMocks.createAgentSession.mock.calls[0] ?? [];
    const opts = callArgs[0] as Record<string, unknown>;
    expect(opts).toBeDefined();
    // Parent runtime-bearing object forwarded by exact identity.
    expect(opts.modelRegistry).toBe(registry);
    // The runtime attached to the parent registry forwarded unchanged.
    expect(opts.modelRuntime).toBe(sentinelRuntime);
    // Every pre-existing shared option preserved.
    expect(opts.cwd).toBe(cwd);
    expect(opts.resourceLoader).toBeDefined();
    expect(opts.sessionManager).toBeDefined();
    expect(opts.model).toBeUndefined();
    expect(opts.thinkingLevel).toBe("medium");
    expect((opts.customTools as { name: string }[]).map((tool) => tool.name)).toEqual([
      "handoff",
      "end",
      "ask_user",
    ]);
    expect(opts.tools).toEqual(["read", "handoff", "end", "ask_user"]);
  });
});
