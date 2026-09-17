/** Fixed Bubblewrap filesystem construction from verified materialization inputs (#106 §§4–5). */

import { isAbsolute, join, posix } from "node:path";
import type { PreparedRuntimeDescriptor } from "./runtime-types.js";

export interface SandboxWritableMount {
  /** Repository-relative exact root already validated against materialization authority. */
  readonly path: string;
  readonly kind: "file" | "directory";
}

/** Host-verified data tree mounted at a fixed, non-executable-authority destination (#118). */
export interface SandboxReadonlyInput {
  readonly sourcePath: string;
  /** Only /inputs and /source-git are admitted; never a controller-supplied host path. */
  readonly destination: string;
}

export interface SandboxMountPlanInput {
  /** Independently verified, sealed snapshot; the planner performs no filesystem I/O. */
  readonly runtime: PreparedRuntimeDescriptor;
  /** Host-owned base contains regular placeholders for each overlay and protected ancestors. */
  readonly immutableWorkspaceRoot: string;
  /** Private child-owned tree that mirrors exactly the declared writable roots. */
  readonly privateWritableRoot: string;
  readonly bootstrapPath: string;
  readonly writableRoots: readonly SandboxWritableMount[];
  readonly environment: Readonly<Record<string, string>>;
  readonly readonlyInputs?: readonly SandboxReadonlyInput[];
  /** Per-filesystem byte limit for /scratch and the four ambient temporary filesystems. */
  readonly scratchBytes?: number;
}

/** Build setup argv only; the trusted bootstrap command is appended by its separate boundary. */
export function buildSandboxMountPlan(input: SandboxMountPlanInput): readonly string[] {
  const readonlyInputs = input.readonlyInputs ?? [];
  if (
    new Set(readonlyInputs.map((entry) => entry.destination)).size !== readonlyInputs.length ||
    readonlyInputs.some((entry) => !["/inputs", "/source-git"].includes(entry.destination))
  )
    throw new TypeError("read-only inputs require unique fixed destinations");
  for (const entry of readonlyInputs) assertAbsolute("input source", entry.sourcePath);
  if (
    input.scratchBytes !== undefined &&
    (!Number.isSafeInteger(input.scratchBytes) ||
      input.scratchBytes < 4096 ||
      input.scratchBytes > 1073741824)
  )
    throw new TypeError("scratch filesystem size must be between 4096 and 1073741824 bytes");
  for (const [name, value] of Object.entries({
    runtimeRoot: input.runtime.snapshotPath,
    immutableWorkspaceRoot: input.immutableWorkspaceRoot,
    privateWritableRoot: input.privateWritableRoot,
    bootstrapPath: input.bootstrapPath,
  }))
    assertAbsolute(name, value);
  const sources = [
    input.runtime.snapshotPath,
    input.immutableWorkspaceRoot,
    input.privateWritableRoot,
    input.bootstrapPath,
    ...readonlyInputs.map((entry) => entry.sourcePath),
  ];
  if (
    sources.some((root, index) =>
      sources.some(
        (other, otherIndex) =>
          index !== otherIndex && (root === other || other.startsWith(`${root}/`)),
      ),
    )
  )
    throw new TypeError("sandbox mount sources must not overlap");
  const runtimeDirectories = runtimeTopLevelDirectories(input.runtime.inventory);
  const roots = uniqueWritableRoots(input.writableRoots);
  const environment = environmentArgs(input.environment, runtimeDirectories);

  const args = [
    "--unshare-user",
    "--disable-userns",
    "--assert-userns-disabled",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--dir",
    "/workspace",
    "--dir",
    "/tmp",
    "--dir",
    "/home",
    "--dir",
    "/home/sandbox",
    "--dir",
    "/run",
    "--dir",
    "/bootstrap",
  ];
  for (const directory of runtimeDirectories) args.push("--dir", `/${directory}`);
  for (const entry of readonlyInputs) args.push("--dir", entry.destination);
  for (const directory of runtimeDirectories)
    args.push("--ro-bind", join(input.runtime.snapshotPath, directory), `/${directory}`);
  args.push("--ro-bind", input.immutableWorkspaceRoot, "/workspace");
  for (const root of roots)
    args.push("--bind", join(input.privateWritableRoot, root.path), `/workspace/${root.path}`);
  for (const entry of readonlyInputs) args.push("--ro-bind", entry.sourcePath, entry.destination);
  const tmpfs = (path: string): string[] => [
    ...(input.scratchBytes === undefined ? [] : ["--size", String(input.scratchBytes)]),
    "--tmpfs",
    path,
  ];
  args.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...tmpfs("/dev/shm"),
    ...tmpfs("/tmp"),
    ...tmpfs("/home/sandbox"),
    ...tmpfs("/run"),
    ...(input.scratchBytes === undefined ? [] : tmpfs("/scratch")),
    "--ro-bind",
    input.bootstrapPath,
    "/bootstrap/bootstrap.sh",
    ...environment,
    "--chdir",
    "/workspace",
    "--remount-ro",
    "/",
  );
  return Object.freeze(args);
}

function assertAbsolute(name: string, value: string): void {
  if (
    !isAbsolute(value) ||
    value === "/" ||
    value.endsWith("/") ||
    value.includes("\0") ||
    posix.normalize(value) !== value
  )
    throw new TypeError(`${name} must be an absolute canonical NUL-free path`);
}
const RUNTIME_TOP_LEVEL = new Set(["bin", "sbin", "usr", "lib", "lib64", "etc", "opt"]);
function runtimeTopLevelDirectories(
  inventory: PreparedRuntimeDescriptor["inventory"],
): readonly string[] {
  if (
    inventory.some((entry) => {
      const parts = entry.path.split("/");
      return (
        !RUNTIME_TOP_LEVEL.has(parts[0] ?? "") ||
        entry.path.includes("\\") ||
        entry.path.includes("\0") ||
        parts.some(
          (part) =>
            part === "" ||
            part === "." ||
            part === ".." ||
            part === ".git" ||
            part === ".pi-conductor",
        )
      );
    })
  )
    throw new TypeError("runtime inventory contains unsafe paths");
  const directories = inventory
    .filter((entry) => entry.type === "directory" && !entry.path.includes("/"))
    .map((entry) => entry.path);
  if (
    directories.length === 0 ||
    new Set(directories).size !== directories.length ||
    directories.some((entry) => !RUNTIME_TOP_LEVEL.has(entry))
  )
    throw new TypeError("runtime inventory has invalid top-level directories");
  return [...directories].sort();
}
function projectPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("~") &&
    !/^[A-Za-z]:/.test(value) &&
    !/[\\\0*?[\]{}]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          part !== ".git" &&
          part !== ".pi-conductor",
      )
  );
}
function uniqueWritableRoots(
  values: readonly SandboxWritableMount[],
): readonly SandboxWritableMount[] {
  if (
    new Set(values.map((v) => v.path)).size !== values.length ||
    values.some((v) => !projectPath(v.path) || (v.kind !== "file" && v.kind !== "directory"))
  )
    throw new TypeError("writable roots must be unique safe literals");
  const sorted = [...values].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    sorted.some((root, i) =>
      sorted.some((other, j) => i !== j && other.path.startsWith(`${root.path}/`)),
    )
  )
    throw new TypeError("writable roots must not overlap");
  return sorted;
}
function environmentArgs(
  environment: Readonly<Record<string, string>>,
  runtimeDirectories: readonly string[],
): readonly string[] {
  const allowed = new Set(["PATH", "LANG", "LC_ALL", "TERM"]);
  const args = ["--setenv", "HOME", "/home/sandbox", "--setenv", "TMPDIR", "/tmp"];
  for (const [name, value] of Object.entries(environment).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (!allowed.has(name) || value.includes("\0") || Buffer.byteLength(value, "utf8") > 1024)
      throw new TypeError(`invalid sandbox environment ${name}`);
    if (
      name === "PATH" &&
      (value
        .split(":")
        .some(
          (p) =>
            !p.startsWith("/") || p.endsWith("/") || p.startsWith("//") || posix.normalize(p) !== p,
        ) ||
        value
          .split(":")
          .some((p) => !runtimeDirectories.some((d) => p === `/${d}` || p.startsWith(`/${d}/`))))
    )
      throw new TypeError("PATH must remain within admitted runtime directories");
    args.push("--setenv", name, value);
  }
  return args;
}
