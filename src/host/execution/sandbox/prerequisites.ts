/** Static Bubblewrap admission evidence for Issue #106 §5; capability execution remains separate. */

import { posix } from "node:path";

/** The CVE whose fix must be established before Bubblewrap can be admitted. */
export const BUBBLEWRAP_REQUIRED_CVE = "CVE-2026-87766";

/** Bubblewrap options required by the fixed Issue #106 production policy. */
export const BUBBLEWRAP_REQUIRED_OPTIONS = [
  "--unshare-user",
  "--unshare-pid",
  "--unshare-net",
  "--unshare-ipc",
  "--unshare-uts",
  "--disable-userns",
  "--die-with-parent",
  "--new-session",
  "--clearenv",
  "--json-status-fd",
  "--ro-bind",
  "--bind",
  "--dir",
  "--proc",
  "--dev",
  "--tmpfs",
  "--chdir",
  "--setenv",
] as const;

/** Filesystem identity that must be repeated immediately before Bubblewrap spawn. */
export interface BubblewrapBinaryIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/** One lstat-derived directory observation on the trusted Bubblewrap path. */
export interface BubblewrapAncestorDirectory {
  readonly path: string;
  readonly isDirectory: boolean;
  readonly uid: number;
  readonly mode: number;
}

/** Host-observed properties of the absolute Bubblewrap executable. */
export interface BubblewrapBinaryObservation {
  readonly path: string;
  readonly identity: BubblewrapBinaryIdentity;
  /** Lowercase SHA-256 of the observed executable bytes. */
  readonly sha256: string;
  readonly isRegularFile: boolean;
  /** Empty only after the host has observed no file capabilities. */
  readonly fileCapabilities: readonly string[];
  /** One `bwrap --version` line, optionally ending in one LF or CRLF, never manifest input. */
  readonly upstreamVersionOutput: string;
  /** Host-observed supported options, never a caller-provided argument list. */
  readonly supportedOptions: readonly string[];
}

/** Fresh pre-spawn Bubblewrap observation compared with accepted static evidence. */
export interface CurrentBubblewrapBinary {
  readonly identity: BubblewrapBinaryIdentity;
  readonly sha256: string;
}

/** Independently observed package ownership of the installed Bubblewrap binary. */
export interface BubblewrapDistributionPackage {
  readonly manager: string;
  readonly name: string;
  readonly version: string;
  /** Package ownership must still bind to the exact observed executable. */
  readonly installedBinaryIdentity: BubblewrapBinaryIdentity;
}

/** Host-side static observation consumed by the fail-closed prerequisite evaluator. */
export interface BubblewrapStaticObservation {
  readonly platform: string;
  /** The account that made the observations and will execute Bubblewrap. */
  readonly observerUid: number;
  readonly binary: BubblewrapBinaryObservation;
  readonly ancestorDirectories: readonly BubblewrapAncestorDirectory[];
  /** Present only when a host-owned package observer bound it to the executable. */
  readonly distributionPackage?: BubblewrapDistributionPackage;
}

/** Locally approved, exact upstream Bubblewrap release for the required CVE. */
export interface HostApprovedBubblewrapUpstreamRelease {
  readonly kind: "upstream-release";
  readonly release: string;
  readonly binaryIdentity: BubblewrapBinaryIdentity;
  readonly sha256: string;
  /** Stable host approval ID; descriptive references alone are not evidence. */
  readonly approvalId: string;
}

/** Locally approved, exact distribution backport evidence for the required CVE. */
export interface HostApprovedBubblewrapDistributionBackport {
  readonly kind: "distribution-backport";
  readonly packageManager: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly advisory: typeof BUBBLEWRAP_REQUIRED_CVE;
  readonly binaryIdentity: BubblewrapBinaryIdentity;
  readonly sha256: string;
  /** Stable host approval ID; descriptive references alone are not evidence. */
  readonly approvalId: string;
}

/** Host-owned exact patched-build approvals; never sourced from a manifest or task. */
export type HostApprovedBubblewrapBuild =
  | HostApprovedBubblewrapUpstreamRelease
  | HostApprovedBubblewrapDistributionBackport;

/** Immutable static prerequisite evidence; it deliberately does not attest runtime isolation. */
export interface BubblewrapStaticPrerequisiteEvidence {
  readonly capabilityProbe: "not-run";
  readonly binaryPath: string;
  readonly binaryIdentity: BubblewrapBinaryIdentity;
  readonly sha256: string;
  readonly version: string;
  readonly provenance:
    | {
        readonly kind: "upstream-release";
        readonly release: string;
        readonly approvalId: string;
      }
    | {
        readonly kind: "distribution-backport";
        readonly packageManager: string;
        readonly packageName: string;
        readonly packageVersion: string;
        readonly approvalId: string;
      };
}

/** Reason static Bubblewrap admission was denied before a command can be spawned. */
export type BubblewrapPrerequisiteRejectionReason =
  | "bubblewrap-unsupported-platform"
  | "bubblewrap-privileged-observer"
  | "bubblewrap-invalid-observation"
  | "bubblewrap-path-not-absolute"
  | "bubblewrap-path-not-canonical"
  | "bubblewrap-ancestor-mismatch"
  | "bubblewrap-unsafe-ancestor"
  | "bubblewrap-not-regular-file"
  | "bubblewrap-unsafe-binary-owner"
  | "bubblewrap-set-id-mode"
  | "bubblewrap-writable-mode"
  | "bubblewrap-not-unprivileged-executable"
  | "bubblewrap-file-capabilities"
  | "bubblewrap-unverified-build"
  | "bubblewrap-required-option-missing";

/** Explicit result from static prerequisites; no rejected state is silently accepted. */
export type BubblewrapStaticPrerequisiteResult =
  | { readonly status: "accepted"; readonly evidence: BubblewrapStaticPrerequisiteEvidence }
  | {
      readonly status: "rejected";
      readonly reason: BubblewrapPrerequisiteRejectionReason;
      readonly option?: (typeof BUBBLEWRAP_REQUIRED_OPTIONS)[number];
    };

/**
 * Assess static Bubblewrap evidence without executing a namespace probe (Issue #106 §5).
 *
 * `approvedBuilds` is host-owned configuration produced from authoritative local
 * verification. It is intentionally separate from the observation so a manifest or
 * caller cannot treat an arbitrary observed version as proof of a backport.
 */
export function assessBubblewrapStaticPrerequisites(
  observation: BubblewrapStaticObservation,
  approvedBuilds: readonly HostApprovedBubblewrapBuild[] = [],
): BubblewrapStaticPrerequisiteResult {
  if (observation.platform !== "linux") return rejected("bubblewrap-unsupported-platform");
  if (!Number.isInteger(observation.observerUid) || observation.observerUid <= 0)
    return rejected("bubblewrap-privileged-observer");

  const { binary } = observation;
  if (!isSha256(binary.sha256)) return rejected("bubblewrap-invalid-observation");
  if (!posix.isAbsolute(binary.path)) return rejected("bubblewrap-path-not-absolute");
  if (posix.normalize(binary.path) !== binary.path)
    return rejected("bubblewrap-path-not-canonical");
  if (!hasSafeAncestorChain(binary.path, observation.ancestorDirectories))
    return rejected("bubblewrap-ancestor-mismatch");
  if (observation.ancestorDirectories.some((entry) => !isSafeAncestor(entry)))
    return rejected("bubblewrap-unsafe-ancestor");
  if (!binary.isRegularFile) return rejected("bubblewrap-not-regular-file");
  if (binary.identity.uid !== 0) return rejected("bubblewrap-unsafe-binary-owner");
  if ((binary.identity.mode & 0o6000) !== 0) return rejected("bubblewrap-set-id-mode");
  if ((binary.identity.mode & 0o022) !== 0) return rejected("bubblewrap-writable-mode");
  if ((binary.identity.mode & 0o001) === 0)
    return rejected("bubblewrap-not-unprivileged-executable");
  if (binary.fileCapabilities.length !== 0) return rejected("bubblewrap-file-capabilities");

  const version = observedVersion(binary.upstreamVersionOutput);
  if (version === null) return rejected("bubblewrap-unverified-build");
  const provenance = provenPatchedBuild(
    version,
    observation.distributionPackage,
    binary.identity,
    binary.sha256,
    approvedBuilds,
  );
  if (provenance === null) return rejected("bubblewrap-unverified-build");

  const options = new Set(binary.supportedOptions);
  for (const option of BUBBLEWRAP_REQUIRED_OPTIONS) {
    if (!options.has(option)) return rejected("bubblewrap-required-option-missing", option);
  }

  return Object.freeze({
    status: "accepted",
    evidence: Object.freeze({
      capabilityProbe: "not-run",
      binaryPath: binary.path,
      binaryIdentity: Object.freeze({ ...binary.identity }),
      sha256: binary.sha256,
      version,
      provenance: Object.freeze(provenance),
    }),
  });
}

/** Compare the pre-spawn binary identity with its accepted static evidence (Issue #106 §5). */
export function bubblewrapBinaryIdentityChanged(
  evidence: BubblewrapStaticPrerequisiteEvidence,
  current: CurrentBubblewrapBinary,
): boolean {
  return (
    !isSha256(current.sha256) ||
    evidence.sha256 !== current.sha256 ||
    !sameBinaryIdentity(evidence.binaryIdentity, current.identity)
  );
}

function rejected(
  reason: BubblewrapPrerequisiteRejectionReason,
  option?: (typeof BUBBLEWRAP_REQUIRED_OPTIONS)[number],
): BubblewrapStaticPrerequisiteResult {
  return option === undefined
    ? Object.freeze({ status: "rejected", reason })
    : Object.freeze({ status: "rejected", reason, option });
}

function isSafeAncestor(entry: BubblewrapAncestorDirectory): boolean {
  return entry.isDirectory && entry.uid === 0 && (entry.mode & 0o022) === 0;
}

function hasSafeAncestorChain(
  binaryPath: string,
  ancestors: readonly BubblewrapAncestorDirectory[],
): boolean {
  const expected = ancestorPaths(binaryPath);
  return (
    expected.length === ancestors.length &&
    expected.every((path, index) => path === ancestors[index]?.path)
  );
}

function ancestorPaths(binaryPath: string): readonly string[] {
  const paths: string[] = [];
  let current = posix.dirname(binaryPath);
  while (true) {
    paths.push(current);
    const parent = posix.dirname(current);
    if (parent === current) return paths.reverse();
    current = parent;
  }
}

function observedVersion(rawVersion: string): string | null {
  const match = /^bubblewrap (\d+\.\d+\.\d+)(?:\r?\n)?$/.exec(rawVersion);
  return match?.[1] ?? null;
}

function provenPatchedBuild(
  version: string,
  distributionPackage: BubblewrapDistributionPackage | undefined,
  binaryIdentity: BubblewrapBinaryIdentity,
  binarySha256: string,
  approvedBuilds: readonly HostApprovedBubblewrapBuild[],
): BubblewrapStaticPrerequisiteEvidence["provenance"] | null {
  const upstream = approvedBuilds.find(
    (candidate): candidate is HostApprovedBubblewrapUpstreamRelease =>
      candidate.kind === "upstream-release" &&
      candidate.release === version &&
      isPatchedUpstreamRelease(candidate.release) &&
      candidate.approvalId.trim().length > 0 &&
      isSha256(candidate.sha256) &&
      candidate.sha256 === binarySha256 &&
      sameBinaryIdentity(candidate.binaryIdentity, binaryIdentity),
  );
  if (upstream !== undefined)
    return {
      kind: "upstream-release",
      release: upstream.release,
      approvalId: upstream.approvalId,
    };
  if (
    distributionPackage === undefined ||
    !sameBinaryIdentity(binaryIdentity, distributionPackage.installedBinaryIdentity)
  )
    return null;
  const backport = approvedBuilds.find(
    (candidate): candidate is HostApprovedBubblewrapDistributionBackport =>
      candidate.kind === "distribution-backport" &&
      candidate.packageManager === distributionPackage.manager &&
      candidate.packageName === distributionPackage.name &&
      candidate.packageVersion === distributionPackage.version &&
      candidate.advisory === BUBBLEWRAP_REQUIRED_CVE &&
      candidate.approvalId.trim().length > 0 &&
      isSha256(candidate.sha256) &&
      candidate.sha256 === binarySha256 &&
      sameBinaryIdentity(candidate.binaryIdentity, binaryIdentity),
  );
  return backport === undefined
    ? null
    : {
        kind: "distribution-backport",
        packageManager: backport.packageManager,
        packageName: backport.packageName,
        packageVersion: backport.packageVersion,
        approvalId: backport.approvalId,
      };
}

function isPatchedUpstreamRelease(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch))
    return false;
  return major > 0 || (major === 0 && (minor > 12 || (minor === 12 && patch >= 0)));
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function sameBinaryIdentity(
  left: BubblewrapBinaryIdentity,
  right: BubblewrapBinaryIdentity,
): boolean {
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
