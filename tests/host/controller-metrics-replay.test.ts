import { describe, expect, it } from "vitest";
import { projectControllerMetrics } from "../../src/host/controller/metrics.js";
import type {
  ControllerActivationStartedRecord,
  ControllerDefinitionPinnedRecord,
} from "../../src/persistence/controller-records.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import {
  acceptedMetricRecord,
  finishedMetricExecution,
  startedMetricChild,
  startedMetricExecution,
  terminalMetricChild,
} from "./fixtures/controller-metrics-fixture.js";

describe("controller metric replay", () => {
  it("uses canonical durable sources and null restart durations for every reconstructable metric", () => {
    const definition = metricDefinition();
    const activation: ControllerActivationStartedRecord = {
      type: "controller_activation_started",
      schema_version: 1,
      run_id: "run",
      controller_id: "controller",
      definition_digest: definition.definition_digest,
      activation_id: "activation",
      owner_epoch: 1,
      reason: "start",
      previous_activation_id: null,
      ts: 2,
    };
    const records: PersistedRecord[] = [
      definition,
      activation,
      acceptedMetricRecord(),
      startedMetricChild(),
      terminalMetricChild(),
      startedMetricExecution("planner", "planner-exec"),
      finishedMetricExecution("planner", "planner-exec"),
      startedMetricExecution("adapter", "adapter-exec"),
      finishedMetricExecution("adapter", "adapter-exec"),
      startedMetricExecution("preparation", "preparation-exec"),
      finishedMetricExecution("preparation", "preparation-exec"),
    ];

    const snapshot = projectControllerMetrics(records, "run");
    if (snapshot === null) throw new Error("expected controller metrics");
    expect(new Set(snapshot.latencies.map((entry) => entry.name))).toEqual(
      new Set([
        "controller-result-to-native-acceptance",
        "acceptance-to-child-start",
        "child-terminal-to-controller-start",
        "controller-duration",
        "adapter-duration",
        "preparation-duration",
        "runtime-capture-duration",
      ]),
    );
    for (const sample of snapshot.latencies) {
      expect(sample.durationMs).toBeNull();
      expect(sample.restartBoundary).toBe(true);
      for (const source of [sample.from, sample.to]) {
        if (source === null) continue;
        expect(source.digest).toBe(sha256Canonical(records[source.ordinal]));
      }
    }
    expect(snapshot.capacity).toMatchObject({
      accepted: 1,
      running: 0,
      maxParallel: 2,
      free: 2,
      remainingAllowance: 2,
      eligible: "unknown",
    });
  });

  it("returns null for a run without pinned controller authority", () => {
    expect(projectControllerMetrics([], "run")).toBeNull();
  });
});

function metricDefinition(): ControllerDefinitionPinnedRecord {
  return {
    type: "controller_definition_pinned",
    schema_version: 1,
    run_id: "run",
    controller_id: "controller",
    definition_digest: "d".repeat(64),
    pinned_definition: {
      config: {
        protocol_version: 1,
        controller_id: "controller",
        runtime_id: "runtime",
        executable: "/controller",
        argv: [],
        adapters: [],
        delegation: {
          allowed_subagents: ["worker"],
          max_children_per_session: 3,
          max_parallel: 2,
        },
      },
    },
    controller_authority: {
      registration_id: "runtime",
      approval_id: "approval",
      runtime_digest: "a".repeat(64),
      executable_digest: "b".repeat(64),
      capability_digest: "c".repeat(64),
    },
    adapter_authorities: [],
    limits: { max_decisions: 10, max_actions: 10, max_outstanding_actions: 4 },
    ts: 1,
  };
}
