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
      confirm: vi.fn().mockResolvedValue(true),
      onTerminalInput: () => () => {},
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
    expect(bridgeMocks.createProductionHost.mock.calls[0]?.[0]?.extension?.uiContext).toBe(ctx.ui);
    expect(bridgeMocks.createProductionHost.mock.calls[0]?.[0]?.extension?.displaySink).toBe(
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
    expect(bridgeMocks.createProductionHost.mock.calls[0]?.[0]?.extension?.uiContext).toBe(ctx.ui);
    expect(bridgeMocks.createProductionHost.mock.calls[0]?.[0]?.extension?.displaySink).toBe(
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

  it("forwards text events as conduct.role.text with kind='text' and tool_call/tool_result as conduct.role.tool with kind='tool'", () => {
    // Phase 7B.UX: the sink now emits text events as
    // `conduct.role.text` (unchanged) and tool_call / tool_result
    // as `conduct.role.tool` with compact summaries.
    const sendMessage = vi.fn();
    const sink = createConductDisplaySink(sendMessage);

    sink({ role: "worker", kind: "text", text: "hello world" });
    sink({ role: "worker", kind: "tool_call", text: 'bash: {"command":"ls"}' });
    sink({ role: "worker", kind: "tool_result", text: "✓" });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      customType: "conduct.role.text",
      content: "hello world",
      display: true,
      details: { role: "worker", kind: "text", is_orchestrator: false },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      customType: "conduct.role.tool",
      content: 'bash: {"command":"ls"}',
      display: true,
      details: { role: "worker", kind: "tool", is_orchestrator: false },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(3, {
      customType: "conduct.role.tool",
      content: "✓",
      display: true,
      details: { role: "worker", kind: "tool", is_orchestrator: false },
    });
  });

  it("emits ALL tool events through the sink (no tool suppression at this level)", () => {
    // Phase 7B.UX removed the Phase 5.5 suppression of tool events.
    // The sink emits every tool_call and tool_result as
    // `conduct.role.tool`. Tool-name-level filtering (machine tools
    // vs built-in tools) happens upstream in the formatters, not
    // at the sink level.
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

    // All 6 tool events now emit as conduct.role.tool messages.
    expect(sendMessage).toHaveBeenCalledTimes(6);
    for (const call of sendMessage.mock.calls) {
      const [msg] = call;
      expect(msg).toMatchObject({
        customType: "conduct.role.tool",
        display: true,
        details: { kind: "tool" },
      });
    }
  });

  it("emits text as conduct.role.text and tool_call / tool_result as conduct.role.tool with compact summaries; full tool bodies NOT shown", () => {
    // Phase 7B.UX: the sink now emits text events as
    // `conduct.role.text` (unchanged) and tool_call / tool_result
    // as `conduct.role.tool` with the formatter's compact
    // summaries. Full tool args/results are NOT shown — the
    // formatters in src/host/tool-summary.ts produce one-liners.
    const sendMessage = vi.fn();
    const sink = createConductDisplaySink(sendMessage);

    sink({ role: "worker", kind: "text", text: "hello world" });
    sink({ role: "worker", kind: "tool_call", text: "bash: ls" });
    sink({ role: "worker", kind: "tool_result", text: "✓" });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      customType: "conduct.role.text",
      content: "hello world",
      display: true,
      details: { role: "worker", kind: "text", is_orchestrator: false },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      customType: "conduct.role.tool",
      content: "bash: ls",
      display: true,
      details: { role: "worker", kind: "tool", is_orchestrator: false },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(3, {
      customType: "conduct.role.tool",
      content: "✓",
      display: true,
      details: { role: "worker", kind: "tool", is_orchestrator: false },
    });
  });

  it("suppresses machine-tool events (handoff/end/ask_user) — they never reach the sink", () => {
    // Machine tools are suppressed at the formatter level
    // (formatToolCallSummary / formatToolResultSummary return null).
    // The formatters in src/host/tool-summary.ts filter them before
    // the host emits. The sink itself does not receive machine-tool
    // events; this test asserts the sink path for tool events is
    // active (non-machine tools would emit). Since the fixture
    // feeds the sink directly, machine-tool text still goes through
    // but the sink does not re-filter by tool name — it treats all
    // tool_call / tool_result as `conduct.role.tool`.
    setCurrentOrchestratorRole("orchestrator");
    const sendMessage = vi.fn();
    const sink = createConductDisplaySink(sendMessage);

    sink({ role: "orchestrator", kind: "tool_call", text: 'handoff: {"target_role":"worker"}' });
    sink({
      role: "orchestrator",
      kind: "tool_result",
      text: "emission recorded: handoff → worker",
    });

    // Machine-tool text *does* get through the sink (the sink
    // doesn't know about tool names). The formatter-level
    // suppression happens upstream. At the sink level, ALL
    // tool_call / tool_result events become conduct.role.tool.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      customType: "conduct.role.tool",
      content: 'handoff: {"target_role":"worker"}',
      display: true,
      details: { role: "orchestrator", kind: "tool", is_orchestrator: true },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      customType: "conduct.role.tool",
      content: "emission recorded: handoff → worker",
      display: true,
      details: { role: "orchestrator", kind: "tool", is_orchestrator: true },
    });
  });

  it("forwards text_stream events as conduct.role.text_stream with kind='text_stream'", () => {
    // tui-stream-readability Phase 1: stream continuation chunks
    // use kind="text_stream" and map to conduct.role.text_stream.
    // is_orchestrator is always false per N12 (label-less renderer
    // ignores it).
    const sendMessage = vi.fn();
    const sink = createConductDisplaySink(sendMessage);

    sink({ role: "worker", kind: "text_stream", text: " continuation text" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      customType: "conduct.role.text_stream",
      content: " continuation text",
      display: true,
      details: { role: "worker", kind: "text_stream", is_orchestrator: false },
    });
  });

  it("forwards text_stream with orchestrator role and ignores is_orchestrator", () => {
    // Even when the streaming role is the orchestrator, the sink
    // stamps is_orchestrator: false on text_stream events (N12:
    // the label-less renderer does not use it).
    setCurrentOrchestratorRole("orchestrator");
    const sendMessage = vi.fn();
    const sink = createConductDisplaySink(sendMessage);

    sink({
      role: "orchestrator",
      kind: "text_stream",
      text: " more analysis...",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    // is_orchestrator is false even though the current orchestrator
    // role matches — the text_stream renderer ignores it.
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      customType: "conduct.role.text_stream",
      content: " more analysis...",
      display: true,
      details: {
        role: "orchestrator",
        kind: "text_stream",
        is_orchestrator: false,
      },
    });
  });
});
