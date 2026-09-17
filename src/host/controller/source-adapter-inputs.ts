/** Private filesystem materialization for bounded source-adapter file inputs — issue #118. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSafeControllerSourcePath } from "../../manifest/controller-source.js";

interface InputFileIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

/** One sealed private input tree, including its exact-byte verification and owner disposal. */
export interface SourceAdapterInputs {
  readonly directory: string;
  verify(): Promise<void>;
  dispose(): Promise<void>;
}

/** Copy already-authorized immutable bytes into a private read-only input tree. */
export async function materializeSourceAdapterInputs(input: {
  readonly root: string;
  readonly files: readonly { readonly path: string; readonly bytes: Buffer }[];
  readonly maxFiles: number;
  readonly maxBytes: number;
}): Promise<SourceAdapterInputs> {
  if (input.files.length > input.maxFiles)
    throw new Error("source adapter input file count exceeds policy");
  let total = 0;
  const seen = new Set<string>();
  const directory = join(input.root, "inputs");
  await mkdir(directory, { mode: 0o700 });
  const files: InputFileIdentity[] = [];
  for (const file of input.files) {
    if (!isSafeControllerSourcePath(file.path) || seen.has(file.path))
      throw new Error("source adapter input path is unsafe or duplicated");
    seen.add(file.path);
    total += file.bytes.byteLength;
    if (total > input.maxBytes) throw new Error("source adapter input bytes exceed policy");
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400,
    );
    try {
      await handle.writeFile(file.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    files.push({
      path: file.path,
      sha256: sha256(file.bytes),
      byteLength: file.bytes.byteLength,
    });
  }
  await sealDirectories(directory);
  const identity = await lstat(directory);
  return Object.freeze({
    directory,
    verify: () => verifyInputTree(directory, identity, files),
    dispose: () => disposeInputRoot(input.root, directory),
  });
}

async function verifyInputTree(
  directory: string,
  rootIdentity: Awaited<ReturnType<typeof lstat>>,
  expected: readonly InputFileIdentity[],
): Promise<void> {
  const root = await lstat(directory);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.ino !== rootIdentity.ino ||
    root.dev !== rootIdentity.dev ||
    (root.mode & 0o777) !== 0o500
  )
    throw new Error("source adapter input tree identity changed");
  const remaining = new Map(expected.map((file) => [file.path, file]));
  const expectedDirectories = new Set<string>();
  for (const file of expected) {
    const parts = file.path.split("/");
    for (let length = 1; length < parts.length; length += 1)
      expectedDirectories.add(parts.slice(0, length).join("/"));
  }
  await verifyDirectory(directory, "", remaining, expectedDirectories);
  if (remaining.size !== 0) throw new Error("source adapter input tree is missing expected bytes");
}

async function verifyDirectory(
  directory: string,
  prefix: string,
  remaining: Map<string, InputFileIdentity>,
  expectedDirectories: ReadonlySet<string>,
): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o500)
    throw new Error("source adapter input tree contains an unsafe directory");
  for (const name of await readdir(directory)) {
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    const path = join(directory, name);
    const item = await lstat(path);
    if (item.isDirectory()) {
      if (!expectedDirectories.has(relative))
        throw new Error("source adapter input tree contains an unexpected directory");
      await verifyDirectory(path, relative, remaining, expectedDirectories);
      continue;
    }
    const expected = remaining.get(relative);
    if (
      expected === undefined ||
      !item.isFile() ||
      item.isSymbolicLink() ||
      item.nlink !== 1 ||
      (item.mode & 0o777) !== 0o400
    )
      throw new Error("source adapter input tree contains an unsafe file");
    const bytes = await readFile(path);
    if (bytes.byteLength !== expected.byteLength || sha256(bytes) !== expected.sha256)
      throw new Error("source adapter input bytes changed after materialization");
    remaining.delete(relative);
  }
}

async function sealDirectories(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if ((await lstat(path)).isDirectory()) await sealDirectories(path);
  }
  await chmod(directory, 0o500);
}

async function disposeInputRoot(root: string, directory: string): Promise<void> {
  await makeRemovable(directory);
  await rm(root, { recursive: true, force: true });
}

async function makeRemovable(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if ((await lstat(path)).isDirectory()) await makeRemovable(path);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
