import { describe, expect, it } from "vitest";
import { toMachineDefinition } from "../../src/manifest/definition.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import { parseManifest } from "../../src/manifest/parse.js";
import { pinExecutionPolicies } from "../../src/manifest/pin-execution-policy.js";
import {
  createManifestSnapshot,
  verifyManifestSnapshot,
} from "../../src/persistence/trajectory-records.js";

const YAML = `
version: 1
handoffs:
  - from: orchestrator
    to: worker
    mode: fresh
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: worker
    max_visits: 2
    tools: [handoff, end]
    tool_execution:
      timeout_seconds: 42
subagents:
  - name: helper
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/helper.md
`;

describe("pinExecutionPolicies", () => {
  it("copies every role and profile with resolved immutable defaults", () => {
    const manifest = parseManifest(YAML);
    const pinned = pinExecutionPolicies(manifest);

    expect(manifest.roles[0]?.tool_execution).toBeUndefined();
    expect(manifest.subagents?.[0]?.tool_execution).toBeUndefined();
    expect(pinned.roles[0]?.tool_execution).toEqual(DEFAULT_TOOL_EXECUTION_POLICY);
    expect(pinned.roles[1]?.tool_execution).toEqual({
      timeout_seconds: 42,
      max_recoverable_timeouts: 2,
      termination_grace_seconds: 2,
    });
    expect(pinned.subagents?.[0]?.tool_execution).toEqual(DEFAULT_TOOL_EXECUTION_POLICY);
    expect(pinned).not.toBe(manifest);
    expect(pinned.roles).not.toBe(manifest.roles);
    expect(pinned.subagents).not.toBe(manifest.subagents);
    expect(Object.isFrozen(pinned)).toBe(true);
    expect(Object.isFrozen(pinned.roles)).toBe(true);
    expect(Object.isFrozen(pinned.roles[0])).toBe(true);
    expect(Object.isFrozen(pinned.roles[0]?.tool_execution)).toBe(true);
  });

  it("round-trips resolved defaults through the durable manifest snapshot", () => {
    const pinned = pinExecutionPolicies(parseManifest(YAML));
    const snapshot = createManifestSnapshot({
      runId: "run-pin",
      manifest: pinned,
      definition: toMachineDefinition(pinned),
      ts: 1,
    });

    expect(snapshot.normalized_manifest.roles[0]?.tool_execution).toEqual(
      DEFAULT_TOOL_EXECUTION_POLICY,
    );
    expect(snapshot.normalized_manifest.subagents?.[0]?.tool_execution).toEqual(
      DEFAULT_TOOL_EXECUTION_POLICY,
    );
    expect(verifyManifestSnapshot(snapshot)).toBe(snapshot);
  });
});
