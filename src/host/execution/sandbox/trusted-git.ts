import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { trustedGitConfig, trustedGitEnvironment } from "./trusted-git-environment.js";
import {
  assertGeneratedBranch,
  assertGitObjectId,
  assertTrustedGitCapabilities,
  canonicalGeneratedWorktree,
  canonicalGitDirectory,
  canonicalGitPath,
  canonicalMissingGitPath,
  captureGitIdentity,
  GIT_OBJECT_ID,
  type GitFileIdentity,
  isSafeGitPath,
  protectGeneratedWorktree,
  sameGitIdentity,
  sameStableGitIdentity,
  TRUSTED_GIT_BINARY,
  validateSelectedGitPaths,
  verifyTrustedGitBinary,
} from "./trusted-git-validation.js";

const execute = promisify(execFile);
const BINARY = TRUSTED_GIT_BINARY;
const MAX_OUTPUT = 257 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
type IdentityName = "binary" | "gitDir" | "commonDir" | "index" | "workTree" | "controlFile";
/** Captured generated-worktree identity used by closed trusted operations. */
export interface TrustedProjectedWorktree {
  readonly binary: typeof BINARY;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly index: string;
  readonly workTree: string;
  readonly controlFile: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly identities: Readonly<Record<IdentityName, GitFileIdentity>>;
}
interface Repository extends Omit<TrustedProjectedWorktree, "branch" | "baseCommit"> {}
/** Create one generated branch/worktree and populate only approved regular blobs. */
export async function createTrustedProjectedWorktree(input: {
  readonly hostWorktreePath: string;
  readonly generatedWorktreePath: string;
  readonly generatedBranch: string;
  readonly baseCommit: string;
  readonly selectedPaths: readonly string[];
}): Promise<TrustedProjectedWorktree> {
  await assertTrustedGitCapabilities();
  assertGitObjectId(input.baseCommit);
  assertGeneratedBranch(input.generatedBranch);
  const selected = validateSelectedGitPaths(input.selectedPaths);
  const hostPath = await canonicalGitDirectory(input.hostWorktreePath);
  const generatedPath = await canonicalGeneratedWorktree(input.generatedWorktreePath);
  const host = await captureRepository(hostPath, false);
  await verifiedRun(host, [
    "worktree",
    "add",
    "--no-checkout",
    "-b",
    input.generatedBranch,
    generatedPath,
    input.baseCommit,
  ]);
  await protectGeneratedWorktree(generatedPath);

  let generated = await initializeGeneratedRepository(generatedPath, input.baseCommit);
  if (!sameStableGitIdentity(host.identities.commonDir, generated.identities.commonDir)) {
    throw new Error("generated worktree does not use the captured Git common directory");
  }
  const tracked = await verifiedRun(generated, ["ls-files", "-z"]);
  await runWithInput(generated, ["update-index", "--skip-worktree", "-z", "--stdin"], tracked);
  generated = await recaptureSameRepository(generated);
  const tree = await readTree(generated, input.baseCommit);
  for (const path of selected) {
    const entry = tree.get(path);
    if (entry === undefined)
      throw new Error(`selected Git path is absent at the pinned base: ${path}`);
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755"))
      throw new Error(`unsupported selected Git entry: ${path}`);
  }
  await runWithInput(
    generated,
    ["update-index", "--no-skip-worktree", "-z", "--stdin"],
    Buffer.from(`${selected.join("\0")}\0`),
  );
  generated = await recaptureSameRepository(generated);
  for (const path of selected) {
    const entry = tree.get(path);
    if (entry === undefined) throw new Error("selected Git entry vanished");
    await writeBlob(generated, path, entry.object, entry.mode === "100755" ? 0o755 : 0o644);
  }
  await verifyRepository(generated);
  return Object.freeze({
    ...generated,
    branch: input.generatedBranch,
    baseCommit: input.baseCommit,
  });
}

async function initializeGeneratedRepository(
  workTree: string,
  baseCommit: string,
): Promise<Repository> {
  const paths = await discover(workTree, true);
  const controlFile = join(workTree, ".git");
  await chmod(paths.gitDir, 0o700);
  await chmod(controlFile, 0o600);
  const captured = {
    binary: await captureGitIdentity(BINARY, "file"),
    gitDir: await captureGitIdentity(paths.gitDir, "directory"),
    commonDir: await captureGitIdentity(paths.commonDir, "directory"),
    workTree: await captureGitIdentity(workTree, "directory"),
    controlFile: await captureGitIdentity(controlFile, "file"),
  };
  await verifyTrustedGitBinary();
  for (const name of ["gitDir", "commonDir", "workTree", "controlFile"] as const) {
    const current = await captureGitIdentity(
      name === "workTree" ? workTree : name === "controlFile" ? controlFile : paths[name],
      name === "controlFile" ? "file" : "directory",
    );
    if (!sameGitIdentity(captured[name], current))
      throw new Error(`trusted Git identity changed: ${name}`);
  }
  await execute(BINARY, [...trustedGitConfig(), "read-tree", baseCommit], {
    cwd: workTree,
    encoding: "buffer",
    env: {
      ...trustedGitEnvironment(),
      GIT_DIR: paths.gitDir,
      GIT_COMMON_DIR: paths.commonDir,
      GIT_INDEX_FILE: paths.index,
      GIT_WORK_TREE: workTree,
    },
    maxBuffer: MAX_OUTPUT,
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  await chmod(paths.index, 0o600);
  return captureRepository(workTree, true);
}

async function recaptureSameRepository(previous: Repository): Promise<Repository> {
  await chmod(previous.index, 0o600);
  const current = await captureRepository(previous.workTree, true);
  for (const name of ["gitDir", "commonDir", "workTree", "controlFile"] as const) {
    if (!sameStableGitIdentity(previous.identities[name], current.identities[name]))
      throw new Error(`trusted Git identity changed: ${name}`);
  }
  return current;
}

/** Verify metadata and inspect only the generated branch and immutable HEAD. */
export async function inspectTrustedProjectedWorktree(
  worktree: TrustedProjectedWorktree,
): Promise<{ readonly branch: string; readonly headCommit: string }> {
  await verifyRepository(worktree);
  const branch = (await verifiedRun(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]))
    .toString()
    .trim();
  const headCommit = (await verifiedRun(worktree, ["rev-parse", "--verify", "HEAD"]))
    .toString()
    .trim();
  if (
    branch !== worktree.branch ||
    headCommit !== worktree.baseCommit ||
    !GIT_OBJECT_ID.test(headCommit)
  )
    throw new Error("trusted generated worktree branch or HEAD changed");
  return Object.freeze({ branch, headCommit });
}

async function captureRepository(workTree: string, linked: boolean): Promise<Repository> {
  const paths = await discover(workTree);
  const controlFile = join(workTree, ".git");
  const identities = Object.freeze({
    binary: await captureGitIdentity(BINARY, "file"),
    gitDir: await captureGitIdentity(paths.gitDir, "directory"),
    commonDir: await captureGitIdentity(paths.commonDir, "directory"),
    index: await captureGitIdentity(paths.index, "file"),
    workTree: await captureGitIdentity(workTree, "directory"),
    controlFile: await captureGitIdentity(controlFile, linked ? "file" : undefined),
  });
  const repository = Object.freeze({ binary: BINARY, ...paths, workTree, controlFile, identities });
  await verifyRepository(repository);
  if (JSON.stringify(paths) !== JSON.stringify(await discover(workTree)))
    throw new Error("Git metadata changed during capture");
  return repository;
}

async function discover(
  workTree: string,
  allowMissingIndex = false,
): Promise<{ gitDir: string; commonDir: string; index: string }> {
  const { stdout } = await execute(
    BINARY,
    [
      ...trustedGitConfig(),
      "-C",
      workTree,
      "rev-parse",
      "--path-format=absolute",
      "--absolute-git-dir",
      "--git-common-dir",
      "--git-path",
      "index",
    ],
    {
      encoding: "utf8",
      env: trustedGitEnvironment(),
      maxBuffer: MAX_OUTPUT,
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  const values = stdout.trimEnd().split("\n");
  if (values.length !== 3) throw new Error("Git repository discovery returned an unexpected shape");
  const gitDir = await canonicalGitPath(values[0] ?? "");
  const commonDir = await canonicalGitPath(values[1] ?? "");
  const rawIndex = values[2] ?? "";
  const index = allowMissingIndex
    ? await canonicalMissingGitPath(rawIndex)
    : await canonicalGitPath(rawIndex);
  return { gitDir, commonDir, index };
}

async function verifyRepository(repository: Repository): Promise<void> {
  await verifyTrustedGitBinary();
  const directories = new Set<IdentityName>(["gitDir", "commonDir", "workTree"]);
  for (const name of [
    "binary",
    "gitDir",
    "commonDir",
    "index",
    "workTree",
    "controlFile",
  ] as const) {
    const current = await captureGitIdentity(
      repository[name],
      directories.has(name) ? "directory" : undefined,
    );
    if (!sameGitIdentity(repository.identities[name], current))
      throw new Error(`trusted Git identity changed: ${name}`);
  }
}

async function verifiedRun(repository: Repository, args: readonly string[]): Promise<Buffer> {
  await verifyRepository(repository);
  const { stdout } = await execute(BINARY, [...trustedGitConfig(), ...args], {
    cwd: repository.workTree,
    encoding: "buffer",
    env: repositoryEnvironment(repository),
    maxBuffer: MAX_OUTPUT,
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return stdout;
}

async function runWithInput(
  repository: Repository,
  args: readonly string[],
  input: Buffer,
): Promise<void> {
  await verifyRepository(repository);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(BINARY, [...trustedGitConfig(), ...args], {
      cwd: repository.workTree,
      env: repositoryEnvironment(repository),
      stdio: ["pipe", "ignore", "pipe"],
    });
    const errors: Buffer[] = [];
    let errorBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes >= 128 * 1024) return;
      const retained = chunk.subarray(0, 128 * 1024 - errorBytes);
      errors.push(retained);
      errorBytes += retained.length;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    timer.unref();
    child.once("error", reject);
    child.stdin.once("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EPIPE") reject(cause);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `trusted Git command failed (${signal ?? code}): ${Buffer.concat(errors).toString()}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}

function repositoryEnvironment(repository: Repository): NodeJS.ProcessEnv {
  return {
    ...trustedGitEnvironment(),
    GIT_DIR: repository.gitDir,
    GIT_COMMON_DIR: repository.commonDir,
    GIT_INDEX_FILE: repository.index,
    GIT_WORK_TREE: repository.workTree,
  };
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly object: string;
}
async function readTree(repository: Repository, commit: string): Promise<Map<string, TreeEntry>> {
  const output = await verifiedRun(repository, ["ls-tree", "-rz", "-r", "--full-tree", commit]);
  const entries = new Map<string, TreeEntry>();
  for (const record of output.toString().split("\0")) {
    if (record === "") continue;
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40,64})\t(.+)$/.exec(record);
    const mode = match?.[1];
    const type = match?.[2];
    const object = match?.[3];
    const path = match?.[4];
    if (
      mode === undefined ||
      type === undefined ||
      object === undefined ||
      path === undefined ||
      !isSafeGitPath(path) ||
      entries.has(path)
    )
      throw new Error("trusted Git tree contains an unsafe or duplicate entry");
    entries.set(path, Object.freeze({ mode, type, object }));
  }
  return entries;
}

async function writeBlob(
  repository: Repository,
  path: string,
  object: string,
  mode: number,
): Promise<void> {
  assertGitObjectId(object);
  const destination = join(repository.workTree, ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const content = await verifiedRun(repository, ["cat-file", "blob", object]);
  const file = await open(destination, "wx", mode);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}
