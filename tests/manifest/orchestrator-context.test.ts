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

const PREWALK_WORKER = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    context_retention: run
    prewalk:
      validation_allowlist: [pnpm]
      guide: { model: stub:guide, effort: medium, max_cost_usd: 1, max_turns: 2 }
      executor: { max_turns: 2, max_wall_clock_s: 60 }
`;

const PREWALK_ORCHESTRATOR = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    context_retention: run
    prewalk:
      validation_allowlist: [pnpm]
      guide: { model: stub:guide, effort: medium, max_cost_usd: 1, max_turns: 2 }
      executor: { max_turns: 2, max_wall_clock_s: 60 }
  - name: worker
    max_visits: 2
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
    expect(errorCodes(parseManifest(PREWALK_WORKER))).toContain("context-retention-on-worker");
    const explicitWorkerNone = {
      ...manifest,
      roles: [{ ...manifest.roles[0] }, { ...manifest.roles[1], context_retention: "none" }],
    } as unknown as Manifest;
    expect(errorCodes(explicitWorkerNone)).toContain("context-retention-on-worker");
    expect(
      errorCodes({ version: 1, roles: [{ name: "orchestrator", is_orchestrator: true }] }),
    ).not.toContain("invalid-context-retention");
  });

  it("rejects retention with trajectory and on a prewalk orchestrator", () => {
    const trajectory = parseManifest(
      withOrchestratorRetention(
        `${BASE}\nhandoffs:\n  - { from: orchestrator, to: worker, mode: trajectory }\n`,
        "run",
      ),
    );
    expect(errorCodes(trajectory)).toContain("context-retention-trajectory-conflict");
    expect(errorCodes(parseManifest(PREWALK_ORCHESTRATOR))).toContain(
      "context-retention-prewalk-conflict",
    );
  });

  it("allows prewalk on a worker while retaining run on the orchestrator", () => {
    const manifest = parseManifest(
      PREWALK_WORKER.replace("    context_retention: run\n", "")
        .replace(
          "    is_orchestrator: true",
          "    is_orchestrator: true\n    context_retention: run",
        )
        .replace("    context_retention: run\n    prewalk:", "    prewalk:"),
    );
    expect(errorCodes(manifest)).not.toContain("context-retention-prewalk-conflict");
    expect(manifest.roles[0]?.context_retention).toBe("run");
  });
});
