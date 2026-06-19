/**
 * Tests for the seam validator — spec §3 (boundary contract).
 *
 * Contract rules pinned here:
 *  1. Terminate by emitting exactly one machine event: `handoff` (with `target_role`)
 *     or `end`.
 *  2. Emit a payload whose shape matches the schema for that event.
 *  3. Emit nothing else to the machine (capture-buffer concern, not validated here).
 *
 * Breach reasons (§11.3):
 *  - `no_emission`     — empty capture buffer
 *  - `extra_emission`  — more than one machine event in the buffer
 *  - `schema_invalid`  — the single emission's args fail the TypeBox schema check
 *
 * The handoff/end schemas MUST also serve as the `defineTool` param schemas
 * in Phase 4 (§3 rule 2). Tests assert the schemas directly so the dual-use
 * is pinned here, not in the host.
 */

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { endArgsSchema, handoffArgsSchema } from "../../src/seam/schema.js";
import type { EmissionCapture } from "../../src/seam/validate-emission.js";
import { validateEmission } from "../../src/seam/validate-emission.js";

// ─── handoffArgsSchema shape (§5.1 + §3 rule 2) ─────────────────────────

describe("handoffArgsSchema (TypeBox)", () => {
  it("accepts a well-formed handoff args object (target_role only)", () => {
    expect(Value.Check(handoffArgsSchema, { target_role: "implementer" })).toBe(true);
  });

  it("accepts a handoff with optional reason and suggests_next", () => {
    expect(
      Value.Check(handoffArgsSchema, {
        target_role: "reviewer",
        reason: "ready for review",
        suggests_next: "reviewer",
      }),
    ).toBe(true);
  });

  it("accepts role-defined additional fields (§5.1: 'plus role-defined fields')", () => {
    expect(
      Value.Check(handoffArgsSchema, {
        target_role: "implementer",
        summary: "implemented X",
        artifacts: ["foo.ts", "bar.ts"],
      }),
    ).toBe(true);
  });

  it("rejects a handoff missing target_role", () => {
    expect(Value.Check(handoffArgsSchema, { reason: "no target" })).toBe(false);
  });

  it("rejects a handoff with a non-string target_role", () => {
    expect(Value.Check(handoffArgsSchema, { target_role: 42 })).toBe(false);
  });

  it("rejects a handoff with an empty target_role", () => {
    expect(Value.Check(handoffArgsSchema, { target_role: "" })).toBe(false);
  });

  it("rejects a handoff with a non-string optional reason", () => {
    expect(Value.Check(handoffArgsSchema, { target_role: "x", reason: 7 })).toBe(false);
  });

  it("rejects a handoff with a non-string optional suggests_next", () => {
    expect(Value.Check(handoffArgsSchema, { target_role: "x", suggests_next: true })).toBe(false);
  });

  it("rejects non-object args (string)", () => {
    expect(Value.Check(handoffArgsSchema, "implementer")).toBe(false);
  });

  it("rejects null args", () => {
    expect(Value.Check(handoffArgsSchema, null)).toBe(false);
  });
});

// ─── endArgsSchema shape ────────────────────────────────────────────────

describe("endArgsSchema (TypeBox)", () => {
  it("accepts an empty args object (end has no required fields)", () => {
    expect(Value.Check(endArgsSchema, {})).toBe(true);
  });

  it("accepts an end with optional reason", () => {
    expect(Value.Check(endArgsSchema, { reason: "all done" })).toBe(true);
  });

  it("accepts end with arbitrary additional fields (symmetry with handoff)", () => {
    expect(Value.Check(endArgsSchema, { reason: "done", final_note: "see README" })).toBe(true);
  });

  it("rejects end with a non-string reason", () => {
    expect(Value.Check(endArgsSchema, { reason: 7 })).toBe(false);
  });

  it("rejects non-object args (array)", () => {
    expect(Value.Check(endArgsSchema, [])).toBe(false);
  });
});

// ─── validateEmission: ok path (§3 contract, exactly one well-formed event) ──

describe("validateEmission: ok path", () => {
  it("accepts a single handoff emission and returns a MachineEvent", () => {
    const captures: EmissionCapture[] = [
      { toolName: "handoff", args: { target_role: "implementer" } },
    ];
    const result = validateEmission(captures);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.event.type).toBe("handoff");
    if (result.event.type !== "handoff") throw new Error("unreachable");
    expect(result.event.target_role).toBe("implementer");
    // The full validated args flow through as payload (Phase 4 uses it
    // to seed the next session; the reducer treats payload as unknown).
    expect(result.event.payload).toEqual({ target_role: "implementer" });
  });

  it("accepts a single end emission and returns a MachineEvent", () => {
    const captures: EmissionCapture[] = [
      { toolName: "end", args: { reason: "all work complete" } },
    ];
    const result = validateEmission(captures);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.event.type).toBe("end");
    if (result.event.type !== "end") throw new Error("unreachable");
    expect(result.event.payload).toEqual({ reason: "all work complete" });
  });

  it("accepts a handoff with role-defined additional fields", () => {
    const captures: EmissionCapture[] = [
      {
        toolName: "handoff",
        args: { target_role: "reviewer", summary: "implemented X", artifacts: ["a.ts"] },
      },
    ];
    const result = validateEmission(captures);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    if (result.event.type !== "handoff") throw new Error("unreachable");
    expect(result.event.payload).toMatchObject({ summary: "implemented X", artifacts: ["a.ts"] });
  });
});

// ─── validateEmission: breach reasons (§11.3) ──────────────────────────

describe("validateEmission: no_emission (empty capture buffer)", () => {
  it("returns no_emission when there are zero captures", () => {
    const result = validateEmission([]);
    expect(result).toEqual({ kind: "breach", reason: "no_emission" });
  });
});

describe("validateEmission: extra_emission (more than one machine event)", () => {
  it("returns extra_emission when there are two captures (handoff + end)", () => {
    const captures: EmissionCapture[] = [
      { toolName: "handoff", args: { target_role: "implementer" } },
      { toolName: "end", args: { reason: "actually done" } },
    ];
    const result = validateEmission(captures);
    expect(result).toEqual({ kind: "breach", reason: "extra_emission" });
  });

  it("returns extra_emission when there are two handoff captures", () => {
    const captures: EmissionCapture[] = [
      { toolName: "handoff", args: { target_role: "implementer" } },
      { toolName: "handoff", args: { target_role: "reviewer" } },
    ];
    const result = validateEmission(captures);
    expect(result).toEqual({ kind: "breach", reason: "extra_emission" });
  });
});

describe("validateEmission: schema_invalid (single emission, bad shape)", () => {
  it("returns schema_invalid when a handoff is missing target_role", () => {
    const captures: EmissionCapture[] = [
      { toolName: "handoff", args: { reason: "forgot target" } },
    ];
    const result = validateEmission(captures);
    expect(result).toEqual({ kind: "breach", reason: "schema_invalid" });
  });

  it("returns schema_invalid when a handoff has a non-string target_role", () => {
    const captures: EmissionCapture[] = [{ toolName: "handoff", args: { target_role: 42 } }];
    const result = validateEmission(captures);
    expect(result).toEqual({ kind: "breach", reason: "schema_invalid" });
  });

  it("returns schema_invalid when args is null", () => {
    const captures: EmissionCapture[] = [{ toolName: "handoff", args: null }];
    const result = validateEmission(captures);
    expect(result).toEqual({ kind: "breach", reason: "schema_invalid" });
  });

  it("returns schema_invalid when args is a primitive (not an object)", () => {
    const captures: EmissionCapture[] = [{ toolName: "handoff", args: "implementer" }];
    const result = validateEmission(captures);
    expect(result).toEqual({ kind: "breach", reason: "schema_invalid" });
  });

  it("returns schema_invalid when an end has a non-string reason", () => {
    const captures: EmissionCapture[] = [{ toolName: "end", args: { reason: 7 } }];
    const result = validateEmission(captures);
    expect(result).toEqual({ kind: "breach", reason: "schema_invalid" });
  });
});

// ─── validateEmission: precedence rules ─────────────────────────────────

describe("validateEmission: precedence", () => {
  it("extra_emission takes precedence over schema_invalid (more than one capture, even if both bad)", () => {
    const captures: EmissionCapture[] = [
      { toolName: "handoff", args: { reason: "no target" } }, // schema-invalid
      { toolName: "end", args: { reason: 7 } }, // schema-invalid
    ];
    const result = validateEmission(captures);
    expect(result).toEqual({ kind: "breach", reason: "extra_emission" });
  });

  it("extra_emission takes precedence over schema_invalid with two schema-invalid handoffs", () => {
    const captures: EmissionCapture[] = [
      { toolName: "handoff", args: null },
      { toolName: "handoff", args: "not an object" },
    ];
    const result = validateEmission(captures);
    expect(result).toEqual({ kind: "breach", reason: "extra_emission" });
  });
});
