import { describe, expect, it } from "vitest";
import { spentDelegationSlots } from "../../src/persistence/delegation-task.js";
import {
  cancelled,
  child,
  completed,
  deferred,
  fixture,
  input,
  turn,
  within,
} from "./delegation-scheduler-review-fixture.js";

describe("scheduler durable ownership review", () => {
  it.each([
    false,
    true,
  ])("fails closed on acceptance append ambiguity (written=%s)", async (written) => {
    const test = fixture({
      runTask: async (task) => completed(task),
      persist: (record, append) => {
        if (record.type === "delegation_submission_accepted") {
          if (written) append();
          throw new Error("acceptance ambiguous");
        }
        append();
      },
    });
    await expect(test.scheduler.submit("call-a", input("a"))).rejects.toThrow(
      "acceptance ambiguous",
    );
    await expect(test.scheduler.submit("call-a", input("a"))).rejects.toThrow();
    expect(test.scheduler.isClosed()).toBe(true);
    expect(test.starts).toEqual([]);
    expect(test.log.records("run")).toHaveLength(written ? 1 : 0);
    await expect(test.scheduler.close()).rejects.toThrow("acceptance ambiguous");
  });

  it.each([
    false,
    true,
  ])("settles existing and later waits on terminal append ambiguity (written=%s)", async (written) => {
    const release = deferred<void>();
    const test = fixture({
      runTask: async (task) => {
        await release.promise;
        return completed(task);
      },
      persist: (record, append) => {
        if (record.type === "subagent_completed") {
          if (written) append();
          throw new Error("terminal ambiguous");
        }
        append();
      },
    });
    const [id = ""] = await test.scheduler.submit("call-a", input("a"));
    const early = test.scheduler.wait(id).catch((error: unknown) => error);
    release.resolve();
    expect(await within(early)).toEqual(new Error("terminal ambiguous"));
    expect(test.scheduler.status([id])[0]?.result).toBeUndefined();
    expect(test.scheduler.isClosed()).toBe(true);
    expect(
      test.log
        .records("run")
        .filter(
          (record) => record.type === "subagent_completed" || record.type === "subagent_failed",
        ),
    ).toHaveLength(written ? 1 : 0);
    await expect(within(test.scheduler.wait(id))).rejects.toThrow("terminal ambiguous");
    await expect(within(test.scheduler.close())).rejects.toThrow("terminal ambiguous");
  });

  it("close waits for admission preparation to settle and cannot acknowledge an orphan", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const test = fixture({
      runTask: async (task) => completed(task),
      prepare: async () => {
        entered.resolve();
        await release.promise;
        return { baseCommit: "base", materializedParentPaths: [], tasks: [child("a")] };
      },
    });
    const submission = test.scheduler.submit("call-a", input("a")).catch((cause: unknown) => cause);
    await entered.promise;
    let closed = false;
    const closure = test.scheduler.close().then(() => {
      closed = true;
    });
    try {
      await turn();
      expect(closed).toBe(false);
    } finally {
      release.resolve();
      await within(submission);
      await within(closure);
    }
    expect(test.starts).toEqual([]);
    expect(test.log.records("run")).toEqual([]);
  });

  it.each([
    false,
    true,
  ])("targeted queued cancellation append ambiguity stops admission (written=%s)", async (written) => {
    const cleanup = deferred<void>();
    const test = fixture({
      maxParallel: 1,
      runTask: async (task) => {
        await cleanup.promise;
        return cancelled(task);
      },
      persist: (record, append) => {
        if (record.type === "subagent_failed" && record.task_id === "b") {
          if (written) append();
          throw new Error("targeted terminal ambiguous");
        }
        append();
      },
    });
    const [, queued = ""] = await test.scheduler.submit("call-ab", input("a", "b"));
    try {
      await expect(test.scheduler.cancel([queued])).rejects.toThrow("targeted terminal ambiguous");
      expect(test.scheduler.isClosed()).toBe(true);
      await expect(test.scheduler.submit("call-c", input("c"))).rejects.toThrow();
      await expect(within(test.scheduler.wait(queued))).rejects.toThrow(
        "targeted terminal ambiguous",
      );
    } finally {
      cleanup.resolve();
      await within(test.scheduler.close().catch((cause: unknown) => cause));
    }
    expect(
      test.log
        .records("run")
        .filter((record) => record.type === "subagent_failed" && record.child_id === queued),
    ).toHaveLength(written ? 1 : 0);
  });

  it("close still cancels and awaits active cleanup if a queued cancellation append fails", async () => {
    const cleanup = deferred<void>();
    const abortObserved = deferred<void>();
    const test = fixture({
      maxParallel: 1,
      runTask: async (task, signal) => {
        signal.addEventListener("abort", () => abortObserved.resolve(), { once: true });
        await cleanup.promise;
        return cancelled(task);
      },
      persist: (record, append) => {
        if (record.type === "subagent_failed" && record.task_id === "b")
          throw new Error("queued terminal ambiguous");
        append();
      },
    });
    const [, queued = ""] = await test.scheduler.submit("call-ab", input("a", "b"));
    let closed = false;
    const closure = test.scheduler
      .close()
      .catch((cause: unknown) => cause)
      .then((cause) => {
        closed = true;
        return cause;
      });
    try {
      await within(abortObserved.promise);
      expect(closed).toBe(false);
    } finally {
      cleanup.resolve();
      await within(closure);
    }
    expect(await closure).toEqual(new Error("queued terminal ambiguous"));
    await expect(within(test.scheduler.wait(queued))).rejects.toThrow("queued terminal ambiguous");
  });

  it("a child terminal reaching the budget cancels queued work and awaits active cleanup", async () => {
    const releaseA = deferred<void>();
    const cleanupB = deferred<void>();
    const abortB = deferred<void>();
    let exhausted = false;
    const test = fixture({
      exhausted: () => exhausted,
      runTask: async (task, signal) => {
        if (task.taskId === "a") {
          await releaseA.promise;
          return completed(task);
        }
        signal.addEventListener("abort", () => abortB.resolve(), { once: true });
        await cleanupB.promise;
        return cancelled(task);
      },
      persist: (record, append) => {
        append();
        if (record.type === "subagent_completed") exhausted = true;
      },
    });
    const [a = "", b = "", c = ""] = await test.scheduler.submit("call-abc", input("a", "b", "c"));
    try {
      releaseA.resolve();
      await within(test.scheduler.wait(a));
      await within(abortB.promise);
      expect(test.starts).toEqual(["a", "b"]);
      expect((await within(test.scheduler.wait(c))).status).toBe("cancelled");
      expect(test.scheduler.status([b])[0]?.result).toBeUndefined();
      expect(test.scheduler.isClosed()).toBe(true);
    } finally {
      cleanupB.resolve();
      await within(test.scheduler.close());
    }
  });

  it.each([
    "runner",
    "terminal",
  ] as const)("%s ambiguity owns sibling cleanup without an onFatal callback", async (failure) => {
    const releaseA = deferred<void>();
    const cleanupB = deferred<void>();
    const abortB = deferred<void>();
    const test = fixture({
      notifyFatal: false,
      runTask: async (task, signal) => {
        if (task.taskId === "a") {
          await releaseA.promise;
          if (failure === "runner") throw new Error("child ambiguous");
          return completed(task);
        }
        signal.addEventListener("abort", () => abortB.resolve(), { once: true });
        await cleanupB.promise;
        return cancelled(task);
      },
      persist: (record, append) => {
        if (record.type === "subagent_completed" && record.task_id === "a")
          throw new Error("child ambiguous");
        append();
      },
    });
    const [a = "", , c = ""] = await test.scheduler.submit("call-abc", input("a", "b", "c"));
    const resultA = test.scheduler.wait(a).catch((cause: unknown) => cause);
    let closure: Promise<unknown> | undefined;
    try {
      releaseA.resolve();
      expect(await within(resultA)).toEqual(new Error("child ambiguous"));
      await within(abortB.promise);
      let closed = false;
      closure = test.scheduler
        .close()
        .catch((cause: unknown) => cause)
        .then((cause) => {
          closed = true;
          return cause;
        });
      await turn();
      expect(closed).toBe(false);
      expect(test.starts).toEqual(["a", "b"]);
      expect((await within(test.scheduler.wait(c))).status).toBe("cancelled");
      expect(
        test.log
          .records("run")
          .some(
            (record) =>
              (record.type === "subagent_completed" || record.type === "subagent_failed") &&
              record.child_id === a,
          ),
      ).toBe(false);
    } finally {
      cleanupB.resolve();
      closure ??= test.scheduler.close().catch((cause: unknown) => cause);
      await within(closure);
    }
    expect(await closure).toEqual(new Error("child ambiguous"));
  });

  it("restores spent allowance and retained results without preparing a repeated submission", async () => {
    const first = fixture({ maxChildren: 1, runTask: async (task) => completed(task) });
    const ids = await first.scheduler.submit("call-a", input("a"));
    const original = await within(first.scheduler.wait(ids[0] ?? ""));
    await first.scheduler.close();
    const restored = fixture({
      log: first.log,
      maxChildren: 1,
      runTask: async (task) => completed(task),
    });
    expect(await restored.scheduler.submit("call-a", input("a"))).toEqual(ids);
    expect(restored.prepares()).toBe(0);
    expect(await restored.scheduler.wait(ids[0] ?? "")).toEqual(original);
    await expect(restored.scheduler.submit("call-b", input("b"))).rejects.toThrow(/allowance/);
    expect(restored.starts).toEqual([]);
    expect(spentDelegationSlots(first.log.records("run"), "parent")).toBe(1);
  });

  it("refuses an unfinished restored task instead of inventing an interrupted result", async () => {
    const release = deferred<void>();
    const first = fixture({
      runTask: async (task) => {
        await release.promise;
        return completed(task);
      },
    });
    const ids = await first.scheduler.submit("call-a", input("a"));
    try {
      expect(() => fixture({ log: first.log, runTask: async (task) => completed(task) })).toThrow(
        /unfinished|reconcil|ownership|terminal/,
      );
    } finally {
      release.resolve();
      await within(first.scheduler.wait(ids[0] ?? ""));
      await first.scheduler.close();
    }
  });

  it("makes B retrievable and starts C while A remains active under one shared limit", async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    const test = fixture({
      runTask: async (task) => {
        if (task.taskId === "a") await a.promise;
        if (task.taskId === "b") await b.promise;
        return completed(task);
      },
    });
    const [idA = "", idB = ""] = await test.scheduler.submit("call-ab", input("a", "b"));
    const [idC = ""] = await test.scheduler.submit("call-c", input("c"));
    expect(test.starts).toEqual(["a", "b"]);
    try {
      b.resolve();
      expect((await within(test.scheduler.wait(idB))).summary).toBe("result b");
      expect((await within(test.scheduler.wait(idC))).status).toBe("completed");
      expect(test.scheduler.status([idA])[0]?.status).toBe("running");
      expect(test.starts).toEqual(["a", "b", "c"]);
    } finally {
      a.resolve();
      await within(test.scheduler.close());
    }
  });
});
