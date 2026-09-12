import { describe, expect, it } from "vitest";

import { SandboxOperationGate } from "../../src/host/execution/sandbox/operation-gate.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeGate(): SandboxOperationGate {
  return new SandboxOperationGate({ runId: "run", childId: "child" });
}

describe("SandboxOperationGate", () => {
  it("pins its owner and rejects an abort before the first operation microtask", async () => {
    const owner = { runId: "run", childId: "child" };
    const gate = new SandboxOperationGate(owner);
    owner.childId = "replacement";
    expect(gate.owner.childId).toBe("child");
    let ran = false;
    const controller = new AbortController();
    const pending = gate.run(controller.signal, async () => {
      ran = true;
    });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted before start");
    expect(ran).toBe(false);
  });

  it("does not begin an admitted operation after a synchronous seal", async () => {
    const gate = makeGate();
    let ran = false;
    const pending = gate.run(new AbortController().signal, async () => {
      ran = true;
    });
    const cause = new Error("sealed before setup");
    gate.seal(cause);
    await expect(pending).rejects.toBe(cause);
    expect(ran).toBe(false);
  });

  it("serializes operations FIFO and waits for finalization", async () => {
    const gate = makeGate();
    const events: string[] = [];
    const first = gate.run(new AbortController().signal, async () => {
      events.push("first-start");
      await Promise.resolve();
      events.push("first-finalized");
      return "one";
    });
    const second = gate.run(new AbortController().signal, async () => {
      events.push("second-start");
      return "two";
    });
    await expect(first).resolves.toBe("one");
    await expect(second).resolves.toBe("two");
    expect(events).toEqual(["first-start", "first-finalized", "second-start"]);
  });

  it("keeps different child gates independent", async () => {
    const left = new SandboxOperationGate({ runId: "run", childId: "left" });
    const right = new SandboxOperationGate({ runId: "run", childId: "right" });
    const events: string[] = [];
    const blocker = deferred();
    const leftRun = left.run(new AbortController().signal, async () => {
      events.push("left");
      await blocker.promise;
    });
    const rightRun = right.run(new AbortController().signal, async () => events.push("right"));
    await rightRun;
    expect(events).toEqual(["left", "right"]);
    blocker.resolve();
    await leftRun;
  });

  it("removes an aborted queued operation without running it", async () => {
    const gate = makeGate();
    const blocker = deferred();
    const controller = new AbortController();
    const first = gate.run(new AbortController().signal, () => blocker.promise);
    let ran = false;
    const queued = gate.run(controller.signal, async () => {
      ran = true;
    });
    controller.abort();
    await expect(queued).rejects.toThrow("aborted before start");
    blocker.resolve();
    await first;
    expect(ran).toBe(false);
  });

  it("installs the active lock before a reentrant submission can run", async () => {
    const gate = makeGate();
    const hold = deferred();
    let nestedStarted = false;
    let nested!: Promise<void>;
    const outer = gate.run(new AbortController().signal, async () => {
      nested = gate.run(new AbortController().signal, async () => {
        nestedStarted = true;
      });
      await Promise.resolve();
      expect(nestedStarted).toBe(false);
      hold.resolve();
    });
    await outer;
    await nested;
    expect(nestedStarted).toBe(true);
  });

  it("does not unlock on running abort until cleanup settles", async () => {
    const gate = makeGate();
    const controller = new AbortController();
    const cleanup = deferred();
    const started = deferred();
    let secondStarted = false;
    const first = gate.run(controller.signal, async () => {
      started.resolve();
      await cleanup.promise;
    });
    const second = gate.run(new AbortController().signal, async () => {
      secondStarted = true;
    });
    await started.promise;
    controller.abort();
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    cleanup.resolve();
    await first;
    await second;
    expect(secondStarted).toBe(true);
  });

  it("seals new and queued operations and reports the seal after active settlement", async () => {
    const gate = makeGate();
    const active = deferred();
    const cause = new Error("cleanup unconfirmed");
    const started = deferred();
    const first = gate.run(new AbortController().signal, () => {
      started.resolve();
      return active.promise;
    });
    await started.promise;
    const queued = gate.run(new AbortController().signal, async () => undefined);
    gate.seal(cause);
    await expect(queued).rejects.toBe(cause);
    await expect(gate.run(new AbortController().signal, async () => undefined)).rejects.toBe(cause);
    let idleSettled = false;
    const idle = gate.waitForIdle().finally(() => {
      idleSettled = true;
    });
    await Promise.resolve();
    expect(idleSettled).toBe(false);
    active.resolve();
    await first;
    await expect(idle).rejects.toBe(cause);
  });
});
