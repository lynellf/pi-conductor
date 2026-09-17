import { rm } from "node:fs/promises";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerActivationFence } from "../../src/host/controller/activation-fence.js";
import { controllerWaitDeadline } from "../../src/host/controller/controller-wakeup.js";
import { createControllerRoleSession } from "../../src/host/controller/role-session.js";
import type { ControllerRequest } from "../../src/manifest/controller-protocol.js";
import { controllerWaitPayloadSchema } from "../../src/manifest/controller-protocol.js";
import { controllerSessionFixture, response } from "./fixtures/controller-role-session-fixture.js";

afterEach(() => vi.useRealTimers());

describe("durable bounded controller observation wakeups", () => {
  it.each([
    0,
    -1,
    999,
    1000.5,
    600001,
    Number.POSITIVE_INFINITY,
  ])("rejects an unbounded or polling delay %s", (wake_after_ms) => {
    expect(Value.Check(controllerWaitPayloadSchema, { wake_after_ms })).toBe(false);
  });
  it("recognizes an overdue persisted deadline after activation restart", async () => {
    const fixture = await controllerSessionFixture({
      invokePlanner: async (request) => ({
        ...response(request, "wait"),
        decision: "wait",
        wake_after_ms: 1000,
      }),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const prompting = fixture.session.prompt("ignored");
    await vi.advanceTimersByTimeAsync(0);
    const wait = fixture.records.find((record) => record.type === "controller_decision_committed");
    if (wait?.type !== "controller_decision_committed") throw new Error("missing wait");
    await fixture.session.abortOwnedWork?.();
    await prompting;
    await fixture.session.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    const activation = {
      ...fixture.activation,
      activation_id: "activation-2",
      owner_epoch: 2,
      reason: "resume" as const,
      previous_activation_id: fixture.activation.activation_id,
      ts: Date.now(),
    };
    fixture.persist(activation);
    const requests: ControllerRequest[] = [];
    const resumed = await createControllerRoleSession({
      role: "orchestrator",
      sessionId: "controller-session-2",
      sessionFile: `${fixture.root}/resumed.jsonl`,
      activation,
      readRecords: () => fixture.records,
      persist: fixture.persist,
      invokePlanner: async (request) => {
        requests.push(request);
        return response(request, "finish");
      },
      dispatcher: fixture.dispatcher,
      admission: fixture.admission,
      fence: new ControllerActivationFence(activation, () => fixture.records),
      maxParallel: 2,
      isRunCostCapReached: () => false,
      closeOwnedWork: async () => undefined,
    });
    try {
      await resumed.prompt("ignored");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.wakeup).toEqual({
        kind: "timer",
        decision_id: wait.decision_id,
        due_at: wait.ts + 1000,
      });
    } finally {
      await resumed.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("waits without polling, then invokes the planner once with the durable timer identity", async () => {
    const requests: ControllerRequest[] = [];
    const fixture = await controllerSessionFixture({
      invokePlanner: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { ...response(request, "wait"), decision: "wait", wake_after_ms: 1000 }
          : response(request, "finish");
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const prompting = fixture.session.prompt("ignored");
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(1);
      const decision = fixture.records.find(
        (record) => record.type === "controller_decision_committed",
      );
      if (decision?.type !== "controller_decision_committed") throw new Error("missing wait");
      expect(controllerWaitDeadline(decision)).toBe(decision.ts + 1000);
      await vi.advanceTimersByTimeAsync(999);
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await prompting;
      expect(requests).toHaveLength(2);
      expect(requests[1]?.wakeup).toEqual({
        kind: "timer",
        decision_id: decision.decision_id,
        due_at: decision.ts + 1000,
      });
    } finally {
      await fixture.session.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("cancels a scheduled observation on abort", async () => {
    let calls = 0;
    const fixture = await controllerSessionFixture({
      invokePlanner: async (request) => {
        calls += 1;
        return { ...response(request, "wait"), decision: "wait", wake_after_ms: 1000 };
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const prompting = fixture.session.prompt("ignored");
    try {
      await vi.advanceTimersByTimeAsync(0);
      await fixture.session.abortOwnedWork?.();
      await prompting;
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await fixture.session.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
