/** Production preflight, durable selection and visible notice (§2–4). */
import type { ProductionHostOptions } from "../production-host-options.js";
import {
  detectExecutionCapabilities,
  ExecutionCapabilityError,
  executionDegradationNotice,
  preflightExecution,
} from "./execution-capabilities.js";

/** Pin the host's execution tier before any role/model work; fail rather than downgrade requirements. */
export function admitProductionExecution(options: ProductionHostOptions): "enhanced" | "baseline" {
  const capabilities = preflightExecution(
    options.loadedManifest.manifest,
    detectExecutionCapabilities(),
  );
  if (
    capabilities.execution_tier === "baseline" &&
    (options.defaultWorkspace?.backend === "copy" ||
      options.defaultWorkspace?.backend === "worktree")
  )
    throw new ExecutionCapabilityError(
      "host-required protected workspace requires enhanced Linux capabilities; no unconfined fallback",
    );
  options.log.append({
    type: "execution_capabilities",
    schema_version: 1,
    run_id: options.runId,
    ...capabilities,
    degradations: [...capabilities.degradations],
    ts: Date.now(),
  });
  if (capabilities.degradations.length > 0) {
    const notice = executionDegradationNotice(capabilities);
    if (options.uiContext !== undefined && options.isUiContextCurrent?.() !== false)
      options.uiContext.notify(notice, "warning");
    else process.stderr.write(`${notice}\n`);
  }
  return capabilities.execution_tier;
}
