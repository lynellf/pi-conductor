/**
 * `MachineDefinition` derivation — spec §12.
 *
 * `MachineDefinition` is the pinned, immutable snapshot of the manifest
 * config the reducer consumes. Derived once at run-start from the pinned
 * manifest version (§10/§12); never mutated mid-run.
 *
 * Contract: the caller MUST have called `validateManifest` first. If the
 * manifest has any hard validation errors, `toMachineDefinition` throws
 * ("no silent fallbacks"). `validateManifest` can be re-invoked before
 * this call to inspect errors / warnings distinctly.
 *
 * The returned `MachineDefinition` is `Object.freeze`'d at the top level,
 * with `workers` and `max_visits` also frozen. `manifest_version` is the
 * integer manifest version coerced to a string (spec §12 uses string;
 * §10 sources it as a human-bumped integer).
 */

import type { MachineDefinition, Role } from "../core/types.js";
import type { Manifest } from "./types.js";
import { validateManifest } from "./validate.js";

/**
 * Derive the pinned `MachineDefinition` snapshot from a validated manifest.
 *
 * @throws if the manifest has any hard validation errors.
 */
export function toMachineDefinition(m: Manifest): MachineDefinition {
  // Re-validate internally — caller should have validated, but if they
  // didn't (or did and ignored errors), don't silently produce a broken
  // definition. "No silent fallbacks" (AGENTS.md).
  const report = validateManifest(m);
  if (report.errors.length > 0) {
    const codes = report.errors.map((e) => e.code).join(", ");
    throw new Error(
      `cannot derive MachineDefinition: manifest has ${report.errors.length} hard error(s) [${codes}]; call validateManifest first`,
    );
  }

  const orchestrator = m.roles.find((r) => r.is_orchestrator === true);
  if (!orchestrator) {
    // validateManifest would have caught this, but TS doesn't know.
    throw new Error(
      "manifest has no orchestrator role (should have been caught by validateManifest)",
    );
  }

  // Workers = every role that is not the orchestrator.
  const workers: Role[] = m.roles.filter((r) => !r.is_orchestrator).map((r) => r.name);

  // Per-worker visit cap; validateManifest ensured each worker has a
  // finite value, so re-deriving here is safe but defensively throw if
  // a worker slipped through.
  const max_visits: Record<Role, number> = {};
  for (const role of m.roles) {
    if (role.is_orchestrator) continue;
    if (role.max_visits === undefined) {
      throw new Error(
        `worker '${role.name}' has no \`max_visits\`; should have been caught by validateManifest`,
      );
    }
    max_visits[role.name] = role.max_visits;
  }

  return Object.freeze({
    manifest_version: String(m.version),
    orchestrator: orchestrator.name,
    workers: Object.freeze(workers),
    max_visits: Object.freeze(max_visits),
    end_request_roles:
      m.end_request_roles === undefined ? null : Object.freeze([...m.end_request_roles]),
    // Issue #135: opt-in handoff-evidence policy, or null when disabled (absent
    // block) so the continuity seed stays byte-identical to the legacy v2 seed.
    handoff_evidence:
      m.handoff_evidence === undefined
        ? null
        : Object.freeze({
            max_dirty_paths: m.handoff_evidence.max_dirty_paths,
            max_commands: m.handoff_evidence.max_commands,
            max_command_identity_chars: m.handoff_evidence.max_command_identity_chars,
            max_output_head_bytes: m.handoff_evidence.max_output_head_bytes,
          }),
  }) as MachineDefinition;
}
