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
  const projectionRoots =
    input.projectionRoots === undefined ? undefined : [...input.projectionRoots].sort();
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
    ...(projectionRoots === undefined ? {} : { projectionRoots }),
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
  });
  if (sha256Canonical(value) !== sha256Canonical(expected))
    throw new Error("pinned sandbox policy authority or digest mismatch");
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
