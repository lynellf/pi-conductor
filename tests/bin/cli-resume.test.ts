/**
 * Phase 3 — Supported resume command.
 *
 * The CLI surface is `conduct resume [options] <manifestPath> <run-id>`:
 *
 *   - exit 2 — usage error (missing manifest / missing run-id)
 *   - exit 3 — manifest file does not exist on disk
 *   - exit 1 — the original `resumeRun` error, passed through to stderr
 *   - success — `resumeRun(manifestPath, runId, { goal: "", hostFactory,
 *     baseDir, modelRegistry })` on the same production host factory,
 *     resolved base directory, model registry, signal handling, warning
 *     surface and terminal format as start
 *   - output — start-shaped: one `run_started` NDJSON event immediately
 *     after `resumeRun` resolves, then the human-readable terminal line
 *     (or the terminal JSON document under `--json`)
 *
 * The CLI wrapper is driven here with injectable `startRun` + `resumeRun`
 * mocks — the real provider is never invoked.
 *
 * The CLI's actual orchestration logic (model resolution, spawnRole,
 * reduce, persistence) lives in `src/host` and is covered by the host
 * E2E tests.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/bin/cli-main.js";
import type {
  HostFactoryContext,
  LoadedManifest,
  ResumeRunOptions,
  RunHandle,
} from "../../src/index.js";
import { InMemoryRecordLog, loadManifestFromString } from "../../src/index.js";

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
    debug: (...args: unknown[]) => stdoutLines.push(args.map(String).join(" ")),
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
  } as unknown as Console & { stdoutLines: string[]; stderrLines: string[] };
}

/** A no-op ModelRegistry stub (runCli only passes it through). */
const stubModelRegistry = {} as ModelRegistry;

/** Exit recorder — collects codes the CLI would have returned. */
function makeExit(): { fn: (code: number) => void; codes: number[] } {
  const codes: number[] = [];
  return { codes, fn: (code) => codes.push(code) };
}

/** A writable stdout recorder that exposes its captured lines. */
type Recorder = Writable & { readonly chunks: string[] };
/** The captured lines of a recorder, in write order. */
type Chunks = readonly string[];

/**
 * A capturing Writable recorder that collects every written line.
 */
function makeWritableRecorder(): Recorder {
  const chunks: string[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      if (typeof callback === "function") callback();
    },
  });
  return Object.assign(writable, { chunks });
}

/** Make a fresh tmpdir with a fixture manifest at <tmp>/manifest.yaml. */
function makeManifestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-conductor-cli-resume-"));
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

/** A deferred completion result a test can settle on demand. */
function makeDeferred<T>(value?: T): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  if (value !== undefined) resolve(value);
  return { promise, resolve };
}

/**
 * Fake handle whose `completion()` is deferred, so the test can assert the
 * start-shaped event lands before completion settles.
 */
function deferredResumeHandle(
  runId: string,
  exitReason: "done" | "session_failed" | "aborted",
  completion: ReturnType<
    typeof makeDeferred<{
      finalCheckpoint: { current_role: string };
      exitReason: string;
    }>
  >,
): ReturnType<typeof vi.fn> {
  const handle = makeFakeResumeHandle(runId, exitReason);
  return vi.fn(async () => ({
    ...handle,
    completion: () => completion.promise,
  })) as ReturnType<typeof vi.fn>;
}

/**
 * Deferred `startRun` handle for the normal-start `run_started` contract.
 * Mirrors `deferredResumeHandle` but matches the `startRun` seam
 * `(manifestPath, options) => handle` so a normal start can prove its
 * immediate NDJSON event lands before `completion()` settles.
 */
function deferredStartHandle(
  runId: string,
  completion: ReturnType<
    typeof makeDeferred<{
      finalCheckpoint: { current_role: string };
      exitReason: string;
    }>
  >,
): ReturnType<typeof vi.fn> {
  const handle = makeFakeResumeHandle(runId, "done");
  return vi.fn(async () => ({
    ...handle,
    completion: () => completion.promise,
  })) as ReturnType<typeof vi.fn>;
}

/**
 * `resumeRun` mock that resolves with a fake handle.
 */
function makeResumeRunMock(opts: {
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
  warnings?: readonly unknown[];
}): (manifestPath: string, runId: string, options: unknown) => Promise<RunHandle> {
  const failWith = opts.failWith;
  return async (_manifestPath, runId, _options) => {
    if (failWith) throw failWith;
    const finalRole = opts.finalRole ?? "done";
    const exitReason = opts.exitReason ?? "done";
    return {
      runId: opts.runId ?? runId ?? "test-run-1",
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
        warnings: opts.warnings ?? [],
        manifestDir: null,
        manifestVersion: 1,
      } as never,
    } as unknown as RunHandle;
  };
}

function makeFakeResumeHandle(
  runId: string,
  exitReason: "done" | "session_failed" | "aborted",
): RunHandle {
  return {
    runId,
    completion: async () => ({
      finalCheckpoint: { current_role: "orchestrator" },
      exitReason,
    }),
    latestResponse: () => null,
    runStats: () => ({ state: "orchestrator", exitReason, recordsCount: 1 }),
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
}

/**
 * `startRun` mock that never succeeds. Present so `runCli`'s dependency
 * seam is exercised for both providers; resume must not fall back to a
 * start.
 */
function makeStartRunNeverCalls(): { mock: ReturnType<typeof vi.fn> } {
  return {
    mock: vi.fn(async () => {
      throw new Error("startRun must not be called for a resume");
    }),
  };
}

// ─── argv parsing ───────────────────────────────────────────────────────

describe("runCli resume usage", () => {
  it("rejects a resume command with no manifest path or run-id", async () => {
    const exit = makeExit();
    const c = makeConsole();
    const code = await runCli(["resume"], {
      startRun: makeStartRunNeverCalls().mock,
      resumeRun: makeResumeRunMock({}),
      modelRegistry: stubModelRegistry,
      console: c,
      exit: exit.fn,
      cwd: process.cwd(),
    });
    expect(code).toBe(2);
    expect(exit.codes).toEqual([2]);
    expect(c.stderrLines.join("\n")).toMatch(/Usage: conduct resume/);
  });

  it("rejects a resume command with a manifest but no run-id", async () => {
    const exit = makeExit();
    const c = makeConsole();
    const code = await runCli(["resume", "manifest.yaml"], {
      startRun: makeStartRunNeverCalls().mock,
      resumeRun: makeResumeRunMock({}),
      modelRegistry: stubModelRegistry,
      console: c,
      exit: exit.fn,
      cwd: process.cwd(),
    });
    expect(code).toBe(2);
    expect(exit.codes).toEqual([2]);
    expect(c.stderrLines.join("\n")).toMatch(/Usage: conduct resume/);
  });

  it("rejects a resume command whose run-id is not a value", async () => {
    const exit = makeExit();
    const c = makeConsole();
    const code = await runCli(["resume", "manifest.yaml", "--"], {
      startRun: makeStartRunNeverCalls().mock,
      resumeRun: makeResumeRunMock({}),
      modelRegistry: stubModelRegistry,
      console: c,
      exit: exit.fn,
      cwd: process.cwd(),
    });
    expect(code).toBe(2);
    expect(exit.codes).toEqual([2]);
    expect(c.stderrLines.join("\n")).toMatch(/run-id.*is required for resume/);
  });

  it("accepts recognized options before and after the manifest", async () => {
    const dir = makeManifestDir();
    try {
      const exit = makeExit();
      const c = makeConsole();
      const code = await runCli(
        ["resume", "--json", "--log-dir", "records", "manifest.yaml", "resume-run-1"],
        {
          startRun: makeStartRunNeverCalls().mock,
          resumeRun: makeResumeRunMock({}),
          modelRegistry: stubModelRegistry,
          console: c,
          exit: exit.fn,
          cwd: dir,
          stdout: makeWritableRecorder(),
        },
      );
      expect(code).toBe(0);
      expect(exit.codes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── resumeRun delegation ───────────────────────────────────────────────

describe("runCli resume delegation to resumeRun", () => {
  it("never calls startRun and invokes resumeRun with goal '' + the handle runId", async () => {
    const dir = makeManifestDir();
    const runId = "resume-run-1";
    const startRun = makeStartRunNeverCalls().mock;
    const resumeRun = vi.fn(
      makeResumeRunMock({ runId }) as unknown as Parameters<typeof runCli>[1]["resumeRun"],
    );
    const c = makeConsole();
    try {
      const code = await runCli(["resume", "manifest.yaml", runId], {
        startRun: startRun as unknown as Parameters<typeof runCli>[1]["startRun"],
        resumeRun,
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
      });

      expect(code).toBe(0);
      expect(startRun).not.toHaveBeenCalled();
      expect(resumeRun).toHaveBeenCalledTimes(1);
      const [calledPath, calledRunId, calledOptions] = resumeRun.mock.calls[0] as [
        string,
        string,
        ResumeRunOptions,
      ];
      expect(calledPath).toBe(join(dir, "manifest.yaml"));
      expect(calledRunId).toBe(runId);
      expect(calledOptions).toMatchObject({ goal: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the resolved default and explicit --log-dir overrides as baseDir", async () => {
    const dir = makeManifestDir();
    const resumeRun = vi.fn(
      makeResumeRunMock({ runId: "resume-run-default" }) as unknown as Parameters<
        typeof runCli
      >[1]["resumeRun"],
    );
    try {
      const defaultRun = await runCli(["resume", "manifest.yaml", "resume-run-default"], {
        startRun: makeStartRunNeverCalls().mock,
        resumeRun,

        modelRegistry: stubModelRegistry,
        console: makeConsole(),
        exit: makeExit().fn,
        cwd: dir,
      });
      expect(defaultRun).toBe(0);
      const defaultBaseDir = join(dir, ".pi-conductor", "runs");
      const defaultOptions = resumeRun.mock.calls[0]?.[2] as unknown as ResumeRunOptions;
      expect(defaultBaseDir).toBe(defaultOptions.baseDir);

      const overrideResumeRun = vi.fn(
        makeResumeRunMock({ runId: "resume-run-override" }) as unknown as Parameters<
          typeof runCli
        >[1]["resumeRun"],
      );
      const overrideRun = await runCli(
        ["resume", "--log-dir", "records", "manifest.yaml", "resume-run-override"],
        {
          startRun: makeStartRunNeverCalls().mock,
          resumeRun: overrideResumeRun,
          modelRegistry: stubModelRegistry,
          console: makeConsole(),
          exit: makeExit().fn,
          cwd: dir,
        },
      );
      expect(overrideRun).toBe(0);
      const overrideOptions = overrideResumeRun.mock.calls[0]?.[2] as unknown as ResumeRunOptions;
      expect(join(dir, "records")).toBe(overrideOptions.baseDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the manifest path against cwd when it is relative", async () => {
    const dir = makeManifestDir();
    try {
      const resumeRun = vi.fn(
        makeResumeRunMock({ runId: "resume-relative" }) as unknown as Parameters<
          typeof runCli
        >[1]["resumeRun"],
      );
      await runCli(["resume", "manifest.yaml", "resume-relative"], {
        startRun: makeStartRunNeverCalls().mock,
        resumeRun,
        modelRegistry: stubModelRegistry,
        console: makeConsole(),
        exit: makeExit().fn,
        cwd: dir,
      });
      expect(resumeRun).toHaveBeenCalledTimes(1);
      expect(resumeRun.mock.calls[0]?.[0]).toBe(join(dir, "manifest.yaml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails with exit 3 when the manifest does not exist", async () => {
    const dir = makeManifestDir();
    const missingManifest = join(dir, "does-not-exist.yaml");
    try {
      const exit = makeExit();
      const c = makeConsole();
      const code = await runCli(["resume", missingManifest, "resume-run-1"], {
        startRun: makeStartRunNeverCalls().mock,
        resumeRun: makeResumeRunMock({}),
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

  it("passes an explicit --log-dir down to resumeRun and builds the same host factory as start", async () => {
    const dir = makeManifestDir();
    const logDir = join(dir, "nested", "records");
    try {
      const resumeRun = vi.fn(
        makeResumeRunMock({ runId: "resume-factory" }) as unknown as Parameters<
          typeof runCli
        >[1]["resumeRun"],
      );
      const c = makeConsole();
      const code = await runCli(
        ["resume", "--log-dir", "nested/records", "manifest.yaml", "resume-factory"],
        {
          startRun: makeStartRunNeverCalls().mock,
          resumeRun,
          modelRegistry: stubModelRegistry,
          console: c,
          exit: makeExit().fn,
          cwd: dir,
        },
      );

      expect(code).toBe(0);
      expect(existsSync(logDir)).toBe(true);
      const options = resumeRun.mock.calls[0]?.[2] as unknown as ResumeRunOptions;
      expect(options.baseDir).toBe(logDir);
      expect(options.goal).toBe("");

      // The host factory builds a production `Host` bound to the run.
      const hostFactory = options.hostFactory;
      const ctx = {
        runId: "resume-factory",
        def: {} as HostFactoryContext["def"],
        log: new InMemoryRecordLog(),
        loadedManifest: makeLoadedManifest(),
      };
      const host = hostFactory(ctx);
      expect(host).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the original resumeRun error through as exit 1 with the message on stderr", async () => {
    const dir = makeManifestDir();
    const expected = new Error(
      "resumeRun: no checkpoint_snapshot found for run_id 'resume-run-missing' in /tmp/...",
    );
    try {
      const exit = makeExit();
      const c = makeConsole();
      const code = await runCli(["resume", "manifest.yaml", "resume-run-missing"], {
        startRun: makeStartRunNeverCalls().mock,
        resumeRun: makeResumeRunMock({ failWith: expected }),
        modelRegistry: stubModelRegistry,
        console: c,
        exit: exit.fn,
        cwd: dir,
      });
      expect(code).toBe(1);
      expect(exit.codes).toEqual([]);
      expect(c.stderrLines.join("\n")).toMatch(/no checkpoint_snapshot found for run_id/);
      // No terminal output was produced — resume did not start.
      expect(c.stdoutLines).toEqual([]);
      expect(c.stderrLines.join("\n")).not.toMatch(/run_started/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── start-shaped output ────────────────────────────────────────────────

describe("runCli resume start-shaped output", () => {
  /** Poll `chunks` for the first line starting with `{`, failing fast
   *  instead of hanging. Lets a test prove the start-shaped event is on
   *  stdout while completion() is still pending. */
  async function readMatchingLine(
    chunks: readonly string[],
    predicate: (value: string) => boolean,
    windowMs = 200,
  ): Promise<string | undefined> {
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      const match = chunks.find(predicate);
      if (match !== undefined) return match;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return undefined;
  }

  it("writes the run_started event before completion settles (text mode)", async () => {
    const dir = makeManifestDir();
    const runId = "run-resume-text";
    const logDir = join(dir, "records");
    try {
      const completion = makeDeferred<{
        finalCheckpoint: { current_role: string };
        exitReason: string;
      }>();
      const resumeRun = deferredResumeHandle(runId, "done" as const, completion);
      const c = makeConsole();
      const stdout = makeWritableRecorder();
      const chunks: Chunks = stdout.chunks;
      const run = runCli(["resume", "--log-dir", "records", "manifest.yaml", runId], {
        startRun: makeStartRunNeverCalls().mock,
        resumeRun: resumeRun as unknown as NonNullable<Parameters<typeof runCli>[1]["resumeRun"]>,
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
        stdout,
      });

      // The event must already be on stdout while the handle's
      // completion() is still pending — before any completion wait.
      const event = await readMatchingLine(chunks, (value) => value.startsWith("{"));
      expect(JSON.parse(event as string)).toEqual({
        schema_version: 1,
        event: "run_started",
        run_id: runId,
        log_dir: logDir,
      });
      expect(c.stdoutLines).toEqual([]);

      // The terminal line follows the event; terminal semantics are
      // preserved (exit 0, run_id + state).
      completion.resolve({ finalCheckpoint: { current_role: "done" }, exitReason: "done" });
      expect(await run).toBe(0);
      expect(c.stdoutLines.join("\n")).toMatch(/run_id=run-resume-text/);
      expect(c.stdoutLines.join("\n")).toMatch(/state=done/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the run_started event as the first NDJSON document (--json)", async () => {
    const dir = makeManifestDir();
    const runId = "run-resume-json";
    const logDir = join(dir, "records");
    try {
      const completion = makeDeferred<{
        finalCheckpoint: { current_role: string };
        exitReason: string;
      }>();
      const resumeRun = deferredResumeHandle(runId, "done" as const, completion);
      const c = makeConsole();
      const stdout = makeWritableRecorder();
      const chunks: Chunks = stdout.chunks;
      const run = runCli(["--json", "resume", "--log-dir", "records", "manifest.yaml", runId], {
        startRun: makeStartRunNeverCalls().mock,
        resumeRun: resumeRun as unknown as NonNullable<Parameters<typeof runCli>[1]["resumeRun"]>,
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
        stdout,
      });

      const event = await readMatchingLine(chunks, (value) => value.startsWith("{"));
      expect(JSON.parse(event as string)).toEqual({
        schema_version: 1,
        event: "run_started",
        run_id: runId,
        log_dir: logDir,
      });

      completion.resolve({ finalCheckpoint: { current_role: "done" }, exitReason: "done" });
      expect(await run).toBe(0);

      // The terminal result is the final document of the stream.
      const documents = chunks.map((chunk) => JSON.parse(chunk));
      expect(documents).toHaveLength(2);
      expect(documents[1]).toMatchObject({
        schema_version: 1,
        run_id: runId,
        exit_reason: "done",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits no start event and returns exit 1 when resumeRun rejects", async () => {
    const dir = makeManifestDir();
    const c = makeConsole();
    const stdout = makeWritableRecorder();
    const chunks: Chunks = stdout.chunks;
    try {
      const resumeRun = vi.fn(
        makeResumeRunMock({ failWith: new Error("run not found") }),
      ) as unknown as NonNullable<Parameters<typeof runCli>[1]["resumeRun"]>;
      const run = runCli(["resume", "manifest.yaml", "run-resume-error"], {
        startRun: makeStartRunNeverCalls().mock,
        resumeRun,
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
        stdout,
      });

      await readMatchingLine(chunks, (value) => value.startsWith("{"));
      expect(chunks).toEqual([]);
      expect(c.stdoutLines).toEqual([]);
      expect(await run).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── normal-start run_started contract (Phase 3 repair) ────────────────

describe("runCli normal-start run_started contract", () => {
  /** Poll `chunks` for the first NDJSON line without hanging. */
  async function readStartLine(
    chunks: readonly string[],
    windowMs = 200,
  ): Promise<string | undefined> {
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      const match = chunks.find((value) => value.startsWith("{"));
      if (match !== undefined) return match;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return undefined;
  }

  it("writes one run_started event before completion settles (text mode, start)", async () => {
    const dir = makeManifestDir();
    const runId = "run-start-text";
    const logDir = join(dir, "records");
    try {
      const completion = makeDeferred<{
        finalCheckpoint: { current_role: string };
        exitReason: string;
      }>();
      const startRun = deferredStartHandle(runId, completion);
      const c = makeConsole();
      const stdout = makeWritableRecorder();
      const chunks: Chunks = stdout.chunks;
      const run = runCli(["--log-dir", "records", "manifest.yaml", "ship a fix"], {
        startRun: startRun as unknown as Parameters<typeof runCli>[1]["startRun"],
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
        stdout,
      });

      const event = await readStartLine(chunks);
      expect(event).toBeDefined();
      expect(JSON.parse(event as string)).toEqual({
        schema_version: 1,
        event: "run_started",
        run_id: runId,
        log_dir: logDir,
      });
      expect(c.stdoutLines).toEqual([]);

      completion.resolve({ finalCheckpoint: { current_role: "done" }, exitReason: "done" });
      expect(await run).toBe(0);
      expect(c.stdoutLines.join("\n")).toMatch(/run_id=run-start-text/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes run_started as the first NDJSON document (--json, start)", async () => {
    const dir = makeManifestDir();
    const runId = "run-start-json";
    const logDir = join(dir, "records");
    try {
      const completion = makeDeferred<{
        finalCheckpoint: { current_role: string };
        exitReason: string;
      }>();
      const startRun = deferredStartHandle(runId, completion);
      const c = makeConsole();
      const stdout = makeWritableRecorder();
      const chunks: Chunks = stdout.chunks;
      const run = runCli(["--json", "--log-dir", "records", "manifest.yaml", "goal"], {
        startRun: startRun as unknown as Parameters<typeof runCli>[1]["startRun"],
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
        stdout,
      });

      const event = await readStartLine(chunks);
      expect(event).toBeDefined();
      expect(JSON.parse(event as string)).toEqual({
        schema_version: 1,
        event: "run_started",
        run_id: runId,
        log_dir: logDir,
      });

      completion.resolve({ finalCheckpoint: { current_role: "done" }, exitReason: "done" });
      expect(await run).toBe(0);

      const documents = chunks.map((chunk) => JSON.parse(chunk));
      expect(documents).toHaveLength(2);
      expect(documents[0]).toEqual({
        schema_version: 1,
        event: "run_started",
        run_id: runId,
        log_dir: logDir,
      });
      expect(documents[1]).toMatchObject({
        schema_version: 1,
        run_id: runId,
        exit_reason: "done",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── warning surface ────────────────────────────────────────────────────

describe("runCli resume warning surface", () => {
  it("prints one aggregated unregistered-provider warning to stderr and still completes", async () => {
    const dir = makeManifestDir();
    try {
      const c = makeConsole();
      const code = await runCli(["resume", "manifest.yaml", "resume-run-warning"], {
        startRun: makeStartRunNeverCalls().mock,
        resumeRun: makeResumeRunMock({
          runId: "resume-run-warning",
          finalRole: "done",
          exitReason: "done",
          warnings: [
            {
              code: "unregistered-provider",
              message: "role 'orchestrator' has no model for entry 'stub:stub-model'",
            },
          ],
        }),
        modelRegistry: stubModelRegistry,
        console: c,
        exit: makeExit().fn,
        cwd: dir,
      });
      expect(code).toBe(0);
      expect(c.stderrLines.join("\n")).toMatch(/unregistered provider warning\(s\)/);
      expect(c.stderrLines.join("\n")).toContain(
        "role 'orchestrator' has no model for entry 'stub:stub-model'",
      );
      expect(c.stderrLines.join("\n")).not.toMatch(/resume warning\(s\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makeLoadedManifest(): LoadedManifest {
  return loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [stub:stub-model]
    system_prompt: roles/orchestrator.md
    tools: [handoff, end]
  - name: worker
    max_visits: 1
    models: [stub:stub-model]
    system_prompt: roles/worker.md
    tools: [handoff, end]
`);
}
