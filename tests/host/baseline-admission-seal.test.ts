import { expect, it, vi } from "vitest";
import { createRoleToolExecutionController } from "../../src/host/execution/role-tool-execution-binding.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";

it("seals baseline admission at cancellation before pending work settles", async () => {
  const controller = createRoleToolExecutionController({
    runId: "run",
    role: "worker",
    roleSessionId: "session",
    visitIndex: 1,
    executionTier: "baseline",
    policy: DEFAULT_TOOL_EXECUTION_POLICY,
    persist: () => {},
  });
  const caller = new AbortController();
  let release!: () => void;
  const first = controller
    .run(
      "bash",
      "first",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      { signal: caller.signal },
    )
    .catch((error: unknown) => error);
  await new Promise<void>((resolve) => setImmediate(resolve));
  caller.abort();
  const effect = vi.fn().mockResolvedValue(undefined);
  const second = controller.run("write", "second", effect);
  release();
  await first;
  await expect(second).rejects.toMatchObject({ code: "tool_closed" });
  expect(effect).not.toHaveBeenCalled();
});
