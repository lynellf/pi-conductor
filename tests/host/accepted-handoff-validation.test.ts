/** Issue #110 seam contract — bounded, recoverable accepted-handoff capture. */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createHandoffTool, type EmissionToolDetails, SessionSeam } from "../../src/host/index.js";

type ExecuteFn = (
  toolCallId: string,
  params: unknown,
) => Promise<{
  readonly details: EmissionToolDetails;
  readonly terminate?: boolean;
}>;

function invoke(tool: ToolDefinition, params: unknown) {
  return (tool.execute as unknown as ExecuteFn)("issue-110-test", params);
}

function validHandoff(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target_role: "orchestrator",
    status: "ready",
    objective: "Dispatch the public packet.",
    summary: "The packet is ready.",
    requested_action: "dispatch-public-packet",
    ...extra,
  };
}

describe("issue #110 — accepted handoff seam validation", () => {
  it("rejects an oversized envelope without capturing or sealing, then accepts a correction", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam);

    const oversized = await invoke(tool, validHandoff({ private_detail: "x".repeat(70_000) }));

    expect(oversized.details).toMatchObject({
      ok: false,
      reason: "handoff_envelope_too_large",
    });
    expect(oversized.terminate).toBe(false);
    expect(seam.read()).toEqual([]);
    expect(seam.isSealed).toBe(false);
    expect(seam.takeHandoffValidationFailures()).toMatchObject([
      {
        missingFields: [],
        invalidFields: [],
        transportError: "handoff_envelope_too_large",
      },
    ]);

    const corrected = await invoke(tool, validHandoff());
    expect(corrected.details).toMatchObject({ ok: true, target_role: "orchestrator" });
    expect(corrected.terminate).toBe(true);
    expect(seam.read()).toHaveLength(1);
    expect(seam.isSealed).toBe(true);
  });

  it("snapshots nested payload values before capture and sealing", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam);
    const publicDispatch = {
      path: "/example/dispatch.json",
      sha256: "a".repeat(64),
    };
    const payload = validHandoff({ public_dispatch: publicDispatch });

    await invoke(tool, payload);
    publicDispatch.path = "/mutated-after-capture.json";
    publicDispatch.sha256 = "b".repeat(64);

    expect(seam.read()[0]).toMatchObject({
      toolName: "handoff",
      args: {
        public_dispatch: {
          path: "/example/dispatch.json",
          sha256: "a".repeat(64),
        },
      },
    });
  });

  it("reports non-JSON transport failure as correctable telemetry without touching the seam", async () => {
    const seam = new SessionSeam();
    const tool = createHandoffTool(seam);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const result = await invoke(tool, validHandoff({ cyclic }));

    expect(result.details).toMatchObject({
      ok: false,
      reason: "handoff_envelope_not_json",
    });
    expect(result.terminate).toBe(false);
    expect(seam.read()).toEqual([]);
    expect(seam.isSealed).toBe(false);
    expect(seam.takeHandoffValidationFailures()).toMatchObject([
      {
        missingFields: [],
        invalidFields: [],
        transportError: "handoff_envelope_not_json",
        actualUtf8Bytes: null,
      },
    ]);
  });
});
