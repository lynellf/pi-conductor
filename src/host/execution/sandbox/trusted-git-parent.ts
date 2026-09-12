/** Filter-free primary checkout capture for sandbox delegation admission (#106 §4). */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ParentMaterializedProjection } from "../../delegation/projection.js";
import { type SandboxDirectory, withSandboxDirectory } from "./anchored-file-access.js";
import { trustedGitConfig, trustedGitEnvironment } from "./trusted-git-environment.js";
import {
  assertTrustedGitCapabilities,
  canonicalGitDirectory,
  canonicalGitPath,
  captureGitIdentity,
  isSafeGitPath,
  sameGitIdentity,
  TRUSTED_GIT_BINARY,
  verifyTrustedGitBinary,
} from "./trusted-git-validation.js";

const execute = promisify(execFile);
const MAX_METADATA = 16 * 1024 * 1024;

interface ParentRepository {
  readonly binary: typeof TRUSTED_GIT_BINARY;
  readonly workTree: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly index: string;
  readonly controlFile: string;
  readonly identities: Readonly<
    Record<
      "binary" | "workTree" | "gitDir" | "commonDir" | "index" | "controlFile",
      Awaited<ReturnType<typeof captureGitIdentity>>
    >
  >;
}

/** Capture a clean raw primary projection without invoking Git conversion machinery. */
export async function captureTrustedParentProjection(
  primaryCheckout: string,
): Promise<ParentMaterializedProjection> {
  await verifyTrustedGitBinary();
  const repository = await captureParentRepository(primaryCheckout);
  const head = text(await run(repository, ["rev-parse", "--verify", "HEAD"]));
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head))
    throw new Error("trusted parent HEAD is not an immutable object ID");
  const tree = parseTree(await run(repository, ["ls-tree", "-rz", "-r", "--full-tree", head]));
  const index = parseIndex(await run(repository, ["ls-files", "--stage", "-z"]));
  assertTreeMatchesIndex(tree, index);

  const tags = parseTags(await run(repository, ["ls-files", "-t", "-z"]));
  if (tags.size !== index.size || [...tags.keys()].some((path) => !index.has(path)))
    throw new Error("trusted parent index tag capture is incomplete");
  const materialized: string[] = [];
  let isSparse = false;
  await withSandboxDirectory(repository.workTree, async (files) => {
    for (const [path, tag] of tags) {
      if (tag === "S") {
        isSparse = true;
        continue;
      }
      if (tag !== "H" || !isSafeGitPath(path))
        throw new Error(`unsupported materialized parent path: ${path}`);
      const expected = index.get(path);
      if (expected === undefined) throw new Error("trusted parent index changed during capture");
      await assertWorkingBlob(files, path, expected);
      materialized.push(path);
    }
  });
  const untracked = nulPaths(
    await run(repository, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  if (untracked.length > 0)
    throw new Error(`trusted parent has untracked materialized paths: ${untracked[0]}`);
  await verifyParentRepository(repository);
  if (text(await run(repository, ["rev-parse", "--verify", "HEAD"])) !== head)
    throw new Error("trusted parent HEAD changed during capture");
  return Object.freeze({
    baseCommit: head,
    paths: Object.freeze(materialized.sort()),
    trackedPaths: Object.freeze([...index.keys()].sort()),
    isSparse,
  });
}

/** Read one bounded raw blob from an immutable primary commit without filters. */
export async function readTrustedParentBlob(
  primaryCheckout: string,
  baseCommit: string,
  path: string,
  maxBytes: number,
): Promise<{ readonly bytes: Buffer } | { readonly oversizedByteLength: number }> {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(baseCommit))
    throw new Error("trusted parent blob revision must be immutable");
  if (!isSafeGitPath(path)) throw new Error("trusted parent blob path is unsafe");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 256 * 1024 * 1024)
    throw new Error("trusted parent blob byte bound is invalid");
  const repository = await captureParentRepository(primaryCheckout);
  const object = `${baseCommit}:${path}`;
  if (text(await run(repository, ["cat-file", "-t", object])) !== "blob")
    throw new Error("trusted parent object is not a blob");
  const sizeText = text(await run(repository, ["cat-file", "-s", object]));
  if (!/^\d+$/.test(sizeText)) throw new Error("trusted parent blob size is invalid");
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size)) throw new Error("trusted parent blob size exceeds safe bounds");
  if (size > maxBytes) return Object.freeze({ oversizedByteLength: size });
  await verifyParentRepository(repository);
  const { stdout } = await execute(
    TRUSTED_GIT_BINARY,
    [...trustedGitConfig(), "cat-file", "blob", object],
    {
      ...options(),
      cwd: repository.workTree,
      encoding: "buffer",
      maxBuffer: maxBytes + 1,
      env: repositoryEnvironment(repository),
    },
  );
  if (stdout.length !== size) throw new Error("trusted parent blob size changed during read");
  await verifyParentRepository(repository);
  return Object.freeze({ bytes: stdout });
}

async function captureParentRepository(input: string): Promise<ParentRepository> {
  await assertTrustedGitCapabilities();
  const workTree = await canonicalGitDirectory(input);
  const { stdout } = await execute(
    TRUSTED_GIT_BINARY,
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
    options(),
  );
  const values = stdout.trimEnd().split("\n");
  if (values.length !== 3)
    throw new Error("trusted parent Git discovery returned an unexpected shape");
  const gitDir = await canonicalGitPath(values[0] ?? "");
  const commonDir = await canonicalGitPath(values[1] ?? "");
  const index = await canonicalGitPath(values[2] ?? "");
  const controlFile = `${workTree}/.git`;
  const identities = Object.freeze({
    binary: await captureGitIdentity(TRUSTED_GIT_BINARY, "file"),
    workTree: await captureGitIdentity(workTree, "directory"),
    gitDir: await captureGitIdentity(gitDir, "directory"),
    commonDir: await captureGitIdentity(commonDir, "directory"),
    index: await captureGitIdentity(index, "file"),
    controlFile: await captureGitIdentity(controlFile),
  });
  const repository = Object.freeze({
    binary: TRUSTED_GIT_BINARY,
    workTree,
    gitDir,
    commonDir,
    index,
    controlFile,
    identities,
  });
  await verifyParentRepository(repository);
  return repository;
}

async function verifyParentRepository(repository: ParentRepository): Promise<void> {
  await verifyTrustedGitBinary();
  for (const name of [
    "binary",
    "workTree",
    "gitDir",
    "commonDir",
    "index",
    "controlFile",
  ] as const) {
    const current = await captureGitIdentity(
      repository[name],
      name === "index" || name === "binary"
        ? "file"
        : name === "controlFile"
          ? undefined
          : "directory",
    );
    if (!sameGitIdentity(repository.identities[name], current))
      throw new Error(`trusted parent Git identity changed: ${name}`);
  }
}

async function run(repository: ParentRepository, args: readonly string[]): Promise<Buffer> {
  await verifyParentRepository(repository);
  const { stdout } = await execute(TRUSTED_GIT_BINARY, [...trustedGitConfig(), ...args], {
    ...options(),
    cwd: repository.workTree,
    encoding: "buffer",
    env: repositoryEnvironment(repository),
  });
  return stdout;
}

function repositoryEnvironment(repository: ParentRepository): NodeJS.ProcessEnv {
  return {
    ...trustedGitEnvironment(),
    GIT_DIR: repository.gitDir,
    GIT_COMMON_DIR: repository.commonDir,
    GIT_INDEX_FILE: repository.index,
    GIT_WORK_TREE: repository.workTree,
  };
}

function options() {
  return {
    encoding: "utf8" as const,
    env: trustedGitEnvironment(),
    maxBuffer: MAX_METADATA,
    timeout: 10_000,
    killSignal: "SIGKILL" as const,
  };
}

interface IndexEntry {
  readonly mode: string;
  readonly object: string;
}
function parseTree(output: Buffer): Map<string, IndexEntry> {
  const result = new Map<string, IndexEntry>();
  for (const record of nulPaths(output)) {
    const match = /^(\d{6}) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/.exec(record);
    if (
      match?.[1] === undefined ||
      match[2] === undefined ||
      match[3] === undefined ||
      result.has(match[3])
    )
      throw new Error("trusted parent tree metadata is malformed");
    result.set(match[3], Object.freeze({ mode: match[1], object: match[2] }));
  }
  return result;
}
function parseIndex(output: Buffer): Map<string, IndexEntry> {
  const result = new Map<string, IndexEntry>();
  for (const record of nulPaths(output)) {
    const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t([\s\S]+)$/.exec(record);
    if (
      match?.[1] === undefined ||
      match[2] === undefined ||
      match[3] === undefined ||
      result.has(match[3])
    )
      throw new Error("trusted parent index has conflicts or malformed entries");
    result.set(match[3], Object.freeze({ mode: match[1], object: match[2] }));
  }
  return result;
}
function parseTags(output: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  for (const record of nulPaths(output)) {
    const tag = record[0];
    const path = record.slice(2);
    if ((tag !== "H" && tag !== "S") || record[1] !== " " || path === "" || result.has(path))
      throw new Error("trusted parent materialization tags are malformed");
    result.set(path, tag);
  }
  return result;
}
function assertTreeMatchesIndex(
  tree: Map<string, IndexEntry>,
  index: Map<string, IndexEntry>,
): void {
  if (tree.size !== index.size) throw new Error("trusted parent HEAD and index differ");
  for (const [path, expected] of tree) {
    const actual = index.get(path);
    if (actual?.mode !== expected.mode || actual.object !== expected.object)
      throw new Error(`trusted parent HEAD and index differ: ${path}`);
  }
}

async function assertWorkingBlob(
  files: SandboxDirectory,
  path: string,
  expected: IndexEntry,
): Promise<void> {
  if (expected.mode === "120000" || expected.mode === "160000")
    throw new Error(`unsupported materialized parent Git entry: ${path}`);
  const observed = await files.gitBlobDigest(
    path,
    expected.object.length === 64 ? "sha256" : "sha1",
  );
  if (
    observed.objectId !== expected.object ||
    (expected.mode === "100755") !== (observed.executableMode !== 0)
  )
    throw new Error(`trusted parent working bytes differ from raw HEAD: ${path}`);
}
function nulPaths(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter((value) => value !== "");
}
function text(output: Buffer): string {
  return output.toString("utf8").trim();
}
