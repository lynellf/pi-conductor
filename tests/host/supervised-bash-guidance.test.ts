import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createSupervisedTools } from "../../src/host/execution/supervised-tools.js";
import { ToolExecutionController } from "../../src/host/execution/tool-execution-controller.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";

describe("supervised bash guidance", () => {
  it("explains the pinned foreground deadline and safe recovery", () => {
    const policy = { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 417 };
    const controller = new ToolExecutionController({
      runId: "run",
      logicalSessionId: "logical",
      roleSessionId: "role",
      policy,
      persist: () => undefined,
    });
    const bash = createSupervisedTools({
      cwd: process.cwd(),
      getController: () => controller,
      getPolicy: () => policy,
      declaredTools: ["bash"],
    }).find((candidate) => candidate.name === "bash") as ToolDefinition | undefined;

    expect(bash?.description).toContain("417-second");
    expect(bash?.description).toMatch(/foreground/i);
    expect(bash?.description).toMatch(/nohup.*&.*setsid.*disown/i);
    expect(bash?.description).toMatch(/partial effects/i);
    expect(bash?.description).toMatch(/never automatically replay/i);
    expect(bash?.promptSnippet).toContain("417s");
    expect(bash?.promptGuidelines?.join(" ")).toContain("new run");
  });
});
