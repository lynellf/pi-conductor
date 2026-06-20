/**
 * Phase 1 foundation bridge — `/conduct` handlers thread `ctx.ui` into the
 * production host factory.
 *
 * This file uses dynamic `doMock` + re-imports so the handler-level mocks stay
 * local to the test file and do not leak into the rest of the suite.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConductDisplaySink } from "../../src/extension/display-sink-wiring.js";

const bridgeMocks = {
  createProductionHost: vi.fn(),
  resumeRun: vi.fn(),
  startRun: vi.fn(),
  startStatusPoller: vi.fn(() => () => {}),
};

type StartHandler = typeof import("../../src/extension/commands/start.js").handleStart;
type ResumeHandler = typeof import("../../src/extension/commands/resume.js").handleResume;

let handleStart: StartHandler;
let handleResume: ResumeHandler;
let InMemoryRecordLog: typeof import("../../src/index.js").InMemoryRecordLog;
let loadManifestFromString: typeof import("../../src/index.js").loadManifestFromString;

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

function makeLoadedManifest(): ReturnType<typeof loadManifestFromString> {
  return loadManifestFromString(MANIFEST);
}

function makeCtx(cwd: string) {
  return {
    cwd,
    getFlag: () => undefined,
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  } as unknown as Parameters<StartHandler>[1];
}

function makeCompletionHandle(runId: string) {
  return {
    abort: vi.fn().mockResolvedValue(undefined),
    completion: vi.fn().mockResolvedValue({
      exitReason: "done",
      finalCheckpoint: { current_role: "done" },
    }),
    runId,
  };
}

describe("extension shell — Phase 1 uiContext bridge", () => {
  let cwd: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../../src/index.js", async () => {
      const actual =
        await vi.importActual<typeof import("../../src/index.js")>("../../src/index.js");
      return {
        ...actual,
        createProductionHost: bridgeMocks.createProductionHost,
        resumeRun: bridgeMocks.resumeRun,
        startRun: bridgeMocks.startRun,
      };
    });
    vi.doMock("../../src/extension/status.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/extension/status.js")>(
        "../../src/extension/status.js",
      );
      return {
        ...actual,
        startStatusPoller: bridgeMocks.startStatusPoller,
      };
    });

    const startModule = await import("../../src/extension/commands/start.js");
    const resumeModule = await import("../../src/extension/commands/resume.js");
    const indexModule = await import("../../src/index.js");

    handleStart = startModule.handleStart;
    handleResume = resumeModule.handleResume;
    InMemoryRecordLog = indexModule.InMemoryRecordLog;
    loadManifestFromString = indexModule.loadManifestFromString;

    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-tui-bridge-"));
    await mkdir(join(cwd, ".pi/roles"), { recursive: true });
    await writeFile(join(cwd, ".pi/conductor.yaml"), MANIFEST, "utf8");
    bridgeMocks.createProductionHost.mockReset();
    bridgeMocks.resumeRun.mockReset();
    bridgeMocks.startRun.mockReset();
    bridgeMocks.startStatusPoller.mockReturnValue(() => {});
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    vi.doUnmock("../../src/index.js");
    vi.doUnmock("../../src/extension/status.js");
    vi.resetModules();
  });

  it("passes ctx.ui through /conduct to createProductionHost", async () => {
    const ctx = makeCtx(cwd);
    const handle = makeCompletionHandle("run-start-ui-1");
    const displaySink = vi.fn();
    bridgeMocks.createProductionHost.mockReturnValue({} as never);
    bridgeMocks.startRun.mockImplementation(async (_manifestPath, opts) => {
      await opts.hostFactory({
        log: new InMemoryRecordLog(),
        loadedManifest: makeLoadedManifest(),
        runId: "run-start-ui-1",
      } as never);
      return handle;
    });

    await handleStart("test goal", ctx, { getFlag: () => undefined, displaySink });

    expect(bridgeMocks.createProductionHost).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.createProductionHost.mock.calls[0][0].extension.uiContext).toBe(ctx.ui);
    expect(bridgeMocks.createProductionHost.mock.calls[0][0].extension.displaySink).toBe(
      displaySink,
    );
  });

  it("passes ctx.ui through /conduct:resume to createProductionHost", async () => {
    const ctx = makeCtx(cwd);
    const handle = makeCompletionHandle("run-resume-ui-1");
    const displaySink = vi.fn();
    bridgeMocks.createProductionHost.mockReturnValue({} as never);
    bridgeMocks.resumeRun.mockImplementation(async (_manifestPath, _runId, opts) => {
      await opts.hostFactory({
        log: new InMemoryRecordLog(),
        loadedManifest: makeLoadedManifest(),
        runId: "run-resume-ui-1",
      } as never);
      return handle;
    });

    await handleResume("run-resume-ui-1", ctx, { getFlag: () => undefined, displaySink });

    expect(bridgeMocks.createProductionHost).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.createProductionHost.mock.calls[0][0].extension.uiContext).toBe(ctx.ui);
    expect(bridgeMocks.createProductionHost.mock.calls[0][0].extension.displaySink).toBe(
      displaySink,
    );
  });
});

describe("extension shell — Phase 2 display sink wiring", () => {
  it("wraps display events in custom messages with role-prefixed markdown", () => {
    const sendMessage = vi.fn();
    const sink = createConductDisplaySink(sendMessage);

    sink({ role: "worker", kind: "text", text: "hello world" });
    sink({ role: "worker", kind: "tool_call", text: 'bash: {"command":"ls"}' });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      customType: "conduct.role.text",
      content: "### worker\n\nhello world",
      display: true,
      details: { role: "worker", kind: "text" },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      customType: "conduct.role.tool",
      content: '### worker\n\nbash: {"command":"ls"}',
      display: true,
      details: { role: "worker", kind: "tool_call" },
    });
  });
});
