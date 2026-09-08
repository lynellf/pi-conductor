import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ToolExecutionController } from "../../src/host/execution/tool-execution-controller.js";
import {
  ToolExecutionModelError,
  toToolExecutionModelError,
} from "../../src/host/execution/tool-execution-model-error.js";
import { makeStubModel } from "../../src/host/stub-provider.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

describe("tool execution model error boundary", () => {
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  afterEach(() => session?.dispose());

  it("encodes safe structured fields without raw diagnostics", () => {
    const error = toToolExecutionModelError(
      Object.assign(new Error("worker failed\nsecret output"), {
        code: "tool_timeout",
        cleanup: "confirmed",
        executionId: "execution-1",
      }),
    );
    expect(error).toBeInstanceOf(ToolExecutionModelError);
    expect(JSON.parse(error.message)).toEqual({
      code: "tool_timeout",
      cleanup: "confirmed",
      executionId: "execution-1",
      message:
        "worker failed secret output. The operation was not replayed; partial file effects may remain. Inspect the workspace before repair.",
    });
  });

  it.each([null, undefined])("normalizes %s without throwing", (value) => {
    const error = toToolExecutionModelError(value);
    expect(JSON.parse(error.message)).toMatchObject({
      code: "tool_failed",
      cleanup: "not-started",
      message: String(value),
    });
  });

  it("retains repair guidance when the diagnostic is very long", () => {
    const error = toToolExecutionModelError(
      Object.assign(new Error("x".repeat(5_000)), {
        code: "tool_cleanup_unconfirmed",
        cleanup: "unconfirmed",
      }),
    );
    const message = JSON.parse(error.message).message as string;
    expect(message).toContain("The operation was not replayed");
    expect(message).toContain("Inspect the workspace before repair.");
    expect(message.length).toBeLessThanOrEqual(512);
  });

  it("preserves the controller cause for an ordinary worker failure", async () => {
    const controller = new ToolExecutionController({
      runId: "run",
      logicalSessionId: "logical",
      roleSessionId: "role",
      policy: DEFAULT_TOOL_EXECUTION_POLICY,
      persist: () => undefined,
    });
    let caught: unknown;
    try {
      await controller.run("read", "missing", async () => {
        throw new Error("ENOENT: missing.txt");
      });
    } catch (error) {
      caught = error;
    }
    const modelError = toToolExecutionModelError(caught);
    expect(JSON.parse(modelError.message).message).toBe("ENOENT: missing.txt");
  });

  it("makes a thrown boundary error an SDK tool error", async () => {
    const tool = defineTool({
      name: "explode",
      label: "explode",
      description: "test failure boundary",
      parameters: Type.Object({}),
      async execute() {
        throw toToolExecutionModelError(
          Object.assign(new Error("bounded failure"), {
            code: "tool_timeout",
            cleanup: "confirmed",
            executionId: "execution-2",
          }),
        );
      },
    });
    const events: Array<{
      readonly isError?: boolean;
      readonly result?: { readonly content: readonly { readonly text?: string }[] };
    }> = [];
    const created = await createAgentSession({
      cwd: process.cwd(),
      model: makeStubModel(),
      modelRegistry: makeModelRegistryWithStub([
        { kind: "emit_tool_calls", calls: [{ name: "explode", arguments: {} }] },
      ]),
      sessionManager: SessionManager.inMemory(process.cwd()),
      customTools: [tool],
      tools: ["explode"],
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-model-error-"),
    });
    session = created.session;
    session.subscribe((event) => {
      if (event.type === "tool_execution_end") events.push(event);
    });
    await session.prompt("run the failing tool");
    expect(events).toHaveLength(1);
    expect(events[0]?.isError).toBe(true);
    expect(events[0]?.result?.content[0]?.text).toContain('"code":"tool_timeout"');
  });
});
