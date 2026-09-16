/** Serialized controller state/decision writer — issue #115 §§3–5. */
import type { ControllerRequest, ControllerResponse } from "../../manifest/controller-protocol.js";
import { reconstructControllerTimeline } from "../../persistence/controller-timeline.js";
import type { EndArgs } from "../../seam/schema.js";
import { prepareControllerDecision } from "./decision.js";
import { getControllerEvents } from "./event-page.js";
import { TypedControllerProtocolError } from "./protocol-codec.js";
import type { ControllerRoleSessionOptions } from "./session-contract.js";

/** Lifetime controls owned by the RoleSession, separate from deterministic decision state. */
export interface ControllerPumpControls {
  readonly signal: AbortSignal;
  readonly wait: () => Promise<void>;
  readonly audit: (value: unknown) => void;
  readonly assertHealthy: () => void;
}

/** Run one controller lifetime until an ordinary finish can be presented to the existing loop. */
export async function runControllerPump(
  options: ControllerRoleSessionOptions,
  controls: ControllerPumpControls,
): Promise<EndArgs> {
  let unchangedAttempts = 0;
  let staleAttempts = 0;
  let forceRetry = false;
  for (;;) {
    controls.assertHealthy();
    options.fence.assertPlanningOpen();
    const records = options.readRecords();
    const timeline = reconstructControllerTimeline(records);
    const page = getControllerEvents(records, options.activation, timeline.consumedCursor);
    if (page.events.length === 0 && !forceRetry) {
      await controls.wait();
      continue;
    }
    if (page.events.length > 0) unchangedAttempts = 0;
    forceRetry = false;
    const statuses = options.admission.status();
    const state = timeline.latestDecision?.controller_state ?? {};
    if (state === null || typeof state !== "object" || Array.isArray(state))
      throw new Error("durable controller state is not an object");
    const request: ControllerRequest = {
      protocol_version: 1,
      run_id: options.activation.run_id,
      controller_id: options.activation.controller_id,
      definition_digest: options.activation.definition_digest,
      activation_id: options.activation.activation_id,
      owner_epoch: options.activation.owner_epoch,
      state_revision: timeline.nextRevision - 1,
      event_cursor: timeline.consumedCursor,
      page_cursor: page.page_cursor,
      events: page.events,
      state: state as Record<string, unknown>,
      pending_operations: timeline.actions
        .filter(
          (action) =>
            action.latestReceipt === null ||
            ["pending", "accepted"].includes(action.latestReceipt.outcome),
        )
        .map((action) => ({
          action_id: action.actionId,
          kind: action.intent.kind,
          status: action.latestReceipt?.outcome ?? "intent",
        })),
      capacity: {
        running: statuses.filter((task) => task.status === "running").length,
        queued: statuses.filter((task) => task.status === "queued").length,
        remaining_allowance: options.admission.remainingChildren(),
        max_parallel: options.maxParallel,
      },
    };
    let response: ControllerResponse;
    try {
      response = await options.invokePlanner(request, controls.signal);
    } catch (error) {
      controls.assertHealthy();
      if (
        error instanceof TypedControllerProtocolError &&
        error.code === "stale_identity" &&
        ++staleAttempts < 3
      ) {
        forceRetry = true;
        continue;
      }
      throw error;
    }
    controls.assertHealthy();
    staleAttempts = 0;
    if (response.decision === "plan") await options.dispatcher.validateReferences(response.actions);
    controls.assertHealthy();
    options.fence.assertPlanningOpen();
    // Re-read only decision state for CAS. Native facts arriving during planning remain for the next page.
    const prepared = prepareControllerDecision(options.readRecords(), request, response);
    options.persist(prepared.record);
    controls.audit({
      type: "controller_decision",
      decision_id: prepared.record.decision_id,
      state_revision: prepared.record.state_revision,
      decision: response.decision,
    });
    if (response.decision === "plan") {
      for (const actionId of prepared.newActionIds) options.dispatcher.dispatchCommitted(actionId);
      if (prepared.newActionIds.length === 0) {
        if (++unchangedAttempts >= 3)
          throw new Error("controller made three unchanged decisions without new work");
        forceRetry = true;
      }
      continue;
    }
    if (response.decision === "escalate")
      throw new Error(`controller escalated: ${response.reason}`);
    if (response.decision === "wait") continue;
    options.fence.finishPending();
    await options.dispatcher.settle();
    const children = options.admission
      .status()
      .filter((task) => task.status === "running" || task.status === "queued");
    await Promise.all(
      children.map((child) => options.admission.wait(child.childId, controls.signal)),
    );
    controls.assertHealthy();
    return response.payload;
  }
}
