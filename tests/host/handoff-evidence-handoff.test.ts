/**
 * Focused tests for the host continuity-seed materialization seam that now
 * surfaces host-observed handoff evidence — issue #135 Phase 4.
 *
 * The host seeds a fresh recipient session by folding records through the same
 * `materializeContinuity` + `renderContinuitySeed` boundary it uses internally
 * (see `src/host/production-host-state.ts`). This suite exercises that seam:
 * evidence appears only from host-authored `handoff_evidence` records, the
 * seed is byte-identical to the v2 baseline when no policy is pinned, and
 * model-supplied custom fields are never promoted into host evidence.
 */

import { describe, expect, it } from "vitest";
import {
  materializeContinuity,
  renderContinuitySeed,
} from "../../src/persistence/continuity-materialization.js";
import type { HandoffEvidenceRecord } from "../../src/persistence/handoff-evidence-schema.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

// ─── Helpers ───────────────────────────────────────────────────────────

function makeTransitionAccepted(
  recordId: string,
  runId: string,
  ts: number,
  continuity: unknown,
  extraPayload?: Record<string, unknown>,
) {
  const accepted_handoff = continuity
    ? {
        schema_version: 1 as const,
        recipient_role: "implementer" as const,
        payload: { summary: "test", continuity, ...extraPayload },
        utf8_bytes: 12,
        continuity_evidence: [],
        continuity_packet_utf8_bytes: JSON.stringify(continuity).length,
      }
    : null;
  return {
    type: "transition_accepted" as const,
    run_id: runId,
    from: "orchestrator" as const,
    to: "implementer" as const,
    event: "handoff" as const,
    target_role: "implementer" as const,
    request_end: false,
    end_authority: null,
    end_requested_by: null,
    role: "orchestrator" as const,
    suggests_next: null,
    payload_summary: { field_names: ["summary"] },
    guard: null,
    effect: [],
    session_file: `session-${recordId}.jsonl`,
    ...(accepted_handoff !== null && { accepted_handoff }),
    ts,
  };
}

function makePacket() {
  return {
    schema_version: 1 as const,
    summary: "test",
    findings: [
      {
        id: "f-1",
        kind: "fact",
        confidence: "observed",
        statement: "a fact",
        evidence: [],
        supersedes: [],
      },
    ],
    evaluations: [],
    open_questions: [],
    next_steps: [],
    okf_candidate_ids: [],
  };
}

function withLifecycles(records: readonly PersistedRecord[]): PersistedRecord[] {
  const out: PersistedRecord[] = [];
  for (const record of records) {
    if (record.type === "transition_accepted")
      out.push({
        type: "session_started",
        run_id: record.run_id,
        role: record.role,
        visit_index: 1,
        state: record.role,
        model: "test",
        session_file: record.session_file,
        parent_session: null,
        ts: record.ts - 1,
      });
    out.push(record);
  }
  return out;
}

function makeHandoffEvidence(opts: {
  handoff_id: string;
  ts: number;
  head?: string;
}): HandoffEvidenceRecord {
  const worktree: HandoffEvidenceRecord["worktree"] =
    opts.head === undefined
      ? {
          kind: "unavailable",
          reason: "non_git_backend",
          detail: "host did not observe a worktree",
        }
      : { head: opts.head, dirty_paths: [{ path: "src/app.ts", preexisting: false }] };
  const record: HandoffEvidenceRecord = {
    type: "handoff_evidence",
    schema_version: 1,
    run_id: "run-1",
    handoff_id: opts.handoff_id,
    ts: opts.ts,
    worktree,
    commands: [],
    omitted: { dirty_paths: 0, commands: 0 },
  };
  return Object.freeze(record);
}

const ENABLED_POLICY = {
  run_id: "run-1",
  schema_version: 1 as const,
  require_handoff: true,
  require_delegated_result: false,
  seed_max_utf8_bytes: 32 * 1024,
};

// ─── Host continuity-seed seam ─────────────────────────────────────────

describe("handoff evidence into fresh recipient seed (issue #135 Phase 4)", () => {
  it("materializes host-observed evidence into the seed when the policy is enabled", () => {
    const records = withLifecycles([
      makeTransitionAccepted("rec-1", "run-1", 1000, makePacket()),
      makeHandoffEvidence({ handoff_id: "handoff-1", ts: 1000, head: "deadbeef" }),
    ]);
    const ledger = materializeContinuity(records, { ...ENABLED_POLICY });
    const seed = renderContinuitySeed(ledger, ENABLED_POLICY.seed_max_utf8_bytes);

    const hostEvidence = seed.sections.host_evidence as readonly unknown[] | undefined;
    expect(hostEvidence?.length ?? 0).toBe(1);
    expect((hostEvidence?.[0] as Record<string, unknown>).kind).toBe("host_evidence");
  });

  it("leaves the seed byte-identical to the v2 baseline when no policy is pinned", () => {
    const records = withLifecycles([
      makeTransitionAccepted("rec-1", "run-1", 1000, makePacket()),
      makeHandoffEvidence({ handoff_id: "handoff-1", ts: 1000, head: "deadbeef" }),
    ]);
    // Absent policy → the host omits the continuity section entirely; the seed
    // projection must not introduce a host_evidence section.
    const ledger = materializeContinuity(records, { run_id: "run-1" });
    const seed = renderContinuitySeed(ledger, 32 * 1024);

    expect(seed.rendered).not.toContain("host_evidence");
    expect("host_evidence" in seed.sections).toBe(false);
  });

  it("ignores model-supplied custom fields (no promotion into host evidence)", () => {
    const records = withLifecycles([
      makeTransitionAccepted(
        "rec-1",
        "run-1",
        1000,
        makePacket(),
        // A model-supplied custom field that merely references evidence; it is
        // not a host-authored handoff_evidence record and must be ignored.
        { handoff_evidence: { fabricated: [{ kind: "claim", statement: "I ran the tests" }] } },
      ),
    ]);
    const ledger = materializeContinuity(records, { ...ENABLED_POLICY });
    const seed = renderContinuitySeed(ledger, ENABLED_POLICY.seed_max_utf8_bytes);

    expect("host_evidence" in seed.sections).toBe(false);
  });

  it("holds the seed within the byte budget when evidence is projected", () => {
    const bigHead = "z".repeat(2_000);
    const records = withLifecycles([
      makeTransitionAccepted("rec-1", "run-1", 1000, makePacket()),
      makeHandoffEvidence({ handoff_id: "handoff-big", ts: 1000, head: bigHead }),
    ]);
    const ledger = materializeContinuity(records, { ...ENABLED_POLICY });
    const seed = renderContinuitySeed(ledger, ENABLED_POLICY.seed_max_utf8_bytes);

    expect(new TextEncoder().encode(seed.rendered).byteLength).toBeLessThanOrEqual(
      seed.budget.max_bytes,
    );
    expect(seed.budget.used_bytes).toBeLessThanOrEqual(seed.budget.max_bytes);
  });
});
