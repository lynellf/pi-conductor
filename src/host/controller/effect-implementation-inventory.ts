/** Measured build-byte inventory for the privileged built-in effect implementations. */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import {
  createBuiltinEffectImplementations,
  type SupportedEffectImplementation,
} from "./effect-registry.js";

export interface EffectImplementationFileIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly mtime_ns: string;
  readonly ctime_ns: string;
  readonly sha256: string;
}

export interface EffectImplementationMeasurement {
  readonly digest: string;
  readonly files: readonly EffectImplementationFileIdentity[];
  readonly runtime: Readonly<Record<string, string>>;
}

export interface BuiltinEffectInventoryPaths {
  readonly shared: readonly string[];
  readonly git_integrate: readonly string[];
  readonly git_promote: readonly string[];
  readonly deliver_ref: readonly string[];
  readonly runtime: readonly string[];
}

const MAX_IMPLEMENTATION_BYTES = 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;
const requireFromInventory = createRequire(import.meta.url);

/**
 * Return the audited local dependency closure. Additions to runtime imports must be
 * reflected here; the focused closure test prevents silently omitting local modules.
 */
export async function builtinEffectInventoryPaths(): Promise<BuiltinEffectInventoryPaths> {
  const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? ".ts" : ".js";
  const local = (relative: string) =>
    fileURLToPath(new URL(relative.replace(/\.js$/, extension), import.meta.url));
  const shared = await localClosure([
    local("../../manifest/controller-effect.js"),
    local("../../persistence/trajectory-records.js"),
    local("./effect-registry.js"),
    local("./effect-broker.js"),
    local("./effect-broker-contract.js"),
    local("./effect-artifacts.js"),
    local("./production-effects.js"),
  ]);
  return Object.freeze({
    shared,
    git_integrate: await localClosure([
      local("./git-effect.js"),
      local("./git-effect-operations.js"),
      local("../execution/sandbox/trusted-git-environment.js"),
      local("../execution/sandbox/trusted-git-validation.js"),
      local("../execution/sandbox/observation-files.js"),
      local("../execution/sandbox/observation-error.js"),
      local("../execution/sandbox/observation-support.js"),
    ]),
    git_promote: await localClosure([
      local("./git-effect.js"),
      local("./git-effect-operations.js"),
      local("../execution/sandbox/trusted-git-environment.js"),
      local("../execution/sandbox/trusted-git-validation.js"),
      local("../execution/sandbox/observation-files.js"),
      local("../execution/sandbox/observation-error.js"),
      local("../execution/sandbox/observation-support.js"),
    ]),
    deliver_ref: await localClosure([local("./remote-effect.js")]),
    runtime: freezePaths([
      await canonicalRuntimeAnchor(process.execPath),
      ...(await externalRuntimeClosure(requireFromInventory.resolve("typebox"))),
      ...(await externalRuntimeClosure(requireFromInventory.resolve("typebox/value"))),
    ]),
  });
}

/** Hash protected canonical regular files and stable runtime facts without executing them. */
export async function measureProtectedImplementationFiles(
  paths: readonly string[],
  runtime: Readonly<Record<string, string>>,
): Promise<EffectImplementationMeasurement> {
  const unique = [...new Set(paths)].sort();
  if (unique.length !== paths.length)
    throw new Error("effect implementation inventory repeats a file");
  const files = Object.freeze(await Promise.all(unique.map(inspectProtectedFile)));
  const frozenRuntime = Object.freeze({ ...runtime });
  return Object.freeze({
    digest: sha256Canonical({
      domain: "pi-conductor/effect-implementation-files/v1",
      files,
      runtime: frozenRuntime,
    }),
    files,
    runtime: frozenRuntime,
  });
}

/** Measure current loaded implementation bytes into the supported-effect registry shape. */
export async function measureBuiltinEffectImplementations(): Promise<
  readonly SupportedEffectImplementation[]
> {
  const paths = await builtinEffectInventoryPaths();
  const runtime = Object.freeze({
    node: process.version,
    modules: process.versions.modules ?? "unknown",
    platform: process.platform,
    arch: process.arch,
  });
  const shared = freezePaths([...paths.shared, ...paths.runtime]);
  const integratePaths = freezePaths([...shared, ...paths.git_integrate]);
  const promotePaths = freezePaths([...shared, ...paths.git_promote]);
  const deliverPaths = freezePaths([...shared, ...paths.deliver_ref]);
  const all = await measureProtectedImplementationFiles(
    freezePaths([...integratePaths, ...promotePaths, ...deliverPaths]),
    runtime,
  );
  const files = new Map(all.files.map((file) => [file.path, file]));
  const integrate = measurementFor(integratePaths, files, runtime);
  const promote = measurementFor(promotePaths, files, runtime);
  const deliver = measurementFor(deliverPaths, files, runtime);
  return createBuiltinEffectImplementations({
    git_integrate: integrate.digest,
    git_promote: promote.digest,
    deliver_ref: deliver.digest,
  });
}

/** Remeasure immediately before an effect and reject any build/runtime mutation. */
export async function verifyBuiltinEffectImplementations(
  expected: readonly SupportedEffectImplementation[],
): Promise<readonly SupportedEffectImplementation[]> {
  const current = await measureBuiltinEffectImplementations();
  if (sha256Canonical(current) !== sha256Canonical(expected))
    throw new Error("built-in effect implementation inventory changed or was replaced");
  return current;
}

async function inspectProtectedFile(path: string): Promise<EffectImplementationFileIdentity> {
  const canonical = await realpath(path).catch(() => null);
  const before = await lstat(path, { bigint: true }).catch(() => null);
  const uid = process.getuid?.();
  if (
    canonical !== path ||
    before === null ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.nlink !== 1n && !isPnpmDependencyFile(canonical)) ||
    (before.mode & 0o022n) !== 0n ||
    (uid !== undefined && before.uid !== BigInt(uid) && before.uid !== 0n)
  )
    throw new Error(`effect implementation is not a protected canonical regular file: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened)) throw changed(path);
    const sha256 = await hashBoundedFile(handle, opened.size, path);
    const after = await handle.stat({ bigint: true });
    if (!sameBigIdentity(opened, after)) throw changed(path);
    return Object.freeze({
      path,
      dev: Number(opened.dev),
      ino: Number(opened.ino),
      mode: Number(opened.mode),
      uid: Number(opened.uid),
      gid: Number(opened.gid),
      size: Number(opened.size),
      mtime_ns: opened.mtimeNs.toString(),
      ctime_ns: opened.ctimeNs.toString(),
      sha256,
    });
  } finally {
    await handle.close();
  }
}

function measurementFor(
  paths: readonly string[],
  files: ReadonlyMap<string, EffectImplementationFileIdentity>,
  runtime: Readonly<Record<string, string>>,
): EffectImplementationMeasurement {
  const selected = paths.map((path) => {
    const file = files.get(path);
    if (file === undefined) throw new Error(`effect implementation file was not measured: ${path}`);
    return file;
  });
  return Object.freeze({
    digest: sha256Canonical({
      domain: "pi-conductor/effect-implementation-files/v1",
      files: selected,
      runtime,
    }),
    files: Object.freeze(selected),
    runtime,
  });
}

async function hashBoundedFile(
  handle: Awaited<ReturnType<typeof open>>,
  size: bigint,
  path: string,
): Promise<string> {
  if (size > BigInt(MAX_IMPLEMENTATION_BYTES))
    throw new Error(
      `effect implementation exceeds ${MAX_IMPLEMENTATION_BYTES} byte limit: ${path}`,
    );
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let position = 0;
  while (position < Number(size)) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.byteLength, Number(size) - position),
      position,
    );
    if (bytesRead === 0) throw changed(path);
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function isPnpmDependencyFile(path: string): boolean {
  return path.includes(`${sep}node_modules${sep}.pnpm${sep}`);
}

function sameIdentity(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  return sameBigIdentity(left, right);
}

function sameBigIdentity(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  return ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"].every(
    (key) => left[key as keyof typeof left] === right[key as keyof typeof right],
  );
}

function freezePaths(paths: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(paths)].sort());
}

async function localClosure(roots: readonly string[]): Promise<readonly string[]> {
  const pending = [...roots];
  const found = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || found.has(path)) continue;
    found.add(path);
    const source = await readFile(path, "utf8");
    const runtimeSource = source.replace(/import\s+type\s+[\s\S]*?from\s+["'][^"']+["'];?/g, "");
    for (const match of runtimeSource.matchAll(/(?:from\s+|import\s*)["'](\.\.?\/[^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier?.endsWith(".js") !== true) continue;
      const dependency = resolve(
        dirname(path),
        specifier.replace(/\.js$/, path.endsWith(".ts") ? ".ts" : ".js"),
      );
      if (!dependency.includes(`${resolve(dirname(fileURLToPath(import.meta.url)), "../../")}/`))
        throw new Error("effect implementation imports outside the trusted source tree");
      pending.push(dependency);
    }
  }
  return freezePaths([...found]);
}

/** Resolve the actual external TypeBox runtime closure, never a package-manager lockfile. */
async function externalRuntimeClosure(root: string): Promise<readonly string[]> {
  const canonicalRoot = await realpath(root).catch(() => null);
  if (canonicalRoot === null) throw new Error("TypeBox runtime entrypoint cannot be resolved");
  const packageRoot = await packageRootFor(canonicalRoot);
  const pending = [canonicalRoot];
  const found = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || found.has(path)) continue;
    if (!isWithin(packageRoot, path))
      throw new Error("TypeBox runtime escapes its resolved package");
    found.add(path);
    const source = await readFile(path, "utf8");
    for (const specifier of runtimeSpecifiers(source)) {
      if (!specifier.startsWith("."))
        throw new Error(`TypeBox runtime imports an unpinned external module: ${specifier}`);
      const dependency = await realpath(resolve(dirname(path), specifier)).catch(() => null);
      if (dependency === null)
        throw new Error(`TypeBox runtime dependency is unavailable: ${specifier}`);
      pending.push(dependency);
    }
  }
  return freezePaths([...found]);
}

async function packageRootFor(entry: string): Promise<string> {
  let current = dirname(entry);
  while (true) {
    const candidate = resolve(current, "package.json");
    try {
      await lstat(candidate);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error("TypeBox runtime package root is unavailable");
      current = parent;
    }
  }
}

async function canonicalRuntimeAnchor(path: string): Promise<string> {
  const canonical = await realpath(path).catch(() => null);
  if (canonical === null) throw new Error("Node runtime executable cannot be resolved");
  return canonical;
}

function runtimeSpecifiers(source: string): readonly string[] {
  const runtimeSource = source.replace(/import\s+type\s+[\s\S]*?from\s+["'][^"']+["'];?/g, "");
  return Object.freeze(
    [
      ...runtimeSource.matchAll(
        /^\s*(?:import\s+(?:[\w$*{},\s]+?\s+from\s+)?|export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+)["']([^"']+)["']/gm,
      ),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]])),
  );
}

function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}
function changed(path: string): Error {
  return new Error(`effect implementation changed while hashing: ${path}`);
}
