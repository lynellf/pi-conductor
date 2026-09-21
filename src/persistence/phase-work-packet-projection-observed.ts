/**
 * Issue #139 Phase 1: `host_observed` section projection for the
 * host-materialized phase work packet.
 *
 * The `host_observed` section is the deterministic summary of facts copied
 * from `handoff_evidence` (#135), `review_decision`, and `review_gate_pinned`
 * records. Commands and verification entries are keyed by their source record
 * key so the recipient can trace each entry back; worktree dirty paths are
 * redacted to short hashes before rendering so raw filesystem paths never
 * appear in the durable packet text.
 *
 * Pure; no I/O, no pi imports.
 */

import type { HandoffEvidencePolicy } from "../core/types.js";
import type { HandoffEvidenceRecord } from "./handoff-evidence-schema.js";
import { latestEvidence } from "./phase-work-packet-projection-helpers.js";
import type {
  CommandObservation,
  HostObservedSection,
  PhaseWorkPacketOmission,
  VerificationEntry,
  WorktreeObservation,
} from "./phase-work-packet-schema.js";
import type { ReviewDecisionRecord, ReviewGatePinnedRecord } from "./review.js";

/** Inputs the observed projection consumes. */
export interface ProjectObservedInput {
  readonly handoff_evidence_policy: HandoffEvidencePolicy | null | undefined;
  readonly evidence: readonly HandoffEvidenceRecord[];
  readonly decisions: readonly ReviewDecisionRecord[];
  readonly pinnedGates: readonly ReviewGatePinnedRecord[];
}

/** Build a `worktree` observation from the latest #135 record. */
export function projectWorktree(
  evidence: readonly HandoffEvidenceRecord[],
  policy: HandoffEvidencePolicy | null | undefined,
  omissions: PhaseWorkPacketOmission[],
): WorktreeObservation {
  const latest = latestEvidence(evidence);
  if (latest === null) {
    if (policy === undefined || policy === null) {
      omissions.push({ kind: "handoff_evidence_not_configured" });
      return { kind: "not_configured" };
    }
    omissions.push({ kind: "handoff_evidence_unavailable" });
    return { kind: "unavailable", reason: "handoff_evidence_unavailable" };
  }
  if ("reason" in latest.worktree) {
    omissions.push({
      kind: "handoff_evidence_unavailable",
      detail: latest.worktree.reason,
    });
    return { kind: "unavailable", reason: latest.worktree.reason };
  }
  return {
    kind: "snapshot",
    head: latest.worktree.head,
    dirty_paths: latest.worktree.dirty_paths.map((entry) => ({
      path: entry.path,
      preexisting: entry.preexisting,
    })),
  };
}

/** Build source-keyed command observations from the latest #135 record. */
export function projectCommands(evidence: readonly HandoffEvidenceRecord[]): CommandObservation[] {
  const latest = latestEvidence(evidence);
  if (latest === null) return [];
  return latest.commands.map((cmd, idx) => {
    if ("command" in cmd) {
      const outcome: CommandObservation["outcome"] =
        cmd.host_exit_status === 0 ? "passed" : "failed";
      return {
        source_key: `handoff_evidence:${idx}`,
        command: cmd.command,
        outcome,
      };
    }
    return {
      source_key: `handoff_evidence:${idx}`,
      command: `unavailable:${cmd.reason}`,
      outcome: "not_run",
    };
  });
}

/**
 * Build source-keyed verification entries from review decision / pinned
 * gate evidence. Model-reported verification strings never enter this list.
 */
export function projectVerification(
  decisions: readonly ReviewDecisionRecord[],
  pinnedGates: readonly ReviewGatePinnedRecord[],
): VerificationEntry[] {
  const verification: VerificationEntry[] = [];
  for (const decision of decisions) {
    if (decision.evidence?.checks !== undefined) {
      for (const check of decision.evidence.checks) {
        verification.push({
          source_key: `review_decision:${decision.gate_id}`,
          name: check.name,
          outcome: check.outcome,
        });
      }
    }
  }
  for (const gate of pinnedGates) {
    if (gate.evidence?.checks !== undefined) {
      for (const check of gate.evidence.checks) {
        verification.push({
          source_key: `review_gate_pinned:${gate.gate_id}`,
          name: check.name,
          outcome: check.outcome,
        });
      }
    }
  }
  return verification;
}

/** Project the full `host_observed` section. */
export function projectHostObserved(
  input: ProjectObservedInput,
  omissions: PhaseWorkPacketOmission[],
): HostObservedSection {
  return {
    label: "host_observed",
    worktree: projectWorktree(input.evidence, input.handoff_evidence_policy, omissions),
    commands: projectCommands(input.evidence),
    verification: projectVerification(input.decisions, input.pinnedGates),
  };
}
