/**
 * `ProductionHost` — Phase 7A scaffold + pure resolution pieces
 * (Tasks 7A.1, 7A.2).
 *
 * Production `Host` implementation that resolves
 * `role.models[modelIndex]` (`provider:id`) against a real
 * `ModelRegistry`, loads `role.system_prompt` from disk, and
 * wires a real `DefaultResourceLoader` for each role session.
 * Reuses the host-owned `run_id`-keyed append-only log and
 * `LoadedManifest` the loop already programs against.
 *
 * **Status (Phase 7A):** 7A.1 delivers the constructor + `Host`
 * interface conformance + the three boundary errors
 * (`ModelNotFoundError`, `MalformedModelEntryError`,
 * `SystemPromptNotFoundError`). 7A.2 adds the **pure resolution
 * pieces** used by `spawnRole` (this file's three module-level
 * exports). 7A.3 wires `DefaultResourceLoader` and the
 * `SessionManager` into `spawnRole`. 7A.4 matches `StubHost`'s
 * event-handling semantics (usage capture, terminal reason,
 * model fallback, visit index, abort, seal, persistence,
 * run-memory seeding).
 *
 * The class is constructible and type-conformant, but its
 * `Host` methods still throw "not yet implemented" until 7A.3
 * (for `spawnRole`) and 7A.4 (for the rest) land.
 *
 * **Host-agnosticism:** this module imports from
 * `@earendil-works/pi-coding-agent` (it's in `src/host/` — the
 * grep-guard test allows pi imports here). The pure core
 * (`src/core`, `src/manifest`, `src/seam`, `src/cost`) is
 * untouched and remains host-agnostic.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { RunMemory } from "../core/run-memory.js";
import type { Role, UsageRecord } from "../core/types.js";
import type { RoleConfig } from "../manifest/types.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import {
  MalformedModelEntryError,
  ModelNotFoundError,
  NoMoreModelsError,
  SystemPromptNotFoundError,
} from "./errors.js";
import type { Host, RoleSession, SessionTerminalReason, SpawnRoleOptions } from "./host.js";
import type { LoadedManifest } from "./manifest.js";

/**
 * Constructor options for `ProductionHost`. Mirrors the production
 * context the orchestration loop needs to pass through: the
 * `ModelRegistry` (typically the extension's
 * `ExtensionCommandContext.modelRegistry`, shared with pi's
 * configured providers), the working directory (typically
 * `ctx.cwd`), and the run-scoped state (`log`, `loadedManifest`,
 * `runId`) the loop already gives `StubHost`.
 */
export interface ProductionHostOptions {
  /** Real `ModelRegistry` from the host's environment (extension
   *  `ExtensionCommandContext.modelRegistry` or
   *  `ModelRegistry.create(authStorage, modelsPath)` in standalone). */
  readonly modelRegistry: ModelRegistry;
  /** Working directory for prompt-path resolution and session cwd. */
  readonly cwd: string;
  /** Host-owned `run_id`-keyed append-only log (Task 13.5). */
  readonly log: RecordLog;
  /** Pinned manifest snapshot (def + role configs + warnings). */
  readonly loadedManifest: LoadedManifest;
  /** The run this host is bound to. */
  readonly runId: string;
}

/**
 * Production `Host` — `Phase 7A` scaffold.
 *
 * `implements Host` enforces compile-time conformance to the
 * seam the loop programs against. Adding/removing/renaming a
 * `Host` method in `host.ts` will fail typecheck here, which
 * is the right shape for a scaffold: any drift between the
 * seam and the implementation is caught at the boundary, not
 * at runtime.
 */
export class ProductionHost implements Host {
  // ─── Stored production context ────────────────────────────────────
  /** See {@link ProductionHostOptions.modelRegistry}. */
  readonly modelRegistry: ModelRegistry;
  /** See {@link ProductionHostOptions.cwd}. */
  readonly cwd: string;
  /** See {@link ProductionHostOptions.log}. */
  readonly log: RecordLog;
  /** See {@link ProductionHostOptions.loadedManifest}. */
  readonly loadedManifest: LoadedManifest;
  /** See {@link ProductionHostOptions.runId}. */
  readonly runId: string;

  constructor(opts: ProductionHostOptions) {
    this.modelRegistry = opts.modelRegistry;
    this.cwd = opts.cwd;
    this.log = opts.log;
    this.loadedManifest = opts.loadedManifest;
    this.runId = opts.runId;
  }

  // ─── Host methods (scaffold — not yet implemented) ────────────────
  // 7A.1 deliverable is the surface only. Each method throws a
  // typed, phase-tagged error so any accidental use is loud and
  // traceable to the task that will fill it in.

  async spawnRole(_role: Role, _opts: SpawnRoleOptions = {}): Promise<RoleSession> {
    throw new Error("ProductionHost.spawnRole: not yet implemented (Phase 7A.2 / 7A.3)");
  }

  captureUsage(_session: RoleSession): UsageRecord {
    throw new Error("ProductionHost.captureUsage: not yet implemented (Phase 7A.4)");
  }

  persistRecord(_record: PersistedRecord): void {
    throw new Error("ProductionHost.persistRecord: not yet implemented (Phase 7A.4)");
  }

  seedRunMemory(_args: {
    readonly checkpoint: import("../core/types.js").Checkpoint;
    readonly def: import("../core/types.js").MachineDefinition;
    readonly goal: string;
    readonly runCostCap: number | null;
  }): RunMemory {
    throw new Error("ProductionHost.seedRunMemory: not yet implemented (Phase 7A.4)");
  }

  async abortSession(_session: RoleSession, _reason: string): Promise<void> {
    throw new Error("ProductionHost.abortSession: not yet implemented (Phase 7A.4)");
  }

  sealSession(_session: RoleSession): void {
    throw new Error("ProductionHost.sealSession: not yet implemented (Phase 7A.4)");
  }

  nextVisitIndex(_role: Role): number {
    throw new Error("ProductionHost.nextVisitIndex: not yet implemented (Phase 7A.4)");
  }

  sessionTerminalReason(_session: RoleSession): SessionTerminalReason {
    throw new Error("ProductionHost.sessionTerminalReason: not yet implemented (Phase 7A.4)");
  }

  getNextModel(_role: Role, _currentModelIndex: number): string | null {
    throw new Error("ProductionHost.getNextModel: not yet implemented (Phase 7A.4)");
  }

  runCostSoFar(): number {
    throw new Error("ProductionHost.runCostSoFar: not yet implemented (Phase 7A.4)");
  }
}

// ─── Task 7A.2: pure resolution pieces (§8.1) ────────────────────────
// Three module-level exports. The class above does not call them
// yet — 7A.3 wires `spawnRole` to use them. 7A.2 delivers them as
// independently-testable pure functions so the boundary-error
// paths (malformed entry, missing model, missing prompt) and the
// "system model" path (omitted `models` field) are pinned down
// before the orchestration arrives.

// ─── `selectModelEntry` ────────────────────────────────────────────────

/**
 * Pick the `provider:id` entry to resolve for a role (Task 7A.2,
 * spec §8.1).
 *
 * Returns `roleConfig.models[modelIndex]` when the role has a
 * `models` list. Returns `null` when the role has no `models`
 * field (or no `RoleConfig` at all) — caller uses the SDK's
 * default ("system model" path). Throws `NoMoreModelsError`
 * (Phase 4 Task 18) when `modelIndex` is past the end of the
 * list — same signal both hosts use for fallback exhaustion.
 *
 * **Why explicit (plan 7A.2 acceptance):** a "no `models` field"
 * role is a different policy from a "registry miss" or from
 * "fallback exhausted." Conflating them (e.g., by guessing an
 * alias when `models` is omitted) hides which roles are uncapped
 * vs misconfigured. This function makes the system-model path
 * visible at the type level: `string | null` rather than a
 * sentinel or a thrown error.
 *
 * @param role - The role name (for `NoMoreModelsError` diagnostics).
 * @param roleConfig - The role's `RoleConfig` from `LoadedManifest`.
 *   Pass `undefined` when the role is not declared in the manifest
 *   (a malformed/legacy path; the caller is expected to validate
 *   the role set upstream).
 * @param modelIndex - 0-based index into the `models` list.
 * @returns The entry string, or `null` for the system-model path.
 * @throws {NoMoreModelsError} when `modelIndex` is out of range.
 */
export function selectModelEntry(
  role: Role,
  roleConfig: Pick<RoleConfig, "models"> | undefined,
  modelIndex: number,
): string | null {
  if (roleConfig === undefined) return null;
  const models = roleConfig.models;
  if (models === undefined || models.length === 0) return null;
  const entry = models[modelIndex];
  if (entry === undefined) {
    throw new NoMoreModelsError(role, modelIndex, models.length);
  }
  return entry;
}

// ─── `resolveModel` ───────────────────────────────────────────────────

/**
 * Look up the `Model` for a `provider:id` entry (Task 7A.2, §8.1).
 *
 * Validates the entry is in `provider:id` form (exactly one `:`
 * with both sides non-empty), splits it, and calls
 * `modelRegistry.find(provider, id)`. On a registry miss throws
 * `ModelNotFoundError`; on a malformed entry throws
 * `MalformedModelEntryError`. The `logical` field on the return
 * is the original `provider:id` string the lifecycle record
 * carries (§11.4) — not the registry's normalized form.
 *
 * @param role - The role name (for error diagnostics).
 * @param entry - The `provider:id` string from `role.models[modelIndex]`.
 * @param modelRegistry - The host's `ModelRegistry` (typically the
 *   extension's `ExtensionCommandContext.modelRegistry`).
 * @returns `{ model, logical }` — the resolved `Model` and the
 *   original `provider:id` for the lifecycle record.
 * @throws {MalformedModelEntryError} when `entry` is not `provider:id`.
 * @throws {ModelNotFoundError} when the registry has no model for
 *   the resolved `(provider, id)`.
 */
export function resolveModel(
  role: Role,
  entry: string,
  modelRegistry: ModelRegistry,
): { model: Model<never>; logical: string } {
  const split = splitProviderId(role, entry);
  // The SDK types `ModelRegistry.find` as `Model<Api> | undefined`,
  // but we expose `Model<never>` on the return for the same
  // escape-hatch reason the existing `SpawnRoleOptions.model` does
  // (any-Api model is what flows through `createAgentSession`).
  const model = modelRegistry.find(split.provider, split.id);
  if (model === undefined) {
    throw new ModelNotFoundError(role, entry);
  }
  return { model: model as Model<never>, logical: entry };
}

/**
 * Split a `provider:id` entry. Internal helper for `resolveModel`;
 * not exported — the entry validation is the resolution contract,
 * and exposing the raw split would invite callers to skip the
 * check. The form is strict: exactly one `:`, both sides non-empty.
 */
function splitProviderId(role: Role, entry: string): { provider: string; id: string } {
  const first = entry.indexOf(":");
  if (first === -1) {
    throw new MalformedModelEntryError(role, entry);
  }
  // Reject more than one colon — `provider:id` has exactly one
  // separator. `anthropic:claude:x` is malformed (would have to
  // pick which colon to split on).
  if (entry.indexOf(":", first + 1) !== -1) {
    throw new MalformedModelEntryError(role, entry);
  }
  const provider = entry.slice(0, first);
  const id = entry.slice(first + 1);
  if (provider === "" || id === "") {
    throw new MalformedModelEntryError(role, entry);
  }
  return { provider, id };
}

// ─── `loadSystemPrompt` ───────────────────────────────────────────────

/**
 * Load a role's system prompt from disk (Task 7A.2, §8.1).
 *
 * - `path === undefined` (no `system_prompt` declared) → returns
 *   `null` (caller does not pass `systemPromptOverride`; the SDK
 *   uses its default).
 * - `path` declared and file exists → returns UTF-8 contents.
 * - `path` declared but file missing on disk → throws
 *   `SystemPromptNotFoundError`.
 *
 * Relative paths are resolved against `cwd`; absolute paths are
 * used as-is (standard Node `path.resolve` semantics). Symlinks
 * are followed (default `fs.readFile` behavior).
 *
 * The function reads the file once and returns the full contents
 * as a UTF-8 string — `createAgentSession`'s
 * `DefaultResourceLoader({ systemPromptOverride })` expects a
 * `() => string` closure, so a string return is the right shape.
 *
 * @param role - The role name (for `SystemPromptNotFoundError` diagnostics).
 * @param path - The declared `system_prompt` path from the
 *   manifest. `undefined` means "no prompt declared."
 * @param cwd - The host's working directory (relative-path base).
 * @returns UTF-8 prompt contents, or `null` when no path was declared.
 * @throws {SystemPromptNotFoundError} when the declared path is
 *   missing or unreadable on disk.
 */
export async function loadSystemPrompt(
  role: Role,
  path: string | undefined,
  cwd: string,
): Promise<string | null> {
  if (path === undefined) return null;
  const fullPath = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    return await readFile(fullPath, "utf8");
  } catch {
    // Anything other than a clean read — ENOENT, EACCES, EISDIR,
    // a symlink loop — is "the prompt isn't loadable as a UTF-8
    // file." The error message names the role + path; the
    // underlying `NodeJS.ErrnoException` is intentionally not
    // preserved (callers should re-derive the cause from the
    // filesystem rather than parsing stack text).
    throw new SystemPromptNotFoundError(role, path);
  }
}
