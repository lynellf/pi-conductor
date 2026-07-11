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
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
    // Ensure real timers are active even if fake timers leaked from
    // a previous test file (isolate:false). Some tests yield control
    // via `await new Promise(res => setTimeout(res, 0))` which would
    // hang forever under fake timers.
    vi.useRealTimers();
  });

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

    // The mutex's `await prev` may yield before the dialog mock
    // is called. If the signal is already aborted at that point,
    // attaching a listener won't fire (the event has passed).
    // Handle both the live-abort and already-aborted cases so
    // the reject-or-never guarantee holds regardless of timing.
    ui.input.mockImplementation(() => {
      if (controller.signal.aborted) {
        return Promise.reject(new Error("dialog aborted"));
      }
      return new Promise<string | undefined>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            reject(new Error("dialog aborted"));
          },
          { once: true },
        );
      });
    });

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

  it("rejects options for input before opening the input dialog", async () => {
    const ui = makeUi();
    const tool = createAskUserTool();

    await expect(
      invoke(tool, { kind: "input", prompt: "What now?", options: ["A", "B"] }, undefined, {
        hasUI: true,
        mode: "tui",
        ui,
      } as never),
    ).rejects.toThrow("ask_user: 'input' kind does not accept 'options'; use 'select'");
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("rejects options for confirm before opening the confirmation dialog", async () => {
    const ui = makeUi();
    const tool = createAskUserTool();

    await expect(
      invoke(tool, { kind: "confirm", prompt: "Which one?", options: ["A", "B"] }, undefined, {
        hasUI: true,
        mode: "tui",
        ui,
      } as never),
    ).rejects.toThrow("ask_user: 'confirm' kind does not accept 'options'; use 'select'");
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  // ─── run fceb3964 fix: executionMode + mutex serialization ───────────

  it("declares executionMode: 'sequential' (spec §B, run fceb3964)", () => {
    const tool = createAskUserTool();
    expect(tool.executionMode).toBe("sequential");
  });

  it("serializes two concurrent execute calls via the in-tool mutex", async () => {
    // Two deferred promises — the test controls when each dialog resolves.
    let resolveFirst!: (v: string | undefined) => void;
    let resolveSecond!: (v: string) => void;

    const ui = makeUi();
    ui.input.mockReturnValue(
      new Promise<string | undefined>((res) => {
        resolveFirst = res;
      }),
    );
    ui.select.mockReturnValue(
      new Promise<string>((res) => {
        resolveSecond = res;
      }),
    );

    const tool = createAskUserTool();

    // Fire both concurrently — second must queue behind first.
    const p1 = invoke(tool, { kind: "input", prompt: "Q1" }, undefined, {
      hasUI: true,
      mode: "tui",
      ui,
    } as never);
    const p2 = invoke(tool, { kind: "select", prompt: "Q2", options: ["a", "b"] }, undefined, {
      hasUI: true,
      mode: "tui",
      ui,
    } as never);

    // Yield so p1's execute runs through the mutex acquire and enters
    // its dialog; p2's execute reaches the mutex and blocks on `await prev`.
    await new Promise<void>((res) => setTimeout(res, 0));

    // p1's dialog is now in-flight; p2 is queued on the mutex.
    // Only p1's ui.input should have been called.
    expect(ui.input).toHaveBeenCalledTimes(1);
    expect(ui.select).toHaveBeenCalledTimes(0);

    // Resolve p1.
    resolveFirst("answer1");
    const r1 = await p1;
    expect(r1.details).toEqual({ kind: "input", answer: "answer1" });

    // Now p2's mutex should be released and its dialog invoked.
    // Yield again to let p2's execute run.
    await new Promise<void>((res) => setTimeout(res, 0));
    expect(ui.select).toHaveBeenCalledTimes(1);
    expect(ui.select).toHaveBeenCalledWith("Q2", ["a", "b"], undefined);

    // Resolve p2.
    resolveSecond("a");
    const r2 = await p2;
    expect(r2.details).toEqual({ kind: "select", answer: "a" });
  });

  it("mutex is released on rejection so next caller proceeds", async () => {
    // If the first call throws, the mutex must release and the
    // second call must proceed (not hang).
    const ui = makeUi();
    ui.input.mockRejectedValue(new Error("dialog aborted"));
    let selectResolve!: (v: string) => void;
    ui.select.mockReturnValue(
      new Promise<string>((res) => {
        selectResolve = res;
      }),
    );

    const tool = createAskUserTool();

    const p1 = invoke(tool, { kind: "input", prompt: "Q1" }, undefined, {
      hasUI: true,
      mode: "tui",
      ui,
    } as never);
    const p2 = invoke(tool, { kind: "select", prompt: "Q2", options: ["x"] }, undefined, {
      hasUI: true,
      mode: "tui",
      ui,
    } as never);

    // p1 rejected — the finally block releases the mutex.
    await expect(p1).rejects.toThrow("dialog aborted");

    // p2's mutex should be released — yield so p2's execute runs.
    await new Promise<void>((res) => setTimeout(res, 0));
    expect(ui.select).toHaveBeenCalledTimes(1);

    selectResolve("x");
    const r2 = await p2;
    expect(r2.details).toEqual({ kind: "select", answer: "x" });
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
      description:
        "Dialog control: input for free-form text, confirm for yes/no, select for one option.",
    });
  });
});
