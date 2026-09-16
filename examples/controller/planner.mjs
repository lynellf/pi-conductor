#!/usr/bin/env node
// Fixed executable for the no-model controller example. It accepts only protocol v1 JSON on stdin.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const request = JSON.parse(readFileSync(0, "utf8"));
const preparedPacket = JSON.stringify({ packet: "prepared", stage: "prepare" });
const preparedSha256 = createHash("sha256").update(preparedPacket).digest("hex");

function payload(event) {
  return event.payload !== null && typeof event.payload === "object" ? event.payload : {};
}

function updatedState() {
  const previous = request.state !== null && typeof request.state === "object" ? request.state : {};
  const actions = { ...(previous.actions ?? {}) };
  let nativeTerminalRef = typeof previous.native_terminal_ref === "string"
    ? previous.native_terminal_ref
    : undefined;
  for (const event of request.events) {
    const body = payload(event);
    if (event.kind === "action_terminal" && typeof body.action_id === "string") {
      actions[body.action_id] = {
        outcome: body.outcome,
        result_refs: Array.isArray(body.result_refs) ? body.result_refs : [],
        ...(body.read_result === undefined ? {} : { read_result: body.read_result }),
      };
    }
    if (event.kind === "child_terminal" && typeof body.record_ref === "string") {
      nativeTerminalRef = body.record_ref;
    }
  }
  return { actions, ...(nativeTerminalRef === undefined ? {} : { native_terminal_ref: nativeTerminalRef }) };
}

const state = updatedState();
const action = (id) => state.actions[id] ?? null;
const isCompleted = (id) => action(id)?.outcome === "completed";
const artifact = (id) =>
  action(id)?.result_refs?.find((ref) => typeof ref === "string" && ref.startsWith("artifact/"));
const isPending = (id) => request.pending_operations.some((operation) => operation.action_id === id);
const base = {
  protocol_version: 1,
  run_id: request.run_id,
  controller_id: request.controller_id,
  owner_epoch: request.owner_epoch,
  definition_digest: request.definition_digest,
  activation_id: request.activation_id,
  state_revision: request.state_revision,
  event_cursor: request.page_cursor,
  state,
};
const respond = (decision) => console.log(JSON.stringify({ ...base, ...decision }));
function readValidatedPacket(receipt, validationRef) {
  if (receipt?.source_ref !== validationRef || receipt.result?.encoding !== "base64") return false;
  try {
    const value = JSON.parse(Buffer.from(receipt.result.data, "base64").toString("utf8"));
    return value.packet === "prepared" && value.stage === "validated" && value.native_status === "completed";
  } catch {
    return false;
  }
}

if (!isCompleted("prepare")) {
  if (isPending("prepare")) respond({ decision: "wait" });
  else respond({ decision: "plan", actions: [
    { kind: "adapter", action_id: "prepare", adapter_id: "prepare", input_refs: [] },
  ] });
} else if (!isCompleted("work")) {
  if (isPending("work")) respond({ decision: "wait" });
  else {
    const ref = artifact("prepare");
    if (ref === undefined) throw new Error("prepared artifact receipt is missing");
    respond({ decision: "plan", actions: [
      {
        kind: "delegate",
        action_id: "work",
        tasks: [{
          id: "packet-work",
          subagent: "worker",
          objective: "Return the prepared packet.",
          expected_output: "packet received",
          projection_paths: ["worker-output.txt"],
          context_artifacts: [{
            id: "prepared-packet",
            source: "host_artifact",
            ref,
            sha256: preparedSha256,
            byte_length: Buffer.byteLength(preparedPacket, "utf8"),
            media_type: "application/json",
          }],
        }],
      },
    ] });
  }
} else if (!isCompleted("validate")) {
  if (isPending("validate")) respond({ decision: "wait" });
  else {
    const prepRef = artifact("prepare");
    if (prepRef === undefined || state.native_terminal_ref === undefined)
      throw new Error("validator inputs are missing");
    respond({ decision: "plan", actions: [
      {
        kind: "adapter",
        action_id: "validate",
        adapter_id: "validate",
        input_refs: [prepRef, state.native_terminal_ref],
      },
    ] });
  }
} else if (!isCompleted("read-validation")) {
  if (isPending("read-validation")) respond({ decision: "wait" });
  else {
    const ref = artifact("validate");
    if (ref === undefined) throw new Error("validation artifact receipt is missing");
    respond({ decision: "plan", actions: [
      { kind: "read", action_id: "read-validation", ref },
    ] });
  }
} else {
  const validationRef = artifact("validate");
  const readResult = action("read-validation")?.read_result;
  if (validationRef === undefined || !readValidatedPacket(readResult, validationRef))
    throw new Error("read receipt does not contain the validated packet");
  respond({ decision: "finish", payload: { reason: "packet prepared, delegated, validated, and read" } });
}
