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
 * Host-owned I/O. The pure core (Phase 1) ships the parsers + validators
 * + derivation; this module adds the disk read and the typed-error
 * wrapper. No pi imports.
 */

import { readFile } from "node:fs/promises";

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
 * can render rule codes (`uncapped-worker`, `bare-model-alias`, …)
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
 */
export interface LoadedManifest {
  readonly def: MachineDefinition;
  readonly warnings: readonly ManifestWarning[];
}

/**
 * Load `.pi/conductor.yaml` from `path`, validate it against §13, and
 * derive the pinned `MachineDefinition`.
 *
 * @throws {HostManifestError} on hard validation errors (errors carry codes).
 * @throws {ManifestParseError} on malformed YAML or shape violations
 *         (re-thrown from `parseManifest` unchanged).
 */
export async function loadManifest(path: string): Promise<LoadedManifest> {
  const raw = await readFile(path, "utf8");
  return loadManifestFromString(raw);
}

/**
 * Parse + validate + derive from a manifest string. Exposed for tests
 * and for callers (a future TUI viewer, a test harness) that already
 * have the YAML in hand.
 *
 * @throws {HostManifestError} on hard validation errors.
 * @throws {ManifestParseError} on malformed YAML or shape violations.
 */
export function loadManifestFromString(rawYaml: string): LoadedManifest {
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
    warnings: Object.freeze([...report.warnings]),
  }) as LoadedManifest;
}
