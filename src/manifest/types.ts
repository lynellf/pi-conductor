/**
 * Manifest types — spec §8 / issue-17-delegation-lite §3.
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
 *
 * Subagent profile types are host-only configuration (not part of the
 * FSM `MachineDefinition`).
 */

import type { ModelEffort, Role } from "../core/types.js";
import type { ChildCompletionProtocol } from "../persistence/child-completion.js";

// ─── Subagent profile types (delegation lite §3) ───────────────────────

/**
 * §3: a named subagent profile in the manifest's `subagents` block.
 *
 * A subagent profile is NOT an FSM `Role`; it cannot appear in
 * `MachineDefinition` and cannot be a reducer target.
 */
export interface SubagentProfile {
  readonly name: string;
  readonly models: readonly ModelConfig[];
  readonly max_session_cost_usd: number;
  readonly system_prompt: string;
  /** Issue #57: profile-pinned child terminal contract; default is legacy report_result. */
  readonly completion_protocol: ChildCompletionProtocol;
  /** Issue #55: opt-in exact-file projection policy for delegated children. */
  readonly workspace?: SubagentWorkspaceConfig;
}

/** Issue #55: the only workspace block permitted on a subagent profile. */
export interface SubagentWorkspaceConfig {
  readonly projection: SubagentProjectionPolicy;
}

/** Issue #55: literal policy roots used to resolve a child exact-file projection. */
export interface SubagentProjectionPolicy {
  readonly required: boolean;
  readonly allowed_paths: readonly string[];
  readonly default_paths?: readonly string[];
}

/**
 * §3: the delegation policy attached to a parent role.
 *
 * A role receives `delegate` only when it declares BOTH `tools: [delegate]`
 * AND a `delegation` block. Neither is injected implicitly.
 */
export interface DelegationPolicy {
  readonly allowed_subagents: readonly string[];
  readonly max_children_per_session: number;
  readonly max_parallel: number;
}

/** Parsed manifest model entry: logical model id plus conductor-owned effort. */
export interface ModelConfig {
  readonly model: string;
  readonly effort: ModelEffort;
  /** Additional fresh-session attempts after the initial model attempt (0–10). */
  readonly retries?: number;
  /** Delay before each same-model retry, in milliseconds (0–60,000). */
  readonly retry_delay_ms?: number;
}

/**
 * §8 / §10 / delegation lite §3: raw manifest shape parsed from `.pi/conductor.yaml`.
 */
export interface Manifest {
  /** §10: human-bumped integer, pinned at run-start, never mutated. */
  readonly version: number;
  /** Authorized worker roles that may request completion through handoff. */
  readonly end_request_roles?: readonly Role[];
  readonly roles: readonly RoleConfig[];
  /** Delegation lite §3: optional subagent profile declarations. */
  readonly subagents?: readonly SubagentProfile[];
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
 * - `delegation`: delegation policy for parent roles (delegation lite §3).
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
  /** Delegation lite §3: delegation policy for parent roles. */
  readonly delegation?: DelegationPolicy;
  /** Issue #48 §4: optional per-role workspace + artifact config (host-only). */
  readonly workspace?: WorkspaceConfig;
  /** Issue #48 §4: optional artifact-handoff configuration. */
  readonly artifacts?: ArtifactConfig;
}

// ─── Issue #48: per-role workspace + artifact config ────────────────────

/**
 * Issue #48 §4: workspace backend policy for a role.
 *
 * - `shared` (default): the integration workspace (today's behavior).
 * - `worktree`: per-visit Git worktree under run state dir.
 * - `copy`: filesystem copy of the pinned snapshot (no Git metadata).
 * - `container`: bind-mounts a worktree/copy into a Docker container.
 */
export type WorkspaceBackend = "shared" | "worktree" | "copy" | "container";

/**
 * Issue #48 §4: source resolution strategy for an isolated role.
 *
 * - `snapshot` (default): the integration workspace HEAD at run start.
 * - `ref:<git-ref>`: resolve a named Git ref (requires Git repo).
 */
export type WorkspaceSource = "snapshot" | `ref:${string}`;

/**
 * Issue #48 §4: a mount entry in an isolated role's projection.
 */
export interface WorkspaceMount {
  readonly path: string;
  readonly writable: boolean;
}

/** Issue #51: opt-in paths a worktree role may disclose incrementally. */
export interface ProgressiveDisclosurePolicy {
  /** Static sparse selection present when the role starts. */
  readonly initial_paths: readonly string[];
  /** Exact-file or subtree policy roots for later disclosure requests. */
  readonly allowed_paths: readonly string[];
}

/**
 * Issue #48 §4: per-role workspace declaration in the manifest.
 */
export interface WorkspaceConfig {
  /** Backend: shared | worktree | copy | container. */
  readonly backend?: WorkspaceBackend;
  /** Source: snapshot | ref:<git-ref>. */
  readonly source?: WorkspaceSource;
  /** Additional roots in the role's projection (default: none). */
  readonly mounts?: readonly WorkspaceMount[];
  /** Shell policy: none (default) | container. */
  readonly shell?: "none" | "container";
  /** Container image — required when backend: container. */
  readonly image?: string;
  /** Network policy: bridge (default) | none. */
  readonly network?: "bridge" | "none";
  /** Issue #51: explicit policy for incremental workspace disclosure. */
  readonly progressive_disclosure?: ProgressiveDisclosurePolicy;
}

/**
 * Issue #48 §4: artifact-handoff configuration for a role.
 */
export interface ArtifactConfig {
  /** Default: true for writable worktree workspaces; false for copy. */
  readonly auto_patch?: boolean;
  /** Default: 1 MiB (1048576 bytes) per declared file artifact. */
  readonly max_file_bytes?: number;
  /** Default per handoff: 32 declared files. */
  readonly max_files?: number;
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
