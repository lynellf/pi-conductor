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
 * `StubHost` is a minimal real `Host` implementation that wires
 * `createAgentSession` to the stub provider registered on an
 * in-memory `ModelRegistry`. It is the load-bearing test surface
 * for Phases 4–5 (the production SDK-backed Host will reuse the
 * same wiring with a real provider).
 */

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createEndTool, createHandoffTool, SessionSeam } from "../../src/host/index.js";
import { runLoop } from "../../src/host/loop.js";
import {
  makeStubModel,
  makeStubStreamFunction,
  type StubStep,
} from "../../src/host/stub-provider.js";
import {
  type Checkpoint,
  createInitialCheckpoint,
  type Host,
  InMemoryRecordLog,
  type MachineDefinition,
  type PersistedRecord,
  type Role,
  type RoleSession,
  type SessionLifecycleEvent,
  type TransitionAccepted,
  type TransitionRejected,
  type UsageRecord,
} from "../../src/index.js";

// ─── Test fakes ────────────────────────────────────────────────────────

/**
 * Minimal real `Host` that wires `createAgentSession` to the stub
 * provider. Implements only the methods the loop calls
 * (Task 15's loop: spawnRole, captureUsage, persistRecord,
 * nextVisitIndex); the rest are no-ops.
 */
class StubHost implements Host {
  readonly log = new InMemoryRecordLog();
  private readonly modelRegistry: ModelRegistry;
  private readonly sessionManager: SessionManager;
  private readonly model = makeStubModel();
  private readonly sessionsBySessionId = new Map<
    string,
    { agentSession: AgentSession; seam: SessionSeam; role: Role }
  >();
  private sessionCounter = 0;

  constructor(
    readonly runId: string,
    opts: { steps: readonly StubStep[]; usage?: Partial<Usage> },
  ) {
    const authStorage = AuthStorage.inMemory();
    this.modelRegistry = ModelRegistry.inMemory(authStorage);
    const streamFn = makeStubStreamFunction({
      steps: opts.steps,
      ...(opts.usage !== undefined && { usage: opts.usage }),
    });
    this.modelRegistry.registerProvider("stub", {
      api: "anthropic-messages" as const,
      apiKey: "stub-dummy-key-not-used",
      streamSimple: streamFn,
    });
    this.sessionManager = SessionManager.inMemory();
  }

  async spawnRole(role: Role): Promise<RoleSession> {
    const seam = new SessionSeam();
    const handoff = createHandoffTool(seam);
    const end = createEndTool(seam);

    const { session } = await createAgentSession({
      model: this.model,
      modelRegistry: this.modelRegistry,
      tools: ["handoff", "end"],
      customTools: [handoff, end],
      sessionManager: this.sessionManager,
    });

    this.sessionCounter += 1;
    const sid = `stub-session-${this.sessionCounter}`;
    this.sessionsBySessionId.set(sid, { agentSession: session, seam, role });

    return {
      role,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? `/tmp/${sid}.jsonl`,
      readCaptureBuffer: () => seam.read(),
      resetCaptureBuffer: () => seam.reset(),
      subscribe: (listener) => session.subscribe(listener),
      prompt: (text) => session.prompt(text),
      dispose: () => session.dispose(),
    };
  }

  captureUsage(_session: RoleSession): UsageRecord {
    // Task 17 wires real usage accumulation from the event stream;
    // for Task 16 we return zeros. The §11.4 mapping is asserted
    // against the message_end event directly in Test 1.
    return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
  }

  persistRecord(record: PersistedRecord): void {
    this.log.append(record);
  }

  nextVisitIndex(role: Role): number {
    return (
      this.log.records(this.runId).filter((r) => r.type === "session_started" && r.role === role)
        .length + 1
    );
  }

  // Unused by the loop; no-ops for interface compliance.
  seedRunMemory(): unknown {
    return {};
  }

  async abortSession(): Promise<void> {
    /* no-op */
  }

  sealSession(): void {
    /* no-op */
  }
}

function makeDef(): MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze(["worker"]),
    max_visits: Object.freeze({ worker: 3 }),
  }) as MachineDefinition;
}

const ZERO_USAGE: UsageRecord = Object.freeze({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
}) as UsageRecord;

// ─── (1) Stub drives one createAgentSession turn ──────────────────────

describe("stub provider — drives one createAgentSession turn (Task 16 acceptance #1)", () => {
  it("emits assistant usage on the message_end event in the SDK shape", async () => {
    // Use a self-contained registration (no StubHost) for this test —
    // we want to drive exactly one turn and inspect the event stream
    // directly, before any Host machinery is involved.
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
    const host = new StubHost(initialCheckpoint.run_id, {
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
    const records = host.log.records(initialCheckpoint.run_id);
    const byType = records.reduce<Record<string, number>>((acc, r) => {
      acc[r.type] = (acc[r.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType.session_started).toBe(3);
    expect(byType.session_ended).toBe(3);
    expect(byType.transition_accepted).toBe(3);
    expect(byType.checkpoint_snapshot).toBe(3);
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
    const ended = records.filter((r): r is SessionLifecycleEvent => r.type === "session_ended");
    expect(ended).toHaveLength(3);
    for (const ev of ended) {
      expect(ev.usage).toBeDefined();
      // Note: Task 17 wires the host's accumulation. For Task 16,
      // host.captureUsage returns zeros — this assertion verifies
      // the record shape carries the usage field at all.
      expect(ev.usage).toEqual(ZERO_USAGE);
    }

    // §11.1: every accepted transition produced a checkpoint snapshot.
    const snapshots = records.filter((r) => r.type === "checkpoint_snapshot");
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toMatchObject({
      type: "checkpoint_snapshot",
      checkpoint: { current_role: "worker" },
    });
    expect(snapshots[2]).toMatchObject({
      type: "checkpoint_snapshot",
      checkpoint: { current_role: "done" },
    });

    // parent_session links (§11.4) form a tree: orch₁ → worker → orch₂.
    const started = records.filter((r): r is SessionLifecycleEvent => r.type === "session_started");
    expect(started).toHaveLength(3);
    expect(started.map((s) => s.role)).toEqual(["orchestrator", "worker", "orchestrator"]);
    // Root has no parent; descendants link to the previous session.
    expect(started[0]?.parent_session).toBeNull();
    expect(started[1]?.parent_session).not.toBeNull();
    expect(started[2]?.parent_session).not.toBeNull();
    // parent_session is an opaque link string per §11.4 — the loop
    // uses RoleSession.sessionId as the link token (and session_file
    // as the on-disk identifier). They are intentionally different
    // strings; the assertion above just verifies the chain shape.
  });
});

// ─── (bonus) Stub-driven no_emission → session_failed (no_emission) ───

describe("stub provider — no_emission drives a §11.3 breach (no_emission)", () => {
  it("session emits no tool call → session_failed(no_emission), no reduce", async () => {
    const initialCheckpoint = createInitialCheckpoint(makeDef());
    const host = new StubHost(initialCheckpoint.run_id, {
      steps: [{ kind: "no_emission" }],
    });

    const result = await runLoop({
      def: makeDef(),
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });

    expect(result.exitReason).toBe("session_failed");
    const records = host.log.records(initialCheckpoint.run_id);
    expect(records.some((r) => r.type === "session_started")).toBe(true);
    const failed = records.find((r): r is SessionLifecycleEvent => r.type === "session_failed");
    expect(failed?.failure_reason).toBe("no_emission");
    // CRITICAL: no transition_rejected and no reduce call.
    expect(records.some((r): r is TransitionRejected => r.type === "transition_rejected")).toBe(
      false,
    );
    expect(records.some((r) => r.type === "transition_accepted")).toBe(false);
  });
});
