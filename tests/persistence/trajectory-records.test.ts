import { describe, expect, it } from "vitest";

import { toMachineDefinition } from "../../src/manifest/definition.js";
import { parseManifest } from "../../src/manifest/parse.js";
import {
  createManifestSnapshot,
  type HandoffTransportSelectedRecord,
  ManifestSnapshotError,
  TrajectoryResumeError,
  validateTrajectorySelector,
  verifyManifestSnapshot,
} from "../../src/persistence/trajectory-records.js";

const manifest = parseManifest(`
version: 1
handoffs: [{ from: planner, to: orchestrator, mode: trajectory }]
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:orchestrator, effort: medium }]
    system_prompt: .pi/roles/orchestrator.md
  - name: planner
    max_visits: 1
    models: [{ model: stub:planner, effort: medium }]
    system_prompt: .pi/roles/planner.md
`);

describe("Issue #63 trajectory persistence records", () => {
  it("creates a canonical, hash-verified normalized manifest snapshot", () => {
    const snapshot = createManifestSnapshot({
      runId: "run-63",
      manifest,
      definition: toMachineDefinition(manifest),
      ts: 1,
    });
    expect(snapshot.type).toBe("manifest_snapshot");
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyManifestSnapshot(snapshot)).toEqual(snapshot);
  });

  it("rejects every missing persisted target environment field", () => {
    const selector: HandoffTransportSelectedRecord = {
      type: "handoff_transport_selected",
      schema_version: 1,
      run_id: "run-63",
      source_role_session_id: "source-role-session",
      from: "planner",
      to: "orchestrator",
      mode: "trajectory",
      source_conversation: { id: "conversation", file: "/tmp/conversation.jsonl" },
      target: {
        model: "stub:orchestrator",
        requested_effort: "medium",
        system_prompt: "TARGET",
        active_tool_names: ["handoff", "end", "ask_user"],
        environment_sha256: "a".repeat(64),
      },
      admission: {
        schema_version: 1,
        observed_context_tokens: 1,
        role_envelope_tokens: 1,
        target_max_tokens: 1,
        safety_reservation_tokens: 8192,
        required_tokens: 8195,
        target_context_window: 10000,
        target_model: "stub:orchestrator",
      },
      ts: 1,
    };
    for (const field of [
      "model",
      "requested_effort",
      "system_prompt",
      "active_tool_names",
      "environment_sha256",
    ] as const) {
      const target = { ...selector.target } as Record<string, unknown>;
      delete target[field];
      expect(() =>
        validateTrajectorySelector({
          ...selector,
          target,
        } as unknown as HandoffTransportSelectedRecord),
      ).toThrow(TrajectoryResumeError);
    }
  });

  it("rejects a corrupt manifest snapshot instead of guessing a current manifest", () => {
    const snapshot = createManifestSnapshot({
      runId: "run-63",
      manifest,
      definition: toMachineDefinition(manifest),
      ts: 1,
    });
    expect(() => verifyManifestSnapshot({ ...snapshot, sha256: "0".repeat(64) })).toThrow(
      ManifestSnapshotError,
    );
  });
});
