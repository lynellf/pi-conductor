import { describe, expect, it, vi } from "vitest";
import {
  ToolExecutionError,
  type ToolExecutionScope,
} from "../../src/host/execution/tool-execution-contract.js";
import {
  executeToolLifecycle,
  type ToolExecutionLifecycleAdapter,
} from "../../src/host/execution/tool-execution-lifecycle.js";

function scope(abort = new AbortController()): ToolExecutionScope {
  return {
    executionId: "execution",
    supervisionId: "supervision",
    signal: abort.signal,
    graceMs: 1000,
    remainingTimeoutMs: () => 1000,
    assertOpen: () => {
      if (abort.signal.aborted) throw new Error("aborted");
    },
  };
}
function adapter(events: string[]): ToolExecutionLifecycleAdapter<number, string> {
  return {
    prepare: async () => {
      events.push("prepare");
      return "ready";
    },
    authorize: async () => {
      events.push("authorize");
    },
    settle: async () => {
      events.push("settle");
      return 17;
    },
    terminate: async () => {
      events.push("terminate");
      return "confirmed";
    },
  };
}

describe("controller lifecycle operation", () => {
  it("persists readiness before authorization and returns ordinary nonzero results", async () => {
    const events: string[] = [];
    await expect(
      executeToolLifecycle(adapter(events), scope(), () => {
        events.push("persist");
      }),
    ).resolves.toBe(17);
    expect(events).toEqual(["prepare", "persist", "authorize", "settle"]);
  });
  it("never releases after readiness persistence fails and waits for cleanup", async () => {
    const events: string[] = [];
    const cause = new Error("persistence ambiguous");
    await expect(
      executeToolLifecycle(adapter(events), scope(), () => {
        throw cause;
      }),
    ).rejects.toBe(cause);
    expect(events).toEqual(["prepare", "terminate"]);
  });
  it("cancels held setup without waiting for it or allowing late release", async () => {
    const events: string[] = [];
    const abort = new AbortController();
    let ready!: (value: string) => void;
    const execution = adapter(events);
    execution.prepare = () =>
      new Promise<string>((resolve) => {
        ready = resolve;
      });
    const pending = executeToolLifecycle(execution, scope(abort), () => {
      events.push("persist");
    });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "tool_aborted", cleanup: "confirmed" });
    ready("late");
    await Promise.resolve();
    expect(events).toEqual(["terminate"]);
  });
  it("holds cancellation through termination evidence and calls termination once", async () => {
    const events: string[] = [];
    const abort = new AbortController();
    let cleanup!: (value: "confirmed") => void;
    const execution = adapter(events);
    execution.settle = () => new Promise<number>(() => undefined);
    execution.terminate = vi.fn(
      () =>
        new Promise<"confirmed">((resolve) => {
          cleanup = resolve;
        }),
    );
    const pending = executeToolLifecycle(execution, scope(abort), () => undefined);
    await vi.waitFor(() => expect(events).toContain("authorize"));
    abort.abort();
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    cleanup("confirmed");
    await expect(pending).rejects.toMatchObject({ code: "tool_aborted" });
    expect(execution.terminate).toHaveBeenCalledTimes(1);
  });
  it.each(["unconfirmed", "throws"])("preserves uncertain termination: %s", async (mode) => {
    const execution = adapter([]);
    execution.prepare = async () => {
      throw new Error("setup failed");
    };
    execution.terminate = async () => {
      if (mode === "throws") throw new Error("observation failed");
      return "unconfirmed";
    };
    await expect(executeToolLifecycle(execution, scope(), () => undefined)).rejects.toMatchObject({
      code: "tool_cleanup_unconfirmed",
      cleanup: "unconfirmed",
    });
  });
  it("does not prepare a pre-aborted attempt", async () => {
    const events: string[] = [];
    const abort = new AbortController();
    abort.abort();
    await expect(
      executeToolLifecycle(adapter(events), scope(abort), () => undefined),
    ).rejects.toThrow();
    expect(events).toEqual(["terminate"]);
  });

  it.each([
    "prepare",
    "persist",
    "authorize",
  ] as const)("settles cancellation during %s without advancing phases", async (phase) => {
    const events: string[] = [];
    const abort = new AbortController();
    const execution = adapter(events);
    if (phase === "prepare")
      execution.prepare = async () => {
        events.push("prepare");
        abort.abort();
        return "ready";
      };
    if (phase === "authorize")
      execution.authorize = async () => {
        events.push("authorize");
        abort.abort();
      };
    await expect(
      executeToolLifecycle(execution, scope(abort), () => {
        events.push("persist");
        if (phase === "persist") abort.abort();
      }),
    ).rejects.toThrow();
    expect(events.filter((event) => event === "terminate")).toHaveLength(1);
    expect(events).not.toContain("settle");
    if (phase !== "authorize") expect(events).not.toContain("authorize");
  });

  it.each([
    "authorize",
    "settle",
  ] as const)("terminates after %s rejects without replay", async (phase) => {
    const events: string[] = [];
    const execution = adapter(events);
    const cause = new Error("possibly released");
    execution[phase] = async () => {
      events.push(phase);
      throw cause;
    };
    await expect(executeToolLifecycle(execution, scope(), () => undefined)).rejects.toBe(cause);
    expect(events.filter((event) => event === phase)).toHaveLength(1);
    expect(events.at(-1)).toBe("terminate");
  });

  it("retains persistence ambiguity even when cleanup also fails", async () => {
    const execution = adapter([]);
    execution.terminate = async () => {
      throw new Error("observation unavailable");
    };
    const cause = new ToolExecutionError("tool_persistence_ambiguous", "ready write uncertain", {
      cleanup: "unconfirmed",
    });
    await expect(
      executeToolLifecycle(execution, scope(), () => {
        throw cause;
      }),
    ).rejects.toBe(cause);
  });

  it("latches termination synchronously when authorization observes cancellation", async () => {
    const abort = new AbortController();
    const execution = adapter([]);
    let closed = false;
    let released = false;
    execution.terminate = async () => {
      closed = true;
      return "confirmed";
    };
    execution.authorize = async () => {
      abort.abort();
      if (!closed) released = true;
    };
    await expect(executeToolLifecycle(execution, scope(abort), () => undefined)).rejects.toThrow();
    expect(released).toBe(false);
  });
});
