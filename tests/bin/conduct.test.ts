/**
 * CLI fallback tests (Phase 7C.3).
 *
 * The CLI is a thin wrapper around `startRun` — these tests assert
 * the wrapper behavior:
 *
 *   - argv parsing: rejects missing manifest / missing goal
 *   - manifest existence: rejects non-existent manifest path
 *   - error surface: typed errors from startRun become stderr
 *     one-liners; non-zero exit on failure
 *   - success: terminal state + run_id printed to stdout, exit 0
 *
 * The CLI's actual orchestration logic (model resolution,
 * spawnRole, reduce, persistence) lives in `src/host` and is
 * covered by the host E2E tests. The CLI's job here is just to
 * parse argv, build the host factory, call `startRun`, and report
 * the outcome on stderr/stdout/exit code.
 *
 * We exercise `runCli(argv, deps)` directly so tests don't spawn
 * a subprocess. `runCli` is exported from `src/bin/conduct.ts`
 * with injectable deps (`startRun`, `console`, `exit`, `cwd`).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/bin/conduct.js";
import type { HostFactoryContext, LoadedManifest, RunHandle } from "../../src/index.js";

// ─── Test helpers ───────────────────────────────────────────────────────

/** Capturing console — records every line written to stdout/stderr. */
function makeConsole(): Console & {
  stdoutLines: string[];
  stderrLines: string[];
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    log: (...args: unknown[]) => stdoutLines.push(args.map(String).join(" ")),
    warn: (...args: unknown[]) => stderrLines.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => stderrLines.push(args.map(String).join(" ")),
    info: (...args: unknown[]) => stdoutLines.push(args.map(String).join(" ")),
    debug: (...args: unknown[]) => stderrLines.push(args.map(String).join(" ")),
    // The remaining Console methods are unused by runCli; provide a
    // benign default that satisfies the type without recording.
    dir: () => {},
    table: () => {},
    group: () => {},
    groupEnd: () => {},
    groupCollapsed: () => {},
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
    trace: () => {},
    assert: () => {},
    profile: () => {},
    profileEnd: () => {},
    count: () => {},
    countReset: () => {},
    clear: () => {},
  } as unknown as Console & {
    stdoutLines: string[];
    stderrLines: string[];
  };
}

/** A no-op ModelRegistry stub (runCli only passes it through). */
const stubModelRegistry = {} as ModelRegistry;

/** Exit recorder — collects codes the CLI would have returned. */
function makeExit(): { fn: (code: number) => void; codes: number[] } {
  const codes: number[] = [];
  return { codes, fn: (code: number) => codes.push(code) };
}

/** Make a fresh tmpdir with a fixture manifest at <tmp>/manifest.yaml. */
function makeManifestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-conductor-cli-"));
  // Minimal valid manifest: an orchestrator + a worker. The stub
  // `startRun` we use in tests doesn't validate against the manifest's
  // model entries — it ignores the def. But the file must exist on
  // disk so the CLI's `access()` check passes.
  writeFileSync(
    join(dir, "manifest.yaml"),
    [
      "version: 1",
      "roles:",
      "  - name: orchestrator",
      "    is_orchestrator: true",
      "    system_prompt: roles/orchestrator.md",
      "  - name: worker",
      "    max_visits: 1",
      "    system_prompt: roles/worker.md",
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

/** Make a `startRun` mock that resolves with a fake handle. */
function makeStartRunMock(opts: {
  failWith?: Error;
  runId?: string;
  finalRole?: string;
  exitReason?: string;
}): (manifestPath: string, options: unknown) => Promise<RunHandle> {
  const failWith = opts.failWith;
  return async (_manifestPath, _options) => {
    if (failWith) throw failWith;
    const finalRole = opts.finalRole ?? "done";
    const exitReason = opts.exitReason ?? "done";
    return {
      runId: opts.runId ?? "test-run-1",
      completion: async () => ({
        finalCheckpoint: { current_role: finalRole },
        exitReason: exitReason as "done",
      }),
      // runStats / runConfig / abort are unused by the CLI path.
      runStats: () => ({
        current_role: finalRole,
        visits_remaining_by_role: {},
        cost_spent_usd: 0,
        budget_remaining_usd: null,
        is_terminal: true,
      }),
      runConfig: () => {},
      abort: () => {},
    } as unknown as RunHandle;
  };
}

// ─── argv parsing ───────────────────────────────────────────────────────

describe("runCli argv parsing", () => {
  it("rejects when no args are provided (missing manifest + goal)", async () => {
    const exit = makeExit();
    const c = makeConsole();
    const code = await runCli([], {
      startRun: makeStartRunMock({}),
      modelRegistry: stubModelRegistry,
      console: c,
      exit: exit.fn,
      cwd: process.cwd(),
    });
    expect(code).toBe(2);
    expect(exit.codes).toEqual([2]);
    expect(c.stderrLines.some((l) => /Usage:.*conduct/.test(l))).toBe(true);
  });

  it("rejects when manifest path is provided but goal is missing", async () => {
    const exit = makeExit();
    const c = makeConsole();
    const code = await runCli(["manifest.yaml"], {
      startRun: makeStartRunMock({}),
      modelRegistry: stubModelRegistry,
      console: c,
      exit: exit.fn,
      cwd: process.cwd(),
    });
    expect(code).toBe(2);
    expect(exit.codes).toEqual([2]);
    expect(c.stderrLines.some((l) => /Usage:.*conduct/.test(l))).toBe(true);
  });

  it("rejects when goal is whitespace-only", async () => {
    const exit = makeExit();
    const c = makeConsole();
    const code = await runCli(["manifest.yaml", "   "], {
      startRun: makeStartRunMock({}),
      modelRegistry: stubModelRegistry,
      console: c,
      exit: exit.fn,
      cwd: process.cwd(),
    });
    // Whitespace-only goal should be treated as missing.
    expect(code).toBe(2);
  });
});

// ─── manifest existence ─────────────────────────────────────────────────

describe("runCli manifest existence", () => {
  it("rejects a manifest path that does not exist on disk", async () => {
    const dir = makeManifestDir();
    const fakeManifest = join(dir, "does-not-exist.yaml");
    try {
      const exit = makeExit();
      const c = makeConsole();
      const code = await runCli([fakeManifest, "goal"], {
        startRun: makeStartRunMock({}),
        modelRegistry: stubModelRegistry,
        console: c,
        exit: exit.fn,
        cwd: dir,
      });
      expect(code).toBe(3);
      expect(exit.codes).toEqual([3]);
      expect(c.stderrLines.some((l) => /Manifest not found/.test(l))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the manifest path against cwd when it is relative", async () => {
    const dir = makeManifestDir();
    try {
      const startRun = vi.fn(
        async (_path: string, _opts: unknown) =>
          ({
            runId: "test",
            completion: async () => ({
              finalCheckpoint: { current_role: "done" },
              exitReason: "done",
            }),
          }) as RunHandle,
      );
      const exit = makeExit();
      const c = makeConsole();
      await runCli(["manifest.yaml", "goal"], {
        startRun: startRun as unknown as Parameters<typeof runCli>[1]["startRun"],
        modelRegistry: stubModelRegistry,
        console: c,
        exit: exit.fn,
        cwd: dir,
      });
      // startRun should have been called with the absolute manifest path.
      expect(startRun).toHaveBeenCalledTimes(1);
      const firstArg = startRun.mock.calls[0]?.[0] as string;
      expect(firstArg).toBe(join(dir, "manifest.yaml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── startRun delegation ────────────────────────────────────────────────

describe("runCli delegation to startRun", () => {
  it("builds a production host factory and passes (manifestPath, goal, hostFactory) to startRun", async () => {
    const dir = makeManifestDir();
    try {
      const startRun = vi.fn(
        async (_path: string, _opts: unknown) =>
          ({
            runId: "test-1",
            completion: async () => ({
              finalCheckpoint: { current_role: "done" },
              exitReason: "done",
            }),
          }) as RunHandle,
      );
      const c = makeConsole();
      await runCli(["manifest.yaml", "ship a fix"], {
        startRun: startRun as unknown as Parameters<typeof runCli>[1]["startRun"],
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
      });
      expect(startRun).toHaveBeenCalledTimes(1);
      const [calledPath, calledOpts] = startRun.mock.calls[0] ?? [];
      expect(calledPath).toBe(join(dir, "manifest.yaml"));
      const opts = calledOpts as {
        goal: string;
        hostFactory: (ctx: HostFactoryContext) => unknown;
      };
      expect(opts.goal).toBe("ship a fix");
      // The host factory is callable; invoking it returns a Host.
      const fakeCtx = {
        runId: "fake",
        def: {} as HostFactoryContext["def"],
        log: {} as HostFactoryContext["log"],
        loadedManifest: {} as LoadedManifest,
      };
      expect(() => opts.hostFactory(fakeCtx)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns exit 0 and prints run_id + terminal state on successful run", async () => {
    const dir = makeManifestDir();
    try {
      const c = makeConsole();
      const code = await runCli(["manifest.yaml", "goal"], {
        startRun: makeStartRunMock({
          runId: "run-abc-123",
          finalRole: "done",
          exitReason: "done",
        }),
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
      });
      expect(code).toBe(0);
      // stdout carries the run_id and terminal state.
      const stdout = c.stdoutLines.join("\n");
      expect(stdout).toMatch(/run_id=run-abc-123/);
      expect(stdout).toMatch(/state=done/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns non-zero and prints the error message when startRun throws a typed model error", async () => {
    const dir = makeManifestDir();
    try {
      class FakeModelNotFoundError extends Error {
        override name = "ModelNotFoundError";
        constructor() {
          super(
            "ModelNotFoundError: role 'orchestrator' has no registered model for entry 'openai:gpt-999' (§8.1)",
          );
        }
      }
      const c = makeConsole();
      const code = await runCli(["manifest.yaml", "goal"], {
        startRun: makeStartRunMock({ failWith: new FakeModelNotFoundError() }),
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
      });
      expect(code).toBe(1);
      const stderr = c.stderrLines.join("\n");
      expect(stderr).toMatch(/ModelNotFoundError/);
      expect(stderr).toMatch(/openai:gpt-999/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns non-zero and prints the error message when manifest parse fails", async () => {
    const dir = makeManifestDir();
    try {
      const c = makeConsole();
      const code = await runCli(["manifest.yaml", "goal"], {
        startRun: makeStartRunMock({
          failWith: new Error("ManifestParseError: role 'orchestrator' has no models"),
        }),
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
      });
      expect(code).toBe(1);
      const stderr = c.stderrLines.join("\n");
      expect(stderr).toMatch(/ManifestParseError/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
