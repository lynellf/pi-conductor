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

import type { ModelEffort, Role } from "../core/types.js";

/** Parsed manifest model entry: logical model id plus conductor-owned effort. */
export interface ModelConfig {
  readonly model: string;
  readonly effort: ModelEffort;
  /** Additional fresh-session attempts after the initial model attempt (0–10). */
  readonly retries?: number;
  /** Delay before each same-model retry, in milliseconds (0–60,000). */
  readonly retry_delay_ms?: number;
}

/** §8 / §10: raw manifest shape parsed from `.pi/conductor.yaml`. */
export interface Manifest {
  /** §10: human-bumped integer, pinned at run-start, never mutated. */
  readonly version: number;
  readonly roles: readonly RoleConfig[];
}

/**
 * Delegation policy for a role (spec §6 / issue #17 §6).
 *
 * Enables a role to call the host-owned `delegate` tool with bounded
 * concurrent auxiliary sub-agent tasks. Policy is host-only:
 * `MachineDefinition` never includes it and the reducer never branches
 * on it (spec §12.1 invariant 1).
 *
 * Enable requires both `delegation:` in the manifest AND `delegate` in
 * the role's `tools:` list. Neither is force-injected (spec §5 decision 1).
 */
export interface DelegationPolicy {
  /** Max concurrent child sessions per delegation batch. Must be a finite positive integer. */
  readonly max_parallel: number;
  /** Max total children in the role's lifetime. Must be a finite positive integer. */
  readonly max_children: number;
  /** Fixed to `1` in v1; recursive delegation is out of scope (spec §4 non-goal). */
  readonly max_depth: 1;
  /** Workspace modes available to child tasks (spec §7.4). Non-empty, no duplicates. */
  readonly workspace_modes: readonly ("read_only" | "worktree")[];
  /** Max USD budget for a single child session (spec §9 / issue #17 §11). */
  readonly max_child_cost_usd: number;
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
 * - `models`: ordered `[primary, ...fallbacks]`, normalized to
 *   `{ model, effort }` by the parser (§8.1). Bare aliases are
 *   rejected by §13; the parser still accepts string shorthand in
 *   the raw YAML.
 * - `max_session_cost_usd`: per-invocation cap, shared across model
 *   fallbacks within that invocation (§8.1, §11.7).
 * - `max_run_cost_usd`: run-level cap, lives ONLY on the orchestrator's
 *   entry (§8). `validateManifest` rejects it on workers.
 * - `system_prompt`: path to a per-role system prompt file (host loads).
 * - `tools`: declared tool allowlist. `handoff` and `end` are force-
 *   injected by the host regardless (§8.1); §13 emits a warning when
 *   the manifest omits them.
 * - `delegation`: opt-in sub-agent delegation policy (spec §6 / issue #17).
 *   Host-only; never added to `MachineDefinition`.
 */
export interface RoleConfig {
  readonly name: Role;
  readonly is_orchestrator?: boolean;
  readonly max_visits?: number;
  readonly models?: readonly ModelConfig[];
  readonly max_session_cost_usd?: number;
  readonly max_run_cost_usd?: number;
  readonly system_prompt?: string;
  readonly tools?: readonly string[];
  /** Opt-in delegation policy (spec §6 / issue #17). Host-only. */
  readonly delegation?: DelegationPolicy;
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
