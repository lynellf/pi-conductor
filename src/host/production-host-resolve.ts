/**
 * Pure resolution pieces used by `ProductionHost.spawnRole`
 * (Tasks 7A.2, 7A.3, spec §8.1).
 *
 * Split from `production-host.ts` to keep that file under the
 * AGENTS.md ~400-LOC ceiling (the class + spawnRole + JSDoc push
 * the file past 500 LOC on its own; the pure functions are a
 * separate, independently testable concern).
 *
 * Four module-level exports:
 *   - `selectModelEntry`     — pick `role.models[index]` (7A.2)
 *   - `resolveModel`         — `provider:id` → Model + logical (7A.2)
 *   - `loadSystemPrompt`     — UTF-8 from disk, null or throw (7A.2)
 *   - `buildToolsAllowlist`  — role tools + force-injected (7A.3)
 *
 * Each boundary-error path is independently unit-testable here
 * without touching the SDK's session factory.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { Role } from "../core/types.js";
import type { ModelConfig, RoleConfig } from "../manifest/types.js";
import {
  MalformedModelEntryError,
  ModelNotFoundError,
  NoMoreModelsError,
  SystemPromptNotFoundError,
} from "./errors.js";

// ─── `selectModelEntry` (§8.1) ────────────────────────────────────────

/** Pick the `provider:id` entry to resolve for a role. Returns
 *  `null` for the system-model path (role has no `models` field).
 *  Throws `NoMoreModelsError` on out-of-range index — same signal
 *  `StubHost` uses for fallback exhaustion. */
export function selectModelEntry(
  role: Role,
  roleConfig: Pick<RoleConfig, "models"> | undefined,
  modelIndex: number,
): ModelConfig | null {
  if (roleConfig === undefined) return null;
  const models = roleConfig.models;
  if (models === undefined || models.length === 0) return null;
  const entry = models[modelIndex];
  if (entry === undefined) {
    throw new NoMoreModelsError(role, modelIndex, models.length);
  }
  return entry;
}

// ─── `resolveModel` (§8.1) ───────────────────────────────────────────

/** Look up the `Model` for a `provider:id` entry. Throws
 *  `MalformedModelEntryError` on bad form, `ModelNotFoundError` on
 *  registry miss. The `logical` field is the original `provider:id`
 *  for the §11.4 lifecycle record. */
export function resolveModel(
  role: Role,
  entry: string,
  modelRegistry: ModelRegistry,
): { model: Model<never>; logical: string } {
  const split = splitProviderId(role, entry);
  const model = modelRegistry.find(split.provider, split.id);
  if (model === undefined) {
    throw new ModelNotFoundError(role, entry);
  }
  // The SDK types `find` as `Model<Api> | undefined`; we expose
  // `Model<never>` (any-Api escape, same pattern as
  // `SpawnRoleOptions.model` in `host.ts`).
  return { model: model as Model<never>, logical: entry };
}

/** Internal: split a `provider:id` entry. Strict form: exactly one
 *  `:`, both sides non-empty. Not exported — the validation is the
 *  resolution contract; exposing the raw split would invite callers
 *  to skip the check. */
function splitProviderId(role: Role, entry: string): { provider: string; id: string } {
  const first = entry.indexOf(":");
  if (first === -1) {
    throw new MalformedModelEntryError(role, entry);
  }
  // Reject more than one colon — `provider:id` has exactly one
  // separator.
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

// ─── `loadSystemPrompt` (§8.1, §8.1 version-gated, Phase 7D) ────────

/** Load a role's system prompt from disk. Returns UTF-8 content,
 *  or `null` when no `system_prompt` is declared. Throws
 *  `SystemPromptNotFoundError` on a declared-but-missing path.
 *
 *  **Resolution root (Phase 7D, version-gated).** Relative paths
 *  resolve against different roots depending on the manifest
 *  version (per the spec delta's Q2 decision):
 *
 *    - `manifestVersion == 1` → resolve against `cwd` (back-compat;
 *      existing v1 manifests keep working unchanged).
 *    - `manifestVersion >= 2` → resolve against `manifestDir` (the
 *      directory containing the resolved manifest file). This makes
 *      a manifest self-contained: the manifest and its `roles/*.md`
 *      prompts move together, whether the manifest lives under
 *      `<cwd>/.pi/` or `<home>/.pi/`.
 *
 *  Absolute paths are used as-is regardless of version.
 *  `path === undefined` returns `null` regardless of version.
 *  `manifestVersion` defaults to `1` and `manifestDir` defaults to
 *  `null` so the v1 back-compat path requires no call-site change.
 *
 *  v2 with `manifestDir === null` throws `SystemPromptNotFoundError`
 *  with a "no resolution base" message — this is the test /
 *  programmatic path where the manifest was loaded from a string
 *  without a known file path. Production always has a manifestDir.
 *
 *  The return type is `string` (not `() => string`) because
 *  `systemPromptOverride` is a closure evaluated by the loader;
 *  the `spawnRole` path wraps it. */
export async function loadSystemPrompt(
  role: Role,
  path: string | undefined,
  cwd: string,
  manifestDir: string | null = null,
  manifestVersion: number = 1,
): Promise<string | null> {
  if (path === undefined) return null;

  // v2 + no manifest base: cannot resolve relative paths. The
  // test path is the only path that hits this — production
  // always has `manifestDir` (it's the directory of the loaded
  // manifest file). The error message names the role + path so
  // the test can assert on it.
  if (manifestVersion >= 2 && manifestDir === null) {
    throw new SystemPromptNotFoundError(role, path, null);
  }

  // Pick the resolution root: v2 = manifestDir, v1 = cwd.
  // Absolute paths bypass the root choice (used as-is).
  const resolutionRoot = manifestVersion >= 2 ? (manifestDir as string) : cwd;
  const fullPath = isAbsolute(path) ? path : resolve(resolutionRoot, path);
  try {
    return await readFile(fullPath, "utf8");
  } catch {
    // Any read failure (ENOENT, EACCES, EISDIR, symlink loop) is
    // "the prompt isn't loadable as a UTF-8 file." The underlying
    // `NodeJS.ErrnoException` is intentionally not preserved. The
    // error carries the resolution root we tried so the user can
    // diagnose "wrong manifest dir" / "wrong cwd" from the message.
    throw new SystemPromptNotFoundError(role, path, resolutionRoot);
  }
}

// ─── `buildToolsAllowlist` (§8.1) ────────────────────────────────────

/** Build the SDK `tools` allowlist for a role session. Force-injects
 *  `handoff`, `end`, and `ask_user` (forgetting them here silently
 *  disables them even when they're in `customTools`; sdk-surface.md §1).
 *  Dedups so they appear exactly once even if the role already names them.
 *  Order: declared tools first, then `handoff`, `end`, and `ask_user`. */
export function buildToolsAllowlist(roleTools: readonly string[] | undefined): readonly string[] {
  const declared = roleTools ?? [];
  return Array.from(new Set([...declared, "handoff", "end", "ask_user"]));
}
