import { describe, expect, it } from "vitest";

import { toMachineDefinition } from "../../src/manifest/definition.js";
import { parseManifest } from "../../src/manifest/parse.js";
import {
  createManifestSnapshot,
  ManifestSnapshotError,
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
    const snapshot = createManifestSnapshot({ runId: "run-63", manifest, definition: toMachineDefinition(manifest), ts: 1 });
    expect(snapshot.type).toBe("manifest_snapshot");
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyManifestSnapshot(snapshot)).toEqual(snapshot);
  });

  it("rejects a corrupt manifest snapshot instead of guessing a current manifest", () => {
    const snapshot = createManifestSnapshot({ runId: "run-63", manifest, definition: toMachineDefinition(manifest), ts: 1 });
    expect(() => verifyManifestSnapshot({ ...snapshot, sha256: "0".repeat(64) })).toThrow(ManifestSnapshotError);
  });
});
