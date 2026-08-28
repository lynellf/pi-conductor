import { describe, expect, it } from "vitest";

import { modeFor } from "../../src/manifest/handoffs.js";
import { parseManifest } from "../../src/manifest/parse.js";
import { ManifestParseError } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

const VALID = `
version: 1
handoffs:
  - from: planner
    to: orchestrator
    mode: trajectory
  - from: orchestrator
    to: implementer
    mode: fresh
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:orchestrator, effort: medium }]
    system_prompt: .pi/roles/orchestrator.md
  - name: planner
    max_visits: 1
    models: [{ model: stub:planner, effort: medium }]
    system_prompt: .pi/roles/planner.md
  - name: implementer
    max_visits: 1
    models: [{ model: stub:implementer, effort: high }]
    system_prompt: .pi/roles/implementer.md
`;

describe("Issue #63 manifest handoff policies", () => {
  it("defaults absent and undeclared policies to fresh", () => {
    expect(modeFor(parseManifest(VALID).handoffs, "planner", "orchestrator")).toBe("trajectory");
    expect(modeFor(parseManifest(VALID).handoffs, "implementer", "orchestrator")).toBe("fresh");
    expect(modeFor(parseManifest("version: 1\nroles: []").handoffs, "a", "b")).toBe("fresh");
  });

  it("parses frozen explicit policies", () => {
    const handoffs = parseManifest(VALID).handoffs;
    expect(handoffs).toEqual([
      { from: "planner", to: "orchestrator", mode: "trajectory" },
      { from: "orchestrator", to: "implementer", mode: "fresh" },
    ]);
    expect(Object.isFrozen(handoffs)).toBe(true);
  });

  it.each([
    ["not a sequence", "handoffs: planner", "handoffs"],
    ["not a mapping", "handoffs: [planner]", "handoffs[0]"],
    ["missing mode", "handoffs: [{ from: planner, to: orchestrator }]", "mode"],
    ["invalid mode", "handoffs: [{ from: planner, to: orchestrator, mode: automatic }]", "mode"],
    [
      "unknown key",
      "handoffs: [{ from: planner, to: orchestrator, mode: fresh, extra: no }]",
      "unknown key",
    ],
  ])("rejects malformed policy syntax: %s", (_name, handoffs, expected) => {
    expect(() => parseManifest(`version: 1\n${handoffs}\nroles: []`)).toThrow(ManifestParseError);
    expect(() => parseManifest(`version: 1\n${handoffs}\nroles: []`)).toThrow(expected);
  });

  it.each([
    [
      "undeclared endpoints",
      `[{ from: ghost, to: phantom, mode: fresh }]`,
      ["handoff-policy-from-undeclared", "handoff-policy-to-undeclared"],
    ],
    [
      "duplicate directed edge",
      `[{ from: planner, to: orchestrator, mode: fresh }, { from: planner, to: orchestrator, mode: trajectory }]`,
      ["handoff-policy-duplicate-edge"],
    ],
    ["self edge", `[{ from: planner, to: planner, mode: fresh }]`, ["handoff-policy-self-edge"]],
    [
      "worker to worker edge",
      `[{ from: planner, to: implementer, mode: fresh }]`,
      ["handoff-policy-illegal-edge"],
    ],
    [
      "trajectory isolated workspace",
      `[{ from: planner, to: orchestrator, mode: trajectory }]`,
      ["trajectory-workspace-unsupported"],
    ],
    [
      "trajectory delegation tool",
      `[{ from: planner, to: orchestrator, mode: trajectory }]`,
      ["trajectory-custom-tool-unsupported"],
    ],
    [
      "trajectory target without model",
      `[{ from: planner, to: orchestrator, mode: trajectory }]`,
      ["trajectory-target-model-unresolved"],
    ],
    [
      "trajectory target without prompt",
      `[{ from: planner, to: orchestrator, mode: trajectory }]`,
      ["trajectory-target-system-prompt-unresolved"],
    ],
  ] as const)("reports exact static policy errors: %s", (_name, handoffs, expected) => {
    let yaml = VALID.replace(/handoffs:[\s\S]*?roles:/, `handoffs: ${handoffs}\nroles:`);
    if (_name === "trajectory isolated workspace")
      yaml = yaml.replace(
        "name: planner\n    max_visits",
        "name: planner\n    workspace: { backend: worktree }\n    max_visits",
      );
    if (_name === "trajectory delegation tool")
      yaml = yaml.replace(
        "system_prompt: .pi/roles/planner.md",
        "system_prompt: .pi/roles/planner.md\n    tools: [delegate]\n    delegation: { allowed_subagents: [child], max_children_per_session: 1, max_parallel: 1 }",
      );
    if (_name === "trajectory target without model")
      yaml = yaml.replace("    models: [{ model: stub:orchestrator, effort: medium }]\n", "");
    if (_name === "trajectory target without prompt")
      yaml = yaml.replace("    system_prompt: .pi/roles/orchestrator.md\n", "");
    expect(validateManifest(parseManifest(yaml)).errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([...expected]),
    );
  });
});
