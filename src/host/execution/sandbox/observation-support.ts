import type { BubblewrapBinaryIdentity, HostApprovedBubblewrapBuild } from "./prerequisites.js";

/** Find an approved, patched upstream build bound to the observed file. */
export function matchingUpstreamApproval(
  approvals: readonly HostApprovedBubblewrapBuild[],
  identity: BubblewrapBinaryIdentity,
  sha256: string,
): Extract<HostApprovedBubblewrapBuild, { kind: "upstream-release" }> | undefined {
  return approvals.find(
    (approval): approval is Extract<HostApprovedBubblewrapBuild, { kind: "upstream-release" }> =>
      approval.kind === "upstream-release" &&
      isPatchedRelease(approval.release) &&
      approval.approvalId.trim().length > 0 &&
      approval.sha256 === sha256 &&
      sameIdentity(approval.binaryIdentity, identity),
  );
}

/** Return whether an exact stable release contains the 0.12.0 security fix. */
export function isPatchedRelease(release: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(release);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) return false;
  return major > 0 || (major === 0 && (minor > 12 || (minor === 12 && patch >= 0)));
}

/** Extract the bounded long-option tokens advertised by trusted help output. */
export function extractOptions(help: string): readonly string[] {
  return Object.freeze([...new Set(help.match(/--[a-z0-9-]+/gi) ?? [])]);
}

/** Compare every field in the fixed executable-identity contract. */
export function sameIdentity(
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

/** Validate integer identity fields while permitting fractional stat timestamps. */
export function validIdentity(identity: BubblewrapBinaryIdentity): boolean {
  return (
    [
      identity.device,
      identity.inode,
      identity.mode,
      identity.uid,
      identity.gid,
      identity.size,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    [identity.mtimeMs, identity.ctimeMs].every((value) => Number.isFinite(value) && value >= 0)
  );
}
