/** Issue #112: no ordinary tool effects after a host terminal cause (§12.1). */
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { SessionState } from "../../src/host/cost.js";
import { createCaptureRejector } from "../../src/host/session-event-handler.js";
import { wrapToolWithSeal } from "../../src/host/tool-wrapper.js";

// These tools never access SDK context; only dispatch/effect gating is under test.
const context = {} as ExtensionContext;

it.each([
  "read",
  "write",
  "bash",
])("blocks %s effects on terminal state and allows only confirmed recovery", async (name) => {
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "ran" }],
    details: {},
  }));
  const raw = defineTool({
    name,
    label: name,
    description: "test",
    parameters: Type.Object({}),
    execute,
  });
  const rejector = createCaptureRejector();
  const state = new SessionState({ cap: null, model: "stub:model" });
  rejector.bindState(state);
  const wrapped = wrapToolWithSeal(
    raw,
    () => false,
    () => rejector.getRejection(),
  );
  state.setTerminalReason("model_error", "provider idle timeout");
  const blocked = await wrapped.execute("blocked", {}, undefined, undefined, context);
  expect(blocked).toMatchObject({
    terminate: true,
    details: {
      reason: "host_terminated",
      cause: "model_error",
      diagnostic: "provider idle timeout",
    },
  });
  expect(execute).not.toHaveBeenCalled();
  state.clearRetryableModelError();
  await wrapped.execute("recovered", {}, undefined, undefined, context);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("rebinds a retained tool gate to fresh invocation state without clearing the old cause", async () => {
  const rejector = createCaptureRejector();
  const oldState = new SessionState({ cap: null, model: "stub:old" });
  oldState.setTerminalReason("tool_cleanup_unconfirmed", "cleanup pending");
  rejector.bindState(oldState);
  expect(rejector.getRejection()).toMatchObject({ cause: "tool_cleanup_unconfirmed" });
  const nextState = new SessionState({ cap: null, model: "stub:next" });
  rejector.bindState(nextState);
  expect(rejector.getRejection()).toBe(false);
  expect(oldState.terminalReason).toBe("tool_cleanup_unconfirmed");
  nextState.markAborted();
  expect(rejector.getRejection()).toEqual({ cause: "aborted" });
});
