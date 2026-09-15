import { afterEach, expect, it, vi } from "vitest";

import { DelegationManager } from "../../src/host/delegation/manager.js";
import type { HostRejection } from "../../src/host/host-rejection.js";
import { child, deferred } from "./delegation-scheduler-review-fixture.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";

afterEach(() => {
  vi.doUnmock("../../src/host/delegation/admission.js");
  vi.doUnmock("../../src/host/delegation/pool.js");
  vi.resetModules();
});

it("returns the structured terminal cause when a legacy preparation finishes after termination", async () => {
  vi.resetModules();
  const preparation = deferred<{
    readonly baseCommit: string;
    readonly materializedParentPaths: readonly string[];
    readonly tasks: readonly [ReturnType<typeof child>];
  }>();
  const enteredPreparation = deferred<void>();
  vi.doMock("../../src/host/delegation/admission.js", () => ({
    prepareDelegateSubmission: () => {
      enteredPreparation.resolve();
      return preparation.promise;
    },
  }));
  const runBoundedPool = vi.fn();
  vi.doMock("../../src/host/delegation/pool.js", () => ({ runBoundedPool }));
  const { createDelegateTool } = await import("../../src/host/delegation/delegate-tool-factory.js");
  let rejection: HostRejection | false = false;
  const tool = createDelegateTool({
    role: {
      name: "orchestrator",
      is_orchestrator: true,
      tools: ["delegate"],
      delegation: {
        allowed_subagents: ["worker"],
        max_children_per_session: 1,
        max_parallel: 1,
      },
    },
    subagents: [child("blocked").profile],
    remainingChildren: 1,
    runId: "run",
    parentRole: "orchestrator",
    parentVisitIndex: 1,
    primaryCheckout: "/unused",
    runStateDir: "/unused/run",
    persistRecord: vi.fn(),
    agentDir: "/unused/agent",
    systemPromptRoot: "/unused/prompts",
    modelRegistry: makeModelRegistryWithStub([]),
    sessionDir: "/unused/sessions",
    manager: new DelegationManager(),
    getHostRejection: () => rejection,
  });
  const execution = tool.execute(
    "legacy-race",
    {
      tasks: [
        {
          id: "blocked",
          subagent: "worker",
          objective: "blocked",
          expected_output: "none",
        },
      ],
    },
    undefined,
    undefined,
    {} as never,
  );
  await enteredPreparation.promise;
  rejection = { cause: "model_error", diagnostic: "retry exhausted" };
  preparation.resolve({
    baseCommit: "base",
    materializedParentPaths: [],
    tasks: [child("blocked")],
  });

  await expect(execution).resolves.toMatchObject({
    terminate: true,
    details: {
      ok: false,
      reason: "host_terminated",
      cause: "model_error",
      diagnostic: "retry exhausted",
    },
  });
  expect(runBoundedPool).not.toHaveBeenCalled();
});
