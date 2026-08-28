/** Issue #63 handoff-policy lookup. This module remains pure and Pi-free. */

import type { Role } from "../core/types.js";
import type { HandoffMode, HandoffPolicy } from "./types.js";

/** Select the pinned transport mode for an accepted directed edge. */
export function modeFor(
  policies: readonly HandoffPolicy[] | undefined,
  from: Role,
  to: Role,
): HandoffMode {
  return policies?.find((policy) => policy.from === from && policy.to === to)?.mode ?? "fresh";
}
