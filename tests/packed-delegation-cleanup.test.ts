import { expect, it } from "vitest";

import {
  createPackedDelegationFixture,
  disposePackedDelegationFixture,
} from "./packed-delegation-cleanup-fixture.js";
import { runProbe } from "./packed-delegation-cleanup-probe.js";
import { reconcilePackedDelegationCleanup } from "./packed-delegation-reconcile-fixture.js";

it("settles packed observation failure with explicit child terminals", () => {
  const fixture = createPackedDelegationFixture();
  try {
    const result = runProbe(fixture);
    const toolFinishes = result.records.filter(
      (record) => record.type === "tool_execution_finished",
    );
    expect(result.records.filter((record) => record.type === "subagent_started")).toHaveLength(3);
    expect(toolFinishes.filter((record) => record.tool_name === "read").length).toBeGreaterThan(0);
    expect(toolFinishes.filter((record) => record.tool_name === "ls").length).toBeGreaterThan(0);
    expect(toolFinishes.filter((record) => record.tool_name === "find").length).toBeGreaterThan(0);
    expect(result.probeError).toBeUndefined();
    expect(result.exitReason).toBe("session_failed");
    expect(result.resumeError).toContain("unknown ownership");
    expect(result.leaseReleased).toBe(true);
    const startedChildren = result.records
      .filter((record) => record.type === "subagent_started")
      .map((record) => String(record.child_id));
    for (const childId of startedChildren) {
      const terminals = result.records.filter(
        (record) =>
          ["subagent_failed", "subagent_completed"].includes(String(record.type)) &&
          record.child_id === childId,
      );
      expect(terminals).toHaveLength(1);
    }
    expect(
      result.records.filter((record) => record.type === "subagent_failed").length,
    ).toBeGreaterThan(0);
    expect(result.records.filter((record) => record.type === "session_failed")).toHaveLength(1);
    expect(result.runId).toEqual(expect.any(String));
    const reconciliation = reconcilePackedDelegationCleanup(fixture, result.runId);
    expect(reconciliation.before.unresolved.length).toBeGreaterThan(0);
    expect(reconciliation.confirmations).toHaveLength(reconciliation.before.unresolved.length);
    expect(reconciliation.after.unresolved).toHaveLength(0);
    expect(reconciliation.durableConfirmationExecutionIds).toEqual(
      reconciliation.confirmations.map((confirmation) => confirmation.executionId),
    );
  } finally {
    disposePackedDelegationFixture(fixture);
  }
}, 240_000);
