/** Bounded controller query primitives — issue #115 §6. */

import type {
  ControllerActionState,
  ControllerActivationStartedRecord,
  PersistedRecord,
  reconstructControllerTimeline,
} from "../../persistence/log.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { CreateControllerActionDispatcherOptions } from "./action-dispatcher-contract.js";
import { projectControllerRecord } from "./raw-controller-projection.js";

export function intentCursor(
  records: readonly unknown[],
  actionId: string,
): { readonly ordinal: number; readonly recordDigest: string } {
  for (const [ordinal, record] of records.entries()) {
    if (
      record !== null &&
      typeof record === "object" &&
      "type" in record &&
      record.type === "controller_decision_committed" &&
      "actions" in record &&
      Array.isArray(record.actions) &&
      record.actions.some(
        (action) =>
          action !== null &&
          typeof action === "object" &&
          "action_id" in action &&
          action.action_id === actionId,
      )
    )
      return { ordinal, recordDigest: sha256Canonical(record) };
  }
  throw new Error("read action has no durable intent decision");
}
export function parseStrictJson(bytes: Buffer): unknown {
  if (bytes.byteLength > 1024 * 1024) throw new Error("resolved artifact exceeds one MiB");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("resolved artifact is not UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("resolved artifact is not JSON");
  }
  assertJsonDepth(value, 0);
  return value;
}
function assertJsonDepth(value: unknown, depth: number): void {
  if (depth > 32) throw new Error("resolved artifact exceeds JSON depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("resolved artifact has nonfinite number");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonDepth(item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) assertJsonDepth(item, depth + 1);
    return;
  }
  throw new Error("resolved artifact is not JSON");
}
export function artifactRefs(value: unknown): readonly string[] {
  if (
    value === null ||
    typeof value !== "object" ||
    !("tasks" in value) ||
    !Array.isArray(value.tasks)
  )
    return [];
  const tasks: readonly unknown[] = value.tasks;
  return tasks.flatMap((task: unknown) => {
    if (
      task === null ||
      typeof task !== "object" ||
      !("context_artifacts" in task) ||
      !Array.isArray(task.context_artifacts)
    )
      return [];
    return task.context_artifacts.flatMap((artifact: unknown) =>
      artifact !== null &&
      typeof artifact === "object" &&
      "source" in artifact &&
      artifact.source === "host_artifact" &&
      "ref" in artifact &&
      typeof artifact.ref === "string"
        ? [artifact.ref]
        : [],
    );
  });
}
export function findControllerRef(
  kind: string,
  digest: string,
  timeline: ReturnType<typeof reconstructControllerTimeline>,
  admission: CreateControllerActionDispatcherOptions["admission"],
  records: readonly unknown[],
  runId: string,
): unknown | undefined {
  if (kind === "record") {
    const record = records.find(
      (record) =>
        record !== null &&
        typeof record === "object" &&
        "run_id" in record &&
        record.run_id === runId &&
        sha256Canonical(record) === digest,
    );
    return record === undefined
      ? undefined
      : projectControllerRecord(record, timeline.definition.pinned_definition);
  }
  for (const state of timeline.actions) {
    const candidates: readonly ["action" | "request" | "accepted", unknown][] = [
      ["action", { action_id: state.actionId }],
      ["request", { action_id: state.actionId }],
      ["accepted", { action_id: state.actionId }],
    ];
    for (const [candidateKind, value] of candidates)
      if (candidateKind === kind && sha256Canonical(value) === digest) {
        if (candidateKind === "action") return state;
        if (candidateKind === "request") return state.intent.request;
        return admission.acceptedSubmission(state.actionId) ?? undefined;
      }
  }
  return undefined;
}

/** Recover only the exact durable operation identity behind an execution failure. */
export function operationIdForExecution(
  records: readonly PersistedRecord[],
  executionId: string | undefined,
  state: ControllerActionState,
  identity: ControllerActivationStartedRecord,
): string | null {
  if (executionId === undefined) return null;
  const start = records.find(
    (record) =>
      record.type === "tool_execution_started" &&
      record.schema_version === 2 &&
      record.execution_id === executionId,
  );
  if (start?.type !== "tool_execution_started" || start.schema_version !== 2) return null;
  return start.origin.controller_id === identity.controller_id &&
    start.origin.action_id === state.actionId &&
    start.origin.activation_id === identity.activation_id &&
    start.origin.owner_epoch === identity.owner_epoch &&
    start.origin.definition_digest === identity.definition_digest &&
    start.origin.request_sha256 === state.intent.request_sha256
    ? start.origin.operation_id
    : null;
}
