/** Recoverable Git exemplar checkpointing without touching HEAD, index, or user config (§R11). */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

/** Exact repository baseline captured before the guide's first prompt. */
export interface PrewalkGitBase {
  readonly base_sha: string;
  readonly clean: boolean;
}

/** Exact detached commit pair persisted at the switch. */
export interface PrewalkGitCheckpoint {
  readonly base_sha: string;
  readonly exemplar_sha: string;
}

/** One injectable, argument-safe Git invocation. */
export interface PrewalkGitRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
}

export type PrewalkGitRunner = (request: PrewalkGitRequest) => Promise<string>;

/** Stable fail-closed error while preserving the caller's dirty exemplar. */
export class PrewalkGitCheckpointError extends Error {
  readonly code = "prewalk_git_checkpoint_failed" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrewalkGitCheckpointError";
  }
}

/** Read HEAD and porcelain cleanliness without changing repository state. */
export async function inspectPrewalkGitBase(options: {
  readonly cwd: string;
  readonly runGit?: PrewalkGitRunner;
}): Promise<PrewalkGitBase> {
  const runGit = options.runGit ?? runGitProcess;
  try {
    const baseSha = cleanOutput(
      await runGit({ cwd: options.cwd, args: ["rev-parse", "--verify", "HEAD^{commit}"] }),
    );
    assertSha(baseSha, "repository HEAD");
    const status = await runGit({
      cwd: options.cwd,
      args: ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
    });
    return Object.freeze({ base_sha: baseSha, clean: status.length === 0 });
  } catch (error) {
    throw checkpointError("Prewalk could not inspect the Git baseline", error);
  }
}

/**
 * Write a deterministic detached commit through a temporary index and retain it under a private ref.
 */
export async function createPrewalkGitCheckpoint(options: {
  readonly cwd: string;
  readonly base: PrewalkGitBase;
  readonly roleSessionId: string;
  readonly runGit?: PrewalkGitRunner;
}): Promise<PrewalkGitCheckpoint> {
  if (!options.base.clean) {
    throw new PrewalkGitCheckpointError("Prewalk requires a clean workspace before the guide starts");
  }
  assertSha(options.base.base_sha, "recorded base");
  const runGit = options.runGit ?? runGitProcess;
  const temp = await mkdtemp(join(tmpdir(), "pi-conductor-prewalk-index-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: join(temp, "index"),
    GIT_AUTHOR_NAME: "pi-conductor",
    GIT_AUTHOR_EMAIL: "pi-conductor@localhost.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "pi-conductor",
    GIT_COMMITTER_EMAIL: "pi-conductor@localhost.invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  try {
    const currentHead = cleanOutput(
      await runGit({ cwd: options.cwd, args: ["rev-parse", "--verify", "HEAD^{commit}"] }),
    );
    if (currentHead !== options.base.base_sha) {
      throw new Error("workspace HEAD moved after the guide baseline was captured");
    }
    await runGit({ cwd: options.cwd, args: ["read-tree", options.base.base_sha], env });
    await runGit({ cwd: options.cwd, args: ["add", "-A", "--", "."], env });
    const tree = cleanOutput(await runGit({ cwd: options.cwd, args: ["write-tree"], env }));
    assertSha(tree, "checkpoint tree");
    const exemplarSha = cleanOutput(
      await runGit({
        cwd: options.cwd,
        args: [
          "commit-tree",
          tree,
          "-p",
          options.base.base_sha,
          "-m",
          "pi-conductor prewalk exemplar",
        ],
        env,
      }),
    );
    assertSha(exemplarSha, "exemplar commit");
    await runGit({
      cwd: options.cwd,
      args: ["update-ref", checkpointRef(options.roleSessionId), exemplarSha],
    });
    return Object.freeze({ base_sha: options.base.base_sha, exemplar_sha: exemplarSha });
  } catch (error) {
    throw checkpointError("Prewalk could not create the recoverable exemplar commit", error);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function runGitProcess(request: PrewalkGitRequest): Promise<string> {
  const { stdout } = await execFileAsync("git", [...request.args], {
    cwd: request.cwd,
    ...(request.env !== undefined ? { env: request.env } : {}),
    ...(request.stdin !== undefined ? { input: request.stdin } : {}),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function checkpointRef(roleSessionId: string): string {
  const readable = roleSessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const suffix = readable || createHash("sha256").update(roleSessionId).digest("hex").slice(0, 16);
  return `refs/pi-conductor/prewalk/${suffix}`;
}

function cleanOutput(value: string): string {
  return value.trim();
}

function assertSha(value: string, label: string): void {
  if (!SHA_PATTERN.test(value)) throw new PrewalkGitCheckpointError(`${label} is not a commit SHA`);
}

function checkpointError(message: string, cause: unknown): PrewalkGitCheckpointError {
  return cause instanceof PrewalkGitCheckpointError
    ? cause
    : new PrewalkGitCheckpointError(message, { cause });
}
