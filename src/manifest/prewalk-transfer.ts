/** Pure Prewalk transfer-mode selection (spec §R2 and Slice 2). */

import type { PrewalkConfig } from "./types.js";

/** The two host-supported guide→executor transfer modes. */
export type TransferMode = "native" | "projection";

/** Minimum preflight decision consumed by transfer selection. */
export interface PrewalkTransferPreflight {
  readonly ok: boolean;
}

/** Forward-budget decision consumed by transfer selection. */
export interface PrewalkTransferBudget {
  readonly transcript_fits: boolean;
}

/** Stable typed failure when policy forbids projection after a failed preflight. */
export class PrewalkTransformUnsupportedError extends Error {
  readonly code = "prewalk_transform_unsupported" as const;

  constructor() {
    super("prewalk native transfer preflight failed and projection fallback is disabled");
    this.name = "PrewalkTransformUnsupportedError";
  }
}

/** Select native unless projection is explicit, budget-required, or the configured fallback. */
export function selectTransferMode(
  config: Pick<PrewalkConfig, "transfer" | "on_preflight_failure">,
  preflight: PrewalkTransferPreflight,
  budget: PrewalkTransferBudget,
): TransferMode {
  if (config.transfer === "projection" || !budget.transcript_fits) return "projection";
  if (preflight.ok) return "native";
  if (config.on_preflight_failure === "project") return "projection";
  throw new PrewalkTransformUnsupportedError();
}
