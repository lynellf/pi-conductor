/**
 * Phase 1 (issue #135) tests for the opt-in `handoff_evidence` manifest
 * policy: parse + bounds (parse) and the §13 static-check boundary
 * (validate), plus the MachineDefinition disabled-state pin and the
 * "no behavior change when absent" contract.
 *
 * Issue #135 host-handoff-evidence plan, Phase 1.
 */

import { describe, expect, it } from "vitest";

import { toMachineDefinition } from "../../src/manifest/definition.js";
import {
  HANDOFF_EVIDENCE_MAX_COMMAND_IDENTITY_CHARS,
  HANDOFF_EVIDENCE_MAX_COMMANDS,
  HANDOFF_EVIDENCE_MAX_DIRTY_PATHS,
  HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES,
  parseHandoffEvidencePolicy,
  validateHandoffEvidencePolicy,
} from "../../src/manifest/handoff-evidence.js";
import { parseManifest } from "../../src/manifest/parse.js";
import type { Manifest } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

const BASE_YAML = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [anthropic:claude-sonnet-4-5]
    max_run_cost_usd: 25.0
    system_prompt: .pi/roles/orchestrator.md
    tools: [read, bash, handoff, end]
  - name: implementer
    max_visits: 3
    max_session_cost_usd: 5.0
    models: [anthropic:claude-opus-4-5]
    system_prompt: .pi/roles/implementer.md
    tools: [read, edit, write, bash, handoff, end]
`;

const HANDOFF_EVIDENCE_YAML = `
handoff_evidence:
  max_dirty_paths: 32
  max_commands: 8
  max_command_identity_chars: 256
  max_output_head_bytes: 512
`;

// ─── parseHandoffEvidencePolicy ─────────────────────────────────────────

describe("parseHandoffEvidencePolicy", () => {
  it("parses a full valid block with all four bounds", () => {
    const policy = parseHandoffEvidencePolicy({
      max_dirty_paths: 64,
      max_commands: 16,
      max_command_identity_chars: 512,
      max_output_head_bytes: 1024,
    });
    expect(policy).toEqual({
      max_dirty_paths: 64,
      max_commands: 16,
      max_command_identity_chars: 512,
      max_output_head_bytes: 1024,
    });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("pins bounds to the phase-1 constants", () => {
    expect(HANDOFF_EVIDENCE_MAX_DIRTY_PATHS).toBe(64);
    expect(HANDOFF_EVIDENCE_MAX_COMMANDS).toBe(16);
    expect(HANDOFF_EVIDENCE_MAX_COMMAND_IDENTITY_CHARS).toBe(512);
    expect(HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES).toBe(1024);
  });

  it("rejects an unknown key", () => {
    expect(() =>
      parseHandoffEvidencePolicy({
        max_dirty_paths: 10,
        max_commands: 10,
        max_command_identity_chars: 100,
        max_output_head_bytes: 100,
        extra_key: true,
      }),
    ).toThrow(/unknown key 'extra_key'/);
  });

  it("rejects a missing required value", () => {
    expect(() =>
      parseHandoffEvidencePolicy({
        max_commands: 10,
        max_command_identity_chars: 100,
        max_output_head_bytes: 100,
      }),
    ).toThrow(/max_dirty_paths/);
  });

  it("rejects an out-of-range (over-bound) value", () => {
    expect(() =>
      parseHandoffEvidencePolicy({
        max_dirty_paths: 65,
        max_commands: 16,
        max_command_identity_chars: 512,
        max_output_head_bytes: 1024,
      }),
    ).toThrow(/max_dirty_paths/);
  });

  it("rejects a non-integer value", () => {
    expect(() =>
      parseHandoffEvidencePolicy({
        max_dirty_paths: 1.5,
        max_commands: 16,
        max_command_identity_chars: 512,
        max_output_head_bytes: 1024,
      }),
    ).toThrow(/max_dirty_paths/);
  });
});

// ─── validateHandoffEvidencePolicy ──────────────────────────────────────

describe("validateHandoffEvidencePolicy", () => {
  it("returns no errors for a valid policy", () => {
    const errors = validateHandoffEvidencePolicy({
      max_dirty_paths: 64,
      max_commands: 16,
      max_command_identity_chars: 512,
      max_output_head_bytes: 1024,
    });
    expect(errors).toEqual([]);
  });

  it("returns an error for an unknown key", () => {
    const errors = validateHandoffEvidencePolicy({
      max_dirty_paths: 1,
      max_commands: 1,
      max_command_identity_chars: 1,
      max_output_head_bytes: 1,
      nope: 1,
    });
    expect(errors.map((e) => e.code)).toEqual(["invalid-handoff-evidence"]);
  });

  it("returns an error for a value beyond the absolute cap", () => {
    const errors = validateHandoffEvidencePolicy({
      max_dirty_paths: 100,
      max_commands: 16,
      max_command_identity_chars: 512,
      max_output_head_bytes: 1024,
    });
    expect(errors).not.toEqual([]);
    expect(errors[0]?.code).toBe("invalid-handoff-evidence");
  });
});

// ─── manifest + MachineDefinition wiring ────────────────────────────────

describe("handoff_evidence manifest integration", () => {
  it("absent block: manifest carries no policy and pins disabled (null) into MachineDefinition", () => {
    const manifest = parseManifest(BASE_YAML) as Manifest;
    expect(manifest.handoff_evidence).toBeUndefined();
    const def = toMachineDefinition(manifest);
    expect(def.handoff_evidence).toBeNull();
    const report = validateManifest(manifest);
    expect(report.errors).toEqual([]);
  });

  it("present block: manifest carries the parsed policy and MachineDefinition pins it", () => {
    const manifest = parseManifest(BASE_YAML + HANDOFF_EVIDENCE_YAML) as Manifest;
    expect(manifest.handoff_evidence).toEqual({
      max_dirty_paths: 32,
      max_commands: 8,
      max_command_identity_chars: 256,
      max_output_head_bytes: 512,
    });
    const def = toMachineDefinition(manifest);
    expect(def.handoff_evidence).toEqual(manifest.handoff_evidence);
    expect(validateManifest(manifest).errors).toEqual([]);
  });
});
