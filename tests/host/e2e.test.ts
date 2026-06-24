/**
 * Task 16 E2E tests — stub provider for in-CI end-to-end runs (§15.3).
 *
 * Covers Task 16's acceptance criteria:
 *   (1) A minimal stub `Model`+`Provider` drives one
 *       `createAgentSession` turn with canned `usage`; the
 *       §11.4 mapping is asserted against the captured
 *       `message_end` event.
 *   (2) A full `orchestrator → worker → orchestrator → end` run
 *       completes via the stub with no network and no API key,
 *       asserting the persisted record shapes (§11.2–§11.5) and
 *       final checkpoint.
 *
 * `StubHost` lives in `src/host/stub-host.ts` and is reused here
 * + by Task 13.5's resume tests.
 */

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  createAskUserTool,
  createEndTool,
  createHandoffTool,
  SessionSeam,
  StubHost,
} from "../../src/host/index.js";
import { runLoop } from "../../src/host/loop.js";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import {
  type Checkpoint,
  createInitialCheckpoint,
  InMemoryRecordLog,
  type MachineDefinition,
  type SessionLifecycleEvent,
  type TransitionAccepted,
  type TransitionRejected,
} from "../../src/index.js";

function makeDef(): MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze(["worker"]),
    max_visits: Object.freeze({ worker: 3 }),
  }) as MachineDefinition;
}

// ─── (1) Stub drives one createAgentSession turn ──────────────────────

describe("stub provider — drives one createAgentSession turn (Task 16 acceptance #1)", () => {
  it("emits assistant usage on the message_end event in the SDK shape", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const stubModel = makeStubModel();

    const cannedUsage: Partial<Usage> = {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 165,
      cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.0005, total: 0.0188 },
    };

    modelRegistry.registerProvider("stub", {
      api: "anthropic-messages" as const,
      apiKey: "stub-dummy-key-not-used",
      streamSimple: makeStubStreamFunction({
        steps: [{ kind: "emit_handoff", target_role: "worker", reason: "plan ready" }],
        usage: cannedUsage,
      }),
    });

    // Register handoff/end so the tool call routes successfully (the
    // stub emits a handoff call; the runtime needs the tool to exist).
    const seam = new SessionSeam();
    const handoffTool = createHandoffTool(seam);
    const endTool = createEndTool(seam);

    const { session } = await createAgentSession({
      model: stubModel,
      modelRegistry,
      tools: ["handoff", "end"],
      customTools: [handoffTool, endTool],
      sessionManager: SessionManager.inMemory(),
    });

    const events: AgentSessionEvent[] = [];
    session.subscribe((e) => events.push(e));

    await session.prompt("do the thing");

    // Find the assistant's message_end event. Per sdk-surface.md §3,
    // message_end fires for user / assistant / toolResult messages;
    // only the assistant message carries `usage`.
    const messageEndEvents = events.filter(
      (e): e is { type: "message_end"; message: AssistantMessage } =>
        e.type === "message_end" && e.message.role === "assistant",
    );
    expect(messageEndEvents).toHaveLength(1);

    const usage = messageEndEvents[0]?.message.usage;
    expect(usage).toEqual(cannedUsage);

    // §11.4 mapping: the host's UsageRecord is derived from these
    // camelCase + nested-cost fields. The mapping itself is Task 17's
    // territory, but the source shape is pinned here so a future SDK
    // change surfaces drift in CI.
    expect(usage).toMatchObject({
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 165,
      cost: { total: 0.0188 },
    });

    // The seam recorded the handoff emission (Task 14's tool wrappers).
    const captures = seam.read();
    expect(captures).toHaveLength(1);
    expect(captures[0]?.toolName).toBe("handoff");
    expect(seam.isSealed).toBe(true);

    await session.dispose();
  });
});

// ─── (2) Full linear loop via the stub ─────────────────────────────────

describe("stub provider — full orch → worker → orch → end via runLoop (Task 16 acceptance #2)", () => {
  it("completes with no network and asserts persisted record shapes", async () => {
    // 3 visits: orchestrator → worker, worker → orchestrator,
    // orchestrator → end.
    const initialCheckpoint: Checkpoint = createInitialCheckpoint(makeDef());
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      steps: [
        { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
        { kind: "emit_handoff", target_role: "orchestrator", reason: "worker done" },
        { kind: "emit_end", reason: "all done" },
      ],
      usage: {
        input: 50,
        output: 25,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 75,
        cost: { input: 0.0015, output: 0.0075, cacheRead: 0, cacheWrite: 0, total: 0.009 },
      },
    });

    const result = await runLoop({
      def: makeDef(),
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });

    expect(result.exitReason).toBe("done");
    expect(result.finalCheckpoint.current_role).toBe("done");
    expect(result.finalCheckpoint.active_role_session).toBeNull();
    expect(result.finalCheckpoint.visit_count.worker).toBe(1);

    // §11.2 + §11.4 + §11.1 record shape assertions.
    const records = log.records(initialCheckpoint.run_id);
    const byType = records.reduce<Record<string, number>>((acc, r) => {
      acc[r.type] = (acc[r.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType.session_started).toBe(3);
    expect(byType.session_ended).toBe(3);
    expect(byType.transition_accepted).toBe(3);
    // 3 visits × 3 snapshots per visit (post-session_started,
    // post-reduce, post-session-ended) = 9.
    expect(byType.checkpoint_snapshot).toBe(9);
    expect(byType.session_failed).toBeUndefined();
    expect(byType.transition_rejected).toBeUndefined();

    // §11.2: transition_accepted shape on the first accepted handoff.
    const accepted = records.filter(
      (r): r is TransitionAccepted => r.type === "transition_accepted",
    );
    expect(accepted[0]).toMatchObject({
      type: "transition_accepted",
      run_id: initialCheckpoint.run_id,
      from: "orchestrator",
      to: "worker",
      event: "handoff",
      target_role: "worker",
      role: "orchestrator",
      suggests_next: null,
    });

    // §11.4: every session_ended carries usage (both terminals cost).
    // The StubHost accumulates the stub's canned usage via its
    // message_end event subscription (Task 17). The §11.4 SDK
    // mapping (sdk-surface.md §3, pinned in Test 1) is the source
    // for these numbers:
    //   input  ← message.usage.input
    //   output ← message.usage.output
    //   cache_read   ← message.usage.cacheRead
    //   cache_write  ← message.usage.cacheWrite
    //   tokens       ← message.usage.totalTokens
    //   cost         ← message.usage.cost.total
    const ended = records.filter((r): r is SessionLifecycleEvent => r.type === "session_ended");
    expect(ended).toHaveLength(3);
    for (const ev of ended) {
      expect(ev.usage).toBeDefined();
      expect(ev.usage).toEqual({
        input: 50,
        output: 25,
        cache_read: 0,
        cache_write: 0,
        tokens: 75,
        cost: 0.009,
      });
    }

    // §11.1: every reducer call produces a checkpoint snapshot.
    // 3 visits × 3 snapshots per visit = 9. The post-reduce snapshots
    // at indices 1, 4, 7 reflect the current_role advance.
    const snapshots = records.filter((r) => r.type === "checkpoint_snapshot");
    expect(snapshots).toHaveLength(9);
    expect(snapshots[1]).toMatchObject({
      type: "checkpoint_snapshot",
      checkpoint: { current_role: "worker" },
    });
    expect(snapshots[4]).toMatchObject({
      type: "checkpoint_snapshot",
      checkpoint: { current_role: "orchestrator" },
    });
    expect(snapshots[7]).toMatchObject({
      type: "checkpoint_snapshot",
      checkpoint: { current_role: "done" },
    });
    // The post-session-ended snapshots (2, 5, 8) clear
    // active_role_session — this is what Task 13.5's resumeRun
    // reads to decide whether a run is in a clean terminal state.
    expect(snapshots[2]?.checkpoint.active_role_session).toBeNull();
    expect(snapshots[5]?.checkpoint.active_role_session).toBeNull();
    expect(snapshots[8]?.checkpoint.active_role_session).toBeNull();

    // §11.4 parent_session links form a tree: orch₁ → worker → orch₂.
    const started = records.filter((r): r is SessionLifecycleEvent => r.type === "session_started");
    expect(started).toHaveLength(3);
    expect(started.map((s) => s.role)).toEqual(["orchestrator", "worker", "orchestrator"]);
    expect(started[0]?.parent_session).toBeNull();
    expect(started[1]?.parent_session).not.toBeNull();
    expect(started[2]?.parent_session).not.toBeNull();
  });
});

// ─── (bonus) Stub-driven no_emission → session_failed (no_emission) ───

describe("stub provider — no_emission drives a §11.3 breach (no_emission)", () => {
  it("session emits no tool call → session_failed(no_emission), no reduce", async () => {
    const initialCheckpoint = createInitialCheckpoint(makeDef());
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      steps: [{ kind: "no_emission" }],
    });

    const result = await runLoop({
      def: makeDef(),
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });

    expect(result.exitReason).toBe("session_failed");
    const records = log.records(initialCheckpoint.run_id);
    expect(records.some((r) => r.type === "session_started")).toBe(true);
    const failed = records.find((r): r is SessionLifecycleEvent => r.type === "session_failed");
    expect(failed?.failure_reason).toBe("no_emission");
    expect(records.some((r): r is TransitionRejected => r.type === "transition_rejected")).toBe(
      false,
    );
    expect(records.some((r) => r.type === "transition_accepted")).toBe(false);
  });
});

// ─── run fceb3964 regression: multi-ask_user sequential E2E ───────────

/**
 * A serializing `ExtensionUIContext` mock that records
 * `performance.now()` at entry and exit of each `select` call.
 * Each invocation blocks on a deferred promise the test resolves
 * manually, so the test can prove non-overlapping windows and
 * control the order of resolution.
 */
function makeSerializingUi(): {
  ui: ExtensionUIContext;
  entries: () => readonly { callIndex: number; entry: number; exit: number; answer: string }[];
  resolveCall: (index: number, answer: string) => void;
  waitForCall: (index: number) => Promise<void>;
} {
  const timeline: { callIndex: number; entry: number; exit: number; answer: string }[] = [];
  const resolvers = new Map<number, (v: string | undefined) => void>();
  const callGate = new Map<number, () => void>();
  let callIndex = 0;

  // Stub for every method that ask_user does NOT call. The full
  // ExtensionUIContext interface is large; only `select` matters here.
  // biome-ignore lint/suspicious/noExplicitAny: ExtensionUIContext mock — the real interface carries complex overloads and TUI component types that we intentionally leave untyped in the stub.
  const noopUi: any = {
    confirm: async () => false,
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined as never,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setCustomEditor: () => {},
    getCustomEditor: () => undefined,
    setMessageRenderer: () => {},
    getMessageRenderer: () => undefined,
    requestEditorFocus: () => {},
    requestTerminalFocus: () => {},
    setInputMode: () => {},
    getInputMode: () => "prompt" as const,
  };

  const ui: ExtensionUIContext = {
    ...noopUi,
    select: async (_title: string, _options: string[], _opts?: unknown) => {
      const ci = callIndex++;
      const entry = performance.now();

      // Signal that this call has been entered.
      callGate.get(ci)?.();

      // Block on the test-provided resolver.
      const answer = await new Promise<string | undefined>((resolve) => {
        resolvers.set(ci, resolve);
      });

      const exit = performance.now();
      timeline.push({ callIndex: ci, entry, exit, answer: answer ?? "" });
      return answer;
    },
  };

  return {
    ui,
    entries: () => timeline,
    resolveCall: (index: number, answer: string) => {
      const r = resolvers.get(index);
      if (r) r(answer);
    },
    waitForCall: (index: number) =>
      new Promise<void>((resolve) => {
        callGate.set(index, resolve);
      }),
  };
}

describe("stub provider — multi ask_user sequential E2E (run fceb3964 regression)", () => {
  it("serializes two ask_user select calls in one turn, no hang", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const stubModel = makeStubModel();

    // Stub steps: two ask_user calls in one turn, then handoff.
    modelRegistry.registerProvider("stub", {
      api: "anthropic-messages" as const,
      apiKey: "stub-dummy-key-not-used",
      streamSimple: makeStubStreamFunction({
        steps: [
          {
            kind: "emit_tool_calls",
            calls: [
              {
                name: "ask_user",
                arguments: { kind: "select", prompt: "Q1?", options: ["a1", "b1"] },
              },
              {
                name: "ask_user",
                arguments: { kind: "select", prompt: "Q2?", options: ["a2", "b2"] },
              },
            ],
          },
          { kind: "emit_handoff", target_role: "worker", reason: "done" },
        ],
      }),
    });

    const seam = new SessionSeam();
    const handoffTool = createHandoffTool(seam);
    const endTool = createEndTool(seam);
    const askUser = createAskUserTool() as ToolDefinition;
    const serializing = makeSerializingUi();

    const { session } = await createAgentSession({
      model: stubModel,
      modelRegistry,
      tools: ["handoff", "end", "ask_user"],
      customTools: [handoffTool, endTool, askUser],
      sessionManager: SessionManager.inMemory(),
    });

    await session.bindExtensions({ uiContext: serializing.ui, mode: "tui" });

    const events: AgentSessionEvent[] = [];
    session.subscribe((e) => events.push(e));

    // Start the prompt — it will block on our deferred UI promises.
    const promptDone = session.prompt("please ask two questions then hand off");

    // Wait for the first ask_user call, then answer it.
    await serializing.waitForCall(0);
    serializing.resolveCall(0, "a1");

    // Wait for the second ask_user call, then answer it.
    await serializing.waitForCall(1);
    serializing.resolveCall(1, "a2");

    // Now prompt() should complete (handoff terminates the turn).
    await promptDone;

    // ── Assertions ──────────────────────────────────────────

    // 1. Both calls ran — the session didn't hang.
    const timeline = serializing.entries();
    expect(timeline).toHaveLength(2);

    // 2. Non-overlapping windows: second entry >= first exit.
    expect(timeline[0]).toBeDefined();
    expect(timeline[1]).toBeDefined();
    const c0 = timeline[0] as NonNullable<(typeof timeline)[number]>;
    const c1 = timeline[1] as NonNullable<(typeof timeline)[number]>;
    expect(c1.entry).toBeGreaterThanOrEqual(c0.exit);

    // 3. Both answers were returned to the model (via toolResult events).
    const toolResults = events.filter(
      (e) => e.type === "message_end" && e.message.role === "toolResult",
    );
    expect(toolResults.length).toBeGreaterThanOrEqual(2);

    // 4. The session reached the handoff and is sealed.
    expect(seam.isSealed).toBe(true);
    const captures = seam.read();
    expect(captures).toHaveLength(1);
    expect(captures[0]?.toolName).toBe("handoff");

    await session.dispose();
  }, 10_000);
});
