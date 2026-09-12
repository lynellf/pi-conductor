/**
 * Regression tests for `RunHandle.abort()`.
 */

import { describe, expect, it, vi } from "vitest";

import { createInitialCheckpoint } from "../../src/core/reduce.js";
import type { MachineDefinition, SessionLifecycleEvent } from "../../src/core/types.js";
import type { LoadedManifest } from "../../src/host/manifest.js";
import type { RunControl, RunResponse } from "../../src/host/run-control.js";
import { RunHandle } from "../../src/host/run-handle.js";
import { type CheckpointSnapshot, InMemoryRecordLog } from "../../src/persistence/log.js";

function makeDef(): MachineDefinition {
  return {
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: [],
    max_visits: {},
    end_request_roles: null,
  };
}

function makeHandleWithControl(runControl: RunControl): RunHandle {
  const def = makeDef();
  const log = new InMemoryRecordLog();
  return new RunHandle({
    runId: "controlled-run",
    def,
    log,
    loadedManifest: {
      def,
      manifest: { version: 1, roles: [] } as unknown as LoadedManifest["manifest"],
      warnings: [],
      manifestDir: null,
      manifestVersion: 1,
    },
    configOverrideContainer: { current: {} },
    requestAbort: vi.fn().mockResolvedValue(undefined),
    completionPromise: new Promise(() => undefined),
    runControl,
  });
}

describe("RunHandle operator controls", () => {
  it("reads one log snapshot for each status result", () => {
    const handle = makeHandleWithControl({} as RunControl);
    const reads = vi.spyOn(handle.log, "records");

    expect(handle.runStats()).toMatchObject({ state: "orchestrator", exitReason: "running" });
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("delegates steer and followUp to the run-owned control", async () => {
    const steer = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const runControl = { steer, followUp, latestResponse: vi.fn().mockReturnValue(null) };
    const handle = makeHandleWithControl(runControl as unknown as RunControl);

    await handle.steer("redirect");
    await handle.followUp("next turn");

    expect(steer).toHaveBeenCalledWith("redirect");
    expect(followUp).toHaveBeenCalledWith("next turn");
  });

  it("returns the control's latest completed response", () => {
    const response: RunResponse = {
      runId: "controlled-run",
      role: "reviewer",
      sessionId: "reviewer-1",
      text: "ready to copy",
      completedAt: 42,
    };
    const runControl = {
      steer: vi.fn(),
      followUp: vi.fn(),
      latestResponse: vi.fn().mockReturnValue(response),
    };
    const handle = makeHandleWithControl(runControl as unknown as RunControl);

    expect(handle.latestResponse()).toEqual(response);
  });

  it("keeps the completed failure status after trailing records are appended", async () => {
    const def = { ...makeDef(), workers: ["worker"], max_visits: { worker: 1 } };
    const log = new InMemoryRecordLog();
    const finalCheckpoint = {
      ...createInitialCheckpoint(def),
      run_id: "failed-run",
      current_role: "worker" as const,
    };
    const handle = new RunHandle({
      runId: "failed-run",
      def,
      log,
      loadedManifest: {
        def,
        manifest: { version: 1, roles: [] } as unknown as LoadedManifest["manifest"],
        warnings: [],
        manifestDir: null,
        manifestVersion: 1,
      },
      configOverrideContainer: { current: {} },
      requestAbort: vi.fn().mockResolvedValue(undefined),
      completionPromise: Promise.resolve({
        finalCheckpoint,
        exitReason: "session_failed" as const,
      }),
    });

    await handle.completion();
    log.append({
      type: "session_failed",
      run_id: "failed-run",
      role: "worker",
      visit_index: 1,
      state: "worker",
      model: null,
      session_file: "session.jsonl",
      parent_session: null,
      failure_reason: "tool_cleanup_unconfirmed",
      ts: 1,
    } satisfies SessionLifecycleEvent);
    log.append({
      type: "checkpoint_snapshot",
      checkpoint: finalCheckpoint,
    } satisfies CheckpointSnapshot);

    expect(handle.runStats().exitReason).toBe("session_failed");
  });

  it("does not expose a failure until pending completion settles during recovery", async () => {
    const def = makeDef();
    const log = new InMemoryRecordLog();
    let settle!: (value: {
      finalCheckpoint: ReturnType<typeof createInitialCheckpoint>;
      exitReason: "session_failed";
    }) => void;
    const completionPromise = new Promise<{
      finalCheckpoint: ReturnType<typeof createInitialCheckpoint>;
      exitReason: "session_failed";
    }>((resolve) => {
      settle = resolve;
    });
    const handle = new RunHandle({
      runId: "recovering-run",
      def,
      log,
      loadedManifest: {
        def,
        manifest: { version: 1, roles: [] } as unknown as LoadedManifest["manifest"],
        warnings: [],
        manifestDir: null,
        manifestVersion: 1,
      },
      configOverrideContainer: { current: {} },
      requestAbort: vi.fn().mockResolvedValue(undefined),
      completionPromise,
    });
    log.append({
      type: "session_failed",
      run_id: "recovering-run",
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: null,
      session_file: "session.jsonl",
      parent_session: null,
      failure_reason: "tool_cleanup_unconfirmed",
      ts: 1,
    } satisfies SessionLifecycleEvent);
    log.append({
      type: "session_started",
      run_id: "recovering-run",
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: null,
      session_file: "session.jsonl",
      parent_session: null,
      ts: 1,
    } satisfies SessionLifecycleEvent);

    expect(handle.runStats().exitReason).toBe("running");
    settle({ finalCheckpoint: createInitialCheckpoint(def), exitReason: "session_failed" });
    await handle.completion();
    expect(handle.runStats().exitReason).toBe("session_failed");
  });
});

describe("RunHandle.abort()", () => {
  it("is a no-op after the run has already reached a terminal state", async () => {
    const def = makeDef();
    const log = new InMemoryRecordLog();
    const checkpoint = { ...createInitialCheckpoint(def), current_role: "done" as const };
    log.append({ type: "checkpoint_snapshot", checkpoint });

    const requestAbort = vi.fn().mockResolvedValue(undefined);
    const handle = new RunHandle({
      runId: checkpoint.run_id,
      def,
      log,
      loadedManifest: {
        def,
        manifest: { version: 1, roles: [] } as unknown as LoadedManifest["manifest"],
        warnings: [],
        manifestDir: null,
        manifestVersion: 1,
      },
      configOverrideContainer: { current: {} },
      requestAbort,
      completionPromise: Promise.resolve({
        finalCheckpoint: checkpoint,
        exitReason: "done",
      }),
    });

    expect(handle.runStats().exitReason).toBe("done");

    await handle.abort("escape");

    expect(requestAbort).not.toHaveBeenCalled();
    expect(handle.isAborted()).toEqual({ aborted: false, reason: null });
    expect(handle.runStats().exitReason).toBe("done");
  });
});

describe("RunHandle.loadedManifest (T2.11)", () => {
  it("constructor stores and exposes loadedManifest as the same reference", () => {
    const def = makeDef();
    const log = new InMemoryRecordLog();
    const manifestStub: LoadedManifest = {
      def,
      manifest: { version: 1, roles: [] } as unknown as LoadedManifest["manifest"],
      warnings: [],
      manifestDir: null,
      manifestVersion: 1,
    };

    const handle = new RunHandle({
      runId: "test-loaded-manifest",
      def,
      log,
      loadedManifest: manifestStub,
      configOverrideContainer: { current: {} },
      requestAbort: vi.fn().mockResolvedValue(undefined),
      completionPromise: new Promise(() => {
        // never resolves — the test doesn't await completion().
      }),
    });

    // Reference equality: the handle exposes the exact same object.
    expect(handle.loadedManifest).toBe(manifestStub);
    // Read-only surface (no setters — access is just a property read).
    expect(handle.loadedManifest.def).toBe(def);
    expect(handle.loadedManifest.warnings).toEqual([]);
  });

  it("loadedManifest is read-only (no setter exposed)", () => {
    const def = makeDef();
    const log = new InMemoryRecordLog();
    const manifestStub: LoadedManifest = {
      def,
      manifest: { version: 1, roles: [] } as unknown as LoadedManifest["manifest"],
      warnings: [],
      manifestDir: null,
      manifestVersion: 1,
    };

    const handle = new RunHandle({
      runId: "test-loaded-manifest-ro",
      def,
      log,
      loadedManifest: manifestStub,
      configOverrideContainer: { current: {} },
      requestAbort: vi.fn().mockResolvedValue(undefined),
      completionPromise: new Promise(() => {
        // never resolves.
      }),
    });

    // The field is `readonly` — TS catches writes. At runtime,
    // reading the field returns the original reference.
    expect(handle.loadedManifest.manifestVersion).toBe(1);
  });
});

describe("RunHandle.originalGoal()", () => {
  it("returns empty string when no run_seeded record exists", () => {
    const def = makeDef();
    const log = new InMemoryRecordLog();
    log.append({ type: "checkpoint_snapshot", checkpoint: createInitialCheckpoint(def) });

    const handle = new RunHandle({
      runId: createInitialCheckpoint(def).run_id,
      def,
      log,
      loadedManifest: {
        def,
        manifest: { version: 1, roles: [] } as unknown as LoadedManifest["manifest"],
        warnings: [],
        manifestDir: null,
        manifestVersion: 1,
      },
      configOverrideContainer: { current: {} },
      requestAbort: vi.fn().mockResolvedValue(undefined),
      completionPromise: new Promise(() => {
        // never resolves.
      }),
    });

    expect(handle.originalGoal()).toBe("");
  });

  it("returns the goal from the latest run_seeded record", () => {
    const def = makeDef();
    const log = new InMemoryRecordLog();
    const cp = createInitialCheckpoint(def);
    log.append({ type: "checkpoint_snapshot", checkpoint: cp });
    log.append({
      type: "run_seeded",
      run_id: cp.run_id,
      goal: "fix the bug in foo.ts",
      ts: Date.now(),
    });

    const handle = new RunHandle({
      runId: cp.run_id,
      def,
      log,
      loadedManifest: {
        def,
        manifest: { version: 1, roles: [] } as unknown as LoadedManifest["manifest"],
        warnings: [],
        manifestDir: null,
        manifestVersion: 1,
      },
      configOverrideContainer: { current: {} },
      requestAbort: vi.fn().mockResolvedValue(undefined),
      completionPromise: new Promise(() => {
        // never resolves.
      }),
    });

    expect(handle.originalGoal()).toBe("fix the bug in foo.ts");
  });

  it("returns the latest goal when multiple run_seeded records exist", () => {
    const def = makeDef();
    const log = new InMemoryRecordLog();
    const cp = createInitialCheckpoint(def);
    log.append({ type: "checkpoint_snapshot", checkpoint: cp });
    log.append({
      type: "run_seeded",
      run_id: cp.run_id,
      goal: "first goal",
      ts: 100,
    });
    log.append({
      type: "run_seeded",
      run_id: cp.run_id,
      goal: "latest goal",
      ts: 200,
    });

    const handle = new RunHandle({
      runId: cp.run_id,
      def,
      log,
      loadedManifest: {
        def,
        manifest: { version: 1, roles: [] } as unknown as LoadedManifest["manifest"],
        warnings: [],
        manifestDir: null,
        manifestVersion: 1,
      },
      configOverrideContainer: { current: {} },
      requestAbort: vi.fn().mockResolvedValue(undefined),
      completionPromise: new Promise(() => {
        // never resolves.
      }),
    });

    expect(handle.originalGoal()).toBe("latest goal");
  });
});
