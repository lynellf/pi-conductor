import { describe, expect, it } from "vitest";

import { projectControllerRecord } from "../../src/host/controller/raw-controller-projection.js";

describe("Issue #116 private controller dispatch projection", () => {
  it("preserves native terminal summaries for legacy definitions without output policies", () => {
    const terminal = { type: "subagent_completed", summary: "packet received" };
    expect(projectControllerRecord(terminal, { config: { adapters: [] } })).toEqual(terminal);
  });

  it.each([
    { config: { adapters: [], child_outputs: [] } },
    { config: { adapters: [{ output_consumers: [] }] } },
    { config: { adapters: [{ source_consumers: [] }] } },
    { config: { adapters: [{ result_consumers: [] }] } },
    { config: { adapters: [{ effect_id: "delivery" }] } },
    { config: { adapters: [] }, effects: [] },
    {},
  ])("redacts child summaries whenever private policies exist or definition is unknown: %j", (definition) => {
    expect(
      projectControllerRecord({ type: "subagent_completed", summary: "private" }, definition),
    ).toEqual({ type: "subagent_completed" });
  });

  it("removes private child transcript, verification, failure, context, prompt, and capture metadata", () => {
    const projected = projectControllerRecord({
      type: "subagent_completed",
      run_id: "run",
      child_id: "child",
      task_id: "task",
      subagent: "reviewer",
      summary: "private-canary-summary",
      verification: "private-canary-verification",
      failure_reason: "private-canary-failure",
      completion_evidence: { blocker_reason: "private-canary-nested" },
      context_artifacts: [{ ref: "artifact/v1/private" }],
      prompt: "private-canary-prompt",
      worktree_path: "/private/worktree",
      session_file: "/private/session.jsonl",
      changed_paths: ["/private/host/path"],
      output_capture: { bytes: "private-canary-bytes" },
      status: "completed",
    });

    expect(JSON.stringify(projected)).not.toContain("private-canary");
    expect(projected).toMatchObject({ type: "subagent_completed", status: "completed" });
  });

  it("leaves non-child records intact", () => {
    expect(
      projectControllerRecord({
        type: "controller_action_receipt",
        result_refs: ["artifact/v1/x"],
      }),
    ).toEqual({
      type: "controller_action_receipt",
      result_refs: ["artifact/v1/x"],
    });
  });

  it("does not expose pending effect journal records through record references", () => {
    expect(
      projectControllerRecord({
        type: "controller_effect_intent",
        request: { credential_path: "/private/credential", evidence: ["private-canary"] },
      }),
    ).toBeUndefined();
  });
});
