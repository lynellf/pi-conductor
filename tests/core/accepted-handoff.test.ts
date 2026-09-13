import { describe, expect, it } from "vitest";

import {
  ACCEPTED_HANDOFF_MAX_UTF8_BYTES,
  createAcceptedHandoffEnvelope,
  incomingAcceptedHandoff,
  readAcceptedHandoffEnvelope,
} from "../../src/core/accepted-handoff.js";
import type { TransitionAccepted } from "../../src/core/types.js";

function accepted(): TransitionAccepted {
  const result = createAcceptedHandoffEnvelope(
    { target_role: "orchestrator", packet: "public" },
    "orchestrator",
  );
  if (result.kind !== "ok") throw new Error("fixture envelope rejected");
  return {
    type: "transition_accepted",
    run_id: "run",
    from: "worker",
    to: "orchestrator",
    event: "handoff",
    target_role: "orchestrator",
    role: "worker",
    request_end: false,
    end_authority: null,
    end_requested_by: null,
    suggests_next: null,
    payload_summary: { reason: "ready", field_names: ["target_role", "packet"] },
    guard: null,
    effect: [],
    session_file: "worker-session",
    ts: 1,
    context_ref: { run_id: "run", source_role: "worker", source_session_file: "worker-session" },
    accepted_handoff: result.envelope,
  };
}

describe("accepted handoff envelope (issue #110)", () => {
  it("snapshots a JSON-safe payload and retains role-defined fields", () => {
    const payload = {
      target_role: "orchestrator",
      status: "ready",
      objective: "Dispatch the packet.",
      summary: "path=/public/packet sha256=abc",
      requested_action: "dispatch",
      public_dispatch: { path: "/public/packet", sha256: "abc" },
    };

    const result = createAcceptedHandoffEnvelope(payload, "orchestrator");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    payload.public_dispatch.sha256 = "mutated";
    expect(result.envelope.payload.public_dispatch).toEqual({
      path: "/public/packet",
      sha256: "abc",
    });
    expect(result.envelope.utf8_bytes).toBeGreaterThan(0);
  });

  it("rejects an over-limit payload without truncating it", () => {
    const result = createAcceptedHandoffEnvelope(
      { target_role: "orchestrator", value: "x".repeat(ACCEPTED_HANDOFF_MAX_UTF8_BYTES) },
      "orchestrator",
    );

    expect(result).toMatchObject({ kind: "rejected", reason: "handoff_envelope_too_large" });
  });

  it.each([0, 1])("enforces the exact UTF-8 byte boundary with %i extra bytes", (extra) => {
    const empty = { target_role: "orchestrator", value: "" };
    const available = ACCEPTED_HANDOFF_MAX_UTF8_BYTES - Buffer.byteLength(JSON.stringify(empty));
    const value = "é".repeat(Math.floor(available / 2)) + "x".repeat((available % 2) + extra);
    const result = createAcceptedHandoffEnvelope({ ...empty, value }, "orchestrator");
    expect(result.kind).toBe(extra === 0 ? "ok" : "rejected");
    if (result.kind === "ok") expect(result.envelope.utf8_bytes).toBe(65536);
    else expect(result.actual_utf8_bytes).toBe(65537);
  });

  it("preserves ordinary toJSON data fields and freezes the nested snapshot", () => {
    const result = createAcceptedHandoffEnvelope(
      { target_role: "orchestrator", custom: { toJSON: "ordinary data" } },
      "orchestrator",
    );
    if (result.kind !== "ok") throw new Error("valid JSON rejected");
    expect(result.envelope.payload.custom).toEqual({ toJSON: "ordinary data" });
    expect(Object.isFrozen(result.envelope.payload.custom)).toBe(true);
  });

  it("rejects cyclic and lossy object values before capture", () => {
    const cyclic: { target_role: string; self?: unknown } = { target_role: "orchestrator" };
    cyclic.self = cyclic;

    expect(createAcceptedHandoffEnvelope(cyclic, "orchestrator")).toMatchObject({
      kind: "rejected",
      reason: "handoff_envelope_not_json",
    });
    expect(
      createAcceptedHandoffEnvelope(
        { target_role: "orchestrator", date: new Date() },
        "orchestrator",
      ),
    ).toMatchObject({
      kind: "rejected",
      reason: "handoff_envelope_not_json",
    });
  });

  it("rejects a present envelope whose recipient or byte count does not bind the transition", () => {
    const created = createAcceptedHandoffEnvelope(
      { target_role: "orchestrator", value: "packet" },
      "orchestrator",
    );
    if (created.kind !== "ok") throw new Error("fixture envelope rejected");

    expect(() =>
      readAcceptedHandoffEnvelope(
        { ...created.envelope, recipient_role: "worker" },
        "orchestrator",
      ),
    ).toThrow("recipient_role");
    expect(() =>
      readAcceptedHandoffEnvelope({ ...created.envelope, utf8_bytes: 1 }, "orchestrator"),
    ).toThrow("utf8_bytes");
  });

  it.each([
    { name: "target", patch: { target_role: "other" } },
    { name: "emitter", patch: { from: "other" } },
    {
      name: "source context",
      patch: {
        context_ref: {
          run_id: "other",
          source_role: "worker",
          source_session_file: "worker-session",
        },
      },
    },
  ])("rejects corrupt current-recipient $name binding", ({ patch }) => {
    expect(() =>
      incomingAcceptedHandoff([{ ...accepted(), ...patch }], "run", "orchestrator"),
    ).toThrow();
  });

  it("rejects null metadata but keeps absent metadata legacy-compatible", () => {
    const { accepted_handoff: _envelope, ...legacy } = accepted();
    expect(incomingAcceptedHandoff([legacy], "run", "orchestrator")?.envelope).toBeNull();
    expect(() => readAcceptedHandoffEnvelope(null, "orchestrator")).toThrow();
  });

  it("never recovers a stale envelope behind a synthetic or different-recipient transition", () => {
    const earlier = accepted();
    const { accepted_handoff: _envelope, ...legacy } = earlier;
    const synthesized = { ...legacy, session_file: "<synthesized:worker>", context_ref: null };
    expect(
      incomingAcceptedHandoff([earlier, synthesized], "run", "orchestrator")?.envelope,
    ).toBeNull();
    const outgoing = { ...legacy, to: "worker", target_role: "worker" };
    expect(incomingAcceptedHandoff([earlier, outgoing], "run", "orchestrator")).toBeNull();
    expect(incomingAcceptedHandoff([earlier], "another-run", "orchestrator")).toBeNull();
  });
});
