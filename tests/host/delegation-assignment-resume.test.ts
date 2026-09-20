import { describe, expect, it } from "vitest";
import { loadPinnedManifest } from "../../src/host/api-pinned-manifest.js";
import { toMachineDefinition } from "../../src/manifest/definition.js";
import { parseManifest } from "../../src/manifest/parse.js";
import {
  createManifestSnapshot,
  verifyManifestSnapshot,
} from "../../src/persistence/trajectory-records.js";

function manifestWithExpectedOutput(expectedOutput: string) {
  return parseManifest(`
version: 7
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
      allowed_subagents: [reviewer]
      max_children_per_session: 1
      max_parallel: 1
      assignments:
        - name: review
          subagent: reviewer
          expected_output: ${expectedOutput}
`);
}

describe("pinned assignment manifest resume", () => {
  it("rebuilds assignment authority from the snapshot instead of current YAML", async () => {
    const pinnedManifest = manifestWithExpectedOutput("the pinned output contract");
    const snapshot = createManifestSnapshot({
      runId: "run-1",
      manifest: pinnedManifest,
      definition: toMachineDefinition(pinnedManifest),
      ts: 1,
    });

    const resumed = await loadPinnedManifest(snapshot, "/tmp/current/conductor.yaml", undefined);
    const delegation = resumed.manifest.roles[0]?.delegation;
    const assignment = delegation?.assignments?.[0];

    expect(assignment?.expected_output).toBe("the pinned output contract");
    expect(delegation?.interface).toBe("assignments_v1");
    expect(Object.isFrozen(delegation)).toBe(true);
    expect(Object.isFrozen(delegation?.assignments)).toBe(true);
    expect(Object.isFrozen(assignment)).toBe(true);

    const tampered = {
      ...snapshot,
      normalized_manifest: manifestWithExpectedOutput("current YAML output"),
    };
    expect(() => verifyManifestSnapshot(tampered)).toThrow("sha256");
  });
});
