/**
 * Phase 3 Task 5 — `ask_user` tool behavior.
 *
 * Pins the host-side tool contract:
 *   - `input`, `confirm`, and `select` each return the dialog answer.
 *   - The tool forwards the abort signal to the underlying UI call.
 *   - When no dialog-capable UI is available, it throws
 *     `AskUserUnavailableError`.
 *   - The tool does not touch the `SessionSeam` capture buffer.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  type AskUserUnavailableError,
  createAskUserTool,
  SessionSeam,
} from "../../src/host/index.js";

type ExecuteFn = (
  this: void,
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: unknown,
) => Promise<{
  content: readonly { type: string; text: string }[];
  details: unknown;
  terminate?: boolean;
}>;

function invoke(
  tool: ToolDefinition,
  params: unknown,
  signal: AbortSignal | undefined,
  ctx: unknown,
) {
  const execute = tool.execute as unknown as ExecuteFn;
  return execute.call(undefined, "test-call-id", params, signal, undefined, ctx);
}

function makeUi() {
  return {
    confirm: vi.fn(),
    input: vi.fn(),
    select: vi.fn(),
  };
}

describe("createAskUserTool", () => {
  it("returns the typed text answer for `input` and keeps the capture buffer untouched", async () => {
    const seam = new SessionSeam();
    const ui = makeUi();
    ui.input.mockResolvedValue("Need more context");
    const tool = createAskUserTool();
    const signal = new AbortController().signal;

    const result = await invoke(tool, { kind: "input", prompt: "What do you need?" }, signal, {
      hasUI: true,
      mode: "tui",
      ui,
    } as never);

    expect(seam.read()).toHaveLength(0);
    expect(ui.input).toHaveBeenCalledWith("What do you need?", undefined, { signal });
    expect(result.terminate).toBe(false);
    expect(result.details).toEqual({ kind: "input", answer: "Need more context" });
    expect(result.content).toEqual([{ type: "text", text: "Need more context" }]);
  });

  it("propagates aborts through the dialog signal", async () => {
    const ui = makeUi();
    const tool = createAskUserTool();
    const controller = new AbortController();

    ui.input.mockImplementation(
      () =>
        new Promise<string | undefined>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              reject(new Error("dialog aborted"));
            },
            { once: true },
          );
        }),
    );

    const execution = invoke(tool, { kind: "input", prompt: "What now?" }, controller.signal, {
      hasUI: true,
      mode: "tui",
      ui,
    } as never);

    controller.abort();

    await expect(execution).rejects.toThrow("dialog aborted");
    expect(ui.input).toHaveBeenCalledWith("What now?", undefined, { signal: controller.signal });
  });

  it("returns a boolean-shaped result for `confirm`", async () => {
    const ui = makeUi();
    ui.confirm.mockResolvedValue(false);
    const tool = createAskUserTool();

    const result = await invoke(tool, { kind: "confirm", prompt: "Continue?" }, undefined, {
      hasUI: true,
      mode: "tui",
      ui,
    } as never);

    expect(ui.confirm).toHaveBeenCalledWith("Ask user", "Continue?", undefined);
    expect(result.terminate).toBe(false);
    expect(result.details).toEqual({ kind: "confirm", answer: false });
    expect(result.content).toEqual([{ type: "text", text: "false" }]);
  });

  it("returns the chosen option for `select`", async () => {
    const ui = makeUi();
    ui.select.mockResolvedValue("green");
    const tool = createAskUserTool();

    const result = await invoke(
      tool,
      { kind: "select", prompt: "Pick a color", options: ["red", "green", "blue"] },
      undefined,
      { hasUI: true, mode: "tui", ui } as never,
    );

    expect(ui.select).toHaveBeenCalledWith("Pick a color", ["red", "green", "blue"], undefined);
    expect(result.terminate).toBe(false);
    expect(result.details).toEqual({ kind: "select", answer: "green" });
    expect(result.content).toEqual([{ type: "text", text: "green" }]);
  });

  it("throws AskUserUnavailableError when no UI is available", async () => {
    const seam = new SessionSeam();
    const ui = makeUi();
    const tool = createAskUserTool();

    await expect(
      invoke(tool, { kind: "input", prompt: "Anything?" }, undefined, {
        hasUI: false,
        mode: "print",
        ui,
      } as never),
    ).rejects.toMatchObject({
      name: "AskUserUnavailableError",
      mode: "print",
      hasUI: false,
    } satisfies Partial<AskUserUnavailableError>);
    expect(seam.read()).toHaveLength(0);
    expect(ui.input).not.toHaveBeenCalled();
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(ui.select).not.toHaveBeenCalled();
  });
});
