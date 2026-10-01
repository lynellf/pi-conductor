/** Host-only capability preflight: static manifest validity does not prove OS support (#165). */
import type { Manifest } from "../../manifest/types.js";
import { assertMacObserverReady } from "./macos/observer-runtime.js";
import { isSupervisedProcessSupported } from "./supervised-process-contract.js";

/** Unsupported capabilities name the configured feature before any role/model work begins. */
export class ExecutionCapabilityError extends Error {
  readonly code = "execution-capability-unavailable";
  constructor(message: string) {
    super(message);
    this.name = "ExecutionCapabilityError";
  }
}

/** Check the complete production manifest, including referenced delegated profiles and guards. */
export function assertProductionExecutionCapabilities(manifest: Manifest): void {
  const roles = manifest.roles.filter(
    (role) =>
      role.delegation !== undefined ||
      role.tools?.some((name) =>
        ["read", "write", "edit", "ls", "find", "grep", "bash"].includes(name),
      ),
  );
  const referenced = new Set(
    manifest.roles.flatMap((role) => role.delegation?.allowed_subagents ?? []),
  );
  const sandbox = manifest.subagents?.find(
    (profile) => referenced.has(profile.name) && profile.execution?.backend === "bubblewrap",
  );
  if (process.platform !== "linux" && (sandbox !== undefined || manifest.controller !== undefined))
    throw new ExecutionCapabilityError(
      sandbox === undefined
        ? "controller sandbox execution requires Linux/Bubblewrap; ordinary macOS role tools are supported"
        : `subagent '${sandbox.name}' requires Linux/Bubblewrap; no unsandboxed fallback is permitted`,
    );
  if (roles.length === 0 && manifest.end_guard === undefined) return;
  if (!isSupervisedProcessSupported())
    throw new ExecutionCapabilityError(
      `supervised execution is unavailable on ${process.platform}; required by ${roles.map((role) => role.name).join(", ") || "end_guard"}`,
    );
  if (process.platform === "darwin") assertMacObserverReady();
}
