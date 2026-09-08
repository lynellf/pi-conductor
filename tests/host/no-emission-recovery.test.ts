/** Issue #73: bounded in-session recovery — spec §11.3, §11.4, §12.1. */
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { StubHost } from "../../src/host/index.js";
import { runLoop } from "../../src/host/loop.js";
import type { StubStep } from "../../src/host/stub-provider.js";
import {
  createInitialCheckpoint,
  InMemoryRecordLog,
  type MachineDefinition,
} from "../../src/index.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

function fixture(steps: readonly StubStep[]) {
  // Distinguish instant stub responses for the host's usage deduplication key.
  let timestamp = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => ++timestamp);
  onTestFinished(() => clock.mockRestore());
  const def = {
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: ["worker"],
    max_visits: { worker: 3 },
    end_request_roles: null,
  } as MachineDefinition;
  const initialCheckpoint = createInitialCheckpoint(def);
  const log = new InMemoryRecordLog();
  const host = new StubHost({
    runId: initialCheckpoint.run_id,
    log,
    steps,
    // Empty completions consume cache reads despite producing no output.
    usage: {
      input: 0,
      output: 0,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0.001, cacheWrite: 0, total: 0.001 },
    },
    agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-no-emission-"),
  });
  return {
    run: () => runLoop({ def, initialCheckpoint, host, initialGoal: "Finish the run." }),
    records: () => log.records(initialCheckpoint.run_id),
  };
}

describe("Issue #73 — three no-emission recovery prompts per invocation", () => {
  it.each([
    2, 3,
  ])("recovers after %i consecutive empty completions in the same session", async (emptyCount) => {
    const { run, records } = fixture([
      ...Array.from({ length: emptyCount }, (): StubStep => ({ kind: "no_emission" })),
      { kind: "emit_end", reason: "Completed after transient empty responses." },
    ]);

    expect(await run()).toMatchObject({
      exitReason: "done",
      finalCheckpoint: { current_role: "done", active_role_session: null },
    });
    expect(records().filter((record) => record.type === "session_started")).toHaveLength(1);
    expect(records().filter((record) => record.type === "session_failed")).toEqual([]);
    expect(records().find((record) => record.type === "session_ended")).toMatchObject({
      usage: { tokens: (emptyCount + 1) * 10 },
    });
  });

  it("stops after three recovery prompts and records the recovery count and all consumed usage", async () => {
    const { run, records } = fixture([
      { kind: "no_emission" },
      { kind: "no_emission" },
      { kind: "no_emission" },
      { kind: "no_emission" },
      // An unbounded or off-by-one retry would incorrectly reach this end.
      { kind: "emit_end", reason: "This exceeds the recovery budget." },
    ]);

    expect(await run()).toMatchObject({
      exitReason: "session_failed",
      finalCheckpoint: { current_role: "orchestrator", active_role_session: null },
    });
    expect(records().filter((record) => record.type === "session_failed")).toMatchObject([
      {
        failure_reason: "no_emission",
        failure_detail: expect.stringMatching(/3 recovery prompts/),
        usage: { tokens: 40, cache_read: 40, output: 0, cost: 0.004 },
      },
    ]);
    expect(
      records().filter(
        (record) => record.type === "transition_accepted" || record.type === "transition_rejected",
      ),
    ).toEqual([]);
  });

  it("gives each new role invocation its own recovery budget", async () => {
    const { run, records } = fixture([
      { kind: "no_emission" },
      { kind: "no_emission" },
      { kind: "no_emission" },
      { kind: "emit_handoff", target_role: "worker", reason: "Complete the work." },
      { kind: "no_emission" },
      { kind: "no_emission" },
      { kind: "no_emission" },
      { kind: "emit_handoff", target_role: "orchestrator", reason: "Work complete." },
      { kind: "no_emission" },
      { kind: "no_emission" },
      { kind: "no_emission" },
      { kind: "emit_end", reason: "Finished." },
    ]);

    expect(await run()).toMatchObject({ exitReason: "done" });
    expect(records().filter((record) => record.type === "session_failed")).toEqual([]);
    expect(records().filter((record) => record.type === "session_ended")).toHaveLength(3);
  });
});
