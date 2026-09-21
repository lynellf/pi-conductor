import { describe, expect, it } from "vitest";
import type { MachineDefinition } from "../../src/core/types.js";
import { formatConductStatus } from "../../src/extension/status.js";
import type { ControllerMetricsSnapshot } from "../../src/host/controller/metrics.js";
import type { RoleSession } from "../../src/host/role-session-contract.js";
import { RunControl } from "../../src/host/run-control.js";
import { runStats } from "../../src/host/stats.js";

const def: MachineDefinition = {
  manifest_version: "1",
  orchestrator: "coordinator",
  workers: [],
  max_visits: {},
  end_request_roles: null,
  handoff_evidence: null,
};
function metrics(running: number): ControllerMetricsSnapshot {
  return {
    controllerId: "repository-controller",
    definitionDigest: "a".repeat(64),
    activationId: "activation",
    ownerEpoch: 1,
    coordinatorModelTurns: 0,
    latencies: [],
    idle: [],
    capacity: {
      accepted: 3,
      running,
      free: 2 - running,
      maxParallel: 2,
      remainingAllowance: 7,
      eligible: "unknown",
    },
  };
}

describe("controller status", () => {
  it("shows controller capacity and zero model turns without suggesting a default model", () => {
    const stats = {
      ...runStats([], "run", def, "running"),
      controller: metrics(1),
      activeSession: {
        role: "coordinator",
        sessionFile: "/private/audit.jsonl",
        model: null,
        effort: "off" as const,
      },
    };
    const footer = formatConductStatus(stats);
    expect(footer).toContain(
      "controller=repository-controller · native=1/2 · free=1 · model_turns=0",
    );
    expect(footer).not.toContain("model=");
    expect(footer).not.toContain("/private/");
  });

  it("reads live metrics and retains the final snapshot after the session is released", async () => {
    let snapshot = metrics(1);
    const control = new RunControl({ runId: "run", abortSession: async () => undefined });
    const session: RoleSession = {
      role: "coordinator",
      sessionId: "session",
      sessionFile: "audit.jsonl",
      model: null,
      effort: "off",
      readCaptureBuffer: () => [],
      resetCaptureBuffer: () => undefined,
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      dispose: async () => undefined,
      getControllerMetrics: () => snapshot,
    };
    await control.setActiveSession(session);
    expect(control.getControllerMetrics()?.capacity.running).toBe(1);
    snapshot = metrics(0);
    control.releaseActiveSession(session);
    snapshot = metrics(2);
    expect(control.getControllerMetrics()?.capacity.running).toBe(0);
  });

  it("omits controller stats for legacy runs", () => {
    expect(runStats([], "run", def, "running").controller).toBeUndefined();
  });
});
