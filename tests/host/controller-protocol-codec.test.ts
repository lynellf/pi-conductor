import { describe, expect, it } from "vitest";
import {
  decodeControllerResponse,
  encodeControllerRequest,
  TypedControllerProtocolError,
} from "../../src/host/controller/protocol-codec.js";
import type { ControllerRequest } from "../../src/manifest/controller-protocol.js";

const digest = "a".repeat(64);
const request: ControllerRequest = {
  protocol_version: 1,
  run_id: "run",
  controller_id: "controller",
  owner_epoch: 1,
  definition_digest: digest,
  activation_id: "activation",
  state_revision: 2,
  event_cursor: null,
  state: { status: "idle" },
  events: [],
  page_cursor: null,
  pending_operations: [],
  capacity: { running: 0, queued: 0, remaining_allowance: 4, max_parallel: 2 },
};

function response(decision: "wait" | "finish" | "plan" | "escalate", extra = {}) {
  return Buffer.from(
    JSON.stringify({
      protocol_version: 1,
      run_id: "run",
      controller_id: "controller",
      owner_epoch: 1,
      definition_digest: digest,
      activation_id: "activation",
      state_revision: 2,
      event_cursor: null,
      state: { status: "idle" },
      decision,
      ...(decision === "finish" ? { payload: { reason: "done" } } : {}),
      ...(decision === "escalate" ? { reason: "blocked", evidence_refs: ["evidence"] } : {}),
      ...(decision === "plan" ? { actions: [extra] } : {}),
    }),
  );
}

describe("controller protocol codec", () => {
  it.each(["wait", "finish"] as const)("decodes a valid %s response", (decision) => {
    expect(decodeControllerResponse(response(decision), request).decision).toBe(decision);
  });

  it("decodes plan with each action kind", () => {
    const actions = [
      {
        kind: "delegate",
        action_id: "d",
        tasks: [{ id: "t", subagent: "worker", objective: "do", expected_output: "done" }],
      },
      { kind: "adapter", action_id: "a", adapter_id: "validate", input_refs: ["in"] },
      { kind: "read", action_id: "r", ref: "receipt" },
      { kind: "cancel", action_id: "c", child_ids: ["child"] },
    ] as const;
    for (const action of actions)
      expect(decodeControllerResponse(response("plan", action), request).decision).toBe("plan");
  });

  it("rejects duplicate IDs, stale identity, mismatched cursor, trailing JSON, and invalid UTF-8", () => {
    const duplicateValue = JSON.parse(
      response("plan", { kind: "read", action_id: "x", ref: "r" }).toString(),
    ) as Record<string, unknown>;
    duplicateValue.actions = [
      { kind: "read", action_id: "x", ref: "r" },
      { kind: "read", action_id: "x", ref: "r" },
    ];
    const duplicateTwice = Buffer.from(JSON.stringify(duplicateValue));
    expect(() => decodeControllerResponse(duplicateTwice, request)).toThrow(
      TypedControllerProtocolError,
    );
    expect(() =>
      decodeControllerResponse(Buffer.from(`${response("wait").toString()} {}`), request),
    ).toThrow(/one JSON value/);
    expect(() => decodeControllerResponse(Uint8Array.from([0xc3, 0x28]), request)).toThrow(/UTF-8/);
    const stale = JSON.parse(response("wait").toString()) as Record<string, unknown>;
    stale.run_id = "other";
    expect(() => decodeControllerResponse(Buffer.from(JSON.stringify(stale)), request)).toThrow(
      /identity/,
    );
    const cursor = JSON.parse(response("wait").toString()) as Record<string, unknown>;
    cursor.event_cursor = { ordinal: 1, record_digest: digest };
    expect(() => decodeControllerResponse(Buffer.from(JSON.stringify(cursor)), request)).toThrow(
      /cursor/,
    );
  });

  it("enforces depth, state bytes, nonfinite values, and request JSON size", () => {
    const deep: Record<string, unknown> = {};
    let current = deep;
    for (let index = 0; index < 34; index++) {
      current.next = {};
      current = current.next as Record<string, unknown>;
    }
    expect(() => encodeControllerRequest({ ...request, state: deep })).toThrow(/depth/);
    const veryDeep: Record<string, unknown> = {};
    let veryDeepCurrent = veryDeep;
    for (let index = 0; index < 10_000; index++) {
      veryDeepCurrent.next = {};
      veryDeepCurrent = veryDeepCurrent.next as Record<string, unknown>;
    }
    expect(() => encodeControllerRequest({ ...request, state: veryDeep })).toThrow(/depth/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeControllerRequest({ ...request, state: cyclic })).toThrow(/cycle/);
    expect(() => encodeControllerRequest({ ...request, state: { value: Number.NaN } })).toThrow(
      /finite/,
    );
    for (const value of [undefined, () => {}, Symbol("unsupported"), 1n]) {
      expect(() => encodeControllerRequest({ ...request, state: { value } })).toThrow(
        /unsupported primitive/,
      );
    }
    expect(() =>
      encodeControllerRequest({ ...request, state: { value: "x".repeat(70_000) } }),
    ).toThrow(/64 KiB/);
    expect(() =>
      encodeControllerRequest({
        ...request,
        events: [{ kind: "startup", source: null, payload: "x".repeat(1_100_000) }],
      }),
    ).toThrow(/1 MiB/);
    expect(() =>
      decodeControllerResponse(
        response("plan", { kind: "read", action_id: "é".repeat(65), ref: "r" }),
        request,
      ),
    ).toThrow(/128 UTF-8/);
  });
});
