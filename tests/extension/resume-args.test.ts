import { describe, expect, it } from "vitest";
import { parseResumeCommandArgs } from "../../src/extension/commands/resume-args.js";

describe("resume command arguments", () => {
  it.each([
    ["run-1", { runId: "run-1", resetOrchestratorContext: false }],
    ["--reset-orchestrator-context run-1", { runId: "run-1", resetOrchestratorContext: true }],
    ["run-1 --reset-orchestrator-context", { runId: "run-1", resetOrchestratorContext: true }],
  ])("parses %s", (input, expected) => {
    expect(parseResumeCommandArgs(input)).toEqual(expected);
  });

  it.each([
    ["", "Usage"],
    ["--unknown run-1", "unknown"],
    ["--reset-orchestrator-context --reset-orchestrator-context run-1", "duplicate"],
    ["run-1 run-2", "exactly one"],
  ])("rejects %s", (input, message) => {
    expect(() => parseResumeCommandArgs(input)).toThrow(message);
  });
});
