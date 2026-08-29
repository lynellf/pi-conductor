/**
 * Role-turn telemetry capture through the real `message_end` event path.
 *
 * Proves the additive `role_turn` producer contract at the one seam the spec
 * pins: `attachSessionEventHandler` invokes the producer exactly once for each
 * eligible assistant `message_end`, after the role is confirmed and before the
 * cost-cap / `stopReason: "error"` early returns (spec §4 / §6). These are
 * focused, real-path tests — the producer builds a bounded {@link RoleTurnRecord}
 * and routes it through `Host.persistRecord`, so the durable log is the proof,
 * not a private closure.
 *
 * The producer is seeded from an in-memory log (spec §7.5 reconstruction) so a
 * resume sequence carries across events within a single test.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionState } from "../../src/host/cost.js";
import { RoleTurnProducer } from "../../src/host/role-turn-producer.js";
import { attachSessionEventHandler } from "../../src/host/session-event-handler.js";
import { InMemoryRecordLog, type PersistedRecord, type RecordLog } from "../../src/index.js";
import type { RoleTurnRecord } from "../../src/persistence/log.js";

/** A fake `AgentSession`-shaped event source for the shared handler. */
function makeSession() {
  let listener: ((event: unknown) => void) | undefined;
  return {
    subscribe: (fn: (event: unknown) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    emit(event: unknown) {
      listener?.(event);
    },
  };
}

/** A session-shaped source that fires every subscriber on each emit (spec §6). */
function makeMultiplexSession() {
  const listeners = new Set<(event: unknown) => void>();
  return {
    subscribe: (fn: (event: unknown) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    emit(event: unknown) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

/** Minimal assistant message carrying structured content parts. */
function assistantMessage(
  content: readonly unknown[],
  stopReason: AssistantMessage["stopReason"] = "stop",
  role: string = "assistant",
): AssistantMessage {
  return {
    role,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "stub:model",
    content,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1000,
  } as unknown as AssistantMessage;
}

/** A run-owned producer seeded from an in-memory log, wired exactly as the hosts do. */
function makeProducer(log: RecordLog, runId: string): RoleTurnProducer {
  return new RoleTurnProducer({ runId, log, telemetry: {} });
}

/** Attach the shared handler with a producer and return the session + emit helper. */
function attach(
  log: RecordLog,
  producer: RoleTurnProducer,
  runId: string,
  opts: { role?: string; roleSessionId?: string } = {},
) {
  const session = makeSession();
  const state = new SessionState({ cap: null, model: null });
  attachSessionEventHandler({
    session: session as never,
    state,
    role: opts.role ?? "worker",
    roleTurn: {
      producer,
      context: {
        runId,
        role: opts.role ?? "worker",
        roleSessionId: opts.roleSessionId ?? "logical-1",
        conversationId: "physical-1",
        sessionFile: "/tmp/physical-1.jsonl",
        persist: (record: PersistedRecord) => log.append(record),
      },
    },
  });
  return {
    session,
    emit: (event: unknown) => (session as { emit: (e: unknown) => void }).emit(event),
  };
}

/** Durable, ordered role_turn records for a run. */
function roleTurns(log: RecordLog, runId: string): RoleTurnRecord[] {
  return log.records(runId).filter((r): r is RoleTurnRecord => r.type === "role_turn");
}

/** Exactly one durable role_turn, asserted and narrowed for typed access. */
function onlyTurn(turns: readonly RoleTurnRecord[]): RoleTurnRecord {
  expect(turns).toHaveLength(1);
  const [turn] = turns;
  if (turn === undefined) throw new Error("expected exactly one role_turn");
  return turn;
}

function firstTurn(turns: readonly RoleTurnRecord[]): RoleTurnRecord {
  expect(turns.length).toBeGreaterThanOrEqual(1);
  const [turn] = turns;
  if (turn === undefined) throw new Error("expected at least one role_turn");
  return turn;
}

function lastTurn(turns: readonly RoleTurnRecord[]): RoleTurnRecord {
  expect(turns.length).toBeGreaterThanOrEqual(1);
  const turn = turns[turns.length - 1];
  if (turn === undefined) throw new Error("expected at least one role_turn");
  return turn;
}

describe("role-turn capture — ordered block mapping (spec §4.1)", () => {
  it("persists text + thinking + text as three typed blocks in order, no merging or quoting", () => {
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-ordered");
    const { emit } = attach(log, producer, "run-ordered");

    emit({
      type: "message_end",
      message: assistantMessage([
        { type: "text", text: "Here is the plan." },
        { type: "thinking", thinking: "reasoning stays verbatim" },
        { type: "text", text: "Done." },
      ]),
    });

    const turn = onlyTurn(roleTurns(log, "run-ordered"));
    expect(turn.blocks.map((b) => b.kind)).toEqual(["text", "thinking", "text"]);
    expect(turn.blocks[0]?.text).toBe("Here is the plan.");
    expect(turn.blocks[1]?.text).toBe("reasoning stays verbatim");
    expect(turn.blocks[2]?.text).toBe("Done.");
    // No Markdown quoting: the thinking text is retained verbatim.
    expect(turn.blocks[1]?.text).not.toMatch(/^>\s/);
    expect(turn.capture.limit_causes).toEqual([]);
    expect(turn.capture.captured.blocks).toBe(3);
  });

  it("empty content emits a normal role_turn with blocks []", () => {
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-empty");
    const { emit } = attach(log, producer, "run-empty");

    emit({ type: "message_end", message: assistantMessage([]) });

    const turn = onlyTurn(roleTurns(log, "run-empty"));
    expect(turn.blocks).toEqual([]);
    expect(turn.capture.source.blocks).toBe(0);
    expect(turn.capture.captured.blocks).toBe(0);
  });

  it("a message whose only eligible text block is '' retains one empty text block", () => {
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-emptyspace");
    const { emit } = attach(log, producer, "run-emptyspace");

    emit({ type: "message_end", message: assistantMessage([{ type: "text", text: "" }]) });

    const turn = onlyTurn(roleTurns(log, "run-emptyspace"));
    expect(turn.blocks).toEqual([
      {
        kind: "text",
        text: "",
        original_utf8_bytes: 0,
        original_characters: 0,
        truncated: false,
        truncated_by: [],
      },
    ]);
    expect(turn.capture.captured.blocks).toBe(1);
  });

  it("omits tool call/use, tool result, image, and unknown parts (no v1 representation)", () => {
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-tools");
    const { emit } = attach(log, producer, "run-tools");

    emit({
      type: "message_end",
      message: assistantMessage([
        { type: "text", text: "real text" },
        { type: "tool_use", id: "1", name: "read", input: { path: "x" } },
        { type: "tool_result", toolUseId: "1", content: "result body" },
        { type: "image", source: { type: "base64" } },
        { type: "unknown_part", foo: 1 },
      ]),
    });

    const turn = onlyTurn(roleTurns(log, "run-tools"));
    expect(turn.blocks.map((b) => b.kind)).toEqual(["text"]);
    // The omitted tool/image/unknown parts never contributed a block.
    expect(turn.capture.captured.blocks).toBe(1);
    expect(turn.capture.source.blocks).toBe(1);
  });

  it("omits a text part whose text is not a string (malformed, never coerced)", () => {
    // A text part carrying a non-string `text` has no v1 representation; it is
    // omitted, not coerced to "0" or "" and not thrown (remediation §4).
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-malformed-text");
    const { emit } = attach(log, producer, "run-malformed-text");

    emit({
      type: "message_end",
      message: assistantMessage([
        { type: "text", text: 5 as unknown as string },
        { type: "text", text: "kept" },
      ]),
    });

    const turn = onlyTurn(roleTurns(log, "run-malformed-text"));
    expect(turn.blocks.map((b) => b.kind)).toEqual(["text"]);
    expect(turn.blocks[0]?.text).toBe("kept");
    expect(turn.capture.captured.blocks).toBe(1);
  });
});

describe("role-turn capture — redacted-thinking exclusion (spec §4.2)", () => {
  it("retains readable blocks but drops every redacted-thinking trace from the serialized record", () => {
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-redact");
    const { emit } = attach(log, producer, "run-redact");

    emit({
      type: "message_end",
      message: assistantMessage([
        { type: "thinking", thinking: "", redacted: true, thinkingSignature: "sig-abc" },
        { type: "text", text: "resilient answer content" },
        { type: "thinking", thinking: "another redacted block", redacted: true },
      ]),
    });

    const turn = onlyTurn(roleTurns(log, "run-redact"));
    expect(turn.blocks.map((b) => b.kind)).toEqual(["text"]);
    // Only the non-redacted readable text is retained.
    expect(turn.capture.source.blocks).toBe(1);

    // The serialized record must contain no trace of the redacted parts.
    const serialized = JSON.stringify(turn);
    expect(serialized).not.toContain("sig-abc");
    expect(serialized).not.toContain("redacted");
    expect(serialized).not.toContain("thinkingSignature");
    expect(serialized).not.toContain("another redacted block");
  });

  it("omits readable thinking when the part is empty or non-string", () => {
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-badthinking");
    const { emit } = attach(log, producer, "run-badthinking");

    emit({
      type: "message_end",
      message: assistantMessage([
        { type: "thinking", thinking: "" },
        { type: "thinking", thinking: 5 },
        { type: "text", text: "kept" },
      ]),
    });

    const turn = onlyTurn(roleTurns(log, "run-badthinking"));
    expect(turn.blocks.map((b) => b.kind)).toEqual(["text"]);
    expect(turn.capture.source.blocks).toBe(1);
  });
});

describe("role-turn capture — stopReason: error (spec §4.3)", () => {
  it("still emits one bounded record with no error body, then the loop keeps its own failure path", () => {
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-error");
    // Build the session + state explicitly so the handler's unchanged model-error
    // classification (terminal reason) is observable at the real event seam.
    const session = makeSession();
    const state = new SessionState({ cap: null, model: null });
    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      roleTurn: {
        producer,
        context: {
          runId: "run-error",
          role: "worker",
          roleSessionId: "logical-1",
          conversationId: "physical-1",
          sessionFile: "/tmp/physical-1.jsonl",
          persist: (record: PersistedRecord) => log.append(record),
        },
      },
    });

    session.emit({
      type: "message_end",
      message: assistantMessage(
        [
          { type: "text", text: "partial readable content" },
          { type: "thinking", thinking: "fine-grained readable reasoning" },
        ],
        "error",
      ),
    });

    const turn = onlyTurn(roleTurns(log, "run-error"));
    expect(turn.blocks.map((b) => b.kind)).toEqual(["text", "thinking"]);
    // No error body, signature, provider text, or stack is retained.
    const serialized = JSON.stringify(turn);
    expect(serialized).not.toContain("errorMessage");
    expect(serialized).not.toContain("providerError");
    expect(serialized).not.toContain("reasoningSignature");
    // The model-error terminal classification is unchanged: the producer captures
    // before the early return, and the handler still flips the terminal reason to
    // model_error (the helper message carries no errorMessage, so failureDetail
    // stays null — telemetry did not alter this classification).
    expect(state.terminalReason).toBe("model_error");
    expect(state.failureDetail).toBeNull();
  });

  it("does not capture for non-assistant messages, message_start, message_update, or tool events", () => {
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-noteligible");
    const { emit } = attach(log, producer, "run-noteligible");

    emit({ type: "message_start", message: assistantMessage([{ type: "text", text: "x" }]) });
    emit({ type: "message_update", message: assistantMessage([{ type: "text", text: "y" }]) });
    emit({
      type: "message_end",
      message: assistantMessage([{ type: "text", text: "user said this" }], "stop", "user"),
    });
    emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "read" });
    emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "read" });

    expect(roleTurns(log, "run-noteligible")).toHaveLength(0);
  });

  it("runs the capture before the cost-cap early return, so telemetry does not depend on terminal classification", () => {
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-cap");
    // A state already in a terminal cap-exceeded state stands in for the early
    // return path below the role-turn capture.
    const session = makeSession();
    const state = new SessionState({ cap: 0, model: null });
    state.markAborted();
    state.setTerminalReason("session_cost_cap_exceeded");

    attachSessionEventHandler({
      session: session as never,
      state,
      role: "worker",
      roleTurn: {
        producer,
        context: {
          runId: "run-cap",
          role: "worker",
          roleSessionId: "logical-cap",
          conversationId: "physical-cap",
          sessionFile: "/tmp/physical-cap.jsonl",
          persist: (record: PersistedRecord) => log.append(record),
        },
      },
    });

    session.emit({
      type: "message_end",
      message: assistantMessage([{ type: "text", text: "captured before abort" }]),
    });

    const turn = onlyTurn(roleTurns(log, "run-cap"));
    expect(turn.blocks[0]?.text).toBe("captured before abort");
  });
});

describe("role-turn capture — run-scoped sequence across events (spec §3.2 / §5.5)", () => {
  it("increments the run-scoped sequence and persists durable records in order", () => {
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-seq");
    const first = attach(log, producer, "run-seq", { roleSessionId: "logical-1" });
    // A second logical session shares the same producer; the run-scoped
    // sequence continues across logical invocations (spec §3.2 / §5.5).
    const second = attach(log, producer, "run-seq", { roleSessionId: "logical-2" });

    first.emit({ type: "message_end", message: assistantMessage([{ type: "text", text: "one" }]) });
    second.emit({
      type: "message_end",
      message: assistantMessage([{ type: "text", text: "two" }]),
    });

    const turns = roleTurns(log, "run-seq").sort((a, b) => a.sequence - b.sequence);
    expect(turns).toHaveLength(2);
    const seq0 = firstTurn(turns);
    const seq1 = lastTurn(turns);
    expect(seq0.sequence).toBe(1);
    expect(seq1.sequence).toBe(2);
    // Logical identities differ per invocation; the physical identity is retained.
    expect(seq0.role_session_id).toBe("logical-1");
    expect(seq1.role_session_id).toBe("logical-2");
    expect(seq0.conversation_id).toBe("physical-1");
    expect(seq1.conversation_id).toBe("physical-1");
  });
});

describe("role-turn capture — per-attachment re-fire dedup (spec §6)", () => {
  it("refires the exact same assistant message object once per attachment", () => {
    // A provider abort re-fires the identical message_end object through the same
    // attachment; the closure-local identity-only guard collapses that to one
    // durable record (spec §6). The guard tracks the object reference only.
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-refire-handler");
    const { emit } = attach(log, producer, "run-refire-handler");

    const message = assistantMessage([{ type: "text", text: "shared payload" }]);
    emit({ type: "message_end", message });
    emit({ type: "message_end", message });

    const turns = roleTurns(log, "run-refire-handler");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.blocks.map((b) => b.text)).toEqual(["shared payload"]);
  });

  it("persists distinct objects with identical content/timestamp each once (dedup is identity-only)", () => {
    // Two DIFFERENT message objects with identical content and timestamp must each
    // persist: the guard keys on the object reference, never on a derived
    // content/timestamp signature. The durable log therefore never carries such a
    // signature (dedup state retains no content-derived data).
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-distinct-handler");
    const { emit } = attach(log, producer, "run-distinct-handler");

    emit({ type: "message_end", message: assistantMessage([{ type: "text", text: "same" }]) });
    emit({ type: "message_end", message: assistantMessage([{ type: "text", text: "same" }]) });

    const turns = roleTurns(log, "run-distinct-handler");
    expect(turns).toHaveLength(2);
    const serialized = JSON.stringify(turns);
    expect(serialized).not.toMatch(/timestamp|signature|dedup/i);
  });

  it("persists an identical object once through each of two concurrent attachments, even with equal logical identity", () => {
    // Two live attachments share one producer and the SAME context (equal logical
    // identity), but each owns its own closure-local WeakSet, so the exact same
    // object persists once per attachment and is never cross-suppressed.
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-two-attachments");
    const multiplex = makeMultiplexSession();
    const persist = (record: PersistedRecord) => log.append(record);
    const context = {
      runId: "run-two-attachments",
      role: "worker",
      roleSessionId: "logical-1",
      conversationId: "physical-1",
      sessionFile: "/tmp/physical-1.jsonl",
      persist,
    };
    // Two attachments over one multiplex session, one shared producer + context.
    attachSessionEventHandler({
      session: multiplex as never,
      state: new SessionState({ cap: null, model: null }),
      role: "worker",
      roleTurn: { producer, context },
    });
    attachSessionEventHandler({
      session: multiplex as never,
      state: new SessionState({ cap: null, model: null }),
      role: "worker",
      roleTurn: { producer, context },
    });

    const message = assistantMessage([{ type: "text", text: "routed twice" }]);
    multiplex.emit({ type: "message_end", message });

    const turns = roleTurns(log, "run-two-attachments").sort((a, b) => a.sequence - b.sequence);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.sequence).toBe(1);
    expect(turns[1]?.sequence).toBe(2);
  });

  it("leaves the per-attachment guard unpopulated on a failed persist so the exact object retries at sequence 1", () => {
    // A failed durable append must not populate the guard, so the exact same object
    // retries (through the same attachment) against the unchanged next sequence,
    // proving the guard holds nothing that would suppress a genuine retry (spec §5.5).
    const log = new InMemoryRecordLog();
    const producer = makeProducer(log, "run-handler-retry");
    const session = makeSession();
    // Fails only on the first durable append; the retry (second call) succeeds.
    let attempts = 0;
    attachSessionEventHandler({
      session: session as never,
      state: new SessionState({ cap: null, model: null }),
      role: "worker",
      roleTurn: {
        producer,
        context: {
          runId: "run-handler-retry",
          role: "worker",
          roleSessionId: "logical-1",
          conversationId: "physical-1",
          sessionFile: "/tmp/physical-1.jsonl",
          persist: (record: PersistedRecord) => {
            attempts += 1;
            if (attempts === 1) throw new Error("durable append failed");
            log.append(record);
          },
        },
      },
    });

    const message = assistantMessage([{ type: "text", text: "retry payload" }]);
    // First emit: the durable append fails, the guard stays empty, and the host
    // persistence failure propagates.
    expect(() => session.emit({ type: "message_end", message })).toThrow("durable append failed");
    expect(roleTurns(log, "run-handler-retry")).toHaveLength(0);
    // Second emit: the guard still lacks the object, so it retries and succeeds at
    // the unchanged next sequence (1).
    session.emit({ type: "message_end", message });
    const turns = roleTurns(log, "run-handler-retry");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.sequence).toBe(1);
  });
});
