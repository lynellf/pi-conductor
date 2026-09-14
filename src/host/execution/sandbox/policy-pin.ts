/** Resolve and verify retained delegated execution authority before queueing (#106 §3). */
import { Value } from "typebox/value";
import {
  resolveToolExecutionPolicy,
  type ToolExecutionPolicy,
} from "../../../manifest/execution-policy.js";
import {
  resolveSubagentExecutionPolicy,
  type SubagentExecutionConfig,
} from "../../../manifest/subagent-execution-policy.js";
import {
  isSafeSnapshotPath,
  validateSubagentSnapshotPolicy,
} from "../../../manifest/subagent-snapshot.js";
import type { SubagentSnapshotPolicy } from "../../../manifest/types.js";
import {
  type PinnedSandboxPolicy,
  pinnedSandboxPolicySchema,
} from "../../../persistence/sandbox-policy.js";
import { sha256Canonical } from "../../../persistence/trajectory-records.js";
import { resolveSandboxWritableAuthority } from "./writable-authority.js";

/** Host-captured projection facts and pinned manifest policy required for admission. */
export interface PinSandboxPolicyInput {
  readonly execution: SubagentExecutionConfig;
  readonly toolExecution?: ToolExecutionPolicy;
  readonly selectedPaths: readonly string[];
  readonly trackedPaths: readonly string[];
  readonly projectionRoots?: readonly string[];
  /** Issue #111: explicit broader profile retained with its exact authority. */
  readonly snapshot?: SubagentSnapshotPolicy;
}

/** Resolve a deterministic authority digest independently of generated child IDs. */
export function pinSandboxPolicy(input: PinSandboxPolicyInput): PinnedSandboxPolicy {
  const resolved = resolveSubagentExecutionPolicy(input.execution);
  if (
    resolved.backend !== "bubblewrap" ||
    resolved.runtime_root === null ||
    resolved.network !== "none"
  )
    throw new Error("sandbox policy requires explicit Bubblewrap authority");
  const selectedPaths = [...input.selectedPaths].sort();
  const trackedPaths = [...input.trackedPaths].sort();
  const workspaceSnapshot = resolveWorkspaceSnapshot(input.snapshot, selectedPaths);
  const projectionRoots = resolveProjectionRoots(input.projectionRoots, workspaceSnapshot);
  const writableRoots = resolveSandboxWritableAuthority({
    writablePaths: resolved.writable_paths,
    selectedPaths,
    trackedPaths,
    ...(projectionRoots === undefined ? {} : { projectionRoots }),
  });
  const authority = {
    schemaVersion: 1 as const,
    execution: {
      backend: "bubblewrap" as const,
      runtime_root: resolved.runtime_root,
      writable_paths: [...resolved.writable_paths].sort(),
      network: "none" as const,
      environment: { PATH: "/bin", LANG: "C", ...resolved.environment },
      max_output_bytes: resolved.max_output_bytes,
    },
    toolExecution: { ...resolveToolExecutionPolicy(input.toolExecution) },
    selectedPaths,
    trackedPaths,
    ...(projectionRoots === undefined ? {} : { projectionRoots: [...projectionRoots] }),
    ...(workspaceSnapshot === undefined
      ? {}
      : {
          workspaceSnapshot: {
            mode: workspaceSnapshot.mode,
            paths: [...workspaceSnapshot.paths],
            max_files: workspaceSnapshot.max_files,
          },
        }),
    writableRoots: writableRoots.map((root) => ({ ...root })),
  };
  return freeze({ ...authority, digest: sha256Canonical(authority) });
}

/** Reject malformed, widened, or modified retained policy before filesystem access. */
export function assertPinnedSandboxPolicy(value: unknown): asserts value is PinnedSandboxPolicy {
  if (!Value.Check(pinnedSandboxPolicySchema, value))
    throw new Error("invalid pinned sandbox policy schema");
  const expected = pinSandboxPolicy({
    execution: value.execution,
    toolExecution: value.toolExecution,
    selectedPaths: value.selectedPaths,
    trackedPaths: value.trackedPaths,
    ...(value.projectionRoots === undefined ? {} : { projectionRoots: value.projectionRoots }),
    ...(value.workspaceSnapshot === undefined
      ? {}
      : {
          snapshot: {
            paths: value.workspaceSnapshot.paths,
            max_files: value.workspaceSnapshot.max_files,
          },
        }),
  });
  if (sha256Canonical(value) !== sha256Canonical(expected))
    throw new Error("pinned sandbox policy authority or digest mismatch");
}

function resolveWorkspaceSnapshot(
  snapshot: SubagentSnapshotPolicy | undefined,
  selectedPaths: readonly string[],
):
  | { readonly mode: "snapshot"; readonly paths: readonly string[]; readonly max_files: number }
  | undefined {
  if (snapshot === undefined) return undefined;
  const errors = validateSubagentSnapshotPolicy(snapshot);
  if (errors.length > 0) throw new Error(`invalid workspace snapshot: ${errors[0]}`);

  if (selectedPaths.length === 0)
    throw new Error("workspace snapshot selected paths must not be empty");
  if (selectedPaths.length > snapshot.max_files)
    throw new Error(
      `workspace snapshot selected ${selectedPaths.length} files, exceeding max_files ${snapshot.max_files}`,
    );
  if (new Set(selectedPaths).size !== selectedPaths.length)
    throw new Error("workspace snapshot selected paths must be unique");
  if (selectedPaths.some((path) => !isSafeSnapshotPath(path)))
    throw new Error("workspace snapshot selected paths must be safe literals");

  const paths = Object.freeze([...snapshot.paths].sort());
  for (const root of paths) {
    if (!selectedPaths.some((path) => isCoveredBy(path, root)))
      throw new Error(`workspace snapshot root '${root}' matches no selected path`);
  }
  for (const path of selectedPaths) {
    if (!paths.some((root) => isCoveredBy(path, root)))
      throw new Error(`workspace snapshot selected path '${path}' is outside its configured roots`);
  }
  return Object.freeze({ mode: "snapshot" as const, paths, max_files: snapshot.max_files });
}

function resolveProjectionRoots(
  inputRoots: readonly string[] | undefined,
  snapshot:
    | { readonly mode: "snapshot"; readonly paths: readonly string[]; readonly max_files: number }
    | undefined,
): readonly string[] | undefined {
  const roots = inputRoots === undefined ? undefined : Object.freeze([...inputRoots].sort());
  if (snapshot === undefined) return roots;
  if (roots !== undefined && !samePaths(roots, snapshot.paths))
    throw new Error("workspace snapshot projection roots do not match configured snapshot paths");
  return snapshot.paths;
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function isCoveredBy(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
