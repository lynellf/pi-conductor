/** Create fixed protected workspace roots before sandbox runtime capture (#108). */
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { childPath, DIRECTORY, maybeStat } from "./anchored-file-handles.js";
import { formatRuntimePath } from "./runtime-directory.js";

const FIXED_ROOTS = ["worktrees", "sandbox"] as const;

/** A rejected protected run-directory layout with a classified, bounded path diagnostic. */
export class ProtectedRunLayoutError extends Error {
  constructor(
    readonly code:
      | "run-state-invalid"
      | "run-state-missing"
      | "root-invalid"
      | "root-create-failed",
    path: string,
    reason: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`${code}: ${formatRuntimePath(path)} ${reason}`, options);
    this.name = "ProtectedRunLayoutError";
  }
}

/** Test-only synchronization points for deterministic replacement-race coverage. */
export interface ProtectedRunLayoutTestHook {
  readonly beforeFinalValidation?: () => Promise<void> | void;
}

/** Ensure the host-owned fixed workspace roots exist and remain protected. */
export async function initializeProtectedRunLayout(
  runStateDir: string,
  testHook?: ProtectedRunLayoutTestHook,
): Promise<void> {
  const expected = await validateRunStateDirectory(runStateDir);
  const anchor = await open("/", DIRECTORY).catch((error: unknown) => {
    throw new ProtectedRunLayoutError("run-state-invalid", runStateDir, observationReason(error), {
      cause: error,
    });
  });
  let run: Awaited<ReturnType<typeof open>> | undefined;
  try {
    run = await openAnchoredDirectory(anchor, runStateDir);
    if (!sameDirectory(expected, await observeRun(run, runStateDir)))
      throw new ProtectedRunLayoutError("run-state-invalid", runStateDir, "changed before setup");
    const roots = new Map<string, Stats>();
    for (const name of FIXED_ROOTS)
      roots.set(name, await ensureProtectedRoot(run, runStateDir, name));
    await testHook?.beforeFinalValidation?.();
    const observed = await validateRunStateDirectory(runStateDir);
    if (
      !sameDirectory(expected, observed) ||
      !sameDirectory(expected, await observeRun(run, runStateDir))
    )
      throw new ProtectedRunLayoutError("run-state-invalid", runStateDir, "changed during setup");
    for (const name of FIXED_ROOTS) {
      const root = roots.get(name);
      if (root === undefined)
        throw new ProtectedRunLayoutError("root-invalid", `${runStateDir}/${name}`, "is missing");
      await revalidateProtectedRoot(run, runStateDir, name, root);
    }
  } finally {
    await run?.close();
    await anchor.close();
  }
}

async function validateRunStateDirectory(runStateDir: string): Promise<Stats> {
  if (!isCanonicalAbsolute(runStateDir))
    throw new ProtectedRunLayoutError("run-state-invalid", runStateDir, "is noncanonical");
  const expected = await lstat(runStateDir).catch((error: unknown) => {
    if (isMissing(error))
      throw new ProtectedRunLayoutError("run-state-missing", runStateDir, "is missing (ENOENT)", {
        cause: error,
      });
    throw new ProtectedRunLayoutError("run-state-invalid", runStateDir, observationReason(error), {
      cause: error,
    });
  });
  if (!isCurrentUserProtectedDirectory(expected))
    throw new ProtectedRunLayoutError("run-state-invalid", runStateDir, directoryReason(expected));
  const canonical = await realpath(runStateDir).catch((error: unknown) => {
    throw new ProtectedRunLayoutError("run-state-invalid", runStateDir, observationReason(error), {
      cause: error,
    });
  });
  if (canonical !== runStateDir)
    throw new ProtectedRunLayoutError("run-state-invalid", runStateDir, "is noncanonical");
  await validateAncestorChain(runStateDir);
  return expected;
}

async function validateAncestorChain(path: string): Promise<void> {
  let ancestor = dirname(path);
  while (true) {
    const stat = await lstat(ancestor).catch((error: unknown) => {
      throw new ProtectedRunLayoutError("run-state-invalid", ancestor, observationReason(error), {
        cause: error,
      });
    });
    if (!isOwnerProtectedDirectory(stat) && !isRootOwnedStickyDirectory(stat))
      throw new ProtectedRunLayoutError("run-state-invalid", ancestor, directoryReason(stat));
    const parent = dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
}

async function openAnchoredDirectory(
  anchor: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  let current: Awaited<ReturnType<typeof open>>;
  try {
    current = await open(`/proc/self/fd/${anchor.fd}`, DIRECTORY & ~constants.O_NOFOLLOW);
  } catch (error) {
    throw new ProtectedRunLayoutError("run-state-invalid", path, observationReason(error), {
      cause: error,
    });
  }
  try {
    for (const component of path.slice(1).split("/")) {
      const next = await open(childPath(current, component), DIRECTORY);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw new ProtectedRunLayoutError("run-state-invalid", path, observationReason(error), {
      cause: error,
    });
  }
}

async function ensureProtectedRoot(
  run: Awaited<ReturnType<typeof open>>,
  runStateDir: string,
  name: (typeof FIXED_ROOTS)[number],
): Promise<Stats> {
  const path = `${runStateDir}/${name}`;
  const location = childPath(run, name);
  let created = false;
  if ((await observeRoot(location, path)) === undefined) {
    try {
      await mkdir(location, { mode: 0o700 });
      await run.sync();
      created = true;
    } catch (error) {
      if (!isAlreadyExists(error))
        throw new ProtectedRunLayoutError("root-create-failed", path, observationReason(error), {
          cause: error,
        });
    }
  }
  const before = await observeRoot(location, path);
  if (before === undefined || !isCurrentUserProtectedDirectory(before))
    throw new ProtectedRunLayoutError(
      "root-invalid",
      path,
      before === undefined ? "is missing" : directoryReason(before),
    );
  if (created && (before.mode & 0o777) !== 0o700)
    throw new ProtectedRunLayoutError("root-invalid", path, "new root mode is not 0700");
  const root = await open(location, DIRECTORY).catch((error: unknown) => {
    throw new ProtectedRunLayoutError("root-invalid", path, observationReason(error), {
      cause: error,
    });
  });
  try {
    if (!sameDirectory(before, await observeRootHandle(root, path)))
      throw new ProtectedRunLayoutError("root-invalid", path, "changed before open");
  } finally {
    await root.close();
  }
  return before;
}

async function observeRootHandle(
  root: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<Stats> {
  try {
    return await root.stat();
  } catch (error) {
    throw new ProtectedRunLayoutError("root-invalid", path, observationReason(error), {
      cause: error,
    });
  }
}

async function revalidateProtectedRoot(
  run: Awaited<ReturnType<typeof open>>,
  runStateDir: string,
  name: (typeof FIXED_ROOTS)[number],
  expected: Stats,
): Promise<void> {
  const path = `${runStateDir}/${name}`;
  const observed = await observeRoot(childPath(run, name), path);
  if (
    observed === undefined ||
    !sameDirectory(expected, observed) ||
    !isCurrentUserProtectedDirectory(observed)
  )
    throw new ProtectedRunLayoutError("root-invalid", path, "changed during setup");
}

async function observeRun(run: Awaited<ReturnType<typeof open>>, path: string): Promise<Stats> {
  try {
    return await run.stat();
  } catch (error) {
    throw new ProtectedRunLayoutError("run-state-invalid", path, observationReason(error), {
      cause: error,
    });
  }
}

async function observeRoot(location: string, path: string): Promise<Stats | undefined> {
  try {
    return await maybeStat(location);
  } catch (error) {
    throw new ProtectedRunLayoutError("root-invalid", path, observationReason(error), {
      cause: error,
    });
  }
}

function isCanonicalAbsolute(path: string): boolean {
  return posix.isAbsolute(path) && posix.normalize(path) === path && !path.includes("\0");
}

function isCurrentUserProtectedDirectory(stat: Stats): boolean {
  const owner = process.getuid?.();
  return (
    stat.isDirectory() && owner !== undefined && stat.uid === owner && (stat.mode & 0o022) === 0
  );
}

function isOwnerProtectedDirectory(stat: Stats): boolean {
  const owner = process.getuid?.();
  return (
    stat.isDirectory() &&
    owner !== undefined &&
    (stat.uid === owner || stat.uid === 0) &&
    (stat.mode & 0o022) === 0
  );
}

function isRootOwnedStickyDirectory(stat: Stats): boolean {
  return stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function directoryReason(stat: Stats): string {
  if (stat.isSymbolicLink()) return "is a symlink";
  if (!stat.isDirectory()) return "is not a directory";
  const owner = process.getuid?.();
  if (owner === undefined || stat.uid !== owner) return "is not owned by the current user";
  if ((stat.mode & 0o022) !== 0) return "is group/world writable";
  return "is noncanonical";
}

function observationReason(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code.slice(0, 40)
      : "UNKNOWN";
  return `could not be inspected (${code})`;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
