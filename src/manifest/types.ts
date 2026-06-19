/**
 * Manifest types — spec §8.
 *
 * This is the on-disk config (parsed from `.pi/conductor.yaml`).
 * The reducer NEVER sees a `Manifest`; the host validates this shape
 * and derives a `MachineDefinition` (spec §12) which the reducer
 * consumes as `def`.
 *
 * No validation lives here: `parseManifest` only ensures the YAML
 * parses and has the expected shape. The §13 static checks live in
 * `validateManifest` (Phase 1 Task 4). The split keeps parse cheap and
 * preserves the layering — parsing is a structural concern, validation
 * is a semantic concern.
 */

import type { Role } from "../core/types.js";

/** §8 / §10: raw manifest shape parsed from `.pi/conductor.yaml`. */
export interface Manifest {
  /** §10: human-bumped integer, pinned at run-start, never mutated. */
  readonly version: number;
  readonly roles: readonly RoleConfig[];
}

/**
 * §8: a single role declaration in the manifest.
 *
 * `is_orchestrator: true` marks the hub (§6); exactly one role in the
 * manifest may carry it (enforced by `validateManifest`).
 *
 * Optional fields:
 * - `max_visits`: per-worker visit cap (finite, §7.4). Workers missing
 *   this are uncapped — §13 rejects uncapped workers as a hard error.
 * - `models`: ordered `[primary, ...fallbacks]`, each `provider:id`
 *   (§8.1). Bare aliases are rejected by §13.
 * - `max_session_cost_usd`: per-invocation cap, shared across model
 *   fallbacks within that invocation (§8.1, §11.7).
 * - `max_run_cost_usd`: run-level cap, lives ONLY on the orchestrator's
 *   entry (§8). `validateManifest` rejects it on workers.
 * - `system_prompt`: path to a per-role system prompt file (host loads).
 * - `tools`: declared tool allowlist. `handoff` and `end` are force-
 *   injected by the host regardless (§8.1); §13 emits a warning when
 *   the manifest omits them.
 */
export interface RoleConfig {
  readonly name: Role;
  readonly is_orchestrator?: boolean;
  readonly max_visits?: number;
  readonly models?: readonly string[];
  readonly max_session_cost_usd?: number;
  readonly max_run_cost_usd?: number;
  readonly system_prompt?: string;
  readonly tools?: readonly string[];
}

/**
 * Typed error for malformed YAML or missing/ill-shaped fields.
 *
 * Wraps the underlying parser error via `Error.cause` (ES2022+) so the
 * caller can log/inspect the original cause without losing context.
 * `no silent fallbacks` (AGENTS.md code conventions): always throw
 * rather than guess at an ambiguous input.
 */
export class ManifestParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ManifestParseError";
  }
}
