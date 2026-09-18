/** Durable resume policy selection tests — durable-continuity spec §5, §11. */

import { describe, expect, it } from "vitest";

import { latestManifestSnapshot } from "../../src/host/api-resume-state.js";
import { toMachineDefinition } from "../../src/manifest/definition.js";
import { parseManifest } from "../../src/manifest/parse.js";
import {
  createManifestSnapshot,
  ManifestSnapshotError,
} from "../../src/persistence/trajectory-records.js";

const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:orchestrator, effort: medium }]
  - name: implementer
    max_visits: 1
    models: [{ model: stub:implementer, effort: medium }]
`);

function snapshot(ts: number) {
  return createManifestSnapshot({
    runId: "run-policy",
    manifest,
    definition: toMachineDefinition(manifest),
    ts,
  });
}

describe("latestManifestSnapshot", () => {
  it("rejects duplicate pinned snapshots instead of selecting the last one", () => {
    expect(() => latestManifestSnapshot([snapshot(1), snapshot(2)], "run-policy")).toThrow(
      ManifestSnapshotError,
    );
  });

  it("does not skip a malformed earlier snapshot", () => {
    const malformed = { ...snapshot(1), manifest_hash: "0".repeat(64) };
    expect(() => latestManifestSnapshot([malformed, snapshot(2)], "run-policy")).toThrow(
      ManifestSnapshotError,
    );
  });
});
