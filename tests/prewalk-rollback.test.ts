import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/manifest/parse.js";
import { validateManifest } from "../src/manifest/validate.js";
import { assertPersistedRecordGuarantees } from "../src/persistence/record-materialization.js";

// The rollback must never reinterpret a Prewalk run as an ordinary run.
describe("Prewalk rollback (issue #94)", () => {
  it.each(["{}", "null", "false"])("rejects a manifest carrying prewalk: %s", (value) => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: planner
    is_orchestrator: true
    prewalk: ${value}
`),
    ).toThrow(/prewalk is unavailable/);
  });

  it("rejects programmatic and pinned role configurations carrying Prewalk", () => {
    const role = { name: "planner", is_orchestrator: true, prewalk: {} };
    expect(validateManifest({ version: 1, roles: [role] }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "prewalk-unavailable" })]),
    );
  });

  it("rejects persisted Prewalk records instead of ignoring recovery state", () => {
    expect(() => assertPersistedRecordGuarantees({ type: "prewalk_switch_selected" })).toThrow(
      /Prewalk run records cannot be resumed/,
    );
  });
});
