/** Abort-aware closed Git runner for private source preparation — issue #118. */

import { spawn } from "node:child_process";
import {
  trustedGitConfig,
  trustedGitEnvironment,
} from "../execution/sandbox/trusted-git-environment.js";
import { verifyTrustedGitBinary } from "../execution/sandbox/trusted-git-validation.js";
import { SourceWorkspaceError } from "./source-workspace-contract.js";

const maxOutput = 8 * 1024 * 1024;

/** Run the closed Git command set and wait for termination when its scope aborts. */
export async function runSourceGit(
  cwd: string,
  args: readonly string[],
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  } = {},
): Promise<Buffer> {
  if (options.signal?.aborted) throw new SourceWorkspaceError("aborted");
  await verifyTrustedGitBinary();
  if (options.signal?.aborted) throw new SourceWorkspaceError("aborted");
  const child = spawn("/usr/bin/git", [...trustedGitConfig(), ...args], {
    cwd,
    env: {
      ...trustedGitEnvironment(),
      ...(options.env ?? {}),
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let byteLength = 0;
  let overflow = false;
  const stop = () => {
    if (!child.killed) child.kill("SIGKILL");
  };
  const onData = (chunk: Buffer) => {
    byteLength += chunk.length;
    if (byteLength > maxOutput) {
      overflow = true;
      stop();
      return;
    }
    stdout.push(chunk);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.reduce((size, entry) => size + entry.length, 0) < 16 * 1024) stderr.push(chunk);
  });
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const timeout = setTimeout(stop, 30_000);
  try {
    const outcome = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (options.signal?.aborted)
      throw new SourceWorkspaceError("aborted", "source preparation aborted");
    if (overflow) throw new Error("source Git output exceeds 8 MiB");
    if (outcome.code !== 0)
      throw new Error(
        `source Git command failed (${outcome.code ?? outcome.signal ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8")}`,
      );
    return Buffer.concat(stdout);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", stop);
  }
}

/** Build deterministic author identity for private synthetic source commits. */
export function sourceGitEnvironment(alternateObjects?: string): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: "pi-conductor",
    GIT_AUTHOR_EMAIL: "pi-conductor@invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "pi-conductor",
    GIT_COMMITTER_EMAIL: "pi-conductor@invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    ...(alternateObjects === undefined
      ? {}
      : { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjects }),
  };
}

/** Decode bounded Git stdout that is required to be a one-line identity. */
export function gitText(value: Buffer): string {
  return value.toString("utf8").trim();
}
