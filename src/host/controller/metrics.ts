/** Live monotonic controller observability — issue #115 §7. */
// The source-bearing snapshot contract, observer, and resume merge stay together so their
// identity rules cannot drift; this coherent boundary intentionally remains below 500 lines.
import type { PersistedRecord } from "../../persistence/log.js";

const MAX_SAMPLES = 128;
/** Named controller phase measured by the live metrics observer. */
export type ControllerMetricName =
  | "child-terminal-to-controller-start"
  | "controller-duration"
  | "controller-result-to-native-acceptance"
  | "acceptance-to-child-start"
  | "adapter-duration"
  | "preparation-duration"
  | "runtime-capture-duration";
/** Durable record identity anchoring one metric endpoint. */
export interface ControllerMetricSource {
  readonly ordinal: number;
  readonly digest: string;
}
/** One bounded phase-latency sample with explicit restart uncertainty. */
export interface ControllerLatency {
  readonly name: ControllerMetricName;
  readonly durationMs: number | null;
  readonly restartBoundary: boolean;
  readonly from: ControllerMetricSource | null;
  readonly to: ControllerMetricSource | null;
}
/** Lifetime allowance and current parallel-capacity projection. */
export interface ControllerCapacity {
  readonly maxParallel: number;
  readonly remainingAllowance: number;
  readonly accepted: number;
  readonly running: number;
  readonly free: number;
  readonly eligible: boolean | "unknown";
}
/** One bounded interval during which native capacity remained free. */
export interface ControllerIdleInterval {
  readonly durationMs: number | null;
  readonly eligible: boolean | "unknown";
  readonly restartBoundary: boolean;
  readonly from: ControllerMetricSource | null;
  readonly to: ControllerMetricSource | null;
}
/** Public controller observability returned by `RunHandle.runStats()`. */
export interface ControllerMetricsSnapshot {
  readonly controllerId: string;
  readonly definitionDigest: string;
  readonly activationId: string;
  readonly ownerEpoch: number;
  readonly coordinatorModelTurns: 0;
  readonly latencies: readonly ControllerLatency[];
  readonly capacity: ControllerCapacity;
  readonly idle: readonly ControllerIdleInterval[];
}
export interface ControllerMetricsObserver {
  record(record: PersistedRecord, source: ControllerMetricSource): void;
  plannerStarted(): void;
  plannerFinished(actionIds: readonly string[]): void;
  runtimeCaptureStarted(executionId: string): void;
  runtimeCaptureFinished(executionId: string): void;
  seedCapacity(value: ControllerCapacity): void;
  capacity(value: ControllerCapacity): void;
  snapshot(): ControllerMetricsSnapshot;
}

/**
 * Create bounded live metrics from monotonic observation time and durable evidence.
 * Controller duration spans planner execution start to terminal; result-to-acceptance starts after
 * validating that result and uses its committed decision as the durable source identity. Runtime
 * capture is nested within, and separately reported from, preparation.
 * Historical durations remain unknown because monotonic clocks do not cross process lifetimes.
 */
export function createControllerMetricsObserver(input: {
  readonly now?: () => number;
  readonly runId: string;
  readonly maxChildren: number;
  readonly maxParallel: number;
  readonly controllerId: string;
  readonly definitionDigest: string;
  readonly activationId: string;
  readonly ownerEpoch: number;
}): ControllerMetricsObserver {
  const now = input.now ?? (() => performance.now());
  const pendingChildTerminals: Array<{ time: number; source: ControllerMetricSource }> = [];
  let capacity: ControllerCapacity = {
    accepted: 0,
    running: 0,
    free: input.maxParallel,
    maxParallel: input.maxParallel,
    remainingAllowance: input.maxChildren,
    eligible: "unknown",
  };
  let idleStart:
    | {
        time: number;
        eligible: ControllerCapacity["eligible"];
        source: ControllerMetricSource | null;
      }
    | undefined;
  const pendingResults = new Map<string, { time: number; source: ControllerMetricSource | null }>();
  const seenActions = new Set<string>();
  const acceptances = new Map<string, { time: number; source: ControllerMetricSource }>();
  const acceptedChildIds = new Set<string>();
  const runningChildIds = new Set<string>();
  let baseAccepted = 0;
  let baseRemainingAllowance = input.maxChildren;
  let capacitySeeded = false;
  const operations = new Map<
    string,
    {
      time: number;
      source: ControllerMetricSource;
      kind: "planner" | "adapter" | "preparation";
    }
  >();
  let latestPlannerResult:
    | { readonly time: number; readonly source: ControllerMetricSource }
    | undefined;
  const runtimeStarts = new Map<string, number>();
  const runtimeDurations = new Map<string, number>();
  const latencies: ControllerLatency[] = [];
  const idle: ControllerIdleInterval[] = [];
  const add = (
    name: ControllerMetricName,
    durationMs: number | null,
    from: ControllerMetricSource | null,
    to: ControllerMetricSource | null,
    restartBoundary = false,
  ) => {
    latencies.push(Object.freeze({ name, durationMs, restartBoundary, from, to }));
    if (latencies.length > MAX_SAMPLES) latencies.shift();
  };
  const updateIdle = (next: ControllerCapacity, source: ControllerMetricSource | null) => {
    const time = now();
    const idleNow = next.free > 0;
    if (idleStart !== undefined && idleNow && idleStart.eligible !== next.eligible) {
      idle.push(
        Object.freeze({
          durationMs: Math.max(0, time - idleStart.time),
          eligible: idleStart.eligible,
          restartBoundary: false,
          from: idleStart.source,
          to: source,
        }),
      );
      if (idle.length > MAX_SAMPLES) idle.shift();
      idleStart = { time, eligible: next.eligible, source };
    }
    if (idleStart !== undefined && !idleNow) {
      idle.push(
        Object.freeze({
          durationMs: Math.max(0, time - idleStart.time),
          eligible: idleStart.eligible,
          restartBoundary: false,
          from: idleStart.source,
          to: source,
        }),
      );
      if (idle.length > MAX_SAMPLES) idle.shift();
      idleStart = undefined;
    }
    if (idleStart === undefined && idleNow) idleStart = { time, eligible: next.eligible, source };
  };
  const refreshDurableCapacity = (source: ControllerMetricSource) => {
    const next = Object.freeze({
      ...capacity,
      accepted: baseAccepted + acceptedChildIds.size,
      running: runningChildIds.size,
      free: Math.max(0, input.maxParallel - runningChildIds.size),
      remainingAllowance: Math.max(0, baseRemainingAllowance - acceptedChildIds.size),
    });
    capacity = next;
    updateIdle(next, source);
  };
  return Object.freeze({
    record(record: PersistedRecord, source: ControllerMetricSource) {
      if (!("run_id" in record) || record.run_id !== input.runId) return;
      const time = now();
      if (
        (record.type === "subagent_completed" || record.type === "subagent_failed") &&
        acceptances.has(record.child_id)
      ) {
        pendingChildTerminals.push({ time, source });
        if (pendingChildTerminals.length > MAX_SAMPLES) pendingChildTerminals.shift();
      }
      if (record.type === "controller_decision_committed")
        for (const action of record.actions) {
          if (seenActions.has(action.action_id)) pendingResults.delete(action.action_id);
          else {
            const result = pendingResults.get(action.action_id);
            if (action.kind === "delegate" && result !== undefined)
              pendingResults.set(action.action_id, { ...result, source });
          }
          seenActions.add(action.action_id);
        }
      if (
        record.type === "delegation_submission_accepted" &&
        record.schema_version === 2 &&
        record.origin.kind === "controller_action" &&
        record.origin.controller_id === input.controllerId &&
        record.origin.definition_digest === input.definitionDigest
      ) {
        const accepted = { time, source };
        for (const child of record.children) {
          acceptances.set(child.child_id, accepted);
          acceptedChildIds.add(child.child_id);
        }
        refreshDurableCapacity(source);
        const result = pendingResults.get(record.origin.action_id);
        add(
          "controller-result-to-native-acceptance",
          result === undefined ? null : Math.max(0, time - result.time),
          result?.source ?? null,
          source,
          result === undefined,
        );
        pendingResults.delete(record.origin.action_id);
      }
      if (record.type === "subagent_started" && acceptances.has(record.child_id)) {
        runningChildIds.add(record.child_id);
        refreshDurableCapacity(source);
        const accepted = acceptances.get(record.child_id);
        add(
          "acceptance-to-child-start",
          accepted === undefined ? null : Math.max(0, time - accepted.time),
          accepted?.source ?? null,
          source,
          accepted === undefined,
        );
      }
      if (
        (record.type === "subagent_completed" || record.type === "subagent_failed") &&
        acceptances.has(record.child_id)
      ) {
        runningChildIds.delete(record.child_id);
        refreshDurableCapacity(source);
      }
      if (
        record.type === "tool_execution_started" &&
        record.schema_version === 2 &&
        record.origin.controller_id === input.controllerId &&
        record.origin.definition_digest === input.definitionDigest &&
        (record.origin.operation_kind === "planner" ||
          record.origin.operation_kind === "adapter" ||
          record.origin.operation_kind === "preparation")
      ) {
        operations.set(record.execution_id, { time, source, kind: record.origin.operation_kind });
        if (record.origin.operation_kind === "planner") {
          for (const terminal of pendingChildTerminals)
            add(
              "child-terminal-to-controller-start",
              Math.max(0, time - terminal.time),
              terminal.source,
              source,
            );
          pendingChildTerminals.length = 0;
        }
      }
      if (
        record.type === "tool_execution_finished" &&
        record.schema_version === 2 &&
        record.origin.controller_id === input.controllerId &&
        record.origin.definition_digest === input.definitionDigest
      ) {
        const operation = operations.get(record.execution_id);
        if (operation !== undefined) {
          const name =
            operation.kind === "planner"
              ? "controller-duration"
              : operation.kind === "adapter"
                ? "adapter-duration"
                : "preparation-duration";
          add(name, Math.max(0, time - operation.time), operation.source, source);
          if (operation.kind === "planner") latestPlannerResult = { time, source };
          const captureDuration = runtimeDurations.get(record.execution_id);
          if (captureDuration !== undefined) {
            add("runtime-capture-duration", captureDuration, operation.source, source);
            runtimeDurations.delete(record.execution_id);
          }
          operations.delete(record.execution_id);
        }
      }
    },
    plannerStarted() {
      // Durable planner execution records provide the authoritative timing sources.
    },
    plannerFinished(actionIds: readonly string[]) {
      const result =
        latestPlannerResult === undefined
          ? undefined
          : { time: now(), source: latestPlannerResult.source };
      for (const actionId of actionIds)
        if (result !== undefined) {
          pendingResults.set(actionId, result);
          if (pendingResults.size > MAX_SAMPLES) {
            const oldest = pendingResults.keys().next().value;
            if (oldest !== undefined) pendingResults.delete(oldest);
          }
        }
      latestPlannerResult = undefined;
    },
    runtimeCaptureStarted(executionId: string) {
      if (operations.get(executionId)?.kind !== "preparation")
        throw new Error("runtime capture has no matching preparation execution");
      runtimeStarts.set(executionId, now());
    },
    runtimeCaptureFinished(executionId: string) {
      const start = runtimeStarts.get(executionId);
      if (start !== undefined) runtimeDurations.set(executionId, Math.max(0, now() - start));
      runtimeStarts.delete(executionId);
    },
    seedCapacity(value: ControllerCapacity) {
      if (capacitySeeded || acceptedChildIds.size > 0)
        throw new Error("controller metric capacity may only be seeded before live acceptance");
      capacitySeeded = true;
      baseAccepted = value.accepted;
      baseRemainingAllowance = value.remainingAllowance;
      capacity = Object.freeze({ ...value });
      updateIdle(capacity, null);
    },
    capacity(value: ControllerCapacity) {
      capacity = Object.freeze({ ...value });
      updateIdle(capacity, null);
    },
    snapshot() {
      const openIdle =
        idleStart === undefined
          ? []
          : [
              Object.freeze({
                durationMs: Math.max(0, now() - idleStart.time),
                eligible: idleStart.eligible,
                restartBoundary: false,
                from: idleStart.source,
                to: null,
              }),
            ];
      return Object.freeze({
        controllerId: input.controllerId,
        definitionDigest: input.definitionDigest,
        activationId: input.activationId,
        ownerEpoch: input.ownerEpoch,
        coordinatorModelTurns: 0,
        latencies: Object.freeze([...latencies]),
        capacity,
        idle: Object.freeze([
          ...idle.slice(openIdle.length === 0 ? -MAX_SAMPLES : 1 - MAX_SAMPLES),
          ...openIdle,
        ]),
      });
    },
  });
}

/** Merge durable restart-safe history with exact live samples for the current activation. */
export function mergeControllerMetrics(
  durable: ControllerMetricsSnapshot | null,
  live: ControllerMetricsSnapshot,
): ControllerMetricsSnapshot {
  if (durable === null) return live;
  if (
    durable.controllerId !== live.controllerId ||
    durable.definitionDigest !== live.definitionDigest ||
    durable.activationId !== live.activationId ||
    durable.ownerEpoch !== live.ownerEpoch
  )
    throw new Error("controller metric snapshots do not describe the same activation");

  return Object.freeze({
    ...live,
    latencies: mergeSamples(durable.latencies, live.latencies, latencyKey),
    idle: mergeIdle(durable.idle, live.idle, live.ownerEpoch > 1),
  });
}

function mergeSamples<T>(
  durable: readonly T[],
  live: readonly T[],
  key: (value: T) => string,
): readonly T[] {
  const merged = [...durable];
  const indexes = new Map(merged.map((sample, index) => [key(sample), index]));
  for (const sample of live) {
    const index = indexes.get(key(sample));
    if (index === undefined) {
      indexes.set(key(sample), merged.length);
      merged.push(sample);
    } else merged[index] = sample;
  }
  return Object.freeze(merged.slice(-MAX_SAMPLES));
}

function mergeIdle(
  durable: readonly ControllerIdleInterval[],
  live: readonly ControllerIdleInterval[],
  preserveUnboundedStart: boolean,
): readonly ControllerIdleInterval[] {
  const merged = [...durable];
  const indexes = new Map(merged.map((sample, index) => [idleKey(sample), index]));
  for (const sample of live) {
    const index = indexes.get(idleKey(sample));
    if (index !== undefined) {
      const prior = merged[index];
      if (preserveUnboundedStart && prior?.restartBoundary === true && sample.from === null)
        continue;
      merged[index] = sample;
      continue;
    }
    const overlapsRestartSample = merged.some(
      (candidate) =>
        candidate.restartBoundary &&
        candidate.eligible === sample.eligible &&
        sourceKey(candidate.to) === sourceKey(sample.to),
    );
    if (!overlapsRestartSample) merged.push(sample);
  }
  return Object.freeze(merged.slice(-MAX_SAMPLES));
}

function latencyKey(sample: ControllerLatency): string {
  return `${sample.name}:${sourceKey(sample.from)}:${sourceKey(sample.to)}`;
}

function idleKey(sample: ControllerIdleInterval): string {
  return `${sample.eligible}:${sourceKey(sample.from)}:${sourceKey(sample.to)}`;
}

function sourceKey(source: ControllerMetricSource | null): string {
  return source === null ? "null" : `${source.ordinal}:${source.digest}`;
}

export { projectControllerMetrics } from "./metrics-replay.js";
