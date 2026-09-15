import { describe, expect, it } from "vitest";
import {
  formatHostRejection,
  type HostRejection,
  normalizeHostRejection,
} from "../../src/host/host-rejection.js";
import { SessionSeam } from "../../src/host/seam.js";
import { createEndTool, createHandoffTool } from "../../src/host/tools.js";

type ToolResult = {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly details: Record<string, unknown>;
  readonly terminate?: boolean;
};

async function invoke(tool: unknown, signal?: AbortSignal): Promise<ToolResult> {
  const execute = (tool as { execute: (...args: unknown[]) => Promise<ToolResult> }).execute;
  return execute("call", {}, signal, undefined, undefined);
}

describe("issue #112 host-driven emission rejection", () => {
  it("returns a concrete model_error and diagnostic without writing capture", async () => {
    const seam = new SessionSeam();
    const tool = createEndTool(seam, () => ({
      cause: "model_error",
      diagnostic: "provider failed",
    }));

    const result = await invoke(tool);

    expect(result.details).toEqual({
      ok: false,
      reason: "host_terminated",
      cause: "model_error",
      diagnostic: "provider failed",
    });
    expect(result.content[0]?.text).toContain("model_error");
    expect(result.content[0]?.text).toContain("Stop retrying this invocation");
    expect(seam.read()).toEqual([]);
  });

  it("prefers a specific cap cause when the abort signal is also set", async () => {
    const seam = new SessionSeam();
    const controller = new AbortController();
    controller.abort();
    const tool = createHandoffTool(seam, () => ({ cause: "session_cost_cap_exceeded" }));

    const result = await invoke(tool, controller.signal);

    expect(result.details).toMatchObject({
      reason: "host_terminated",
      cause: "session_cost_cap_exceeded",
    });
    expect(seam.read()).toEqual([]);
  });

  it("uses aborted for a generic abort signal", async () => {
    const seam = new SessionSeam();
    const controller = new AbortController();
    controller.abort();

    const result = await invoke(createEndTool(seam), controller.signal);

    expect(result.details).toMatchObject({ reason: "host_terminated", cause: "aborted" });
    expect(seam.read()).toEqual([]);
  });

  it("keeps legacy boolean rejection callbacks working", async () => {
    const seam = new SessionSeam();

    const result = await invoke(createEndTool(seam, () => true));

    expect(result.details).toMatchObject({ reason: "host_terminated", cause: "host_terminated" });
    expect(seam.read()).toEqual([]);
  });

  it("bounds and sanitizes diagnostics for terminal output", () => {
    const rejection: HostRejection = {
      cause: "model_error",
      diagnostic: `bad\u0000\u001b[31m${"x".repeat(5000)}`,
    };

    const normalized = normalizeHostRejection(rejection);
    const result = formatHostRejection("handoff", rejection);

    expect(normalized.diagnostic).toBeDefined();
    expect(normalized.diagnostic).not.toMatch(/\p{Cc}/u);
    expect(Buffer.byteLength(normalized.diagnostic ?? "", "utf8")).toBeLessThanOrEqual(4096);
    expect(result.content[0]?.text).not.toMatch(/\p{Cc}/u);
  });
});
