/** Host capability detection and fail-closed requirements — progressive-enhancement §2–4. */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { Manifest } from "../../manifest/types.js";
import { SANDBOX_UNAVAILABLE_MESSAGE } from "./sandbox/enablement.js";

/** Execution guarantees selected before a production role is admitted. */
export interface ExecutionCapabilities {
  readonly platform: NodeJS.Platform;
  readonly execution_tier: "enhanced" | "baseline";
  readonly degradations: readonly string[];
}

const EXECUTABLE_TOOLS = new Set(["bash", "read", "write", "edit", "ls", "find", "grep"]);

function usableLinuxObservation(): boolean {
  try {
    if (process.getuid === undefined || process.geteuid === undefined) return false;
    const stat = readFileSync("/proc/self/stat", "utf8");
    if (!stat.startsWith(`${process.pid} (`) || !stat.includes(") ")) return false;
    readFileSync("/proc/self/environ");
    if (!readFileSync("/proc/self/status", "utf8").includes("Uid:")) return false;
    if (!readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()) return false;
    for (const name of ["pid", "time", "net"]) readlinkSync(`/proc/self/ns/${name}`);
    return readdirSync("/proc").includes(String(process.pid));
  } catch {
    return false;
  }
}

/** Probe only host-owned observation interfaces; never persist environments or install tooling. */
export function detectExecutionCapabilities(
  platform: NodeJS.Platform = process.platform,
  linuxObservation: () => boolean = usableLinuxObservation,
): ExecutionCapabilities {
  const enhanced = platform === "linux" && linuxObservation();
  return Object.freeze({
    platform,
    execution_tier: enhanced ? "enhanced" : "baseline",
    degradations: Object.freeze(
      enhanced
        ? []
        : [
            "descendant-cleanup-unavailable",
            "durable-reconciliation-unavailable",
            "timeout-recovery-unavailable",
            ...(platform === "win32" ? ["process-group-termination-unavailable"] : []),
          ],
    ),
  });
}

/** Typed preflight failure; an explicit security/backend contract cannot degrade. */
export class ExecutionCapabilityError extends Error {
  readonly code = "execution-capability-unavailable";
  constructor(message: string) {
    super(message);
    this.name = "ExecutionCapabilityError";
  }
}

/** Inspect every configured role/profile before model work, without changing the manifest. */
export function preflightExecution(
  manifest: Manifest,
  capabilities: ExecutionCapabilities,
): ExecutionCapabilities {
  const delegationRequired = manifest.roles.some((role) => role.delegation !== undefined);
  const profiles = delegationRequired ? (manifest.subagents ?? []) : [];
  const requiresLinux = manifest.controller !== undefined || delegationRequired;
  if (requiresLinux && capabilities.execution_tier !== "enhanced") {
    throw new ExecutionCapabilityError(
      "configured controller, delegation or Bubblewrap requires enhanced Linux capabilities; no unsandboxed fallback",
    );
  }
  if (profiles.some((profile) => profile.execution?.backend === "bubblewrap"))
    throw new ExecutionCapabilityError(SANDBOX_UNAVAILABLE_MESSAGE);
  if (
    manifest.roles.some(
      (role) => role.workspace?.backend === "container" || role.workspace?.shell === "container",
    )
  ) {
    throw new ExecutionCapabilityError(
      "configured container workspace requires an unavailable backend",
    );
  }
  const executes =
    manifest.end_guard !== undefined ||
    manifest.roles.some((role) => role.tools?.some((name) => EXECUTABLE_TOOLS.has(name)) === true);
  if (
    executes &&
    manifest.execution_policy?.mode === "strict" &&
    capabilities.execution_tier === "baseline"
  ) {
    throw new ExecutionCapabilityError(
      "strict execution_policy requires enhanced cleanup; baseline execution is unavailable under this policy",
    );
  }
  return executes
    ? capabilities
    : Object.freeze({ ...capabilities, degradations: Object.freeze([]) });
}

/** Human-facing notice; baseline success never implies confirmed descendant cleanup. */
export function executionDegradationNotice(capabilities: ExecutionCapabilities): string {
  return `pi-conductor baseline execution on ${capabilities.platform}: ${capabilities.degradations.join(", ")}. Foreground deadlines and output bounds remain; descendant cleanup is NOT guaranteed. Interrupted calls block resume; inspect partial effects before starting new work.`;
}
