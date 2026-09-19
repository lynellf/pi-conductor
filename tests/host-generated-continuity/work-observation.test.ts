import { describe, expect, it } from "vitest";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { materializeWorkObservations } from "../../src/persistence/work-observation.js";
import { renderWorkObservationSeed } from "../../src/persistence/work-observation-seed.js";

const runId = "run-v2";

function transition(
  role: string,
  sessionFile: string,
  to: string,
  ts: number,
  control: NonNullable<
    Extract<PersistedRecord, { type: "transition_accepted" }>["accepted_control"]
  >,
): Extract<PersistedRecord, { type: "transition_accepted" }> {
  return {
    type: "transition_accepted",
    run_id: runId,
    from: role,
    to,
    event: "handoff",
    target_role: to,
    request_end: false,
    end_authority: null,
    end_requested_by: null,
    role,
    suggests_next: null,
    payload_summary: { field_names: [] },
    guard: null,
    effect: [],
    session_file: sessionFile,
    accepted_control: control,
    ts,
  };
}

function control(direction: "dispatch" | "return", recipientRole: string) {
  return {
    schema_version: 2 as const,
    direction,
    recipient_role: recipientRole,
    task: {
      host_directive:
        direction === "dispatch"
          ? `Perform the work assigned to role ${recipientRole} in service of the run goal.`
          : "Assess the returned work against the run goal and choose the next legal action.",
      ...(direction === "dispatch" ? { reported_objective: "inspect the service" } : {}),
    },
    reported_hints: { summary: "bounded summary" },
    ignored_hint_fields: [],
    utf8_bytes: 200,
  };
}

describe("host-generated v2 work observations", () => {
  it("reconstructs dispatches and returns with host evidence in append order", () => {
    const records: PersistedRecord[] = [
      {
        type: "session_started",
        run_id: runId,
        role: "orchestrator",
        visit_index: 1,
        state: "orchestrator",
        model: "model-a",
        session_file: "orch-session",
        parent_session: null,
        ts: 1,
      },
      {
        type: "file_mutation",
        run_id: runId,
        role: "orchestrator",
        session_id: "orch-session",
        session_file: "orch-session",
        tool_name: "write",
        files: [{ path: "src/service.ts" }],
        ts: 2,
      },
      transition("orchestrator", "orch-session", "worker", 3, control("dispatch", "worker")),
      {
        type: "session_started",
        run_id: runId,
        role: "worker",
        visit_index: 1,
        state: "worker",
        model: "model-b",
        session_file: "worker-session",
        parent_session: "orch-session",
        ts: 4,
      },
      transition("worker", "worker-session", "orchestrator", 5, control("return", "orchestrator")),
    ];

    const observations = materializeWorkObservations(records, runId);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      source: "dispatch",
      provenance: { role: "orchestrator", visit: 1 },
      observed: { terminal: "dispatched", changed_paths: ["src/service.ts"] },
    });
    expect(observations[1]).toMatchObject({
      source: "role_return",
      provenance: { role: "worker", visit: 1 },
      observed: { terminal: "returned_control" },
    });
  });

  it("renders newest-first historical context deterministically", () => {
    const records: PersistedRecord[] = [
      transition("orchestrator", "orch-session", "worker", 1, control("dispatch", "worker")),
      transition("worker", "worker-session", "orchestrator", 2, control("return", "orchestrator")),
    ];
    const observations = materializeWorkObservations(records, runId);
    const args = {
      runGoal: "ship the service",
      recipientRole: "orchestrator",
      task: control("return", "orchestrator").task,
      observations,
      maxBytes: 32_768,
      maxObservations: 64,
    };
    const first = renderWorkObservationSeed(args);
    const second = renderWorkObservationSeed(args);
    expect(first).toEqual(second);
    expect(first.direct_observation?.source_kind).toBe("role_return");
    expect(first.historical_observations[0]?.source_kind).toBe("dispatch");
    expect(first.rendered).toContain("host directive");
    expect(first.rendered).toContain("historical observation");
  });

  it("omits absolute paths from host-observed changed-path projections", () => {
    const records: PersistedRecord[] = [
      {
        type: "session_started",
        run_id: runId,
        visit_index: 1,
        state: "orchestrator",
        role: "orchestrator",
        model: "model-a",
        session_file: "orch-session",
        parent_session: null,
        ts: 1,
      },
      {
        type: "file_mutation",
        run_id: runId,
        role: "orchestrator",
        session_id: "orch-session",
        session_file: "orch-session",
        tool_name: "write",
        files: [{ path: "C:/private/secret.txt" }],
        ts: 2,
      },
      transition("orchestrator", "orch-session", "worker", 3, control("dispatch", "worker")),
    ];
    const [observation] = materializeWorkObservations(records, runId);
    expect(observation?.observed.changed_paths).toEqual(["<path omitted>"]);
  });

  it("keeps child terminal outcome host-derived", () => {
    const record: PersistedRecord = {
      type: "subagent_completed",
      run_id: runId,
      child_id: "child-1",
      task_id: "task-1",
      subagent: "implementer",
      model: "model-c",
      status: "completed",
      summary: "legacy summary must not become v2 authority",
      branch: "child-branch",
      worktree_path: "/tmp/child",
      base_commit: "base",
      head_commit: "head",
      session_file: "child-session",
      usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, tokens: 2, cost: 0 },
      terminal_observation: { outcome: "returned", workspace_state: "clean" },
      ts: 1,
    };
    const [observation] = materializeWorkObservations([record], runId);
    expect(observation?.observed.terminal).toBe("returned");
    expect(observation?.observed.workspace_state).toBe("clean");
  });
});
