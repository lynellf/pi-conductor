/** Manifest-level review gate parsing and static validation (issue #124). */

import type { Role } from "../core/types.js";
import type { Manifest, ReviewGateConfig } from "./types.js";
import { ManifestParseError } from "./types.js";
import type { ManifestError } from "./validate.js";

const REVIEW_GATE_KEYS = new Set([
  "id",
  "phase_id",
  "reviewer_role",
  "phase_owner_role",
  "next_phase",
  "repair_guidance",
]);

/** Parse the optional manifest review-gate array without applying semantic policy. */
export function parseReviewGates(raw: unknown): readonly ReviewGateConfig[] {
  if (!Array.isArray(raw)) throw new ManifestParseError("`review_gates:` must be an array");
  return Object.freeze(raw.map((entry, index) => parseReviewGate(entry, index)));
}

function parseReviewGate(raw: unknown, index: number): ReviewGateConfig {
  const path = `review_gates[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!REVIEW_GATE_KEYS.has(key))
      throw new ManifestParseError(`${path} has unknown key '${key}'`);
  }
  const repairGuidance =
    entry.repair_guidance === undefined
      ? undefined
      : toBoundedString(entry.repair_guidance, `${path}.repair_guidance`, 4096);
  return Object.freeze({
    id: toNonEmptyString(entry.id, `${path}.id`),
    phase_id: toNonEmptyString(entry.phase_id, `${path}.phase_id`),
    reviewer_role: toNonEmptyString(entry.reviewer_role, `${path}.reviewer_role`) as Role,
    phase_owner_role: toNonEmptyString(entry.phase_owner_role, `${path}.phase_owner_role`) as Role,
    next_phase: toNonEmptyString(entry.next_phase, `${path}.next_phase`),
    ...(repairGuidance === undefined ? {} : { repair_guidance: repairGuidance }),
  });
}

/** Return a gate by its stable id, or null when the manifest has no such gate. */
export function findReviewGate(manifest: Manifest, gateId: string): ReviewGateConfig | null {
  return manifest.review_gates?.find((gate) => gate.id === gateId) ?? null;
}

/** Validate cross-field review-gate invariants against the declared roles. */
export function validateReviewGates(manifest: Manifest, errors: ManifestError[]): void {
  const gates = manifest.review_gates;
  if (gates === undefined) return;
  const roleNames = new Set(manifest.roles.map((role) => role.name));
  const orchestrator = manifest.roles.find((role) => role.is_orchestrator === true)?.name;
  const ids = new Set<string>();
  const phases = new Set<string>();

  for (const gate of gates) {
    if (ids.has(gate.id)) {
      errors.push({
        code: "review-gate-duplicate-id",
        message: `review gate '${gate.id}' is declared more than once`,
      });
    }
    ids.add(gate.id);
    if (phases.has(gate.phase_id)) {
      errors.push({
        code: "review-gate-duplicate-phase",
        message: `review phase '${gate.phase_id}' has more than one gate`,
      });
    }
    phases.add(gate.phase_id);
    if (!roleNames.has(gate.reviewer_role)) {
      errors.push({
        code: "review-gate-reviewer-undeclared",
        message: `review gate '${gate.id}' names undeclared reviewer '${gate.reviewer_role}'`,
        role: gate.reviewer_role,
      });
    }
    if (!roleNames.has(gate.phase_owner_role)) {
      errors.push({
        code: "review-gate-owner-undeclared",
        message: `review gate '${gate.id}' names undeclared phase owner '${gate.phase_owner_role}'`,
        role: gate.phase_owner_role,
      });
    }
    if (gate.reviewer_role === gate.phase_owner_role) {
      errors.push({
        code: "review-gate-self-owner",
        message: `review gate '${gate.id}' reviewer and phase owner must differ`,
        role: gate.reviewer_role,
      });
    }
    if (gate.reviewer_role === orchestrator) {
      errors.push({
        code: "review-gate-reviewer-orchestrator",
        message: `review gate '${gate.id}' reviewer cannot be the orchestrator`,
        role: gate.reviewer_role,
      });
    }
    if (gate.phase_id === gate.next_phase) {
      errors.push({
        code: "review-gate-self-next-phase",
        message: `review gate '${gate.id}' next_phase must differ from phase_id`,
      });
    }
  }
}

function toBoundedString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new ManifestParseError(`${path} must be non-empty and at most ${maxLength} characters`);
  }
  return value.trim();
}

function toNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ManifestParseError(`${path} must be a non-empty string`);
  }
  return value.trim();
}
