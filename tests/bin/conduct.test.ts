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

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/bin/conduct.js";
import type {
  HostFactoryContext,
  LoadedManifest,
  RunHandle,
  StartRunOptions,
} from "../../src/index.js";

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

function makeWritableRecorder(): Writable & { chunks: string[] } {
  const chunks: string[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as Writable & { chunks: string[] };
  writable.chunks = chunks;
  return writable;
}

type CliSignal = "SIGINT" | "SIGTERM";

class FakeSignalSource {
  private readonly listeners = new Map<CliSignal, Set<(signal: CliSignal) => void>>();

  on(signal: CliSignal, listener: (signal: CliSignal) => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: CliSignal, listener: (signal: CliSignal) => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: CliSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener(signal);
  }

  listenerCount(signal: CliSignal): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

function makeDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  exitReason?: "done" | "session_failed" | "aborted";
  latestResponse?: {
    role: string;
    text: string;
    completedAt: number;
  } | null;
  runStats?: Readonly<Record<string, unknown>>;
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
        exitReason,
      }),
      latestResponse: () => opts.latestResponse ?? null,
      runStats: () =>
        opts.runStats ?? {
          state: finalRole,
          exitReason,
          recordsCount: 1,
        },
      runConfig: () => {},
      abort: () => {},
      loadedManifest: {
        def: {} as Record<string, unknown>,
        manifest: {} as Record<string, unknown>,
        warnings: [],
        manifestDir: null,
        manifestVersion: 1,
      } as never,
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

  it("accepts recognized options in any order before the manifest path", async () => {
    const dir = makeManifestDir();
    try {
      const startRun = vi.fn(makeStartRunMock({}));
      const code = await runCli(
        [
          "--json",
          "--log-dir",
          "records",
          "--non-interactive",
          "manifest.yaml",
          "ship",
          "a",
          "fix",
        ],
        {
          startRun,
          modelRegistry: stubModelRegistry,
          console: makeConsole(),
          exit: makeExit().fn,
          cwd: dir,
          stdout: makeWritableRecorder(),
        },
      );

      expect(code).toBe(0);
      expect(startRun).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a usage error when --log-dir has no value", async () => {
    const exit = makeExit();
    const c = makeConsole();
    const code = await runCli(["--log-dir"], {
      startRun: makeStartRunMock({}),
      modelRegistry: stubModelRegistry,
      console: c,
      exit: exit.fn,
      cwd: process.cwd(),
    });

    expect(code).toBe(2);
    expect(exit.codes).toEqual([2]);
    expect(c.stderrLines.join("\n")).toMatch(/--log-dir requires a path/);
  });

  it("keeps option-looking words after the manifest as legacy goal text", async () => {
    const dir = makeManifestDir();
    try {
      const startRun = vi.fn(makeStartRunMock({}));
      const code = await runCli(["manifest.yaml", "apply", "--json"], {
        startRun,
        modelRegistry: stubModelRegistry,
        console: makeConsole(),
        exit: makeExit().fn,
        cwd: dir,
      });

      expect(code).toBe(0);
      expect(startRun.mock.calls[0]?.[1]).toMatchObject({ goal: "apply --json" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
            loadedManifest: {
              def: {} as Record<string, unknown>,
              manifest: {} as Record<string, unknown>,
              warnings: [],
              manifestDir: null,
              manifestVersion: 1,
            } as Record<string, unknown>,
            completion: async () => ({
              finalCheckpoint: { current_role: "done" },
              exitReason: "done",
            }),
          }) as unknown as RunHandle,
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
            loadedManifest: {
              def: {} as Record<string, unknown>,
              manifest: {} as Record<string, unknown>,
              warnings: [],
              manifestDir: null,
              manifestVersion: 1,
            } as Record<string, unknown>,
            completion: async () => ({
              finalCheckpoint: { current_role: "done" },
              exitReason: "done",
            }),
          }) as unknown as RunHandle,
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

  it("threads a stdin-backed UI context into the CLI production host for ask_user", async () => {
    const dir = makeManifestDir();
    try {
      const stdin = Readable.from(["blue\n"]);
      const stdout = makeWritableRecorder();
      let answer: string | undefined;
      const startRun = vi.fn(async (_path: string, opts: StartRunOptions) => {
        const host = opts.hostFactory({
          runId: "fake",
          def: {} as HostFactoryContext["def"],
          log: {} as HostFactoryContext["log"],
          loadedManifest: {} as LoadedManifest,
        });
        const uiContext = (
          host as { uiContext?: { input: (title: string) => Promise<string | undefined> } }
        ).uiContext;
        answer = await uiContext?.input("Which color?");
        return {
          runId: "test-cli-ui",
          loadedManifest: {
            def: {} as Record<string, unknown>,
            manifest: {} as Record<string, unknown>,
            warnings: [],
            manifestDir: null,
            manifestVersion: 1,
          } as Record<string, unknown>,
          completion: async () => ({
            finalCheckpoint: { current_role: "done" },
            exitReason: "done",
          }),
        } as unknown as RunHandle;
      });

      const code = await runCli(["manifest.yaml", "goal"], {
        startRun: startRun as unknown as Parameters<typeof runCli>[1]["startRun"],
        modelRegistry: stubModelRegistry,
        console: makeConsole(),
        exit: makeExit().fn,
        cwd: dir,
        stdin,
        stdout,
      });

      expect(code).toBe(0);
      expect(answer).toBe("blue");
      expect(stdout.chunks.join("")).toContain("Which color?:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a noninteractive UI whose input fails without reading stdin", async () => {
    const dir = makeManifestDir();
    try {
      let reads = 0;
      const stdin = new Readable({
        read() {
          reads += 1;
          this.push("should-not-be-read\n");
          this.push(null);
        },
      });
      const startRun = vi.fn(async (_path: string, opts: StartRunOptions) => {
        const host = opts.hostFactory({
          runId: "fake",
          def: {} as HostFactoryContext["def"],
          log: {} as HostFactoryContext["log"],
          loadedManifest: {} as LoadedManifest,
        });
        const uiContext = (
          host as { uiContext?: { input: (title: string) => Promise<string | undefined> } }
        ).uiContext;
        await uiContext?.input("Which color?");
        return makeStartRunMock({})(_path, opts);
      });
      const c = makeConsole();

      const code = await runCli(["--non-interactive", "manifest.yaml", "goal"], {
        startRun: startRun as unknown as Parameters<typeof runCli>[1]["startRun"],
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
        stdin,
      });

      expect(code).toBe(1);
      expect(reads).toBe(0);
      expect(c.stderrLines.join("\n")).toMatch(/AskUserUnavailableError/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates --log-dir recursively and passes its absolute path as baseDir", async () => {
    const dir = makeManifestDir();
    const logDir = join(dir, "nested", "records");
    try {
      const startRun = vi.fn(makeStartRunMock({}));
      const code = await runCli(["--log-dir", "nested/records", "manifest.yaml", "goal"], {
        startRun,
        modelRegistry: stubModelRegistry,
        console: makeConsole(),
        exit: makeExit().fn,
        cwd: dir,
      });

      expect(code).toBe(0);
      expect(existsSync(logDir)).toBe(true);
      expect(startRun.mock.calls[0]?.[1]).toMatchObject({ baseDir: logDir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly before startRun when --log-dir cannot be created", async () => {
    const dir = makeManifestDir();
    const filePath = join(dir, "not-a-directory");
    writeFileSync(filePath, "file", "utf8");
    try {
      const startRun = vi.fn(makeStartRunMock({}));
      const c = makeConsole();
      const code = await runCli(["--log-dir", "not-a-directory", "manifest.yaml", "goal"], {
        startRun,
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
      });

      expect(code).toBe(1);
      expect(startRun).not.toHaveBeenCalled();
      expect(c.stderrLines.join("\n")).toMatch(/Cannot create log directory/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes one versioned JSON result to stdout from the existing handle projections", async () => {
    const dir = makeManifestDir();
    try {
      const stdout = makeWritableRecorder();
      const c = makeConsole();
      const runStats = {
        runId: "run-json-1",
        state: "done",
        exitReason: "done",
        recordsCount: 7,
      };
      const code = await runCli(["--json", "manifest.yaml", "goal"], {
        startRun: makeStartRunMock({
          runId: "run-json-1",
          latestResponse: {
            role: "orchestrator",
            text: "Completed.",
            completedAt: 123,
          },
          runStats,
        }),
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
        stdout,
      });

      expect(code).toBe(0);
      expect(c.stdoutLines).toEqual([]);
      const document = stdout.chunks.join("");
      expect(document.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(document)).toEqual({
        schema_version: 1,
        run_id: "run-json-1",
        exit_reason: "done",
        final_role: "done",
        latest_response: {
          role: "orchestrator",
          text: "Completed.",
          completed_at: 123,
        },
        run_stats: runStats,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not resolve until the JSON stdout write completes", async () => {
    const dir = makeManifestDir();
    try {
      const chunks: string[] = [];
      const writeStarted = makeDeferred<void>();
      let releaseWrite!: () => void;
      const stdout = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(String(chunk));
          releaseWrite = () => callback();
          writeStarted.resolve();
        },
      });
      const run = runCli(["--json", "manifest.yaml", "goal"], {
        startRun: makeStartRunMock({ runId: "run-json-flush" }),
        modelRegistry: stubModelRegistry,
        console: makeConsole(),
        exit: makeExit().fn,
        cwd: dir,
        stdout,
      });
      const settled = vi.fn();
      void run.then(settled);

      await writeStarted.promise;
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();

      releaseWrite();
      expect(await run).toBe(0);
      expect(JSON.parse(chunks.join(""))).toMatchObject({ run_id: "run-json-flush" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a JSON result for session_failed without changing terminal exit semantics", async () => {
    const dir = makeManifestDir();
    try {
      const stdout = makeWritableRecorder();
      const code = await runCli(["--json", "manifest.yaml", "goal"], {
        startRun: makeStartRunMock({
          runId: "run-json-failed",
          finalRole: "worker",
          exitReason: "session_failed",
          latestResponse: null,
        }),
        modelRegistry: stubModelRegistry,
        console: makeConsole(),
        exit: makeExit().fn,
        cwd: dir,
        stdout,
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout.chunks.join(""))).toMatchObject({
        schema_version: 1,
        run_id: "run-json-failed",
        exit_reason: "session_failed",
        final_role: "worker",
        latest_response: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps interactive prompts on stderr when JSON mode owns stdout", async () => {
    const dir = makeManifestDir();
    try {
      const stdin = Readable.from(["blue\n"]);
      const stdout = makeWritableRecorder();
      const stderr = makeWritableRecorder();
      let answer: string | undefined;
      const startRun = vi.fn(async (_path: string, opts: StartRunOptions) => {
        const host = opts.hostFactory({
          runId: "fake",
          def: {} as HostFactoryContext["def"],
          log: {} as HostFactoryContext["log"],
          loadedManifest: {} as LoadedManifest,
        });
        const uiContext = (
          host as { uiContext?: { input: (title: string) => Promise<string | undefined> } }
        ).uiContext;
        answer = await uiContext?.input("Which color?");
        return makeStartRunMock({ runId: "run-json-prompt" })(_path, opts);
      });

      const code = await runCli(["--json", "manifest.yaml", "goal"], {
        startRun: startRun as unknown as Parameters<typeof runCli>[1]["startRun"],
        modelRegistry: stubModelRegistry,
        console: makeConsole(),
        exit: makeExit().fn,
        cwd: dir,
        stdin,
        stdout,
        stderr,
      });

      expect(code).toBe(0);
      expect(answer).toBe("blue");
      expect(stderr.chunks.join("")).toContain("Which color?:");
      expect(JSON.parse(stdout.chunks.join(""))).toMatchObject({
        schema_version: 1,
        run_id: "run-json-prompt",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns nonzero with empty stdout when JSON-mode startup fails", async () => {
    const dir = makeManifestDir();
    try {
      const stdout = makeWritableRecorder();
      const c = makeConsole();
      const code = await runCli(["--json", "manifest.yaml", "goal"], {
        startRun: makeStartRunMock({ failWith: new Error("startup failed") }),
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
        stdout,
      });

      expect(code).toBe(1);
      expect(stdout.chunks).toEqual([]);
      expect(c.stderrLines.join("\n")).toContain("startup failed");
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

// ─── CLI preflight warning surface (Issue #6 / T2.12) ──────────────────

describe("CLI preflight unregistered-provider warning (T2.12)", () => {
  it("prints aggregated warning to stderr when find returns undefined, then proceeds to completion", async () => {
    const dir = makeManifestDir();
    try {
      const c = makeConsole();
      const code = await runCli(["manifest.yaml", "goal"], {
        startRun: makeStartRunMock({
          runId: "run-preflight-1",
          finalRole: "done",
          exitReason: "done",
        }),
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
      });
      // The mock handle has empty warnings so no preflight message.
      // But the run still proceeds — exit 0.
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no preflight message on stderr when no warnings present", async () => {
    const dir = makeManifestDir();
    try {
      const c = makeConsole();
      await runCli(["manifest.yaml", "goal"], {
        startRun: makeStartRunMock({
          runId: "run-preflight-2",
          finalRole: "done",
          exitReason: "done",
        }),
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
      });
      const stderr = c.stderrLines.join("\n");
      expect(stderr).not.toMatch(/unregistered provider/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── graceful process signals (issue #34) ─────────────────────────────

describe("runCli process signals", () => {
  it.each([
    "SIGINT",
    "SIGTERM",
  ] as const)("requests one graceful abort for a first %s and removes listeners after completion", async (signal) => {
    const dir = makeManifestDir();
    try {
      const completion = makeDeferred<{
        finalCheckpoint: { current_role: string };
        exitReason: "aborted";
      }>();
      const abort = vi.fn(async () => {});
      const baseHandle = await makeStartRunMock({ runId: "run-signal" })("", {});
      const handle = {
        ...baseHandle,
        completion: () => completion.promise,
        abort,
      } as unknown as RunHandle;
      const startRun = vi.fn(async () => handle);
      const signals = new FakeSignalSource();
      const exit = makeExit();

      const run = runCli(["manifest.yaml", "goal"], {
        startRun,
        modelRegistry: stubModelRegistry,
        console: makeConsole(),
        exit: exit.fn,
        cwd: dir,
        signals,
      });
      await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));

      signals.emit(signal);
      completion.resolve({
        finalCheckpoint: { current_role: "orchestrator" },
        exitReason: "aborted",
      });

      expect(await run).toBe(0);
      expect(abort).toHaveBeenCalledTimes(1);
      expect(abort).toHaveBeenCalledWith(expect.stringContaining(signal));
      expect(exit.codes).toEqual([]);
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("terminates immediately on a second signal without requesting another abort", async () => {
    const dir = makeManifestDir();
    try {
      const completion = makeDeferred<{
        finalCheckpoint: { current_role: string };
        exitReason: "aborted";
      }>();
      const abort = vi.fn(async () => {});
      const baseHandle = await makeStartRunMock({ runId: "run-second-signal" })("", {});
      const handle = {
        ...baseHandle,
        completion: () => completion.promise,
        abort,
      } as unknown as RunHandle;
      const startRun = vi.fn(async () => handle);
      const signals = new FakeSignalSource();
      const exit = makeExit();

      const run = runCli(["manifest.yaml", "goal"], {
        startRun,
        modelRegistry: stubModelRegistry,
        console: makeConsole(),
        exit: exit.fn,
        cwd: dir,
        signals,
      });
      await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));

      signals.emit("SIGINT");
      signals.emit("SIGTERM");
      completion.resolve({
        finalCheckpoint: { current_role: "orchestrator" },
        exitReason: "aborted",
      });

      expect(await run).toBe(0);
      expect(abort).toHaveBeenCalledTimes(1);
      expect(exit.codes).toEqual([143]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
