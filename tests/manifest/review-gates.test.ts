/** Manifest-level review gate contract tests (issue #124). */

import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/manifest/parse.js";
import { validateManifest } from "../../src/manifest/validate.js";

const roles = `
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: implementer
    max_visits: 3
  - name: reviewer
    max_visits: 3
`;

describe("manifest review gates", () => {
  it("parses a stable phase/gate contract", () => {
    const manifest = parseManifest(`
version: 1
review_gates:
  - id: implementation-review
    phase_id: implementation
    reviewer_role: reviewer
    phase_owner_role: implementer
    next_phase: integration
    repair_guidance: Fix the failing checks and rerun the gate.
${roles}`);

    expect(manifest.review_gates).toEqual([
      {
        id: "implementation-review",
        phase_id: "implementation",
        reviewer_role: "reviewer",
        phase_owner_role: "implementer",
        next_phase: "integration",
        repair_guidance: "Fix the failing checks and rerun the gate.",
      },
    ]);
    expect(validateManifest(manifest).errors).toEqual([]);
  });

  it("rejects duplicate phases and orchestrator review roles", () => {
    const manifest = parseManifest(`
version: 1
review_gates:
  - id: first
    phase_id: implementation
    reviewer_role: orchestrator
    phase_owner_role: implementer
    next_phase: integration
  - id: second
    phase_id: implementation
    reviewer_role: reviewer
    phase_owner_role: orchestrator
    next_phase: integration
${roles}`);

    expect(validateManifest(manifest).errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["review-gate-duplicate-phase", "review-gate-reviewer-orchestrator"]),
    );
  });

  it("rejects unknown gate keys at the structural boundary", () => {
    expect(() =>
      parseManifest(`
version: 1
review_gates:
  - id: gate
    phase_id: implementation
    reviewer_role: reviewer
    phase_owner_role: implementer
    next_phase: integration
    route: owner
${roles}`),
    ).toThrow(/unknown key 'route'/);
  });
});
