/** Host-only Bubblewrap approval metadata loader — Issue #106 §5. */

import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { SANDBOX_CAPABILITY_PROBE_PATH } from "../../../persistence/sandbox-probe.js";
import { preparedRuntimeIdentitySchema } from "../../../persistence/sandbox-runtime.js";
import { withSandboxDirectory } from "./anchored-file-access.js";
import { canonicalTrustedSnapshotParent } from "./runtime-capture.js";

const sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const approvalId = Type.String({ minLength: 1, maxLength: 256 });
const approvedBuild = Type.Object(
  {
    kind: Type.Literal("upstream-release"),
    release: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$", maxLength: 32 }),
    binaryIdentity: preparedRuntimeIdentitySchema,
    sha256,
    approvalId,
  },
  { additionalProperties: false },
);
const runtimeFile = Type.Object({ path, sha256 }, { additionalProperties: false });
const bootstrap = Type.Object(
  { approvalId, files: Type.Array(runtimeFile, { minItems: 1, maxItems: 10_000 }) },
  { additionalProperties: false },
);
const probe = Type.Object({ approvalId, sha256 }, { additionalProperties: false });

/** Strict, host-owned Bubblewrap approval document derived from one schema. */
export const sandboxHostApprovalSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    binaryPath: path,
    approvedBuilds: Type.Array(approvedBuild, { minItems: 1, maxItems: 10_000 }),
    bootstrapApproval: bootstrap,
    probeApproval: probe,
    getcapPath: Type.Optional(path),
  },
  { additionalProperties: false },
);

/** Host approval accepted by the production prerequisite evaluator. */
export type SandboxHostApproval = Readonly<Static<typeof sandboxHostApprovalSchema>>;

const MAX_APPROVAL_BYTES = 8 * 1024 * 1024;
const ALLOWED_TOP_LEVEL = new Set(["bin", "sbin", "usr", "lib", "lib64", "etc", "opt"]);

/** Load strict approval metadata through a protected, no-follow host boundary. */
export async function loadSandboxHostApproval(filePath: string): Promise<SandboxHostApproval> {
  const canonical = validateAbsolutePath(filePath, "approval file");
  const parent = await canonicalTrustedSnapshotParent(dirname(canonical));
  const stat = await lstat(canonical);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error("sandbox host approval file must be a current-user regular file with mode 600");
  }
  const basename = posix.basename(canonical);
  const bytes = await withSandboxDirectory(parent, async (directory) => {
    const before = await directory.fileStat(basename);
    const contents = await directory.read(basename, MAX_APPROVAL_BYTES);
    const after = await directory.fileStat(basename);
    if (
      !sameFileIdentity(before, after) ||
      after.uid !== uid ||
      after.nlink !== 1 ||
      (after.mode & 0o777) !== 0o600
    )
      throw new Error("sandbox host approval file changed during read");
    return contents;
  });
  if (bytes.length > MAX_APPROVAL_BYTES) throw new Error("sandbox host approval file is too large");
  let candidate: unknown;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("sandbox host approval file is not valid JSON");
  }
  return validateApproval(candidate);
}

function validateApproval(candidate: unknown): SandboxHostApproval {
  if (!Value.Check(sandboxHostApprovalSchema, candidate))
    throw new Error("sandbox host approval does not match schema version 1");
  const value = candidate as Static<typeof sandboxHostApprovalSchema>;
  for (const id of [
    value.bootstrapApproval.approvalId,
    value.probeApproval.approvalId,
    ...value.approvedBuilds.map((build) => build.approvalId),
  ]) {
    if (id.trim() !== id || id.includes("\0")) throw new Error("approval IDs must be literal text");
  }
  validatePath(value.binaryPath, "binaryPath");
  if (value.getcapPath !== undefined) validatePath(value.getcapPath, "getcapPath");
  const seen = new Set<string>();
  let previousPath: string | undefined;
  for (const file of value.bootstrapApproval.files) {
    validateRuntimePath(file.path);
    if (seen.has(file.path)) throw new Error(`duplicate approved runtime path '${file.path}'`);
    seen.add(file.path);
    if (previousPath !== undefined && file.path <= previousPath)
      throw new Error("bootstrap approval inventory must be sorted by path");
    previousPath = file.path;
  }
  const bash = value.bootstrapApproval.files.find((file) => file.path === "bin/bash");
  const probe = value.bootstrapApproval.files.find(
    (file) => file.path === SANDBOX_CAPABILITY_PROBE_PATH.slice(1),
  );
  if (bash === undefined) throw new Error("bootstrap approval must include bin/bash");
  if (probe === undefined)
    throw new Error("bootstrap approval must include the fixed capability probe");
  if (probe.sha256 !== value.probeApproval.sha256)
    throw new Error("probe approval digest does not match the approved runtime inventory");
  return deepFreeze(structuredClone(value));
}

function validateRuntimePath(value: string): void {
  if (value.startsWith("/") || value.includes("\\") || value.split("/").includes(".."))
    throw new Error(`approved runtime path '${value}' is not a safe relative path`);
  if (posix.normalize(value) !== value || value.includes("\0"))
    throw new Error(`approved runtime path '${value}' is not canonical`);
  const top = value.split("/")[0];
  if (top === undefined || !ALLOWED_TOP_LEVEL.has(top))
    throw new Error(`approved runtime path '${value}' is outside admitted runtime roots`);
}

function validatePath(value: string, label: string): void {
  if (
    value.includes("\0") ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "/"
  )
    throw new Error(`${label} must be a canonical absolute path`);
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function validateAbsolutePath(value: string, label: string): string {
  validatePath(value, label);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
