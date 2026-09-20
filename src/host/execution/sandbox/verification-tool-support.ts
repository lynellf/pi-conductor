/** Small bounded-data and signal helpers for the fixed verification tool. */

import type { SandboxExecutionTerminal } from "../../../persistence/sandbox-command.js";

const MAX_PREVIEW_CODE_UNITS = 8_192;

/** Bound model-visible command previews without retaining unbounded output. */
export function boundedVerificationPreview(value: string): string {
  return value.length <= MAX_PREVIEW_CODE_UNITS
    ? value
    : `${value.slice(0, MAX_PREVIEW_CODE_UNITS)}\n[preview truncated]`;
}

/** Normalize an untrusted runner status to the factual numeric result contract. */
export function normalizeVerificationStatus(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : 1;
}

/** Read runner evidence without allowing a malformed adapter to escape. */
export function safeVerificationTerminal(runner: {
  readonly terminalEvidence: () => SandboxExecutionTerminal;
}): SandboxExecutionTerminal | undefined {
  try {
    return runner.terminalEvidence();
  } catch {
    return undefined;
  }
}

/** Combine the model call and child lifetime signals without exposing either controller. */
export function combineVerificationSignals(
  child: AbortSignal,
  tool: AbortSignal | undefined,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  child.addEventListener("abort", abort, { once: true });
  tool?.addEventListener("abort", abort, { once: true });
  if (child.aborted || tool?.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      child.removeEventListener("abort", abort);
      tool?.removeEventListener("abort", abort);
    },
  };
}
