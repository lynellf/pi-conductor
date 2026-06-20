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
      runId: "run-ui-context-2",
    });

    await host.spawnRole("implementer");

    expect(agentSessionMocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).not.toHaveBeenCalled();
  });
});
