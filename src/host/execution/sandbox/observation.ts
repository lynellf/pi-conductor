/** Read-only Bubblewrap host observation — Issue #106 §5. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BubblewrapObservationError } from "./observation-error.js";
import {
  type BubblewrapFileObserver,
  canonicalAbsolutePath,
  inspectTrustedFile,
  type ObservedTrustedFile,
} from "./observation-files.js";
import {
  extractOptions,
  matchingUpstreamApproval,
  sameIdentity,
  validIdentity,
} from "./observation-support.js";
import type { BubblewrapStaticObservation, HostApprovedBubblewrapBuild } from "./prerequisites.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GETCAP_PATH = "/usr/sbin/getcap";
const MAX_COMMAND_OUTPUT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 2_000;

export { BubblewrapObservationError } from "./observation-error.js";
export type { BubblewrapFileObserver, ObservedTrustedFile } from "./observation-files.js";

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
  readonly platform?: string;
  readonly observerUid?: number;
  /** Deterministic seam for tests; production uses descriptor-anchored inspection. */
  readonly observeFile?: BubblewrapFileObserver;
  readonly canonicalizePath?: CanonicalizePath;
}

type CanonicalizePath = (path: string) => Promise<string>;

/**
 * Collect static, identity-bound Bubblewrap facts without probing namespaces.
 * Pathname execution retains a privileged replacement race after the final check;
 * protected ancestors prevent ordinary unprivileged replacement (#106 §5).
 */
export async function collectBubblewrapStaticObservation(
  options: BubblewrapObservationOptions,
): Promise<BubblewrapStaticObservation> {
  const platform = options.platform ?? process.platform;
  const observerUid = options.observerUid ?? process.getuid?.() ?? -1;
  if (platform !== "linux") {
    throw new BubblewrapObservationError(
      "Bubblewrap requires Linux",
      "bubblewrap-observation-unsupported-platform",
    );
  }
  if (!Number.isInteger(observerUid) || observerUid <= 0) {
    throw new BubblewrapObservationError(
      "Bubblewrap observation requires an unprivileged observer",
      "bubblewrap-observation-privileged-observer",
    );
  }
  const observeFile = options.observeFile ?? inspectTrustedFile;
  const binaryPath = await canonicalAbsolutePath(
    options.binaryPath,
    "Bubblewrap binary",
    options.canonicalizePath,
  );
  const binary = await observeFile(binaryPath, "Bubblewrap binary");
  assertValidObservedFile(binary, "Bubblewrap binary");
  if ((binary.identity.mode & 0o6000) !== 0 || (binary.identity.mode & 0o001) === 0) {
    throw new BubblewrapObservationError(
      "Bubblewrap binary has unsafe mode",
      "bubblewrap-observation-unsafe-file",
    );
  }
  const getcapPath = await canonicalAbsolutePath(
    options.getcapPath ?? DEFAULT_GETCAP_PATH,
    "getcap",
    options.canonicalizePath,
  );
  const getcap = await observeFile(getcapPath, "getcap");
  assertValidObservedFile(getcap, "getcap");
  if ((getcap.identity.mode & 0o6000) !== 0 || (getcap.identity.mode & 0o001) === 0) {
    throw new BubblewrapObservationError(
      "getcap has unsafe mode",
      "bubblewrap-observation-unsafe-file",
    );
  }
  const command = options.runCommand ?? runTrustedCommand;
  const capabilities = await readCapabilities(command, getcapPath, binaryPath);
  if (capabilities.length > 0) {
    throw new BubblewrapObservationError(
      "Bubblewrap binary has file capabilities",
      "bubblewrap-observation-unsafe-file",
    );
  }
  await assertUnchanged(observeFile, getcapPath, getcap, "after getcap");
  const approval = matchingUpstreamApproval(options.approvedBuilds, binary.identity, binary.sha256);
  if (approval === undefined) {
    throw new BubblewrapObservationError(
      "Bubblewrap binary has no host-approved upstream identity and digest",
      "bubblewrap-observation-unapproved-build",
    );
  }
  await assertUnchanged(observeFile, binaryPath, binary, "before Bubblewrap --version");
  const versionResult = await runChecked(command, binaryPath, ["--version"]);
  await assertUnchanged(observeFile, binaryPath, binary, "before Bubblewrap --help");
  const helpResult = await runChecked(command, binaryPath, ["--help"]);
  const current = await observeFile(binaryPath, "Bubblewrap binary");
  if (!sameIdentity(binary.identity, current.identity) || binary.sha256 !== current.sha256) {
    throw new BubblewrapObservationError(
      "Bubblewrap binary identity or digest changed while being observed",
      "bubblewrap-observation-mutated",
    );
  }
  const version = versionResult.stdout.trim();
  if (!/^bubblewrap \d+\.\d+\.\d+$/.test(version) || `bubblewrap ${approval.release}` !== version) {
    throw new BubblewrapObservationError(
      "Bubblewrap --version returned an unrecognized bounded response",
      "bubblewrap-observation-command-failed",
    );
  }
  return Object.freeze({
    platform,
    observerUid,
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

async function assertUnchanged(
  observeFile: BubblewrapFileObserver,
  path: string,
  expected: ObservedTrustedFile,
  label: string,
): Promise<void> {
  const current = await observeFile(path, label);
  assertValidObservedFile(current, label);
  if (!sameIdentity(expected.identity, current.identity) || expected.sha256 !== current.sha256) {
    throw mutated(label);
  }
}

function assertValidObservedFile(file: ObservedTrustedFile, label: string): void {
  if (!validIdentity(file.identity) || !/^[0-9a-f]{64}$/.test(file.sha256)) {
    throw new BubblewrapObservationError(
      `${label} returned invalid file evidence`,
      "bubblewrap-observation-unsafe-file",
    );
  }
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
  if (
    Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_OUTPUT ||
    Buffer.byteLength(result.stderr, "utf8") > MAX_COMMAND_OUTPUT
  ) {
    throw new BubblewrapObservationError(
      "getcap output exceeded the bounded limit",
      "bubblewrap-observation-capability-check-failed",
    );
  }
  if (result.stderr.length > 0) {
    throw new BubblewrapObservationError(
      "getcap reported a capability-check diagnostic",
      "bubblewrap-observation-capability-check-failed",
    );
  }
  if (result.stdout.length > 0 && result.stdout.trim().length === 0) {
    throw new BubblewrapObservationError(
      "getcap returned ambiguous whitespace",
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
    const result = await command(file, args);
    if (
      Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_OUTPUT ||
      Buffer.byteLength(result.stderr, "utf8") > MAX_COMMAND_OUTPUT
    ) {
      throw new BubblewrapObservationError(
        "observation command output exceeded the bounded limit",
        "bubblewrap-observation-command-failed",
      );
    }
    if (result.stderr.length > 0) {
      throw new BubblewrapObservationError(
        "observation command reported an unexpected diagnostic",
        "bubblewrap-observation-command-failed",
      );
    }
    return result;
  } catch (cause) {
    throw new BubblewrapObservationError(
      `${file} ${args[0] ?? "command"} failed`,
      "bubblewrap-observation-command-failed",
      { cause },
    );
  }
}

function mutated(label: string): BubblewrapObservationError {
  return new BubblewrapObservationError(
    `${label} changed during observation`,
    "bubblewrap-observation-mutated",
  );
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
