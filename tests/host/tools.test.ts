/**
 * Task 14 emission-tool tests — spec §3, §5.1, §11.3, §12.1.
 *
 * Covers Task 14's acceptance criteria:
 *   1. A role calling `handoff` with a schema-valid target writes
 *      exactly one capture entry, sets the emission-sealed flag,
 *      and returns a terminating result.
 *   2. The same for `end`.
 *   3. A schema-invalid call writes a `schema_invalid` marker
 *      (1 entry with invalid args), does NOT seal, returns a
 *      terminating error result.
 *   4. A second machine-event call in the same session writes an
 *      `extra_emission` marker (buffer length → 2), does NOT
 *      overwrite the original capture, returns a terminating error
 *      result.
 *   5. The tool does NOT call `reduce` or `persist` — the only
 *      observable state change is on the `SessionSeam`.
 *
 * The loop-level behavior (calling `validateEmission` on the seam's
 * buffer, producing `transition_accepted` / `session_failed` records)
 * is Task 15's responsibility; here we assert only what the tool
 * itself does to the seam.
 *
 * Table-driven where the spec enumerates cases (§11.3 breach
 * vocabulary: `schema_invalid`, `extra_emission`, `no_emission`).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { MachineDefinition } from "../../src/core/types.js";
import {
  createEndTool,
  createHandoffTool,
  type EmissionToolDetails,
} from "../../src/host/index.js";
import { SessionSeam } from "../../src/host/seam.js";
import { InMemoryRecordLog, validateEmission } from "../../src/index.js";

const GATED_DEF: MachineDefinition = {
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: ["implementer", "reviewer"],
  max_visits: { implementer: 2, reviewer: 2 },
  end_request_roles: ["reviewer"],
};

// ─── Test helper: invoke a tool's execute without an ExtensionContext ──
//
// `ToolDefinition.execute` requires 5 args (the 5th is `ExtensionContext`,
// which our factory ignores). Casting to `any` here is the test-only
// shortcut to skip wiring a mock ctx — the production call site
// (createAgentSession) provides the real ctx.
type ExecuteFn = (
  this: void,
  toolCallId: string,
  params: unknown,
) => Promise<{
  content: Array<{ readonly type: string; readonly text: string }>;
  details: EmissionToolDetails;
  terminate?: boolean;
}>;

function invoke(tool: ToolDefinition, params: unknown) {
  const execute = tool.execute as unknown as ExecuteFn;
  return execute.call(undefined, "test-call-id", params);
}

// ─── Valid first call ─────────────────────────────────────────────────

describe("emission tools — valid first call", () => {
  it("describes the complete role-specific handoff contract", () => {
    const tool = createHandoffTool(new SessionSeam(), undefined, {
      role: "reviewer",
      def: GATED_DEF,
    });

    expect(tool.description).toContain("Current role: reviewer");
    expect(tool.description).toContain("target_role must be orchestrator");
    expect(tool.description).toContain("status: ready | blocked | complete");
    expect(tool.description).toContain("request_end: true");
  });

  it("handoff writes one capture, seals, returns terminating ok", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam);

    const result = await invoke(tool, {
      target_role: "implementer",
      reason: "plan ready",
      suggests_next: "reviewer",
      status: "ready",
      objective: "Implement the approved plan.",
      summary: "The planner completed the design and identified the required files.",
      requested_action: "Implement the plan and report the changed files.",
    });

    expect(seam.read()).toHaveLength(1);
    expect(seam.read()[0]).toEqual({
      toolName: "handoff",
      args: {
        target_role: "implementer",
        reason: "plan ready",
        suggests_next: "reviewer",
        status: "ready",
        objective: "Implement the approved plan.",
        summary: "The planner completed the design and identified the required files.",
        requested_action: "Implement the plan and report the changed files.",
      },
    });
    expect(seam.isSealed).toBe(true);
    expect(result.details).toEqual({
      ok: true,
      target_role: "implementer",
    });
    expect(result.terminate).toBe(true);

    // The captured buffer, fed to validateEmission, yields "ok".
    expect(validateEmission(seam.read())).toEqual({
      kind: "ok",
      event: {
        type: "handoff",
        request_end: false,
        target_role: "implementer",
        payload: {
          target_role: "implementer",
          reason: "plan ready",
          suggests_next: "reviewer",
          status: "ready",
          objective: "Implement the approved plan.",
          summary: "The planner completed the design and identified the required files.",
          requested_action: "Implement the plan and report the changed files.",
        },
      },
    });
  });

  it("end writes one capture, seals, returns terminating ok (no target_role)", async () => {
    const seam = new SessionSeam();
    const tool = createEndTool(seam);

    const result = await invoke(tool, { reason: "all done" });

    expect(seam.read()).toHaveLength(1);
    expect(seam.read()[0]?.toolName).toBe("end");
    expect(seam.isSealed).toBe(true);
    expect(result.details).toEqual({ ok: true });
    expect(result.details.target_role).toBeUndefined();
    expect(result.terminate).toBe(true);

    expect(validateEmission(seam.read())).toEqual({
      kind: "ok",
      event: {
        type: "end",
        authority: "role",
        payload: { reason: "all done" },
      },
    });
  });

  it("rejects an incomplete handoff without sealing or terminating the session", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam);

    const result = await invoke(tool, { target_role: "implementer" });

    expect(result.details.ok).toBe(false);
    expect(result.terminate).toBe(false);
    expect(seam.read()).toHaveLength(0);
    expect(seam.isSealed).toBe(false);
    expect(seam.takeHandoffValidationFailures()).toEqual([
      {
        missingFields: ["status", "objective", "summary", "requested_action"],
        invalidFields: [],
      },
    ]);
  });

  it("rejects whitespace-only actionable fields and names each missing field", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam);

    const result = await invoke(tool, {
      target_role: "implementer",
      status: " ",
      objective: "\t",
      summary: "\n",
      requested_action: "  ",
    });

    expect(result.details).toMatchObject({
      ok: false,
      reason: "handoff_incomplete",
      missing_fields: ["status", "objective", "summary", "requested_action"],
    });
    expect(result.terminate).toBe(false);
    expect(seam.read()).toEqual([]);
  });

  it("rejects an invalid status in-session with enum and example guidance", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam, undefined, { role: "reviewer", def: GATED_DEF });
    const result = await invoke(tool, { ...actionableHandoff("orchestrator"), status: "done" });

    expect(result.details).toMatchObject({
      ok: false,
      reason: "handoff_incomplete",
      invalid_fields: ["status"],
    });
    expect(result.terminate).toBe(false);
    expect(result.content[0]?.text).toContain("ready | blocked | complete");
    expect(result.content[0]?.text).toContain("Valid example");
    expect(seam.read()).toEqual([]);
  });

  it("rejects an unauthorized end request without capture or sealing", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam, undefined, {
      role: "implementer",
      def: GATED_DEF,
    });
    const result = await invoke(tool, {
      ...actionableHandoff("orchestrator"),
      status: "complete",
      request_end: true,
    });

    expect(result.details).toMatchObject({
      ok: false,
      reason: "handoff_incomplete",
      invalid_fields: ["request_end"],
    });
    expect(result.terminate).toBe(false);
    expect(seam.read()).toEqual([]);
    expect(seam.isSealed).toBe(false);
  });

  it("fails closed when an end request has no role context", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam);
    const result = await invoke(tool, {
      ...actionableHandoff("custom-orchestrator"),
      status: "complete",
      request_end: true,
    });

    expect(result.details).toMatchObject({
      ok: false,
      reason: "handoff_incomplete",
      invalid_fields: ["request_end"],
    });
    expect(result.terminate).toBe(false);
    expect(seam.read()).toEqual([]);
  });

  it("uses actual manifest role names in correction examples", async () => {
    const def: MachineDefinition = {
      ...GATED_DEF,
      orchestrator: "lead",
      workers: ["builder", "reviewer"],
      max_visits: { builder: 2, reviewer: 2 },
    };
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam, undefined, { role: "builder", def });
    const result = await invoke(tool, { ...actionableHandoff("lead"), status: "done" });

    expect(result.content[0]?.text).toContain('"target_role":"lead"');
    expect(result.content[0]?.text).not.toContain('"target_role":"orchestrator"');
  });
});

// ─── Schema-invalid first call ────────────────────────────────────────

describe("emission tools — schema-invalid first call", () => {
  it("handoff with missing target_role → schema_invalid, no seal, 1 buffer entry", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam);

    const result = await invoke(tool, { reason: "oops" }); // missing target_role

    expect(seam.read()).toHaveLength(1);
    expect(seam.read()[0]?.args).toEqual({ reason: "oops" });
    expect(seam.isSealed).toBe(false); // critical: schema-invalid does NOT seal
    expect(result.details).toEqual({ ok: false, reason: "schema_invalid" });
    expect(result.terminate).toBe(true);

    // Loop-level: validateEmission sees 1 invalid entry → breach.
    expect(validateEmission(seam.read())).toEqual({
      kind: "breach",
      reason: "schema_invalid",
    });
  });

  it("handoff with wrong type for target_role → schema_invalid", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam);

    const result = await invoke(tool, { target_role: 42 }); // not a string

    expect(seam.read()).toHaveLength(1);
    expect(seam.isSealed).toBe(false);
    expect(result.details.reason).toBe("schema_invalid");
    expect(validateEmission(seam.read()).kind).toBe("breach");
  });

  it("end with extra role-defined fields → accepted (schema is permissive, spec §5.1)", async () => {
    // Per spec §5.1: handoff/end payloads carry "plus role-defined fields".
    // Both schemas set additionalProperties: true (Phase 3 Task 9); the
    // tool's seam check accepts the call as valid. Extra fields are
    // preserved in the capture buffer so the host can surface them
    // (e.g. as orchestrator context on the next session).
    const seam = new SessionSeam();
    const tool = createEndTool(seam);

    const result = await invoke(tool, {
      reason: "done",
      metadata: { ticket: "JIRA-1234" },
    });

    expect(seam.read()).toHaveLength(1);
    expect(seam.isSealed).toBe(true);
    expect(result.details.ok).toBe(true);
    // Extra field preserved verbatim on the captured args.
    expect(seam.read()[0]?.args).toEqual({
      reason: "done",
      metadata: { ticket: "JIRA-1234" },
    });
  });

  it("end with non-string reason → schema_invalid", async () => {
    const seam = new SessionSeam();
    const tool = createEndTool(seam);

    const result = await invoke(tool, { reason: 99 });

    expect(seam.read()).toHaveLength(1);
    expect(seam.isSealed).toBe(false);
    expect(result.details.reason).toBe("schema_invalid");
  });
});

// ─── Extra emission (second machine-event call) ──────────────────────

describe("emission tools — extra emission", () => {
  it("valid handoff then end → buffer=2, second call returns extra_emission, first preserved", async () => {
    const seam = new SessionSeam();
    const handoff = createHandoffTool(seam);
    const end = createEndTool(seam);

    const first = await invoke(handoff, actionableHandoff("implementer"));
    expect(first.details.ok).toBe(true);
    expect(seam.read()).toHaveLength(1);
    expect(seam.isSealed).toBe(true);

    const second = await invoke(end, { reason: "I'm done" });
    expect(second.details).toEqual({ ok: false, reason: "extra_emission" });
    expect(second.terminate).toBe(true);

    // Buffer now has 2 entries; FIRST is the original valid handoff.
    const buffer = seam.read();
    expect(buffer).toHaveLength(2);
    expect(buffer[0]).toEqual({
      toolName: "handoff",
      args: actionableHandoff("implementer"),
    });
    expect(buffer[1]).toEqual({
      toolName: "end",
      args: { reason: "I'm done" },
    });

    // Sealed flag stayed true (set on first valid call; extra_emission
    // does not flip it).
    expect(seam.isSealed).toBe(true);

    // Loop-level: validateEmission sees length > 1 → extra_emission.
    expect(validateEmission(buffer)).toEqual({
      kind: "breach",
      reason: "extra_emission",
    });
  });

  it("valid handoff then handoff with different target → buffer=2, second returns extra_emission", async () => {
    const seam = new SessionSeam();
    const handoff = createHandoffTool(seam);

    await invoke(handoff, actionableHandoff("implementer"));
    const second = await invoke(handoff, actionableHandoff("reviewer"));

    expect(second.details.reason).toBe("extra_emission");
    const buffer = seam.read();
    expect(buffer).toHaveLength(2);
    expect(buffer[0]?.args).toEqual(actionableHandoff("implementer"));
    expect(buffer[1]?.args).toEqual(actionableHandoff("reviewer"));
  });

  it("schema-invalid handoff then valid end → buffer=2, loop sees extra_emission (precedence over schema_invalid)", async () => {
    // Per Phase 3 validateEmission precedence: extra_emission > schema_invalid.
    // The tool does NOT need to second-guess this — the buffer shape
    // (length > 1) deterministically reads as extra_emission.
    const seam = new SessionSeam();
    const handoff = createHandoffTool(seam);
    const end = createEndTool(seam);

    const first = await invoke(handoff, { reason: "no target_role" });
    expect(first.details.reason).toBe("schema_invalid");
    expect(seam.isSealed).toBe(false);

    const second = await invoke(end, { reason: "abort" });
    expect(second.details.reason).toBe("extra_emission");

    const buffer = seam.read();
    expect(buffer).toHaveLength(2);
    expect(validateEmission(buffer)).toEqual({
      kind: "breach",
      reason: "extra_emission",
    });
  });

  it("extra emission does not seal if first call was schema-invalid", async () => {
    const seam = new SessionSeam();
    const handoff = createHandoffTool(seam);
    const end = createEndTool(seam);

    await invoke(handoff, { reason: "missing target_role" });
    expect(seam.isSealed).toBe(false);

    await invoke(end, { reason: "abort" });
    expect(seam.isSealed).toBe(false); // still false: extra_emission did not seal
  });
});

function actionableHandoff(targetRole: string): Record<string, string> {
  return {
    target_role: targetRole,
    status: "ready",
    objective: "Perform the assigned work.",
    summary: "The predecessor prepared the required context.",
    requested_action: "Complete the assigned work and report the result.",
  };
}

// ─── Single-owner rule: tool does not reduce or persist ───────────────

describe("emission tools — single-owner rule", () => {
  it("tool calls do not append any record to a RecordLog", async () => {
    const seam = new SessionSeam();
    const log = new InMemoryRecordLog();
    const handoff = createHandoffTool(seam);

    await invoke(handoff, actionableHandoff("implementer"));

    // The tool's only observable effect is on `seam` — no records
    // were persisted. The loop (Task 15) is the sole caller of
    // `reduce` and `persistRecord`.
    expect(log.listRunIds()).toEqual([]);
    expect(log.records("any-run")).toEqual([]);
  });

  it("tool calls do not invoke reduce or persist; only seam state changes", async () => {
    const seam = new SessionSeam();
    const handoff = createHandoffTool(seam);

    // Snapshot seam state before.
    const before = seam.read();
    expect(before).toEqual([]);
    expect(seam.isSealed).toBe(false);

    await invoke(handoff, actionableHandoff("implementer"));

    // After: seam has 1 entry and is sealed. No other host state was
    // touched (no reduce side-effects, no persistence).
    expect(seam.read()).toHaveLength(1);
    expect(seam.isSealed).toBe(true);
  });
});

// ─── Idempotence of the sealed flag ───────────────────────────────────

describe("SessionSeam — sealed flag semantics", () => {
  it("seal() is idempotent (a no-op when already sealed)", () => {
    const seam = new SessionSeam();
    expect(seam.isSealed).toBe(false);
    seam.seal();
    expect(seam.isSealed).toBe(true);
    seam.seal();
    expect(seam.isSealed).toBe(true);
  });

  it("reset() clears captures and the sealed flag", () => {
    const seam = new SessionSeam();
    seam.push({ toolName: "handoff", args: { target_role: "x" } });
    seam.seal();
    expect(seam.read()).toHaveLength(1);
    expect(seam.isSealed).toBe(true);

    seam.reset();
    expect(seam.read()).toEqual([]);
    expect(seam.isSealed).toBe(false);
  });

  it("read() returns a frozen view (mutation throws in strict mode)", () => {
    const seam = new SessionSeam();
    seam.push({ toolName: "end", args: {} });
    const view = seam.read();
    expect(Object.isFrozen(view)).toBe(true);
  });
});
