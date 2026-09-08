import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EndGuardRunner, isSupervisedProcessSupported } from "../../src/host/end-guard-runner.js";

const roots: string[] = [];
const supported = isSupervisedProcessSupported();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!supported)("EndGuardRunner", () => {
  it("passes with trusted cwd and environment", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-end-guard-"));
    roots.push(cwd);
    const result = await new EndGuardRunner(cwd, { END_GUARD_FIXTURE: "ok" }).run({
      attemptId: "attempt-1",
      supervisionId: "supervision-1",
      roleSessionId: "role-1",
      config: { command: 'test "$END_GUARD_FIXTURE" = ok && printf "%s" "$PWD"' },
    });
    expect(result.outcome).toBe("passed");
    expect(result.output).toContain(cwd);
  });

  it("reports nonzero and missing cwd failures", async () => {
    const runner = new EndGuardRunner(process.cwd());
    await expect(
      runner.run({
        attemptId: "attempt-fail",
        supervisionId: "supervision-fail",
        roleSessionId: "role-fail",
        config: { command: "exit 7" },
      }),
    ).resolves.toMatchObject({ outcome: "failed", exitCode: 7 });
    const missing = new EndGuardRunner(join(tmpdir(), "does-not-exist-end-guard"));
    await expect(
      missing.run({
        attemptId: "attempt-spawn",
        supervisionId: "supervision-spawn",
        roleSessionId: "role-spawn",
        config: { command: "true" },
      }),
    ).resolves.toMatchObject({ outcome: "spawn_error" });
  });

  it("bounds UTF-8 diagnostics and reports timeout", async () => {
    const result = await new EndGuardRunner(process.cwd()).run({
      attemptId: "attempt-timeout",
      supervisionId: "supervision-timeout",
      roleSessionId: "role-timeout",
      config: { command: "printf 'é%.0s' $(seq 1 5000); sleep 5", timeout_seconds: 1 },
    });
    expect(result.outcome).toBe("timed_out");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(4096);
    expect(result.truncated).toBe(true);
  });

  it("closes admission and awaits active abort cleanup", async () => {
    const runner = new EndGuardRunner(process.cwd());
    const run = runner.run({
      attemptId: "attempt-abort",
      supervisionId: "supervision-abort",
      roleSessionId: "role-abort",
      config: { command: "sleep 5" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await Promise.all([run, runner.abort("role-abort")]);
    expect(result[0].outcome).toBe("aborted");
    expect(result[0].cleanup).toBe("confirmed");
    await expect(
      runner.run({
        attemptId: "attempt-late",
        supervisionId: "supervision-late",
        roleSessionId: "role-abort",
        config: { command: "true" },
      }),
    ).rejects.toThrow("admission is closed");
  });

  it("rejects an already-aborted request before spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new EndGuardRunner(process.cwd()).run({
        attemptId: "attempt-preabort",
        supervisionId: "supervision-preabort",
        roleSessionId: "role-preabort",
        config: { command: "touch should-not-exist" },
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ outcome: "aborted", cleanup: "not-started" });
  });

  it("rejects overlapping guards for one physical session", async () => {
    const runner = new EndGuardRunner(process.cwd());
    const first = runner.run({
      attemptId: "attempt-first",
      supervisionId: "supervision-first",
      roleSessionId: "role-overlap",
      config: { command: "sleep 1" },
    });
    await expect(
      runner.run({
        attemptId: "attempt-second",
        supervisionId: "supervision-second",
        roleSessionId: "role-overlap",
        config: { command: "true" },
      }),
    ).rejects.toThrow("already running");
    await runner.abort("role-overlap");
    await first;
  });
});
