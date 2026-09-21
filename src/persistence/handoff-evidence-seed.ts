/**
 * Issue #135, Phase 4: pure projection of host-observed handoff-evidence
 * records into the bounded continuity seed section.
 *
 * The full (bounded) evidence record lives in the run-scoped append-only log
 * (plan, Decision 4). The seed carries only a bounded per-handoff summary: a
 * host-observed marker, a reference key to the durable record, the observed
 * HEAD id, the dirty-path delta, the bounded command captures, and the always
 * recorded omission counts.
 *
 * This module is pure (no I/O) and deterministic over its inputs and exposes
 * NO model-facing constructor path: only host-produced
 * {@link HandoffEvidenceRecord} values flow in (plan invariant — the model
 * never authors observed status). Determinism makes resume safe: projection
 * over a replayed log reproduces the live item list exactly.
 */

import type {
  CommandCapture,
  DirtyPath,
  HandoffEvidenceRecord,
  HandoffUnavailable,
  Omitted,
  WorktreeSnapshot,
} from "./handoff-evidence-schema.js";
import { isHandoffEvidenceRecord } from "./handoff-evidence-schema.js";
import type { PersistedRecord } from "./log.js";

/**
 * One bounded, host-observed handoff-evidence item projected into the
 * continuity seed. The `kind: "host_evidence"` marker keeps host-observed
 * facts visually distinct from model-reported narrative claims (continuity
 * findings carry `confidence`/`statement` instead), so a fresh recipient can
 * tell a host-observed fact from a reported claim (plan invariant).
 */
export interface HostEvidenceSeedItem {
  /** Host-observed marker, distinct from a reported narrative claim. */
  readonly kind: "host_evidence";
  /** Reference key to the durable host-observed record in the run log. */
  readonly record_id: string;
  /** Observed HEAD id, or the string `"unavailable"`. */
  readonly worktree_head: string;
  /** Bounded, normalized dirty-path delta against the run-start baseline. */
  readonly dirty_paths: readonly DirtyPath[];
  /** Bounded, redacted host-observed command captures (commands only). */
  readonly commands: readonly CommandCapture[];
  /** Truncation counts that are always recorded (never dropped silently). */
  readonly omitted: Omitted;
}

/** Narrow a captured execution fact to its {@link CommandCapture} variant. */
function isCommandCapture(command: CommandCapture | HandoffUnavailable): command is CommandCapture {
  return "command" in command;
}

/** Narrow a worktree facet to its `unavailable` marker variant. */
function worktreeIsUnavailable(
  worktree: WorktreeSnapshot | HandoffUnavailable,
): worktree is HandoffUnavailable {
  return "kind" in worktree;
}

/**
 * Pure, deterministic projection of the run's {@link HandoffEvidenceRecord}s
 * into bounded seed items. Ordered by log append order (chronological), so
 * resume over the same log reproduces the identical item list (plan:
 * "projection from replayed log equals live projection"). Only the run-scoped
 * records match `runId`; records from other runs are skipped.
 */
export function projectHandoffEvidence(
  records: readonly PersistedRecord[],
  runId: string,
): readonly HostEvidenceSeedItem[] {
  const items: HostEvidenceSeedItem[] = [];
  for (const record of records) {
    if (!isHandoffEvidenceRecord(record) || record.run_id !== runId) continue;
    items.push(projectOne(record));
  }
  return Object.freeze(items);
}

/** Project one durable handoff-evidence record into a bounded seed item. */
function projectOne(record: HandoffEvidenceRecord): HostEvidenceSeedItem {
  const commands = Object.freeze(record.commands.filter((command) => isCommandCapture(command)));
  const omitted = Object.freeze({ ...record.omitted });
  const worktree = record.worktree;
  if (worktreeIsUnavailable(worktree)) {
    return Object.freeze({
      kind: "host_evidence",
      record_id: record.handoff_id,
      worktree_head: "unavailable",
      dirty_paths: Object.freeze([]),
      commands,
      omitted,
    });
  }
  return Object.freeze({
    kind: "host_evidence",
    record_id: record.handoff_id,
    worktree_head: worktree.head,
    dirty_paths: Object.freeze([...worktree.dirty_paths]),
    commands,
    omitted,
  });
}
