/**
 * Regression tests for `RunHandle.abort()`.
 */

import { describe, expect, it, vi } from "vitest";

import { createInitialCheckpoint } from "../../src/core/reduce.js";
import type { MachineDefinition } from "../../src/core/types.js";
import type { LoadedManifest } from "../../src/host/manifest.js";
import { RunHandle } from "../../src/host/run-handle.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";

function makeDef(): MachineDefinition {
  return {
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: [],
    max_visits: {},
  };
}

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
