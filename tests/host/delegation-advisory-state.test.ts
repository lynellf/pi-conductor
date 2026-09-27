import { describe, expect, it } from "vitest";
import type {
  DelegationDispatchAdvisoryStateInput,
  DelegationResultAdvisoryStateInput,
} from "../../src/host/delegation-advisory/state.js";
import {
  buildDelegationDispatchAdvisoryState,
  buildDelegationResultAdvisoryState,
} from "../../src/host/delegation-advisory/state.js";

const usableProfiles = [
  { name: "implementer", description: "Changes code to meet the assigned objective." },
  { name: "reviewer", description: "Checks changes against the declared acceptance criteria." },
];

function dispatchInput(
  overrides: Record<string, unknown> = {},
): DelegationDispatchAdvisoryStateInput {
  return {
    task: {
      id: "private-task-id",
      objective: "Implement the bounded advisory state.",
      expected_output: "A reviewed implementation and focused tests.",
      subagent: "implementer",
      tools: ["read", "edit"],
      projection_paths: ["/private/worktree/src/a.ts", "/private/worktree/src/b.ts"],
      context_artifacts: [{ content: "private artifact body" }],
      verification_recipe: "unit-checks",
      task_text: "untrusted extra task text",
    },
    allowed_profiles: usableProfiles,
    run_id: "private-run-id",
    commit: "a".repeat(40),
    ...overrides,
  } as unknown as DelegationDispatchAdvisoryStateInput;
}

describe("buildDelegationDispatchAdvisoryState", () => {
  it("redacts and caps every outbound text field and projects path/artifact counts", async () => {
    const objective = `Inspect /home/private/repo/main.ts; api_key=do-not-send ${"x".repeat(1100)}`;
    const built = buildDelegationDispatchAdvisoryState(
      dispatchInput({
        task: {
          ...((dispatchInput().task as Record<string, unknown>) ?? {}),
          objective,
          expected_output: `Expected ${"y".repeat(1200)}`,
          projection_paths: ["/secret/a", "C:\\private\\b"],
          context_artifacts: [{ content: "artifact-secret" }, { content: "transcript-secret" }],
          tools: ["read", `tool/${"z".repeat(1100)}`],
        },
      }),
    );

    expect(built.state.task.objective).toHaveLength(1000);
    expect(built.state.task.objective).toContain("<path omitted>");
    expect(built.state.task.objective).toContain("<credential omitted>");
    expect(built.state.task.objective).not.toContain("/home/private/repo/main.ts");
    expect(built.state.task.objective).not.toContain("do-not-send");
    expect(built.state.task.expected_output).toHaveLength(1000);
    expect(built.state.task.tools[1]).toHaveLength(1000);
    expect(built.state.task.projection_path_count).toBe(2);
    expect(built.state.task.context_artifact_count).toBe(2);
    expect(JSON.stringify(built.state)).not.toContain("private-task-id");
    expect(JSON.stringify(built.state)).not.toContain("private artifact body");
    expect(JSON.stringify(built.state)).not.toContain("transcript-secret");
    expect(JSON.stringify(built.state)).not.toContain("/secret/a");
    expect(JSON.stringify(built.state)).not.toContain("a".repeat(40));
  });

  it("includes declared descriptions only when at least two allowed profiles all have descriptions", async () => {
    const built = buildDelegationDispatchAdvisoryState(dispatchInput());

    expect(built.profile_fit).toEqual({ kind: "choice" });
    expect(built.state.profiles).toEqual(usableProfiles);
    expect(JSON.stringify(built.state)).not.toContain("system_prompt");
  });

  it("records the single-profile omission and does not send its profile list", async () => {
    const built = buildDelegationDispatchAdvisoryState(
      dispatchInput({ allowed_profiles: [usableProfiles[0]] }),
    );

    expect(built.profile_fit).toEqual({ kind: "omitted", omitted: "single_profile" });
    expect(built.state).not.toHaveProperty("profiles");
  });

  it("omits profile_fit when any allowed profile lacks a description, without using system_prompt", async () => {
    const built = buildDelegationDispatchAdvisoryState(
      dispatchInput({
        allowed_profiles: [
          usableProfiles[0],
          { name: "reviewer", system_prompt: "This is not a profile-fit description." },
        ],
      }),
    );

    expect(built.profile_fit).toEqual({ kind: "omitted", omitted: "missing_descriptions" });
    expect(built.state).not.toHaveProperty("profiles");
    expect(JSON.stringify(built.state)).not.toContain("not a profile-fit description");
  });
});

describe("buildDelegationResultAdvisoryState", () => {
  it("redacts and bounds host and reported text, counts changed paths, and excludes raw paths and tool output", async () => {
    const adversarialInput = {
      task: {
        id: "private-task-id",
        objective: "Complete /home/private/task.ts safely.",
        expected_output: "Expected output without a path.",
      },
      host: {
        status: "completed",
        normalization_reason: `normalized ${"n".repeat(1100)}`,
        worktree_state: "clean",
        changed_paths: ["/private/change.ts", "C:\\private\\another.ts"],
        verification: [
          { name: "pnpm test", outcome: "passed", tool_output: "private-output" },
          { name: "/private/check.sh", outcome: "failed" },
        ],
        commit: "b".repeat(40),
      },
      reported: {
        summary: `Finished; password=reported-secret ${"s".repeat(1200)}`,
        verification_claims: ["pnpm test passed", `claim ${"c".repeat(1100)}`],
        transcript: "private transcript",
      },
      child_id: "private-child-id",
    };
    const state = buildDelegationResultAdvisoryState(
      adversarialInput as unknown as DelegationResultAdvisoryStateInput,
    );

    expect(state.task.objective).toContain("<path omitted>");
    expect(state.task.objective).not.toContain("/home/private/task.ts");
    expect(state.host.normalization_reason).toHaveLength(1000);
    expect(state.reported.summary).toHaveLength(1000);
    expect(state.reported.summary).toContain("<credential omitted>");
    expect(state.host.changed_path_count).toBe(2);
    expect(state.host.verification).toHaveLength(2);
    expect(state.host.verification[1]?.name).not.toContain("/private/check.sh");
    expect(state.reported.verification_claims[1]).toHaveLength(1000);

    const serialized = JSON.stringify(state);
    for (const prohibited of [
      "private-task-id",
      "private-child-id",
      "/private/change.ts",
      "C:\\private\\another.ts",
      "private-output",
      "private transcript",
      "tool_output",
      "commit",
      "b".repeat(40),
      "reported-secret",
    ]) {
      expect(serialized).not.toContain(prohibited);
    }
  });

  it("bounds the number of reported verification claims", async () => {
    const claims = Array.from({ length: 40 }, (_, index) => `claim ${index}`);
    const state = buildDelegationResultAdvisoryState({
      task: { objective: "Objective", expected_output: "Output" },
      host: {
        status: "failed",
        normalization_reason: "normalization",
        worktree_state: "unavailable",
        changed_paths: [],
        verification: [],
      },
      reported: { summary: "Summary", verification_claims: claims },
    });

    expect(state.reported.verification_claims).toHaveLength(16);
  });
});
