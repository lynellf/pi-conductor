import { expect, it } from "vitest";

import {
  createPackedDelegationFixture,
  disposePackedDelegationFixture,
} from "./packed-delegation-cleanup-fixture.js";
import { runProbe } from "./packed-delegation-cleanup-probe.js";

it("runs packed delegated file tools to completion without observation failure", () => {
  const fixture = createPackedDelegationFixture();
  try {
    const result = runProbe(fixture, false);
    expect(result.probeError).toBeUndefined();
    expect(result.exitReason).toBe("done");
    expect(result.records.filter((record) => record.type === "subagent_completed")).toHaveLength(3);
    const starts = result.records.filter((record) => record.type === "tool_execution_started");
    const finishes = result.records.filter((record) => record.type === "tool_execution_finished");
    expect(starts).toHaveLength(9);
    expect(finishes).toHaveLength(9);
    const finishedIds = new Set(finishes.map((record) => record.execution_id));
    expect(starts.every((record) => finishedIds.has(record.execution_id))).toBe(true);
  } finally {
    disposePackedDelegationFixture(fixture);
  }
}, 240_000);
