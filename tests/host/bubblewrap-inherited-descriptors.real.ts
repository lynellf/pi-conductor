/** Issue #109: real ambient PTY descriptor admission and command regression. */

import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "vitest";

const execute = promisify(execFile);
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const vitestCli = join(repoRoot, "node_modules/vitest/vitest.mjs");
const launcherSource = join(repoRoot, "tests/fixtures/bubblewrap/inherit-ptys.c");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`issue #109 real test requires ${name}`);
  return value;
}

describe("issue #109 inherited descriptor controls", () => {
  it("keeps clean, CLOEXEC, and four concurrent inherited-PTY admissions green", async () => {
    required("PI_CONDUCTOR_BWRAP");
    required("PI_CONDUCTOR_BWRAP_SHA256");
    required("PI_CONDUCTOR_BWRAP_RUNTIME");
    if (process.platform !== "linux" || process.getuid?.() === 0)
      throw new Error("issue #109 real test requires unprivileged Linux");

    const root = await mkdtemp(join(tmpdir(), "conductor-issue-109-"));
    const launcher = join(root, "inherit-ptys");
    try {
      await execute("/usr/bin/cc", [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        launcherSource,
        "-o",
        launcher,
      ]);
      await chmod(launcher, 0o700);
      const common = [
        vitestCli,
        "run",
        "tests/host/bubblewrap-capability-probe.real.ts",
        "tests/host/bubblewrap-command-runner.real.ts",
        "--config",
        "vitest.sandbox.config.ts",
        "-t",
        "issue #109",
      ];
      await runChild(process.execPath, common, "clean");
      await runChild(launcher, ["cloexec", process.execPath, ...common], "cloexec");
      await runChild(launcher, ["inherit", process.execPath, ...common], "inherit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});

async function runChild(
  file: string,
  args: readonly string[],
  mode: "clean" | "cloexec" | "inherit",
): Promise<void> {
  try {
    await execute(file, [...args], {
      cwd: repoRoot,
      env: { ...process.env, CI: "1", PI_CONDUCTOR_ISSUE109_MODE: mode },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 180_000,
    });
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; code?: number | string };
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    throw new Error(
      `issue #109 child failed (${String(error.code ?? "unknown")}): ${output.slice(-8_000)}`,
      { cause },
    );
  }
}
