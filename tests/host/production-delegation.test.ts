import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { DelegateToolFactoryOptions } from "../../src/host/delegation/delegate-tool-factory.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import { ProductionDelegationCoordinator } from "../../src/host/delegation/production-delegation.js";

function options(): Omit<DelegateToolFactoryOptions, "manager" | "scheduler"> {
  return {
    role: {
      name: "orchestrator",
      delegation: {
        allowed_subagents: [],
        max_children_per_session: 0,
        max_parallel: 1,
      },
    },
    subagents: [],
    remainingChildren: 0,
    runId: "run-1",
    parentRole: "orchestrator",
    parentVisitIndex: 1,
    primaryCheckout: process.cwd(),
    runStateDir: process.cwd(),
    persistRecord: () => {},
    agentDir: process.cwd(),
    systemPromptRoot: process.cwd(),
    modelRegistry: {} as ModelRegistry,
    sessionDir: process.cwd(),
    records: () => [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type PrivateCoordinator = {
  scopes: Map<
    string,
    {
      manager: DelegationManager;
      scheduler: {
        isClosed(): boolean;
        close(reason?: string): Promise<void>;
        pendingChildIds(): readonly string[];
      };
    }
  >;
  failures: Map<string, unknown>;
};

function internals(coordinator: ProductionDelegationCoordinator): PrivateCoordinator {
  return coordinator as unknown as PrivateCoordinator;
}

describe("production delegation scopes", () => {
  it("keeps independent parent scopes and settles them independently", async () => {
    const coordinator = new ProductionDelegationCoordinator();
    await coordinator.createTool(options(), '["run-1","worker",1]');
    await coordinator.createTool(options(), '["run-1","worker",2]');

    expect(coordinator.pending('["run-1","worker",1]')).toEqual([]);
    expect(coordinator.pending('["run-1","worker",2]')).toEqual([]);

    await coordinator.closeScope('["run-1","worker",1]', "replacement");
    expect(coordinator.pending('["run-1","worker",1]')).toEqual([]);
    expect(coordinator.pending('["run-1","worker",2]')).toEqual([]);
    await coordinator.close("test cleanup");
  });

  it("waits for an open scope to settle before creating its replacement", async () => {
    const coordinator = new ProductionDelegationCoordinator();
    const id = '["run-1","worker",1]';
    const gate = deferred<void>();
    let closeCalls = 0;
    internals(coordinator).scopes.set(id, {
      manager: new DelegationManager(),
      scheduler: {
        isClosed: () => false,
        close: async () => {
          closeCalls += 1;
          await gate.promise;
        },
        pendingChildIds: () => ["child-a"],
      },
    });
    const creating = coordinator.createTool(options(), id);
    await Promise.resolve();
    expect(closeCalls).toBe(1);
    let settled = false;
    void creating.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await creating;
    expect(internals(coordinator).scopes.has(id)).toBe(true);
    await coordinator.close("test cleanup");
  });

  it("retains the first fatal failure and never replaces a poisoned scope", async () => {
    const coordinator = new ProductionDelegationCoordinator();
    const id = '["run-1","worker",1]';
    const first = new Error("first fatal");
    internals(coordinator).failures.set(id, first);
    internals(coordinator).scopes.set(id, {
      manager: new DelegationManager(),
      scheduler: {
        isClosed: () => true,
        close: async () => undefined,
        pendingChildIds: () => [],
      },
    });
    await expect(coordinator.createTool(options(), id)).rejects.toBe(first);
    internals(coordinator).scopes.delete(id);
    await expect(coordinator.createTool(options(), id)).rejects.toBe(first);
    expect(internals(coordinator).scopes.has(id)).toBe(false);
  });

  it("keeps a failed close from creating a replacement", async () => {
    const coordinator = new ProductionDelegationCoordinator();
    const id = '["run-1","worker",1]';
    const failure = new Error("cleanup failed");
    internals(coordinator).scopes.set(id, {
      manager: new DelegationManager(),
      scheduler: {
        isClosed: () => true,
        close: async () => {
          throw failure;
        },
        pendingChildIds: () => [],
      },
    });
    await expect(coordinator.createTool(options(), id)).rejects.toBe(failure);
    expect(internals(coordinator).scopes.has(id)).toBe(true);
  });
});
