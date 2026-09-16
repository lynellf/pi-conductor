/** Durable controller metric reconstruction across restart boundaries — issue #115 §7. */
import { parseControllerConfig } from "../../manifest/controller.js";
import type { PersistedRecord } from "../../persistence/log.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type {
  ControllerIdleInterval,
  ControllerLatency,
  ControllerMetricName,
  ControllerMetricSource,
  ControllerMetricsSnapshot,
} from "./metrics.js";

const MAX_SAMPLES = 128;
/** Project durable controller facts without inventing cross-process clock durations. */
export function projectControllerMetrics(
  records: readonly PersistedRecord[],
  runId: string,
): ControllerMetricsSnapshot | null {
  const definition = records.find(
    (record) => record.type === "controller_definition_pinned" && record.run_id === runId,
  );
  if (definition?.type !== "controller_definition_pinned") return null;
  const configValue = definition.pinned_definition;
  if (configValue === null || typeof configValue !== "object" || !("config" in configValue))
    return null;
  const config = parseControllerConfig(configValue.config);
  const activations = records.filter(
    (record) =>
      record.type === "controller_activation_started" &&
      record.run_id === runId &&
      record.controller_id === definition.controller_id &&
      record.definition_digest === definition.definition_digest,
  );
  const activation = activations.at(-1);
  if (activation?.type !== "controller_activation_started") return null;
  const source = (ordinal: number): ControllerMetricSource => ({
    ordinal,
    digest: sha256Canonical(records[ordinal]),
  });
  const accepted = new Map<string, ControllerMetricSource>();
  const runningChildIds = new Set<string>();
  const toolStarts = new Map<
    string,
    {
      source: ControllerMetricSource;
      kind: "planner" | "adapter" | "preparation";
      runtimeCapture: boolean;
    }
  >();
  const decisionActions = new Map<string, ControllerMetricSource>();
  const pendingTerminalSources: ControllerMetricSource[] = [];
  const latencies: ControllerLatency[] = [];
  const idle: ControllerIdleInterval[] = [];
  let metricsActive = false;
  let idleFrom: ControllerMetricSource | null | undefined;
  const add = (
    name: ControllerMetricName,
    from: ControllerMetricSource | null,
    to: ControllerMetricSource | null,
  ) => {
    latencies.push({ name, durationMs: null, restartBoundary: true, from, to });
    if (latencies.length > MAX_SAMPLES) latencies.shift();
  };
  const addIdle = (from: ControllerMetricSource | null, to: ControllerMetricSource | null) => {
    idle.push({
      durationMs: null,
      eligible: "unknown",
      restartBoundary: true,
      from,
      to,
    });
    if (idle.length > MAX_SAMPLES) idle.shift();
  };
  for (const [ordinal, record] of records.entries()) {
    if (!("run_id" in record) || record.run_id !== runId) continue;
    const at = source(ordinal);
    if (
      record.type === "controller_activation_started" &&
      record.controller_id === definition.controller_id &&
      record.definition_digest === definition.definition_digest
    ) {
      if (!metricsActive) idleFrom = null;
      metricsActive = true;
    }
    if (
      record.type === "controller_decision_committed" &&
      record.controller_id === definition.controller_id &&
      record.definition_digest === definition.definition_digest
    )
      for (const action of record.actions)
        if (action.kind === "delegate") decisionActions.set(action.action_id, at);
    if (
      record.type === "delegation_submission_accepted" &&
      record.schema_version === 2 &&
      record.origin.kind === "controller_action" &&
      record.origin.controller_id === definition.controller_id &&
      record.origin.definition_digest === definition.definition_digest
    ) {
      for (const child of record.children) accepted.set(child.child_id, at);
      add(
        "controller-result-to-native-acceptance",
        decisionActions.get(record.origin.action_id) ?? null,
        at,
      );
      decisionActions.delete(record.origin.action_id);
      continue;
    }
    if (record.type === "subagent_started" && accepted.has(record.child_id)) {
      const wasIdle = runningChildIds.size < config.delegation.max_parallel;
      runningChildIds.add(record.child_id);
      if (
        metricsActive &&
        wasIdle &&
        runningChildIds.size >= config.delegation.max_parallel &&
        idleFrom !== undefined
      ) {
        addIdle(idleFrom, at);
        idleFrom = undefined;
      }
      add("acceptance-to-child-start", accepted.get(record.child_id) ?? null, at);
      continue;
    }
    if (
      (record.type === "subagent_completed" || record.type === "subagent_failed") &&
      accepted.has(record.child_id)
    ) {
      const wasFull = runningChildIds.size >= config.delegation.max_parallel;
      runningChildIds.delete(record.child_id);
      if (
        metricsActive &&
        wasFull &&
        runningChildIds.size < config.delegation.max_parallel &&
        idleFrom === undefined
      )
        idleFrom = at;
      pendingTerminalSources.push(at);
      if (pendingTerminalSources.length > MAX_SAMPLES) pendingTerminalSources.shift();
      continue;
    }
    if (
      record.type === "tool_execution_started" &&
      record.schema_version === 2 &&
      record.origin.controller_id === definition.controller_id &&
      record.origin.definition_digest === definition.definition_digest &&
      (record.origin.operation_kind === "planner" ||
        record.origin.operation_kind === "adapter" ||
        record.origin.operation_kind === "preparation")
    ) {
      toolStarts.set(record.execution_id, {
        source: at,
        kind: record.origin.operation_kind,
        runtimeCapture:
          record.origin.operation_kind === "preparation" && record.origin.action_id === null,
      });
      if (record.origin.operation_kind === "planner") {
        for (const terminalSource of pendingTerminalSources)
          add("child-terminal-to-controller-start", terminalSource, at);
        pendingTerminalSources.length = 0;
      }
    }
    if (
      record.type === "tool_execution_finished" &&
      record.schema_version === 2 &&
      record.origin.controller_id === definition.controller_id &&
      record.origin.definition_digest === definition.definition_digest
    ) {
      const begin = toolStarts.get(record.execution_id);
      if (begin !== undefined) {
        add(
          begin.kind === "planner"
            ? "controller-duration"
            : begin.kind === "adapter"
              ? "adapter-duration"
              : "preparation-duration",
          begin.source,
          at,
        );
        if (begin.runtimeCapture) add("runtime-capture-duration", begin.source, at);
      }
    }
  }
  if (metricsActive && idleFrom !== undefined) addIdle(idleFrom, null);
  const running = runningChildIds.size;
  const acceptedCount = accepted.size;
  return Object.freeze({
    controllerId: definition.controller_id,
    definitionDigest: definition.definition_digest,
    activationId: activation.activation_id,
    ownerEpoch: activation.owner_epoch,
    coordinatorModelTurns: 0,
    latencies: Object.freeze(latencies),
    capacity: Object.freeze({
      accepted: acceptedCount,
      running,
      free: Math.max(0, config.delegation.max_parallel - running),
      maxParallel: config.delegation.max_parallel,
      remainingAllowance: Math.max(0, config.delegation.max_children_per_session - acceptedCount),
      eligible: "unknown",
    }),
    idle: Object.freeze(idle),
  });
}
