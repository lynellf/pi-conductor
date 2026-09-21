/**
 * Issue #139 Phase 1: deterministic UTF-8 byte-bounded renderer for the
 * host-materialized phase work packet. Pure; no I/O.
 *
 * The renderer always retains the identity header and `phase_process`
 * section. The `host_observed` section is preserved with source-keyed
 * command/verification lines and path-redacted worktree entries; the
 * `reported_narrative` section is the lowest-priority drop target.
 * Every dropped optional field increments a typed omission counter
 * (with an actual count) so the packet never silently truncates a
 * string or drops a row without an inspectable trace.
 */

import { createHash } from "node:crypto";
import type {
  CommandObservation,
  HostObservedSection,
  PhaseProcessSection,
  PhaseWorkPacketOmission,
  PhaseWorkPacketSource,
  ReportedNarrativeSection,
  VerificationEntry,
  WorktreeObservation,
} from "./phase-work-packet-schema.js";

/** Identity header shared between rendered sections. */
export interface PhaseWorkPacketIdentityHeader {
  readonly status: "ready" | "blocked";
  readonly run_id: string;
  readonly recipient_role: string;
  readonly recipient_visit_index: number;
  readonly dispatch_source: PhaseWorkPacketSource;
  readonly cutoff_record_keys: readonly string[];
}

/** Compute the UTF-8 byte length of a string. */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Short, stable, non-reversible fingerprint for one path. */
export function redactPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

export function identityHeaderText(header: PhaseWorkPacketIdentityHeader): string {
  return [
    `status: ${header.status}`,
    `run_id: ${header.run_id}`,
    `recipient_role: ${header.recipient_role}`,
    `recipient_visit_index: ${String(header.recipient_visit_index)}`,
    `dispatch_source.kind: ${header.dispatch_source.kind}`,
    `dispatch_source.ts: ${String(header.dispatch_source.ts)}`,
    `cutoff_record_keys: [${header.cutoff_record_keys.join(", ")}] (${String(header.cutoff_record_keys.length)})`,
  ].join("\n");
}

export interface RenderPacketOptions {
  readonly header: PhaseWorkPacketIdentityHeader;
  readonly phaseProcess: PhaseProcessSection;
  readonly hostObserved: HostObservedSection;
  readonly reportedNarrative: ReportedNarrativeSection;
  readonly omissions: readonly PhaseWorkPacketOmission[];
  readonly dropReportedNarrative: boolean;
}

const COMMAND_OUTCOME_LABELS: Record<CommandObservation["outcome"], string> = {
  passed: "passed",
  failed: "failed",
  not_run: "not_run",
};

const VERIFICATION_OUTCOME_LABELS: Record<VerificationEntry["outcome"], string> = {
  passed: "passed",
  failed: "failed",
  not_run: "not_run",
};

function worktreeLines(worktree: WorktreeObservation): string[] {
  const lines: string[] = [`worktree.kind: ${worktree.kind}`];
  if (worktree.kind === "unavailable") {
    lines.push(`worktree.reason: ${worktree.reason}`);
    return lines;
  }
  if (worktree.kind === "snapshot") {
    lines.push(`worktree.head: ${worktree.head}`);
    lines.push(`worktree.dirty_paths: ${String(worktree.dirty_paths.length)}`);
    for (const entry of worktree.dirty_paths) {
      lines.push(`- ${redactPath(entry.path)} | preexisting=${String(entry.preexisting)}`);
    }
    return lines;
  }
  return lines;
}

function commandLines(commands: readonly CommandObservation[]): string[] {
  const lines: string[] = [`commands: ${String(commands.length)}`];
  for (const command of commands) {
    lines.push(
      `- [${command.source_key}] ${COMMAND_OUTCOME_LABELS[command.outcome]} | ${command.command}`,
    );
  }
  return lines;
}

function verificationLines(verification: readonly VerificationEntry[]): string[] {
  const lines: string[] = [`verification: ${String(verification.length)}`];
  for (const entry of verification) {
    lines.push(
      `- [${entry.source_key}] ${VERIFICATION_OUTCOME_LABELS[entry.outcome]} | ${entry.name}`,
    );
  }
  return lines;
}

/** Render the packet sections deterministically. The order is fixed. */
export function renderPhaseWorkPacket(options: RenderPacketOptions): string {
  const lines: string[] = [];
  lines.push("## phase_work_packet");
  lines.push(identityHeaderText(options.header));

  lines.push("");
  lines.push("### phase_process");
  lines.push(`state.kind: ${options.phaseProcess.state.kind}`);
  if (options.phaseProcess.state.kind === "fsm_visit") {
    lines.push(`state.role: ${options.phaseProcess.state.role}`);
    lines.push(`state.visit_index: ${String(options.phaseProcess.state.visit_index)}`);
  } else {
    lines.push(`state.phase_id: ${options.phaseProcess.state.phase_id}`);
    lines.push(`state.gate_id: ${options.phaseProcess.state.gate_id}`);
    lines.push(`state.decision: ${options.phaseProcess.state.decision ?? "null"}`);
  }
  if (options.phaseProcess.gate_state === null) {
    lines.push("gate_state: null");
  } else {
    lines.push(`gate_state.kind: ${options.phaseProcess.gate_state.kind}`);
    if (options.phaseProcess.gate_state.kind === "incomplete") {
      lines.push(`gate_state.reason: ${options.phaseProcess.gate_state.reason}`);
    }
  }
  lines.push(`legal_action.kind: ${options.phaseProcess.legal_action.kind}`);
  if (options.phaseProcess.host_directive !== null) {
    lines.push(`host_directive: ${options.phaseProcess.host_directive}`);
  }

  lines.push("");
  lines.push("### host_observed");
  lines.push(...worktreeLines(options.hostObserved.worktree));
  lines.push(...commandLines(options.hostObserved.commands));
  lines.push(...verificationLines(options.hostObserved.verification));

  if (!options.dropReportedNarrative) {
    lines.push("");
    lines.push("### reported_narrative");
    if (options.reportedNarrative.objective !== null) {
      lines.push(`objective: ${options.reportedNarrative.objective}`);
    }
    if (options.reportedNarrative.action !== null) {
      lines.push(`action: ${options.reportedNarrative.action}`);
    }
    if (options.reportedNarrative.summary !== null) {
      lines.push(`summary: ${options.reportedNarrative.summary}`);
    }
    if (options.reportedNarrative.reason !== null) {
      lines.push(`reason: ${options.reportedNarrative.reason}`);
    }
    if (options.reportedNarrative.verification.length > 0) {
      lines.push(
        `verification: ${String(options.reportedNarrative.verification.length)} line(s) (reported/untrusted)`,
      );
    }
  }

  if (options.omissions.length > 0) {
    lines.push("");
    lines.push("### omissions");
    for (const omission of options.omissions) {
      const countPart = omission.count === undefined ? "" : ` (count=${String(omission.count)})`;
      const detailPart = omission.detail === undefined ? "" : ` (detail: ${omission.detail})`;
      lines.push(`- ${omission.kind}${countPart}${detailPart}`);
    }
  }

  // Issue #139 Phase 3: packet-first recipient guidance. The packet is
  // authoritative process context; broad rediscovery is allowed only after
  // the role names a precise packet omission or contradiction. The
  // AGENTS.md + named-plan read requirement is retained, not bypassed.
  lines.push("");
  lines.push("### recipient_guidance");
  lines.push(
    "Use this host packet first for phase state, gate state, relevant paths, and verification status.",
  );
  lines.push("Still read AGENTS.md and the named plan for repository instructions.");
  lines.push(
    "A broad repository scan (find/rg over the worktree) or predecessor transcript read is allowed only after you identify a precise packet omission or contradiction.",
  );

  return lines.join("\n");
}
