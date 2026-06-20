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
import { setCurrentOrchestratorRole } from "../../src/extension/current-orchestrator.js";
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
    // Phase 5: the handler reads `handle.def.orchestrator`
    // to set the current-orchestrator slot for the display
    // sink's `is_orchestrator` derivation.
    def: { orchestrator: "orchestrator" },
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

describe("extension shell — Phase 2 + 5 display sink wiring", () => {
  // Phase 5 derives `is_orchestrator` from the active run's
  // orchestrator role (a module-level slot in
  // `current-orchestrator.ts`). The first describe block above
  // uses `vi.resetModules()` in its beforeEach; the second
  // describe's tests run AFTER the first describe's afterEach
  // resets the module registry. Static imports at the top of
  // this file (resolved at file load, before any reset) are
  // the only way to ensure `setCurrentOrchestratorRole` and
  // `createConductDisplaySink` see the same module instance.
  beforeEach(() => {
    setCurrentOrchestratorRole(null);
  });
  afterEach(() => {
    setCurrentOrchestratorRole(null);
  });

  it("emits only text events, with the LLM text verbatim and no role prefix; tool calls and tool results are suppressed", () => {
    // Phase 5.5 remediation: the sink drops the `### ${role}`
    // body prefix (the renderer's structural role label already
    // names the role) and suppresses ALL tool events — both the
    // conductor's `handoff`/`end` machine tools and built-in
    // tools (`bash`, `read`, …). The user-meaningful signal in
    // the TUI is the LLM's text reasoning; real tool activity
    // remains in the per-role session JSONL.
    const sendMessage = vi.fn();
    const sink = createConductDisplaySink(sendMessage);

    sink({ role: "worker", kind: "text", text: "hello world" });
    sink({ role: "worker", kind: "tool_call", text: 'bash: {"command":"ls"}' });
    sink({ role: "worker", kind: "tool_result", text: "emission recorded: handoff → worker" });

    // Only the text event emits a CustomMessage.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      customType: "conduct.role.text",
      // Body is the LLM's text verbatim — no `### worker` prefix.
      content: "hello world",
      display: true,
      details: { role: "worker", kind: "text", is_orchestrator: false },
    });
  });

  it("suppresses tool_call and tool_result events entirely (no CustomMessage emitted for any tool activity)", () => {
    // Dedicated tool-suppression test (Phase 5.5 Task 10):
    // neither the conductor's machine tools (`handoff`, `end`)
    // nor built-in tools (`bash`, `read`, …) surface in the TUI
    // stream. The sink returns without calling `sendMessage` for
    // every `tool_call` and `tool_result` kind. Real tool activity
    // remains in the per-role session JSONL.
    const sendMessage = vi.fn();
    const sink = createConductDisplaySink(sendMessage);

    sink({ role: "orchestrator", kind: "tool_call", text: 'handoff: {"target_role":"worker"}' });
    sink({
      role: "orchestrator",
      kind: "tool_result",
      text: "emission recorded: handoff → worker",
    });
    sink({ role: "worker", kind: "tool_call", text: 'bash: {"command":"ls -la"}' });
    sink({ role: "worker", kind: "tool_result", text: "total 0" });
    sink({ role: "orchestrator", kind: "tool_call", text: 'end: {"reason":"done"}' });
    sink({ role: "orchestrator", kind: "tool_result", text: "emission recorded: end" });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("stamps is_orchestrator=true when the active run's orchestrator emits", () => {
    setCurrentOrchestratorRole("orchestrator");

    const sendMessage = vi.fn();
    const sink = createConductDisplaySink(sendMessage);
    sink({ role: "orchestrator", kind: "text", text: "I am the orchestrator" });
    sink({ role: "worker", kind: "text", text: "I am the worker" });

    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        details: expect.objectContaining({ role: "orchestrator", is_orchestrator: true }),
      }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        details: expect.objectContaining({ role: "worker", is_orchestrator: false }),
      }),
    );
  });
});
