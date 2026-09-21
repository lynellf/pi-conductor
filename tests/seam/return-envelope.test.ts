/**
 * Issue #137 Phase 1 — return-envelope contract + durable reason carry.
 *
 * The worker→orchestrator return transport carries a *supported* narrative
 * whose primary field is `reason`. The host-facing return envelope:
 *
 *   - Documents supported narrative fields: `reason` (primary),
 *     `summary`, `verification`.
 *   - Records any other top-level field (e.g. `phase`, `tdd_stage`,
 *     `changed_paths`, `red_*`, `green_*`) in a stable, explicitly
 *     reported ignored list — never silently displaces `reason`.
 *   - Surfaces a stable diagnostic name per ignored field so a role can
 *     self-correct without having to discover the contract by failure.
 *
 * The envelope is additive on top of the existing v2 control-arguments
 * sanitization (which already extracts `summary`/`reason`/`verification`).
 * It exists as a separately documented contract so the worker return
 * surface is visible without re-reading the host control sanitization.
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { returnEnvelopeArgsSchema as publicReturnEnvelopeArgsSchema } from "../../src/index.js";
import {
  parseReturnEnvelope,
  RETURN_ENVELOPE_DIAGNOSTIC_PREFIX,
  type ReturnEnvelope,
  returnEnvelopeArgsSchema,
} from "../../src/seam/control-arguments.js";

describe("returnEnvelopeArgsSchema (issue #137)", () => {
  it("is exported through the public barrel", () => {
    expect(publicReturnEnvelopeArgsSchema).toBe(returnEnvelopeArgsSchema);
  });

  it("accepts an object with only a primary reason", () => {
    expect(Value.Check(returnEnvelopeArgsSchema, { reason: "go" })).toBe(true);
  });

  it("accepts an object with the full supported narrative", () => {
    expect(
      Value.Check(returnEnvelopeArgsSchema, {
        reason: "go",
        summary: "done",
        verification: ["pnpm typecheck", "pnpm lint"],
      }),
    ).toBe(true);
  });

  it("accepts an empty object (no supported fields)", () => {
    expect(Value.Check(returnEnvelopeArgsSchema, {})).toBe(true);
  });

  it("permits custom non-supported fields for the ignored list (additionalProperties true)", () => {
    expect(
      Value.Check(returnEnvelopeArgsSchema, {
        reason: "go",
        phase: "Phase 1",
        tdd_stage: "red",
        changed_paths: ["src/seam/schema.ts"],
        red_command: "pnpm exec vitest run tests/seam/return-envelope.test.ts",
        green_command: "pnpm exec vitest run --shard=1/4",
      }),
    ).toBe(true);
  });
});

// ─── Supported fields — primary reason is never dropped ────────────────

describe("parseReturnEnvelope: supported narrative fields", () => {
  it("surfaces a non-empty reason (primary)", () => {
    const envelope = parseReturnEnvelope({ reason: "phase 1 GREEN: tests pass" });
    expect(envelope.supported.reason).toBe("phase 1 GREEN: tests pass");
    expect(envelope.supported.summary).toBeUndefined();
    expect(envelope.supported.verification).toBeUndefined();
  });

  it("surfaces summary and verification alongside reason", () => {
    const envelope = parseReturnEnvelope({
      reason: "go",
      summary: "Implemented Phase 1 with the seam contract.",
      verification: ["pnpm typecheck", "pnpm lint"],
    });
    expect(envelope.supported).toEqual({
      reason: "go",
      summary: "Implemented Phase 1 with the seam contract.",
      verification: ["pnpm typecheck", "pnpm lint"],
    });
  });

  it("trims whitespace before accepting the reason", () => {
    const envelope = parseReturnEnvelope({ reason: "  trimmed reason  " });
    expect(envelope.supported.reason).toBe("trimmed reason");
  });

  it("ignores an empty reason (treated as absent)", () => {
    const envelope = parseReturnEnvelope({ reason: "   " });
    expect(envelope.supported.reason).toBeUndefined();
    expect(envelope.ignored.map((entry) => entry.name)).toContain("reason");
  });

  it("ignores a non-string reason with a stable diagnostic", () => {
    const envelope = parseReturnEnvelope({ reason: 42 });
    expect(envelope.supported.reason).toBeUndefined();
    const diagnostic = envelope.ignored.find((entry) => entry.name === "reason")?.diagnostic;
    expect(diagnostic).toBeDefined();
    expect(diagnostic).toMatch(new RegExp(`^${RETURN_ENVELOPE_DIAGNOSTIC_PREFIX}`));
  });
});

// ─── Ignored fields — stable diagnostic name per ignored field ─────────

describe("parseReturnEnvelope: ignored fields with stable diagnostics", () => {
  it("records each custom field with a stable diagnostic name", () => {
    const envelope = parseReturnEnvelope({
      reason: "go",
      phase: "Phase 1",
      tdd_stage: "red",
      changed_paths: ["src/seam/schema.ts"],
    });
    const names = envelope.ignored.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["phase", "tdd_stage", "changed_paths"]));

    for (const entry of envelope.ignored) {
      expect(entry.diagnostic).toMatch(new RegExp(`^${RETURN_ENVELOPE_DIAGNOSTIC_PREFIX}`));
      // diagnostic carries the field name verbatim so a role can self-correct
      expect(entry.diagnostic).toContain(entry.name);
    }
  });

  it("does NOT add supported fields to the ignored list", () => {
    const envelope = parseReturnEnvelope({
      reason: "go",
      summary: "done",
      verification: ["passed"],
    });
    expect(envelope.ignored.map((entry) => entry.name)).not.toContain("reason");
    expect(envelope.ignored.map((entry) => entry.name)).not.toContain("summary");
    expect(envelope.ignored.map((entry) => entry.name)).not.toContain("verification");
  });

  it("returns an empty ignored list when only supported fields are supplied", () => {
    const envelope = parseReturnEnvelope({ reason: "go" });
    expect(envelope.ignored).toEqual([]);
  });

  it("the diagnostic name is stable for the same input (idempotent parse)", () => {
    const first = parseReturnEnvelope({ reason: "go", phase: "Phase 1" });
    const second = parseReturnEnvelope({ reason: "go", phase: "Phase 1" });
    expect(first.ignored).toEqual(second.ignored);
  });

  it("the diagnostic name for an unknown field is prefix:fieldname", () => {
    const envelope = parseReturnEnvelope({
      reason: "go",
      completely_unknown_field: "value",
    });
    const entry = envelope.ignored.find((e) => e.name === "completely_unknown_field");
    expect(entry?.diagnostic).toBe(`${RETURN_ENVELOPE_DIAGNOSTIC_PREFIX}completely_unknown_field`);
  });

  it("escapes control characters in ignored field diagnostics", () => {
    const envelope = parseReturnEnvelope({ reason: "go", "phase\ninjected": "value" });
    const entry = envelope.ignored.find((item) => item.name === "phase\\ninjected");
    expect(entry?.diagnostic).toBe("ignored_return_field:phase\\ninjected");
    expect(entry?.diagnostic).not.toContain("\n");
  });
});

// ─── Reason precedence — supported reason never silently displaced ─────

describe("parseReturnEnvelope: supported reason is never silently displaced", () => {
  it("keeps the supported reason when an ignored field of the same name shadow is impossible (different names)", () => {
    const envelope = parseReturnEnvelope({
      reason: "actual reason",
      phase: "Phase 1",
      tdd_stage: "green",
      changed_paths: ["src/seam/schema.ts"],
    });
    expect(envelope.supported.reason).toBe("actual reason");
  });

  it("ignores red_/green_ command fields and still surfaces the supported reason", () => {
    const envelope = parseReturnEnvelope({
      reason: "Phase 1 GREEN: tests pass",
      red_command: "pnpm exec vitest run tests/seam/return-envelope.test.ts",
      green_command: "pnpm exec vitest run tests/seam/return-envelope.test.ts",
    });
    expect(envelope.supported.reason).toBe("Phase 1 GREEN: tests pass");
    const names = envelope.ignored.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["red_command", "green_command"]));
  });

  it("returns a frozen object so callers cannot mutate the parsed envelope", () => {
    const envelope: ReturnEnvelope = parseReturnEnvelope({ reason: "go" });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.supported)).toBe(true);
    expect(Object.isFrozen(envelope.ignored)).toBe(true);
  });
});

// ─── Non-object inputs ─────────────────────────────────────────────────

describe("parseReturnEnvelope: invalid input", () => {
  it("returns an empty envelope for non-object input", () => {
    expect(parseReturnEnvelope(null)).toEqual({
      supported: {},
      ignored: [],
    });
    expect(parseReturnEnvelope("not an object")).toEqual({
      supported: {},
      ignored: [],
    });
    expect(parseReturnEnvelope(42)).toEqual({
      supported: {},
      ignored: [],
    });
  });

  it("returns an empty envelope for an array (not a valid return envelope object)", () => {
    expect(parseReturnEnvelope(["reason", "go"])).toEqual({
      supported: {},
      ignored: [],
    });
  });
});
