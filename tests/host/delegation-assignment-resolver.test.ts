import { describe, expect, it } from "vitest";

import {
  DelegationAssignmentResolutionError,
  resolveDelegationAssignment,
} from "../../src/host/delegation/assignment-resolver.js";
import { parseManifest } from "../../src/manifest/parse.js";

const source = parseManifest(`
version: 2
subagents:
  - name: reviewer
    models: [stub:reviewer]
    max_session_cost_usd: 1
    system_prompt: reviewer.md
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end, delegate_task, delegation_control]
    delegation:
      interface: assignments_v1
      mode: nonblocking
      allowed_subagents: [reviewer]
      max_children_per_session: 2
      max_parallel: 1
      assignments:
        - name: p1-review
          subagent: reviewer
          expected_output: A focused review patch.
          projection_paths: [src/manifest/validate.ts]
          tools: [read]
          verification_recipe: focused-check
`);
const policy = source.roles[0]?.delegation;
const profiles = source.subagents ?? [];
if (policy === undefined) throw new Error("missing resolver policy fixture");

describe("assignment resolver", () => {
  it("maps one model brief to one pinned internal task and trusted mode", () => {
    const resolved = resolveDelegationAssignment(
      { assignment: "p1-review", brief: "Fix the validation defects." },
      policy,
      profiles,
    );

    expect(resolved).toEqual({
      mode: "nonblocking",
      tasks: [
        {
          id: "p1-review",
          subagent: "reviewer",
          objective: "Fix the validation defects.",
          expected_output: "A focused review patch.",
          projection_paths: ["src/manifest/validate.ts"],
          tools: ["read"],
          verification_recipe: "focused-check",
        },
      ],
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.tasks)).toBe(true);
    expect(Object.isFrozen(resolved.tasks[0])).toBe(true);
  });

  it.each([
    ["unknown assignment", { assignment: "missing", brief: "Do the work." }, "unknown_assignment"],
    ["empty brief", { assignment: "p1-review", brief: "   " }, "invalid_brief"],
    [
      "non-object arguments",
      null as unknown as { assignment: string; brief: string },
      "invalid_assignment",
    ],
  ] as const)("rejects %s before producing a task", (_label, args, code) => {
    try {
      resolveDelegationAssignment(args, policy, profiles);
      throw new Error("expected resolver failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DelegationAssignmentResolutionError);
      expect((error as DelegationAssignmentResolutionError).code).toBe(code);
    }
  });

  it("rejects a policy that cannot authorize the selected assignment profile", () => {
    expect(() =>
      resolveDelegationAssignment(
        { assignment: "p1-review", brief: "Do the work." },
        { ...policy, allowed_subagents: [] },
        profiles,
      ),
    ).toThrow("not allowed");
  });
});
