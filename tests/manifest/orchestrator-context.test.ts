import { describe, expect, it } from "vitest";

import { parseManifest } from "../../src/manifest/parse.js";
import { type Manifest, ManifestParseError } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

const BASE = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:orchestrator, effort: medium }]
    system_prompt: orchestrator.md
  - name: worker
    max_visits: 2
    models: [{ model: stub:worker, effort: medium }]
    system_prompt: worker.md
`;

const WORKER_RETENTION = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    context_retention: run
`;

function withOrchestratorRetention(source: string, value: string): string {
  return source.replace(
    "    system_prompt: orchestrator.md",
    `    system_prompt: orchestrator.md\n    context_retention: ${value}`,
  );
}

function errorCodes(manifest: Manifest): readonly string[] {
  return validateManifest(manifest).errors.map((error) => error.code);
}

describe("Issue #87 orchestrator context retention manifest contract", () => {
  it("normalizes omitted and explicit fresh-run policy to pinned none", () => {
    expect(parseManifest(BASE).roles[0]?.context_retention).toBe("none");
    expect(parseManifest(withOrchestratorRetention(BASE, "none")).roles[0]?.context_retention).toBe(
      "none",
    );
    expect(parseManifest(BASE).roles[1]?.context_retention).toBeUndefined();
  });

  it("parses run retention only as a role policy", () => {
    const manifest = parseManifest(withOrchestratorRetention(BASE, "run"));
    expect(manifest.roles[0]?.context_retention).toBe("run");
    expect(manifest.roles[1]?.context_retention).toBeUndefined();
  });

  it.each(["snapshot", "null", "true"])("rejects invalid parser value %s", (value) => {
    expect(() => parseManifest(withOrchestratorRetention(BASE, value))).toThrow(ManifestParseError);
  });

  it("rejects programmatic null and run retention on a worker", () => {
    const manifest = parseManifest(BASE);
    const nullPolicy = {
      ...manifest,
      roles: [{ ...manifest.roles[0], context_retention: null }, manifest.roles[1]],
    } as unknown as Manifest;
    expect(errorCodes(nullPolicy)).toContain("invalid-context-retention");
    expect(errorCodes(parseManifest(WORKER_RETENTION))).toContain("context-retention-on-worker");
    const parsedWorkerNone = parseManifest(
      WORKER_RETENTION.replace("context_retention: run", "context_retention: none"),
    );
    expect(errorCodes(parsedWorkerNone)).toContain("context-retention-on-worker");
    const explicitWorkerNone = {
      ...manifest,
      roles: [{ ...manifest.roles[0] }, { ...manifest.roles[1], context_retention: "none" }],
    } as unknown as Manifest;
    expect(errorCodes(explicitWorkerNone)).toContain("context-retention-on-worker");
    expect(
      errorCodes({ version: 1, roles: [{ name: "orchestrator", is_orchestrator: true }] }),
    ).not.toContain("invalid-context-retention");
  });

  it("rejects retention with trajectory", () => {
    const trajectory = parseManifest(
      withOrchestratorRetention(
        `${BASE}\nhandoffs:\n  - { from: orchestrator, to: worker, mode: trajectory }\n`,
        "run",
      ),
    );
    expect(errorCodes(trajectory)).toContain("context-retention-trajectory-conflict");
  });

  it("rejects a trajectory policy even when its edge is worker-to-worker", () => {
    const manifest = parseManifest(
      withOrchestratorRetention(
        BASE.replace(
          "version: 1",
          "version: 1\nhandoffs:\n  - { from: worker, to: worker-two, mode: trajectory }",
        ).replace(
          "    system_prompt: worker.md",
          "    system_prompt: worker.md\n  - name: worker-two\n    max_visits: 2",
        ),
        "run",
      ),
    );
    expect(errorCodes(manifest)).toContain("context-retention-trajectory-conflict");
  });
});
