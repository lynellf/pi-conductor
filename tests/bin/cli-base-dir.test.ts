/**
 * Phase 1 — CLI durable-directory contract.
 *
 * The CLI's omitted `baseDir` must resolve to a durable run directory
 * (`<cwd>/.pi-conductor/runs`) so standalone runs are discoverable and
 * resumable. An explicit `--log-dir` stays an absolute override.
 *
 * RED: assert #1 must FAIL against the current CLI (it omits `baseDir`
 * when no `--log-dir` is given); assert #2 must PASS (existing override
 * behavior is preserved). The library's own omitted-`baseDir` temporary
 * default is untouched — see `tests/host/api.test.ts`.
 *
 * `runCli` only uses `error`/`log`/`warn` on its console, so a tiny
 * recorder is enough; helpers here mirror `conduct.test.ts`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/bin/cli-main.js";
import type { RunHandle, StartRunOptions } from "../../src/index.js";

const MANIFEST = [
  "version: 1",
  "roles:",
  "  - name: orchestrator",
  "    is_orchestrator: true",
  "    system_prompt: roles/orchestrator.md",
  "  - name: worker",
  "    max_visits: 1",
  "    system_prompt: roles/worker.md",
  "",
].join("\n");

function makeManifestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-conductor-cli-base-"));
  writeFileSync(join(dir, "manifest.yaml"), MANIFEST, "utf8");
  return dir;
}

function makeConsole(): Console & { stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    log: (...args: unknown[]) => stdoutLines.push(args.map(String).join(" ")),
    warn: (...args: unknown[]) => stderrLines.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => stderrLines.push(args.map(String).join(" ")),
  } as unknown as Console & { stdoutLines: string[]; stderrLines: string[] };
}

const stubModelRegistry = {} as ModelRegistry;

function makeExit(): { fn: (code: number) => void; codes: number[] } {
  const codes: number[] = [];
  return { codes, fn: (code) => codes.push(code) };
}

function makeStartRunMock(): { mock: ReturnType<typeof vi.fn>; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const mock = vi.fn(async (manifestPath: string, opts: StartRunOptions) => {
    calls.push([manifestPath, opts]);
    return {
      runId: "test-run-1",
      completion: async () => ({
        finalCheckpoint: { current_role: "done" },
        exitReason: "done",
      }),
      latestResponse: () => null,
      runStats: () => ({ state: "done", exitReason: "done", recordsCount: 1 }),
      loadedManifest: {
        def: {} as never,
        manifest: {} as never,
        warnings: [],
        manifestDir: null,
        manifestVersion: 1,
      },
    } as unknown as RunHandle;
  });
  return { mock, calls };
}

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

/**
 * `resumeRun` mock that resolves with a fake handle. The run-id comes
 * from the second argument (mirroring the real host seam).
 */
describe("CLI base directory resolution", () => {
  it("passes the absolute <cwd>/.pi-conductor/runs directory as baseDir on a normal start", async () => {
    const dir = makeManifestDir();
    const startRun = makeStartRunMock().mock;
    try {
      const code = await runCli(["manifest.yaml", "goal"], {
        startRun: startRun as unknown as Parameters<typeof runCli>[1]["startRun"],
        resumeRun: makeResumeRunMock({}),
        modelRegistry: stubModelRegistry,
        console: makeConsole(),
        exit: makeExit().fn,
        cwd: dir,
      });

      expect(code).toBe(0);
      expect(startRun).toHaveBeenCalledTimes(1);
      expect(startRun.mock.calls[0]?.[1]).toMatchObject({
        baseDir: join(dir, ".pi-conductor", "runs"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes an explicit --log-dir resolved to an absolute path as baseDir", async () => {
    const dir = makeManifestDir();
    const logDir = join(dir, "nested", "records");
    const startRun = makeStartRunMock().mock;
    try {
      const code = await runCli(["--log-dir", "nested/records", "manifest.yaml", "goal"], {
        startRun: startRun as unknown as Parameters<typeof runCli>[1]["startRun"],
        resumeRun: makeResumeRunMock({}),
        modelRegistry: stubModelRegistry,
        console: makeConsole(),
        exit: makeExit().fn,
        cwd: dir,
      });

      expect(code).toBe(0);
      expect(startRun).toHaveBeenCalledTimes(1);
      expect(startRun.mock.calls[0]?.[1]).toMatchObject({ baseDir: logDir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
