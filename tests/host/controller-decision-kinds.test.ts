import { rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type {
  ControllerRequest,
  ControllerResponse,
} from "../../src/manifest/controller-protocol.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import { controllerSessionFixture } from "./fixtures/controller-role-session-fixture.js";

describe("controller atomic decision kinds", () => {
  it.each([
    "plan",
    "wait",
    "finish",
    "escalate",
  ] as const)("%s commits state and exact cursor before dispatch or termination", async (kind) => {
    const dispatch = vi.fn(() => {
      const committed = fixture.records.find(
        (record) => record.type === "controller_decision_committed",
      );
      expect(committed).toMatchObject({
        response_kind: "plan",
        actions: [{ action_id: "read-source" }],
      });
    });
    const fixture = await controllerSessionFixture({
      invokePlanner: async (request) => response(request, kind),
      dispatcher: { dispatchCommitted: dispatch },
    });
    const settled = fixture.session.prompt("ignored").then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(() =>
        expect(
          fixture.records.some((record) => record.type === "controller_decision_committed"),
        ).toBe(true),
      );
      const committed = fixture.records.find(
        (record) => record.type === "controller_decision_committed",
      );
      expect(committed).toMatchObject({
        response_kind: kind,
        prior_revision: 0,
        state_revision: 1,
        controller_state: { stage: kind },
        consumed_cursor: { ordinal: 1, record_digest: sha256Canonical(fixture.activation) },
      });
      expect(dispatch).toHaveBeenCalledTimes(kind === "plan" ? 1 : 0);
      if (kind === "escalate") expect(await settled).toBeInstanceOf(Error);
      if (kind === "finish") {
        expect(await settled).toBeNull();
        expect(fixture.session.readCaptureBuffer()).toEqual([
          { toolName: "end", args: { reason: "finished" } },
        ]);
      }
    } finally {
      await fixture.session.abortOwnedWork?.();
      await settled;
      await fixture.session.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

function response(
  request: ControllerRequest,
  kind: ControllerResponse["decision"],
): ControllerResponse {
  const base = {
    protocol_version: 1 as const,
    run_id: request.run_id,
    controller_id: request.controller_id,
    definition_digest: request.definition_digest,
    activation_id: request.activation_id,
    owner_epoch: request.owner_epoch,
    state_revision: request.state_revision,
    event_cursor: request.page_cursor,
    state: { stage: kind },
  };
  switch (kind) {
    case "plan":
      return {
        ...base,
        decision: kind,
        actions: [{ kind: "read", action_id: "read-source", ref: "source" }],
      };
    case "wait":
      return { ...base, decision: kind };
    case "finish":
      return { ...base, decision: kind, payload: { reason: "finished" } };
    case "escalate":
      return { ...base, decision: kind, reason: "operator inspection", evidence_refs: ["source"] };
  }
}
