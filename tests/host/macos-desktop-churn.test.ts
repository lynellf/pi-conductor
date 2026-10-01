import type { ExecFileException, ExecFileOptionsWithStringEncoding } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeObservationFailure } from "../../src/host/execution/macos/observer-protocol.js";

const observations = { nativeCalls: 0, identityRaces: 0, otherNativeFailures: 0 };

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

// Record native errors before the production retry discards them; execute the real helper unchanged.
function traceNativeCalls(): void {
  vi.resetModules();
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return {
      ...actual,
      execFile: (
        file: string,
        args: string[],
        options: ExecFileOptionsWithStringEncoding,
        callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
      ) =>
        actual.execFile(file, args, options, (error, stdout, stderr) => {
          observations.nativeCalls++;
          if (error !== null) {
            if (nativeObservationFailure(stderr).code === "EAGAIN") observations.identityRaces++;
            else observations.otherNativeFailures++;
          }
          callback(error, stdout, stderr);
        }),
    };
  });
}

// Ordinary scoped file churn only: no service controls, reindexing, elevated privileges or process exemptions.
describe.runIf(process.platform === "darwin")("macOS desktop churn feasibility", () => {
  it("completes 200 commands while updating an owned workspace directory", async () => {
    // No Linux-skipped file installs a mock, and isolated consumers are rebuilt before native tracing.
    traceNativeCalls();
    const { runSupervisedProcess, SupervisedProcessError } = await import(
      "../../src/host/execution/supervised-process.js"
    );
    const directory = mkdtempSync(join(process.cwd(), "tmp-macos-165-churn-"));
    const commands = [
      "git status --porcelain",
      "/bin/ls >/dev/null",
      "printf 'all:\\n\\t@echo make-ok\\n' | /usr/bin/make -f -",
      `"${process.execPath}" -e 'process.stdout.write("node-ok")'`,
    ];
    const failures: unknown[] = [];
    let writes = 0;
    let passed = 0;
    let unreadableMarkerFailures = 0;
    const timer = setInterval(() => {
      writeFileSync(
        join(directory, `document-${writes++ % 64}.md`),
        `# Scoped churn\n${"text ".repeat(128)}\n${writes}\n`,
      );
    }, 25);
    try {
      for (let index = 0; index < 200; index++) {
        try {
          const result = await runSupervisedProcess({
            executionId: randomUUID(),
            command: commands[index % 4] ?? "",
            cwd: process.cwd(),
            timeoutMs: 3_000,
            onStart: () => undefined,
          });
          expect(result.exitCode, `desktop command ${index}`).toBe(0);
          passed++;
        } catch (error) {
          const diagnostic = error instanceof SupervisedProcessError ? error.diagnostic : undefined;
          if (diagnostic?.observation_error?.operation === "read_environ")
            unreadableMarkerFailures++;
          failures.push({ index, diagnostic: diagnostic ?? "observation failed" });
        }
      }
    } finally {
      clearInterval(timer);
      rmSync(directory, { recursive: true, force: true });
    }
    console.info(
      JSON.stringify({ campaign: 200, passed, writes, ...observations, unreadableMarkerFailures }),
    );
    expect(observations.nativeCalls).toBeGreaterThan(200);
    expect(failures).toEqual([]);
  }, 120_000);
});
