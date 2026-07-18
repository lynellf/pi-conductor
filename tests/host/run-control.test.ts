import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { RoleSession } from "../../src/host/host.js";
import { formatGuidedPrompt, RunControl, RunControlError } from "../../src/host/run-control.js";

type SessionListener = (event: AgentSessionEvent) => void;

interface FakeSession extends RoleSession {
  steer?(text: string): Promise<void>;
  clearQueue?(): { steering: string[]; followUp: string[] };
  isSealed?(): boolean;
  subscribeSealed?(listener: () => void): () => void;
}

function createSession(
  role: string,
  opts: { readonly steerable?: boolean; readonly sealed?: boolean } = {},
): {
  readonly session: FakeSession;
  readonly steerCalls: string[];
  emit(event: AgentSessionEvent): void;
  seal(): void;
  setQueuedSteering(values: readonly string[]): void;
} {
  const listeners = new Set<SessionListener>();
  const sealListeners = new Set<() => void>();
  const steerCalls: string[] = [];
  let sealed = opts.sealed ?? false;
  let queuedSteering: string[] = [];

  const session: FakeSession = {
    role,
    sessionId: `${role}-session`,
    sessionFile: `/tmp/${role}.jsonl`,
    model: null,
    effort: "medium",
    readCaptureBuffer: () => [],
    resetCaptureBuffer: () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async () => undefined,
    dispose: async () => undefined,
    ...(opts.steerable === true
      ? {
          async steer(text: string): Promise<void> {
            steerCalls.push(text);
            queuedSteering.push(text);
          },
          clearQueue(): { steering: string[]; followUp: string[] } {
            const steering = queuedSteering;
            queuedSteering = [];
            return { steering, followUp: [] };
          },
          isSealed: () => sealed,
          subscribeSealed(listener: () => void): () => void {
            sealListeners.add(listener);
            return () => sealListeners.delete(listener);
          },
        }
      : {}),
  };

  return {
    session,
    steerCalls,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    seal() {
      if (sealed) return;
      sealed = true;
      for (const listener of sealListeners) listener();
    },
    setQueuedSteering(values) {
      queuedSteering = [...values];
    },
  };
}

function assistantMessageEvent(args: {
  readonly content: readonly Record<string, unknown>[];
  readonly stopReason?: "stop" | "error";
  readonly timestamp?: number;
}): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: args.content,
      stopReason: args.stopReason ?? "stop",
      timestamp: args.timestamp ?? 1,
    },
  } as unknown as AgentSessionEvent;
}

describe("RunControl operator guidance", () => {
  it.each([
    "",
    "   ",
    "\n\t",
  ])('rejects empty guidance %j with code "empty_message"', async (text) => {
    const control = new RunControl({ runId: "run-1", abortSession: vi.fn() });

    await expect(control.followUp(text)).rejects.toMatchObject({ code: "empty_message" });
  });

  it("queues follow-up guidance for the next prompt even while a session is active", async () => {
    const active = createSession("worker", { steerable: true });
    const control = new RunControl({ runId: "run-1", abortSession: vi.fn() });
    await control.setActiveSession(active.session);

    await control.followUp("review the edge case");

    expect(active.steerCalls).toEqual([]);
    expect(control.takePendingGuidance()).toEqual([
      { id: 1, mode: "followUp", text: "review the edge case" },
    ]);
  });

  it("sends steer guidance to an addressable active SDK session without treating slash text as a command", async () => {
    const active = createSession("worker", { steerable: true });
    const control = new RunControl({ runId: "run-1", abortSession: vi.fn() });
    await control.setActiveSession(active.session);

    await control.steer("/handoff is literal guidance");

    expect(active.steerCalls).toHaveLength(1);
    expect(active.steerCalls[0]).toContain("/handoff is literal guidance");
    expect(active.steerCalls[0]?.startsWith("/")).toBe(false);
    expect(control.takePendingGuidance()).toEqual([]);
  });

  it("queues steer guidance at a live boundary where no session is active", async () => {
    const control = new RunControl({ runId: "run-1", abortSession: vi.fn() });

    await control.steer("carry this into the next role");

    expect(control.takePendingGuidance()).toEqual([
      { id: 1, mode: "steer", text: "carry this into the next role" },
    ]);
  });

  it("reports steering_unavailable only for an active session without native steering", async () => {
    const active = createSession("worker");
    const control = new RunControl({ runId: "run-1", abortSession: vi.fn() });
    await control.setActiveSession(active.session);

    await expect(control.steer("redirect now")).rejects.toMatchObject({
      code: "steering_unavailable",
    });
  });

  it("reclaims an unconsumed active steer when the session seals", async () => {
    const active = createSession("worker", { steerable: true });
    const control = new RunControl({ runId: "run-1", abortSession: vi.fn() });
    await control.setActiveSession(active.session);
    await control.steer("use the newly active role");

    active.seal();

    expect(control.takePendingGuidance()).toEqual([
      { id: 1, mode: "steer", text: "use the newly active role" },
    ]);
  });

  it("does not replay an active steer that the SDK already consumed", async () => {
    const active = createSession("worker", { steerable: true });
    const control = new RunControl({ runId: "run-1", abortSession: vi.fn() });
    await control.setActiveSession(active.session);
    await control.steer("already consumed");
    active.setQueuedSteering([]);

    active.seal();

    expect(control.takePendingGuidance()).toEqual([]);
  });

  it("preserves global arrival order when reclaiming steering beside queued follow-ups", async () => {
    const active = createSession("worker", { steerable: true });
    const control = new RunControl({ runId: "run-1", abortSession: vi.fn() });
    await control.setActiveSession(active.session);
    await control.steer("first");
    await control.followUp("second");

    active.seal();

    expect(control.takePendingGuidance()).toEqual([
      { id: 1, mode: "steer", text: "first" },
      { id: 2, mode: "followUp", text: "second" },
    ]);
  });

  it.each([
    "steer",
    "followUp",
  ] as const)('rejects %s after close with code "run_terminal"', async (method) => {
    const control = new RunControl({ runId: "run-1", abortSession: vi.fn() });
    control.close();

    await expect(control[method]("too late")).rejects.toMatchObject({ code: "run_terminal" });
  });

  it("uses a typed public error class", () => {
    expect(new RunControlError("run_terminal")).toBeInstanceOf(Error);
  });

  it("preserves abort parity when cancellation is requested before a session becomes active", async () => {
    const abortSession = vi.fn(async () => undefined);
    const active = createSession("worker", { steerable: true });
    const control = new RunControl({ runId: "run-1", abortSession });

    await control.requestAbort("stop now");
    await control.requestAbort("duplicate");
    await control.setActiveSession(active.session);

    expect(abortSession).toHaveBeenCalledOnce();
    expect(abortSession).toHaveBeenCalledWith(active.session, "stop now");
  });
});

describe("RunControl latest response", () => {
  it("captures the latest successful assistant response with role metadata and no tool blocks", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(42);
    const active = createSession("reviewer", { steerable: true });
    const control = new RunControl({ runId: "run-1", abortSession: vi.fn() });
    await control.setActiveSession(active.session);

    active.emit(
      assistantMessageEvent({
        timestamp: 42,
        content: [
          { type: "thinking", thinking: "Check carefully", redacted: false },
          { type: "toolCall", name: "read", arguments: { path: "secret" } },
          { type: "text", text: "The result is ready." },
        ],
      }),
    );

    expect(control.latestResponse()).toEqual({
      runId: "run-1",
      role: "reviewer",
      sessionId: "reviewer-session",
      text: "> Check carefully\n\nThe result is ready.",
      completedAt: 42,
    });
    const snapshot = control.latestResponse();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(control.latestResponse()).not.toBe(snapshot);
    now.mockRestore();
  });

  it("ignores assistant error terminals and keeps the previous response", async () => {
    const active = createSession("worker", { steerable: true });
    const control = new RunControl({ runId: "run-1", abortSession: vi.fn() });
    await control.setActiveSession(active.session);
    active.emit(assistantMessageEvent({ content: [{ type: "text", text: "keep me" }] }));

    active.emit(
      assistantMessageEvent({
        stopReason: "error",
        timestamp: 2,
        content: [{ type: "text", text: "provider failed" }],
      }),
    );

    expect(control.latestResponse()?.text).toBe("keep me");
  });

  it("returns null before any completed assistant response", () => {
    const control = new RunControl({ runId: "run-1", abortSession: vi.fn() });
    expect(control.latestResponse()).toBeNull();
  });
});

describe("formatGuidedPrompt", () => {
  it("appends ordered structured guidance while preserving message bytes", () => {
    expect(
      formatGuidedPrompt("role seed", [
        { id: 2, mode: "followUp", text: "  preserve spacing  " },
        { id: 1, mode: "steer", text: "/literal" },
      ]),
    ).toBe(
      "role seed\n\n<operator_guidance>\n" +
        '<message id="1" mode="steer">\n/literal\n</message>\n' +
        '<message id="2" mode="followUp">\n  preserve spacing  \n</message>\n' +
        "</operator_guidance>",
    );
  });

  it("returns the seed unchanged when there is no guidance", () => {
    expect(formatGuidedPrompt("role seed", [])).toBe("role seed");
  });
});
