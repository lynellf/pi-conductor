/**
 * PR_SET_CHILD_SUBREAPER support for the supervision host (issue #157 option 1).
 *
 * With the host as nearest subreaper, escaped orphans reparent to the host
 * instead of init, so the lineage classifier can prove non-descendance even
 * when candidate chains cross shared same-UID ancestors (tmux, sshd sessions).
 * The addon sets the bit and verifies it via PR_GET_CHILD_SUBREAPER; when the
 * addon is unavailable the state reports inactive and classification keeps the
 * fail-closed behavior it had before this feature.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Result of equipping this process as a child subreaper. */
export interface ChildSubreaperState {
  /** The prctl bindings loaded and answered queries. */
  readonly available: boolean;
  /** PR_GET_CHILD_SUBREAPER confirms this process is a subreaper. */
  readonly active: boolean;
  /** Human-readable outcome for logs and diagnostics; never empty. */
  readonly detail: string;
}

/** The two prctl bindings exposed by native/child-subreaper.c. */
export interface ChildSubreaperBindings {
  readonly setChildSubreaper: () => number;
  readonly getChildSubreaper: () => number;
}

/** Pure: decide the state from binding calls (table-testable). */
export function evaluateChildSubreaper(
  bindings: ChildSubreaperBindings | undefined,
): ChildSubreaperState {
  if (bindings === undefined) {
    return {
      available: false,
      active: false,
      detail: "child-subreaper bindings unavailable; lineage classification stays fail-closed",
    };
  }
  const setResult = bindings.setChildSubreaper();
  if (setResult !== 0) {
    return {
      available: true,
      active: false,
      detail: `PR_SET_CHILD_SUBREAPER failed with errno ${String(setResult)}; lineage classification stays fail-closed`,
    };
  }
  const confirmed = bindings.getChildSubreaper();
  if (confirmed !== 1) {
    return {
      available: true,
      active: false,
      detail: `PR_GET_CHILD_SUBREAPER returned ${String(confirmed)} after set; lineage classification stays fail-closed`,
    };
  }
  return {
    available: true,
    active: true,
    detail: "host is a verified child subreaper; orphans reparent here instead of init",
  };
}

function loadBindings(): ChildSubreaperBindings | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = join(moduleDir, "..", "..", "..");
  const addonPath = join(packageRoot, "dist", "native", "child-subreaper.node");
  try {
    return createRequire(import.meta.url)(addonPath) as ChildSubreaperBindings;
  } catch {
    return undefined;
  }
}

let cached: ChildSubreaperState | undefined;

/** Idempotent: equip this process as a child subreaper and verify the claim. */
export function ensureChildSubreaper(): ChildSubreaperState {
  if (cached !== undefined) return cached;
  cached = evaluateChildSubreaper(loadBindings());
  if (!cached.active) console.warn(`child-subreaper: ${cached.detail}`);
  return cached;
}

/** Current state without equipping; undefined until ensureChildSubreaper runs. */
export function childSubreaperState(): ChildSubreaperState | undefined {
  return cached;
}
