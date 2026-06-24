/**
 * Phase 3 Task 5 — `ask_user` tool behavior.
 *
 * Pins the host-side tool contract:
 *   - `input`, `confirm`, and `select` each return the dialog answer.
 *   - The tool forwards the abort signal to the underlying UI call.
 *   - When no dialog-capable UI is available, it throws
 *     `AskUserUnavailableError`.
 *   - The tool does not touch the `SessionSeam` capture buffer.
 *
 * Issue #1 — schema-level tests pin the flat JSON-Schema shape
 * (no `anyOf` root, portable enum) and the `default` / select-guard
 * runtime validation.
 */

import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

import {
  type AskUserUnavailableError,
  askUserArgsSchema,
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
  // `ToolDefinition<...>` widens incorrectly under `exactOptionalPropertyTypes`;
  // `invoke` only reads `.execute`, so accept the specific tool shape via `unknown`.
  tool: { execute: unknown },
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

  // ─── Issue #1: runtime validation ──────────────────────────

  it("throws on unknown kind (default arm)", async () => {
    const ui = makeUi();
    const tool = createAskUserTool();

    await expect(
      invoke(tool, { kind: "bogus", prompt: "anything" }, undefined, {
        hasUI: true,
        mode: "tui",
        ui,
      } as never),
    ).rejects.toThrow("ask_user: unknown kind 'bogus'");
  });

  it("throws on select without options (defensive guard)", async () => {
    const ui = makeUi();
    const tool = createAskUserTool();

    await expect(
      invoke(tool, { kind: "select", prompt: "choose" }, undefined, {
        hasUI: true,
        mode: "tui",
        ui,
      } as never),
    ).rejects.toThrow("ask_user: 'select' kind requires a non-empty 'options' array");
  });

  it("throws on select with empty options (defensive guard)", async () => {
    const ui = makeUi();
    const tool = createAskUserTool();

    await expect(
      invoke(tool, { kind: "select", prompt: "choose", options: [] }, undefined, {
        hasUI: true,
        mode: "tui",
        ui,
      } as never),
    ).rejects.toThrow("ask_user: 'select' kind requires a non-empty 'options' array");
  });
});

// ─── Issue #1: flat schema validation (portable provider JSON-Schema) ───

describe("askUserArgsSchema (flat, portable)", () => {
  it("validates input kind", () => {
    expect(Value.Check(askUserArgsSchema, { kind: "input", prompt: "?" })).toBe(true);
  });

  it("validates confirm kind", () => {
    expect(Value.Check(askUserArgsSchema, { kind: "confirm", prompt: "?" })).toBe(true);
  });

  it("validates select kind with options", () => {
    expect(Value.Check(askUserArgsSchema, { kind: "select", prompt: "?", options: ["a"] })).toBe(
      true,
    );
  });

  it("rejects empty object (the issue #1 reported call)", () => {
    expect(Value.Check(askUserArgsSchema, {})).toBe(false);
  });

  it("rejects input without prompt", () => {
    expect(Value.Check(askUserArgsSchema, { kind: "input" })).toBe(false);
  });

  it("rejects select with empty options", () => {
    expect(
      Value.Check(askUserArgsSchema, {
        kind: "select",
        prompt: "?",
        options: [],
      }),
    ).toBe(false);
  });

  it("rejects unknown kind enum value", () => {
    expect(Value.Check(askUserArgsSchema, { kind: "bogus", prompt: "?" })).toBe(false);
  });

  it("rejects unknown field (additionalProperties: false)", () => {
    expect(
      Value.Check(askUserArgsSchema, {
        kind: "input",
        prompt: "?",
        bogus: true,
      }),
    ).toBe(false);
  });

  it("serializes without anyOf at the top level (provider portability guard)", () => {
    const serialized = JSON.parse(JSON.stringify(askUserArgsSchema));
    // Root must not have `anyOf` (the pre-change union form did).
    expect(serialized).not.toHaveProperty("anyOf");
    // The kind property is the portable {type:"string",enum:[…]} shape.
    expect(serialized.properties.kind).toEqual({
      type: "string",
      enum: ["input", "confirm", "select"],
    });
  });
});
