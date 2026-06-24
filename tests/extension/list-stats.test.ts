/**
 * Issue #2 — `computeListedExitReason` table-driven tests.
 *
 * Pins the exit-reason computation mirroring
 * `RunHandle.computeExitReason` for the `/conduct:list` path.
 * The `aborted` branch is unreachable here (in-process flag only);
 * the helper produces only `done`, `session_failed`, or `running`.
 */

import { describe, expect, it } from "vitest";

import {
  computeListedExitReason,
  type ListedExitReason,
} from "../../src/extension/commands/list-stats.js";
import type { Checkpoint, PersistedRecord } from "../../src/index.js";

/** Build a minimal `Checkpoint` with just the fields the helper reads. */
function ck(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    run_id: "run-1",
    manifest_version: "1",
    current_role: "orchestrator",
    visit_count: {},
    active_role_session: null,
    updated_at: 0,
    ...overrides,
  };
}

/** Build a minimal `session_failed` record. */
function sessionFailed(overrides: Partial<PersistedRecord> = {}): PersistedRecord {
  return {
    type: "session_failed",
    run_id: "run-1",
    role: "worker",
    session_file: "stub",
    ts: 1,
    ...overrides,
  } as PersistedRecord;
}

/** Build a minimal `transition_accepted` record. */
function transitionAccepted(overrides: Partial<PersistedRecord> = {}): PersistedRecord {
  return {
    type: "transition_accepted",
    run_id: "run-1",
    from: "orchestrator",
    to: "worker",
    event: "handoff",
    target_role: "worker",
    role: "orchestrator",
    suggests_next: null,
    payload_summary: { field_names: [] },
    guard: null,
    effect: [],
    session_file: "stub",
    ts: 1,
    ...overrides,
  } as PersistedRecord;
}

describe("computeListedExitReason", () => {
  // ─── Scenario A: fresh run, no transitions, active orchestrator ───

  it("returns 'running' for a fresh run with only an orchestrator checkpoint", () => {
    const reason = computeListedExitReason([], ck({ current_role: "orchestrator" }));
    expect(reason).toBe<ListedExitReason>("running");
  });

  it("returns 'running' when the latest checkpoint is null (no snapshot yet)", () => {
    const reason = computeListedExitReason([transitionAccepted()], null);
    expect(reason).toBe<ListedExitReason>("running");
  });

  // ─── Scenario B: terminal run — checkpoint says done ───

  it("returns 'done' when the latest checkpoint has current_role === 'done'", () => {
    const reason = computeListedExitReason(
      [transitionAccepted({ from: "orchestrator", to: "done", event: "end", target_role: null })],
      ck({ current_role: "done" }),
    );
    expect(reason).toBe<ListedExitReason>("done");
  });

  // ─── Scenario C: crash mid-prompt — orchestrator checkpoint, no session_failed ───

  it("returns 'running' when the last record is not session_failed (mid-prompt crash)", () => {
    const reason = computeListedExitReason(
      [transitionAccepted()],
      ck({ current_role: "orchestrator" }),
    );
    expect(reason).toBe<ListedExitReason>("running");
  });

  // ─── Scenario D: in-flight contract-breach — worker checkpoint + session_failed ───

  it("returns 'session_failed' when the last record is session_failed and checkpoint is not done", () => {
    const reason = computeListedExitReason(
      [transitionAccepted(), sessionFailed()],
      ck({ current_role: "worker" }),
    );
    expect(reason).toBe<ListedExitReason>("session_failed");
  });

  it("returns 'session_failed' even when the only record is session_failed", () => {
    const reason = computeListedExitReason([sessionFailed()], ck({ current_role: "worker" }));
    expect(reason).toBe<ListedExitReason>("session_failed");
  });

  // ─── Scenario E: done precedence over trailing session_failed ───

  it("returns 'done' when checkpoint is done even if a session_failed record trails", () => {
    const reason = computeListedExitReason(
      [transitionAccepted(), sessionFailed()],
      ck({ current_role: "done" }),
    );
    expect(reason).toBe<ListedExitReason>("done");
  });
});
