/**
 * Manifest loader — spec §8, §10, §13.
 *
 * Reads a `.pi/conductor.yaml` from disk, parses it (`parseManifest`,
 * Phase 1 Task 3), runs the §13 static checks (`validateManifest`,
 * Phase 1 Task 4), and derives the pinned `MachineDefinition` snapshot
 * (`toMachineDefinition`, Phase 1 Task 4) the reducer (Phase 2) consumes
 * as `def` (§12).
 *
 * `manifest_version` is pinned to `MachineDefinition.manifest_version`
 * here, at run-start (§10); never mutated mid-run.
 *
 * **Fail fast.** Hard validation errors (e.g. an uncapped worker)
 * throw a typed `HostManifestError` carrying the original `ManifestError`
 * list — the caller surfaces the rule codes, not just a message string.
 * Soft warnings are returned alongside the definition so callers can
 * log them; they never block derivation.
 *
 * **Phase 7D additions:** `LoadedManifest` now carries two extra
 * fields so downstream code (the §8.1 system-prompt resolver in
 * `production-host-resolve.ts`) can locate the manifest's directory
 * (for v2 manifest-base-relative prompt resolution) and read the
 * `version:` integer (for the v1/v2 back-compat branch) without
 * re-deriving either. `manifestDir` is the directory containing the
 * resolved manifest file (`dirname(path)` for the disk path; `null`
 * when loaded via `loadManifestFromString` without an explicit
 * `manifestDir` argument). Both fields are additive; existing
 * callers ignore them.
 *
 * Host-owned I/O. The pure core (Phase 1) ships the parsers + validators
 * + derivation; this module adds the disk read and the typed-error
 * wrapper. No pi imports.
 */

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { MachineDefinition } from "../core/types.js";
import { toMachineDefinition } from "../manifest/definition.js";
import { parseManifest } from "../manifest/parse.js";
import type { Manifest } from "../manifest/types.js";
import {
  type ManifestError,
  type ManifestReport,
  type ManifestWarning,
  validateManifest,
} from "../manifest/validate.js";

/**
 * Typed error for hard manifest validation failures.
 *
 * `errors` is the structured list from `validateManifest` — callers
 * can render rule codes (`uncapped-worker`, `bare-model-alias`, `invalid-model-effort`, …)
 * rather than scraping the message string. `cause` preserves the
 * underlying error for `parseManifest` failures and for any nested
 * throw from `toMachineDefinition` (which itself calls
 * `validateManifest` internally).
 */
export class HostManifestError extends Error {
  readonly errors: readonly ManifestError[];
  constructor(message: string, errors: readonly ManifestError[], options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HostManifestError";
    this.errors = Object.freeze([...errors]);
  }
}

/**
 * Result of a successful manifest load.
 *
 * `warnings` are non-blocking (§13 soft warnings: cheaper-fallback
 * missing, missing-required-tool in role.tools). Callers may surface
 * them but should not block run-start on them.
 *
 * `manifest` is the parsed on-disk shape (the role configs the host
 * needs for per-role cost caps and model-fallback resolution — Task
 * 17 / Task 18). The reducer never sees it (`def` is the reducer's
 * view).
 *
 * `manifestDir` (Phase 7D) is the directory containing the resolved
 * manifest file — `dirname(path)` for the disk path; `null` when
 * loaded via `loadManifestFromString` without an explicit
 * `manifestDir` argument (the test/programmatic path). Used by
 * `loadSystemPrompt` for v2 manifest-base-relative prompt resolution
 * (§8.1).
 *
 * `manifestVersion` (Phase 7D) is the parsed `version:` integer,
 * surfaced here for convenience so `loadSystemPrompt` does not have
 * to re-read `loadedManifest.manifest.version`. Used by
 * `loadSystemPrompt` for the v1/v2 back-compat branch (§8.1).
 */
export interface LoadedManifest {
  readonly def: MachineDefinition;
  readonly manifest: import("../manifest/types.js").Manifest;
  readonly warnings: readonly ManifestWarning[];
  readonly manifestDir: string | null;
  readonly manifestVersion: number;
}

/**
 * Load `.pi/conductor.yaml` from `path`, validate it against §13, and
 * derive the pinned `MachineDefinition`.
 *
 * Phase 7D: also sets `manifestDir = dirname(path)` on the returned
 * `LoadedManifest` so the §8.1 system-prompt resolver can locate
 * manifest-base-relative prompt paths for v2 manifests.
 *
 * @throws {HostManifestError} on hard validation errors (errors carry codes).
 * @throws {ManifestParseError} on malformed YAML or shape violations
 *         (re-thrown from `parseManifest` unchanged).
 */
export async function loadManifest(path: string): Promise<LoadedManifest> {
  const raw = await readFile(path, "utf8");
  return loadManifestFromString(raw, dirname(path));
}

/**
 * Parse + validate + derive from a manifest string. Exposed for tests
 * and for callers (a future TUI viewer, a test harness) that already
 * have the YAML in hand.
 *
 * Phase 7D: accepts an optional `manifestDir` (the directory
 * containing the manifest file, when known). When omitted, defaults
 * to `null` — the test/programmatic path. v1 manifests ignore
 * `manifestDir` (cwd-relative prompt resolution); v2 manifests
 * loaded without `manifestDir` will fail to resolve relative
 * `system_prompt` paths (a deliberate, test-only error path).
 *
 * @throws {HostManifestError} on hard validation errors.
 * @throws {ManifestParseError} on malformed YAML or shape violations.
 */
export function loadManifestFromString(
  rawYaml: string,
  manifestDir: string | null = null,
): LoadedManifest {
  // Phase 1 Task 3 — throws ManifestParseError on shape violations.
  // Pass through unchanged: parse errors are a different failure mode
  // (malformed input) than validation errors (semantically broken).
  const manifest: Manifest = parseManifest(rawYaml);

  // Phase 1 Task 4 — produces a ManifestReport with errors (hard) +
  // warnings (soft). We call it ourselves (rather than relying on
  // `toMachineDefinition`'s internal re-validation) so we can both
  // surface warnings to the caller AND throw a typed error with
  // structured codes on hard failures.
  const report: ManifestReport = validateManifest(manifest);

  if (report.errors.length > 0) {
    // Throw typed so callers can switch on `e.errors[i].code` instead
    // of parsing the message. The message is for humans; the codes
    // are for machines.
    const codes = report.errors.map((e) => e.code).join(", ");
    throw new HostManifestError(
      `cannot load manifest: ${report.errors.length} hard error(s) [${codes}]; see \`errors\` for the structured list`,
      report.errors,
    );
  }

  // Derive the pinned snapshot. By construction this cannot throw
  // (we just verified errors.length === 0; toMachineDefinition's
  // internal re-validation will agree).
  const def: MachineDefinition = toMachineDefinition(manifest);

  return Object.freeze({
    def,
    manifest,
    warnings: Object.freeze([...report.warnings]),
    manifestDir,
    manifestVersion: manifest.version,
  }) as LoadedManifest;
}
