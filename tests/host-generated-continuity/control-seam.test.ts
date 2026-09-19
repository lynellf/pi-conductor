import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { MachineDefinition } from "../../src/core/types.js";
import { SessionSeam } from "../../src/host/seam.js";
import { createEndTool, createHandoffTool } from "../../src/host/tools.js";
import {
  DEFAULT_HOST_CONTINUITY_POLICY,
  isHostGeneratedContinuityPolicy,
  normalizeContinuityPolicyForNewRun,
} from "../../src/manifest/continuity.js";
import { parseManifest } from "../../src/manifest/parse.js";
import {
  RAW_CONTROL_ARGUMENT_MAX_UTF8_BYTES,
  readRawControlArguments,
  sanitizeReportedHintsV2,
} from "../../src/seam/control-arguments.js";
import {
  endArgsSchema,
  orchestratorHandoffArgsSchema,
  reportResultArgsSchema,
  workerHandoffArgsSchema,
} from "../../src/seam/schema.js";
import { validateEmission } from "../../src/seam/validate-emission.js";

describe("host-generated continuity policy", () => {
  it("normalizes absent policy to the pinned v2 defaults", () => {
    expect(normalizeContinuityPolicyForNewRun(undefined)).toEqual(DEFAULT_HOST_CONTINUITY_POLICY);
    expect(isHostGeneratedContinuityPolicy(DEFAULT_HOST_CONTINUITY_POLICY)).toBe(true);
  });

  it("parses an explicit v2 policy", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [test:model]
  - name: worker
    max_visits: 1
    models: [test:model]
continuity:
  schema_version: 2
  seed_max_utf8_bytes: 65536
  max_observations: 128
`);

    expect(manifest.continuity).toEqual({
      schema_version: 2,
      seed_max_utf8_bytes: 65536,
      max_observations: 128,
    });
  });
});

describe("role-aware v2 control schemas", () => {
  it("requires only the orchestrator target", () => {
    expect(Value.Check(orchestratorHandoffArgsSchema, { target_role: "worker" })).toBe(true);
    expect(Value.Check(orchestratorHandoffArgsSchema, {})).toBe(false);
    expect(Value.Check(orchestratorHandoffArgsSchema, { target_role: "worker", summary: 7 })).toBe(
      true,
    );
  });

  it("accepts empty worker, end, and child-result objects", () => {
    expect(Value.Check(workerHandoffArgsSchema, {})).toBe(true);
    expect(Value.Check(endArgsSchema, {})).toBe(true);
    expect(Value.Check(reportResultArgsSchema, {})).toBe(true);
  });
});

describe("v2 tool promotion", () => {
  const def: MachineDefinition = {
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: ["worker"],
    max_visits: { worker: 2 },
    end_request_roles: [],
  };

  it("lets a worker return with empty arguments and derives the hub target", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam, undefined, { role: "worker", def, protocol: "v2" });
    const result = await (tool.execute as never as (id: string, args: unknown) => Promise<unknown>)(
      "call",
      { target_role: "worker", status: 7 },
    );
    expect((result as { readonly terminate?: boolean }).terminate).toBe(true);
    expect(
      validateEmission(seam.read(), { protocol: "v2-worker", workerTargetRole: "orchestrator" }),
    ).toMatchObject({
      kind: "ok",
      event: { target_role: "orchestrator", request_end: false },
    });
  });

  it("keeps a missing orchestrator target correctable in-session", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam, undefined, { role: "orchestrator", def, protocol: "v2" });
    const result = await (tool.execute as never as (id: string, args: unknown) => Promise<unknown>)(
      "call",
      {},
    );
    expect((result as { readonly terminate?: boolean }).terminate).toBe(false);
    expect(seam.read()).toEqual([]);
  });

  it("accepts malformed optional end prose without making it a schema breach", async () => {
    const seam = new SessionSeam();
    const tool = createEndTool(seam, undefined, "v2");
    await (tool.execute as never as (id: string, args: unknown) => Promise<unknown>)("call", {
      reason: 7,
    });
    expect(validateEmission(seam.read(), { protocol: "v2" })).toMatchObject({ kind: "ok" });
  });
});

describe("raw control argument boundary", () => {
  it("rejects non-JSON values before hint extraction", () => {
    const result = readRawControlArguments({ summary: BigInt(1) });
    expect(result).toEqual({ kind: "rejected", reason: "tool_arguments_not_json" });
  });

  it("rejects an oversized compact JSON object before diagnostics", () => {
    const result = readRawControlArguments({ summary: "x".repeat(70_000) });
    expect(result).toEqual({ kind: "rejected", reason: "tool_arguments_too_large" });
  });

  it("measures compact UTF-8 JSON and sanitizes only bounded hints", () => {
    const result = readRawControlArguments({
      objective: "  do the work  ",
      summary: "  résumé  ",
      verification: ["  passed  ", 7],
      unknown: "ignored",
    });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.utf8_bytes).toBe(new TextEncoder().encode(result.json).byteLength);
    expect(result.utf8_bytes).toBeLessThanOrEqual(RAW_CONTROL_ARGUMENT_MAX_UTF8_BYTES);

    expect(sanitizeReportedHintsV2(result.value)).toEqual({
      hints: { summary: "résumé", verification: ["passed"] },
      task_context: { objective: "do the work" },
      ignored_fields: ["verification", "unknown"],
    });
  });
});
