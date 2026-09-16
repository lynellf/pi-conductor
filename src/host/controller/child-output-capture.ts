/** Trusted native child-output collection at the settled worktree boundary — issue #116 A3. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ControllerChildOutputPolicy } from "../../manifest/controller-output.js";
import type { ChildOutputCapture } from "../../persistence/child-output-records.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import {
  trustedGitConfig,
  trustedGitEnvironment,
} from "../execution/sandbox/trusted-git-environment.js";
import {
  assertGeneratedBranch,
  assertGitObjectId,
  canonicalGitDirectory,
  isSafeGitPath,
  TRUSTED_GIT_BINARY,
  verifyTrustedGitBinary,
} from "../execution/sandbox/trusted-git-validation.js";
import {
  assertChildOutputPresent,
  assertPrivateChildWorktree,
  readBoundedChildOutput,
} from "./child-output-capture-files.js";

const execute = promisify(execFile);
const MAX_REPORT_BYTES = 128 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const TRACKED_STATUS_PAIRS = new Set([
  " M",
  " T",
  " D",
  "M ",
  "MM",
  "MT",
  "MD",
  "T ",
  "TM",
  "TT",
  "TD",
  "A ",
  "AM",
  "AT",
  "AD",
  "D ",
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
]);

/** Exact bytes collected from one approved native-child output policy. */
export interface CapturedChildOutput {
  readonly id: string;
  readonly path: string | null;
  readonly kind: "report" | "patch";
  readonly mediaType:
    | "text/plain"
    | "text/markdown"
    | "application/json"
    | "application/octet-stream"
    | "application/x-git-patch";
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly byteLength: number;
}

interface WorktreeSnapshot {
  readonly branch: string;
  readonly head: string;
  readonly status: Buffer;
  readonly diff: Buffer;
  readonly identity: string;
  readonly fingerprint: string;
}

/** Capture policy-authorized bytes only while the settled child worktree stays identical. */
export async function captureTrustedChildOutputs(input: {
  readonly worktree: {
    readonly path: string;
    readonly branch: string;
    readonly acceptedBase: string;
  };
  readonly policy: ControllerChildOutputPolicy;
  readonly policyDigest: string;
  /** Deterministic mutation seam for bounded capture tests only. */
  readonly testHook?: (stage: "after-report-read") => void | Promise<void>;
}): Promise<{
  readonly capture: ChildOutputCapture;
  readonly outputs: readonly CapturedChildOutput[];
}> {
  assertGeneratedBranch(input.worktree.branch);
  assertGitObjectId(input.worktree.acceptedBase);
  if (
    !/^[a-f0-9]{64}$/u.test(input.policyDigest) ||
    input.policyDigest !== sha256Canonical(input.policy)
  )
    throw new Error("child output policy digest is invalid");
  assertPolicyBounds(input.policy);
  await verifyTrustedGitBinary();
  const root = await canonicalGitDirectory(input.worktree.path);
  await assertPrivateChildWorktree(root);

  const before = await snapshot(root, input.worktree);
  assertPermittedChanges(before.status, input.policy);
  const reports = await Promise.all(
    input.policy.reports.map(async (report) =>
      captureReport(root, report.id, report.path, report.media_type, report.max_bytes),
    ),
  );
  await input.testHook?.("after-report-read");
  const patch =
    input.policy.patch === undefined
      ? []
      : [await capturePatch(root, before.status, input.worktree.acceptedBase, input.policy.patch)];
  assertTotalBytes([...reports, ...patch]);

  const after = await snapshot(root, input.worktree);
  if (before.identity !== after.identity || before.fingerprint !== after.fingerprint)
    throw new Error("child output source changed during capture");
  await assertReportsUnchanged(root, reports, input.policy);
  const outputs = Object.freeze([...reports, ...patch]);
  const capture: ChildOutputCapture = Object.freeze({
    schema_version: 1,
    accepted_base: input.worktree.acceptedBase,
    head_commit: before.head,
    policy_digest: input.policyDigest,
    profile_id: input.policy.profile_id,
    outputs: outputs.map((output) =>
      Object.freeze({
        id: output.id,
        path: output.path,
        kind: output.kind,
        media_type: output.mediaType,
        sha256: output.sha256,
        byte_length: output.byteLength,
      }),
    ),
  });
  return Object.freeze({ capture, outputs });
}

async function snapshot(
  root: string,
  worktree: { readonly branch: string; readonly acceptedBase: string },
): Promise<WorktreeSnapshot> {
  const [branch, head, status, diff, identity] = await Promise.all([
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(root, ["rev-parse", "--verify", "HEAD"]),
    git(root, [
      "-c",
      "status.renames=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ]),
    git(root, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--full-index",
      worktree.acceptedBase,
    ]),
    captureWorktreeIdentity(root),
  ]);
  const branchText = branch.toString().trim();
  const headText = head.toString().trim();
  if (branchText !== worktree.branch || headText !== worktree.acceptedBase)
    throw new Error("trusted child worktree branch or HEAD changed");
  assertGitObjectId(headText);
  return Object.freeze({
    branch: branchText,
    head: headText,
    status,
    diff,
    identity,
    fingerprint: digest(Buffer.concat([branch, head, status, diff])),
  });
}

function assertPermittedChanges(status: Buffer, policy: ControllerChildOutputPolicy): void {
  const permitted = new Set<string>([
    ...policy.reports.map((report) => report.path),
    ...(policy.patch?.paths ?? []),
  ]);
  for (const entry of parseStatus(status)) {
    if (!permitted.has(entry.path))
      throw new Error("child output capture found an unexpected changed path");
    if (entry.kind === "ignored")
      throw new Error("child output capture refuses ignored output paths");
    if (entry.kind === "untracked" && policy.patch?.paths.includes(entry.path))
      throw new Error("child output capture cannot safely generate an untracked patch path");
  }
}

async function captureReport(
  root: string,
  id: string,
  path: string,
  mediaType: CapturedChildOutput["mediaType"],
  policyLimit: number,
): Promise<CapturedChildOutput> {
  const bytes = await readBoundedChildOutput(root, path, Math.min(policyLimit, MAX_REPORT_BYTES));
  return output({ id, path, kind: "report", mediaType, bytes });
}

async function capturePatch(
  root: string,
  status: Buffer,
  base: string,
  policy: NonNullable<ControllerChildOutputPolicy["patch"]>,
): Promise<CapturedChildOutput> {
  const changed = new Set(parseStatus(status).map((entry) => entry.path));
  for (const path of policy.paths) {
    if (changed.has(path)) await assertChildOutputPresent(root, path);
  }
  const bytes = await git(root, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--full-index",
    base,
    "--",
    ...policy.paths,
  ]);
  if (bytes.byteLength > Math.min(policy.max_bytes, MAX_PATCH_BYTES))
    throw new Error("child output patch exceeds byte limit");
  return output({
    id: policy.id,
    path: null,
    kind: "patch",
    mediaType: "application/x-git-patch",
    bytes,
  });
}

function output(value: Omit<CapturedChildOutput, "sha256" | "byteLength">): CapturedChildOutput {
  return Object.freeze({
    ...value,
    sha256: digest(value.bytes),
    byteLength: value.bytes.byteLength,
  });
}

function assertTotalBytes(outputs: readonly CapturedChildOutput[]): void {
  if (outputs.length === 0 || outputs.length > 16)
    throw new Error("child output count is outside bounds");
  if (outputs.reduce((total, output) => total + output.byteLength, 0) > MAX_TOTAL_BYTES)
    throw new Error("child output capture exceeds total byte limit");
}

function assertPolicyBounds(policy: ControllerChildOutputPolicy): void {
  const count = policy.reports.length + (policy.patch === undefined ? 0 : 1);
  if (count < 1 || count > 16) throw new Error("child output count is outside bounds");
  let total = 0;
  for (const report of policy.reports) {
    if (
      !Number.isSafeInteger(report.max_bytes) ||
      report.max_bytes < 1 ||
      report.max_bytes > MAX_REPORT_BYTES
    )
      throw new Error("child output report byte limit is invalid");
    total += report.max_bytes;
  }
  if (policy.patch !== undefined) {
    if (
      !Number.isSafeInteger(policy.patch.max_bytes) ||
      policy.patch.max_bytes < 1 ||
      policy.patch.max_bytes > MAX_PATCH_BYTES ||
      policy.patch.paths.length < 1 ||
      policy.patch.paths.length > 256
    )
      throw new Error("child output patch limit is invalid");
    total += policy.patch.max_bytes;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error("child output capture exceeds total byte limit");
}

async function assertReportsUnchanged(
  root: string,
  reports: readonly CapturedChildOutput[],
  policy: ControllerChildOutputPolicy,
): Promise<void> {
  for (const report of reports) {
    if (report.path === null) throw new Error("child output report path is missing");
    const selected = policy.reports.find((candidate) => candidate.id === report.id);
    if (selected === undefined) throw new Error("child output report policy is missing");
    const bytes = await readBoundedChildOutput(
      root,
      report.path,
      Math.min(selected.max_bytes, MAX_REPORT_BYTES),
    );
    if (bytes.byteLength !== report.byteLength || digest(bytes) !== report.sha256)
      throw new Error("child output source changed during capture");
  }
}

async function captureWorktreeIdentity(root: string): Promise<string> {
  const control = join(root, ".git");
  const [directory, metadata] = await Promise.all([lstat(root), lstat(control)]);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    metadata.isSymbolicLink() ||
    (!metadata.isDirectory() && !metadata.isFile())
  )
    throw new Error("trusted child worktree metadata is unsafe");
  return JSON.stringify({
    directory: stableIdentity(directory),
    metadata: stableIdentity(metadata),
  });
}

function stableIdentity(stat: Awaited<ReturnType<typeof lstat>>): Record<string, string> {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtime: String(stat.mtimeMs),
    ctime: String(stat.ctimeMs),
  };
}

async function git(root: string, args: readonly string[]): Promise<Buffer> {
  try {
    const { stdout } = await execute(
      TRUSTED_GIT_BINARY,
      [...trustedGitConfig(), "-C", root, ...args],
      {
        encoding: "buffer",
        env: trustedGitEnvironment(),
        timeout: 15_000,
        maxBuffer: MAX_GIT_OUTPUT,
        killSignal: "SIGKILL",
      },
    );
    return stdout;
  } catch {
    throw new Error("trusted child output Git inspection failed");
  }
}

function parseStatus(
  value: Buffer,
): readonly { readonly kind: "changed" | "untracked" | "ignored"; readonly path: string }[] {
  const fields = value.toString("utf8").split("\0");
  const entries: { kind: "changed" | "untracked" | "ignored"; path: string }[] = [];
  for (const field of fields) {
    if (field === "") continue;
    const prefix = field.slice(0, 3);
    const path = field.slice(3);
    const pair = prefix.slice(0, 2);
    if (
      prefix.length !== 3 ||
      prefix[2] !== " " ||
      (pair !== "??" && pair !== "!!" && !TRACKED_STATUS_PAIRS.has(pair)) ||
      !isSafeGitPath(path)
    )
      throw new Error("trusted child output status is malformed");
    entries.push({
      kind: prefix === "?? " ? "untracked" : prefix === "!! " ? "ignored" : "changed",
      path,
    });
  }
  return entries;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
