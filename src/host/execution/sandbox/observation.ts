/** Read-only Bubblewrap host observation — Issue #106 §5. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { promisify } from "node:util";

import type {
  BubblewrapAncestorDirectory,
  BubblewrapBinaryIdentity,
  BubblewrapStaticObservation,
  HostApprovedBubblewrapBuild,
} from "./prerequisites.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GETCAP_PATH = "/usr/sbin/getcap";
const MAX_COMMAND_OUTPUT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 2_000;

/** Typed failure while collecting trusted host facts for Bubblewrap admission. */
export class BubblewrapObservationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "bubblewrap-observation-invalid-path"
      | "bubblewrap-observation-unavailable"
      | "bubblewrap-observation-unsafe-file"
      | "bubblewrap-observation-mutated"
      | "bubblewrap-observation-capability-check-failed"
      | "bubblewrap-observation-unapproved-build"
      | "bubblewrap-observation-command-failed",
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "BubblewrapObservationError";
  }
}

/** Injectable command seam used to test ordering without running a capability probe. */
export type BubblewrapObservationCommand = (
  file: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

/** Options for collecting one absolute Bubblewrap observation. */
export interface BubblewrapObservationOptions {
  readonly binaryPath: string;
  readonly approvedBuilds: readonly HostApprovedBubblewrapBuild[];
  readonly getcapPath?: string;
  readonly runCommand?: BubblewrapObservationCommand;
}

/** Collect static, identity-bound Bubblewrap facts without probing namespaces. */
export async function collectBubblewrapStaticObservation(
  options: BubblewrapObservationOptions,
): Promise<BubblewrapStaticObservation> {
  const binaryPath = await canonicalAbsolutePath(options.binaryPath, "Bubblewrap binary");
  const binary = await inspectTrustedFile(binaryPath, "Bubblewrap binary");
  const getcapPath = await canonicalAbsolutePath(
    options.getcapPath ?? DEFAULT_GETCAP_PATH,
    "getcap",
  );
  await inspectTrustedFile(getcapPath, "getcap");
  const command = options.runCommand ?? runTrustedCommand;
  const capabilities = await readCapabilities(command, getcapPath, binaryPath);
  const approval = matchingUpstreamApproval(options.approvedBuilds, binary.identity, binary.sha256);
  if (approval === undefined) {
    throw new BubblewrapObservationError(
      "Bubblewrap binary has no host-approved upstream identity and digest",
      "bubblewrap-observation-unapproved-build",
    );
  }
  const versionResult = await runChecked(command, binaryPath, ["--version"]);
  const helpResult = await runChecked(command, binaryPath, ["--help"]);
  const current = await inspectTrustedFile(binaryPath, "Bubblewrap binary");
  if (!sameIdentity(binary.identity, current.identity) || binary.sha256 !== current.sha256) {
    throw new BubblewrapObservationError(
      "Bubblewrap binary identity or digest changed while being observed",
      "bubblewrap-observation-mutated",
    );
  }
  const version = versionResult.stdout.trim();
  if (!/^bubblewrap \d+\.\d+\.\d+$/.test(version)) {
    throw new BubblewrapObservationError(
      "Bubblewrap --version returned an unrecognized bounded response",
      "bubblewrap-observation-command-failed",
    );
  }
  return Object.freeze({
    platform: process.platform,
    observerUid: process.getuid?.() ?? -1,
    binary: Object.freeze({
      path: binaryPath,
      identity: Object.freeze(binary.identity),
      sha256: binary.sha256,
      isRegularFile: true,
      fileCapabilities: Object.freeze(capabilities),
      upstreamVersionOutput: versionResult.stdout,
      supportedOptions: Object.freeze(extractOptions(helpResult.stdout)),
    }),
    ancestorDirectories: Object.freeze(binary.ancestors),
  });
}

async function canonicalAbsolutePath(path: string, label: string): Promise<string> {
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path) {
    throw new BubblewrapObservationError(
      `${label} path must be absolute and canonical`,
      "bubblewrap-observation-invalid-path",
    );
  }
  try {
    return await realpath(path);
  } catch (cause) {
    throw new BubblewrapObservationError(
      `${label} path is unavailable`,
      "bubblewrap-observation-unavailable",
      { cause },
    );
  }
}

async function inspectTrustedFile(
  path: string,
  label: string,
): Promise<{
  readonly identity: BubblewrapBinaryIdentity;
  readonly sha256: string;
  readonly ancestors: readonly BubblewrapAncestorDirectory[];
}> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.uid !== 0 || (before.mode & 0o022) !== 0) {
      throw new BubblewrapObservationError(
        `${label} is not a root-owned non-writable regular file`,
        "bubblewrap-observation-unsafe-file",
      );
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    const identity = fileIdentity(opened);
    if (!sameIdentity(identity, fileIdentity(before))) throw mutated(label);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, position);
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await handle.stat();
    const afterPath = await lstat(path);
    if (
      !sameIdentity(identity, fileIdentity(after)) ||
      !sameIdentity(identity, fileIdentity(afterPath))
    ) {
      throw mutated(label);
    }
    return { identity, sha256: hash.digest("hex"), ancestors: await trustedAncestors(path) };
  } catch (cause) {
    if (cause instanceof BubblewrapObservationError) throw cause;
    throw new BubblewrapObservationError(
      `${label} could not be observed`,
      "bubblewrap-observation-unavailable",
      { cause },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function trustedAncestors(path: string): Promise<readonly BubblewrapAncestorDirectory[]> {
  const paths: string[] = [];
  let current = dirname(path);
  while (true) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const entries: BubblewrapAncestorDirectory[] = [];
  for (const ancestor of paths.reverse()) {
    const stat = await lstat(ancestor);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new BubblewrapObservationError(
        `Bubblewrap ancestor '${ancestor}' is unsafe`,
        "bubblewrap-observation-unsafe-file",
      );
    }
    entries.push({ path: ancestor, isDirectory: true, uid: stat.uid, mode: stat.mode });
  }
  return entries;
}

async function readCapabilities(
  command: BubblewrapObservationCommand,
  getcapPath: string,
  binaryPath: string,
): Promise<readonly string[]> {
  let result: { readonly stdout: string; readonly stderr: string };
  try {
    result = await command(getcapPath, ["--", binaryPath]);
  } catch (cause) {
    throw new BubblewrapObservationError(
      "absolute getcap capability check failed",
      "bubblewrap-observation-capability-check-failed",
      { cause },
    );
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_OUTPUT) {
    throw new BubblewrapObservationError(
      "getcap output exceeded the bounded limit",
      "bubblewrap-observation-capability-check-failed",
    );
  }
  const line = result.stdout.trim();
  if (line.length === 0) return [];
  if (!line.startsWith(`${binaryPath} `)) {
    throw new BubblewrapObservationError(
      "getcap returned an unexpected path",
      "bubblewrap-observation-capability-check-failed",
    );
  }
  return Object.freeze(
    line
      .slice(binaryPath.length + 1)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

async function runChecked(
  command: BubblewrapObservationCommand,
  file: string,
  args: readonly string[],
) {
  try {
    return await command(file, args);
  } catch (cause) {
    throw new BubblewrapObservationError(
      `${file} ${args[0] ?? "command"} failed`,
      "bubblewrap-observation-command-failed",
      { cause },
    );
  }
}

const runTrustedCommand: BubblewrapObservationCommand = async (file, args) => {
  const result = await execFileAsync(file, [...args], {
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_COMMAND_OUTPUT,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function matchingUpstreamApproval(
  approvals: readonly HostApprovedBubblewrapBuild[],
  identity: BubblewrapBinaryIdentity,
  sha256: string,
): Extract<HostApprovedBubblewrapBuild, { kind: "upstream-release" }> | undefined {
  return approvals.find(
    (approval): approval is Extract<HostApprovedBubblewrapBuild, { kind: "upstream-release" }> =>
      approval.kind === "upstream-release" &&
      approval.approvalId.trim().length > 0 &&
      approval.sha256 === sha256 &&
      sameIdentity(approval.binaryIdentity, identity),
  );
}

function extractOptions(help: string): readonly string[] {
  return Object.freeze([...new Set(help.match(/--[a-z0-9-]+/gi) ?? [])]);
}

function fileIdentity(stat: {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): BubblewrapBinaryIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameIdentity(left: BubblewrapBinaryIdentity, right: BubblewrapBinaryIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function mutated(label: string): BubblewrapObservationError {
  return new BubblewrapObservationError(
    `${label} changed during observation`,
    "bubblewrap-observation-mutated",
  );
}
