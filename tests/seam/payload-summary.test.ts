/**
 * Tests for `summarizePayload` — spec §11.2 payload-summary enrichment.
 *
 * The reducer emits a placeholder `{ field_names: [] }`; the seam enriches
 * the `transition_accepted` record with the real structural fingerprint
 * (top-level field names) + a surfaced `reason` string (§5.1 message
 * channel) before the host persists it. The run-memory `last_message`
 * (§8.4) reads `reason` back to deliver a worker's verdict/status to the
 * next orchestrator session.
 */

import { describe, expect, it } from "vitest";
import { summarizePayload } from "../../src/seam/payload-summary.js";

describe("summarizePayload (§11.2)", () => {
  it("non-object payload → empty field_names, no reason", () => {
    expect(summarizePayload(undefined)).toEqual({ field_names: [] });
    expect(summarizePayload(null)).toEqual({ field_names: [] });
    expect(summarizePayload("not an object")).toEqual({ field_names: [] });
  });

  it("extracts top-level field names as a structural fingerprint", () => {
    const s = summarizePayload({ target_role: "implementer", reason: "go", extra: 1 });
    expect(s.field_names).toContain("target_role");
    expect(s.field_names).toContain("reason");
    expect(s.field_names).toContain("extra");
  });

  it("surfaces a string reason (§5.1 message channel)", () => {
    const s = summarizePayload({ target_role: "orchestrator", reason: "REQUEST-CHANGES: fix B1" });
    expect(s.reason).toBe("REQUEST-CHANGES: fix B1");
  });

  it("omits reason when the payload has no reason field", () => {
    const s = summarizePayload({ target_role: "orchestrator" });
    expect(s.reason).toBeUndefined();
    expect(s.field_names).toEqual(["target_role"]);
  });

  it("omits reason when reason is present but not a string", () => {
    const s = summarizePayload({ target_role: "orchestrator", reason: 42 });
    expect(s.reason).toBeUndefined();
  });

  it("does NOT extract suggests_next (the reducer surfaces it at record top-level)", () => {
    const s = summarizePayload({ target_role: "orchestrator", suggests_next: "implementer" });
    expect(s.suggests_next).toBeUndefined();
    expect(s.field_names).toContain("suggests_next");
  });

  it("an unbounded reason is preserved verbatim (no cap, §5.1)", () => {
    const long = "word ".repeat(5000).trim();
    const s = summarizePayload({ target_role: "orchestrator", reason: long });
    expect(s.reason).toBe(long);
  });
});
