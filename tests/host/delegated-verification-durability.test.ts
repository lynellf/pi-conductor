import { describe, expect, it } from "vitest";
import type { PreparedDelegateChild } from "../../src/host/delegation/admission.js";
import { pinVerificationRecipe } from "../../src/manifest/verification-recipes.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { child, completed, fixture, input } from "./delegation-scheduler-review-fixture.js";

const recipe = pinVerificationRecipe({
  name: "focused",
  commands: [{ executable: "/usr/bin/test", args: [] }],
  evaluation: "report_only",
  required_paths: ["package.json"],
  timeout_seconds: 10,
  max_calls: 2,
});

function pinnedChild(taskId: string): PreparedDelegateChild {
  return {
    ...child(taskId),
    effectiveTools: ["read", "verify"],
    verificationRecipe: recipe,
  };
}

describe("delegated verification durable authority", () => {
  it("retains pinned authority through terminal settlement and replayed redelivery", async () => {
    const log = new InMemoryRecordLog();
    const observed: PreparedDelegateChild[] = [];
    let preparations = 0;
    const first = fixture({
      log,
      prepare: async (args) => {
        preparations += 1;
        return {
          baseCommit: "base",
          materializedParentPaths: [],
          tasks: args.tasks.map((task) => pinnedChild(task.id)),
        };
      },
      runTask: async (task) => {
        observed.push(task);
        return completed(task);
      },
    });

    const ids = await first.scheduler.submit("call-1", input("task-1"));
    await first.scheduler.wait(ids[0] ?? "");
    expect(preparations).toBe(1);
    expect(observed[0]).toMatchObject({
      effectiveTools: ["read", "verify"],
      verificationRecipe: recipe,
    });
    const accepted = log
      .records("run")
      .find((record) => record.type === "delegation_submission_accepted");
    expect(
      accepted?.type === "delegation_submission_accepted" ? accepted.children[0] : null,
    ).toMatchObject({
      effective_tools: ["read", "verify"],
      verification_recipe: recipe,
    });
    await first.scheduler.close();

    let replayPreparations = 0;
    const replay = fixture({
      log,
      prepare: async () => {
        replayPreparations += 1;
        throw new Error("replay must not re-admit current manifest authority");
      },
      runTask: async (task) => completed(task),
    });
    await expect(replay.scheduler.submit("call-1", input("task-1"))).resolves.toEqual(ids);
    expect(replayPreparations).toBe(0);
    await replay.scheduler.close();
  });

  it("keeps queued authority immutable after a later submission changes its source inputs", async () => {
    const log = new InMemoryRecordLog();
    const firstGate = deferred();
    const observed: PreparedDelegateChild[] = [];
    let version: "pinned" | "changed" = "pinned";
    const test = fixture({
      log,
      maxParallel: 1,
      prepare: async (args) => ({
        baseCommit: "base",
        materializedParentPaths: [],
        tasks: args.tasks.map((task) =>
          version === "pinned"
            ? pinnedChild(task.id)
            : { ...child(task.id), effectiveTools: ["read"] as const },
        ),
      }),
      runTask: async (task) => {
        observed.push(task);
        if (task.taskId === "first") await firstGate.promise;
        return completed(task);
      },
    });

    const first = await test.scheduler.submit("call-first", input("first"));
    const secondIds = await test.scheduler.submit("call-second", input("second"));
    version = "changed";
    firstGate.resolve();
    await test.scheduler.wait(first[0] ?? "");
    await test.scheduler.wait(secondIds[0] ?? "");

    expect(observed[1]).toMatchObject({
      effectiveTools: ["read", "verify"],
      verificationRecipe: recipe,
    });
    await test.scheduler.close();
  });
});

function deferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
