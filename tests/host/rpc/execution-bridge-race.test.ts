import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

describe("execution bridge close admission race", () => {
  it("does not admit after gated response access and close", async () => {
    vi.resetModules();
    const state = {
      responseId: "",
      entered: undefined as (() => void) | undefined,
      gate: undefined as Promise<void> | undefined,
    };
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        readFile: async (path: Parameters<typeof actual.readFile>[0], options?: unknown) => {
          if (String(path).endsWith(`${state.responseId}.request.json`)) {
            return JSON.stringify({
              id: state.responseId,
              actual_tool_call_id: "race",
              tool_name: "read",
              params: {},
            });
          }
          return actual.readFile(path, options as never);
        },
        access: async (path: Parameters<typeof actual.access>[0], mode?: number) => {
          if (String(path).endsWith(`${state.responseId}.response.json`)) {
            state.entered?.();
            await state.gate;
            const error = new Error("response absent") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          return actual.access(path, mode);
        },
      };
    });
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const { ExecutionBridgeHost } = await import("../../../src/host/rpc/execution-bridge.js");
    const directory = await fs.mkdtemp(join((await import("node:os")).tmpdir(), "execution-race-"));
    const id = "9f5c4f2e-5b57-4c22-9e4e-3b2d93b8d2f0";
    state.responseId = id;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    state.entered = entered;
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await fs.writeFile(
      join(directory, `${id}.request.json`),
      JSON.stringify({ id, actual_tool_call_id: "race", tool_name: "read", params: {} }),
    );
    let executions = 0;
    const host = new ExecutionBridgeHost({
      directory,
      tools: [
        {
          name: "read",
          parameters: Type.Object({}),
          execute: async () => {
            executions += 1;
            return "unexpected";
          },
        },
      ],
    });
    try {
      await enteredPromise;
      const closing = host.close();
      release();
      await closing;
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(executions).toBe(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});
