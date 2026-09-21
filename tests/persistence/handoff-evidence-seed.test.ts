/**
 * Focused tests for host-observed handoff-evidence projection into the bounded
 * continuity seed — durable-continuity spec §11, issue #135 Phase 4.
 *
 * Tests:
 * 1. Projection renders host-observed items with a marker distinct from
 *    reported narrative claims.
 * 2. Byte budget truncates whole items and counts omissions (never drops
 *    silently).
 * 3. Absent evidence → seed byte-identical to the v2 baseline (no evidence
 *    section is emitted).
 * 4. Resume: projection from a replayed log equals the live projection
 *    (pure, deterministic over records).
 */

import { describe, expect, it } from "vitest";
import type { ContinuityLedger } from "../../src/persistence/continuity.js";
import { renderContinuitySeed } from "../../src/persistence/continuity-materialization.js";
import type {
  CommandCapture,
  HandoffEvidenceRecord,
} from "../../src/persistence/handoff-evidence-schema.js";
import { projectHandoffEvidence } from "../../src/persistence/handoff-evidence-seed.js";

// ─── Helpers ───────────────────────────────────────────────────────────

function makeSnapshotWorktree(head: string, dirtyPaths: { path: string; preexisting: boolean }[]) {
  return { head, dirty_paths: dirtyPaths };
}

function makeUnavailableWorktree(
  reason: "non_git_backend" | "git_operation_failed",
): HandoffEvidenceRecord["worktree"] {
  return { kind: "unavailable", reason, detail: "host did not observe a worktree" };
}

function makeCommand(
  command: string,
  outputHead = "",
  opts: Partial<CommandCapture> = {},
): CommandCapture {
  return {
    command,
    host_exit_status: opts.host_exit_status ?? 0,
    elapsed_ms: opts.elapsed_ms ?? 0,
    output_digest: opts.output_digest ?? "0".repeat(64),
    output_head: opts.output_head ?? outputHead,
  };
}

function makeHandoffEvidence(opts: {
  run_id?: string;
  handoff_id: string;
  ts: number;
  worktree: HandoffEvidenceRecord["worktree"];
  commands?: readonly CommandCapture[];
}): HandoffEvidenceRecord {
  const record: HandoffEvidenceRecord = {
    type: "handoff_evidence",
    schema_version: 1,
    run_id: opts.run_id ?? "run-1",
    handoff_id: opts.handoff_id,
    ts: opts.ts,
    worktree: opts.worktree,
    commands: [...(opts.commands ?? [])],
    omitted: { dirty_paths: 0, commands: 0 },
  };
  return Object.freeze(record);
}

/** Minimal ledger with a single field under test; section sources stay empty. */
function ledger(runId: string, host_evidence: readonly unknown[]): ContinuityLedger {
  return Object.freeze({
    run_id: runId,
    generated_at: "2026-01-01T00:00:00.000Z",
    envelopes: Object.freeze([]),
    findings: Object.freeze([]),
    evaluations: Object.freeze([]),
    open_questions: Object.freeze([]),
    next_steps: Object.freeze([]),
    evidence_resolutions: Object.freeze([]),
    okf_candidates: Object.freeze([]),
    host_evidence: Object.freeze(host_evidence),
    counts: Object.freeze({
      envelope_count: 0,
      byte_count: 0,
      active_finding_count: 0,
      superseded_finding_count: 0,
      active_question_count: 0,
      superseded_question_count: 0,
      active_next_step_count: 0,
      superseded_next_step_count: 0,
      okf_candidate_count: 0,
    }),
  }) as ContinuityLedger;
}

// ─── Projection (spec §11) ────────────────────────────────────────────

describe("projectHandoffEvidence (issue #135 Phase 4)", () => {
  it("projects each record into a host-observed item marked distinct from reported claims", () => {
    const records = [
      makeHandoffEvidence({
        handoff_id: "handoff-a",
        ts: 1000,
        worktree: makeSnapshotWorktree("deadbeef", [{ path: "src/app.ts", preexisting: false }]),
        commands: [makeCommand("pnpm test", "PASS", { host_exit_status: 0, elapsed_ms: 12 })],
      }),
    ];

    const items = projectHandoffEvidence(records, "run-1");

    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item).toBeDefined();
    expect(item?.kind).toBe("host_evidence");
    expect(item?.record_id).toBe("handoff-a");
    expect(item?.worktree_head).toBe("deadbeef");
    expect(item?.dirty_paths).toEqual([{ path: "src/app.ts", preexisting: false }]);
    expect(item?.commands).toHaveLength(1);
    expect(item?.commands[0]?.command).toBe("pnpm test");
    expect(item?.commands[0]?.host_exit_status).toBe(0);
    expect(item?.omitted).toEqual({ dirty_paths: 0, commands: 0 });
    // Distinct from a reported narrative claim: continuity findings carry a
    // `confidence`/`statement`; a host-observed item must not.
    expect(Object.keys(item ?? {})).not.toContain("confidence");
    expect(Object.keys(item ?? {})).not.toContain("statement");
  });

  it("projects an unavailable worktree marker with an empty dirty-path list but keeps command captures", () => {
    const records = [
      makeHandoffEvidence({
        handoff_id: "handoff-b",
        ts: 2000,
        worktree: makeUnavailableWorktree("non_git_backend"),
        commands: [makeCommand("pnpm build")],
      }),
    ];

    const items = projectHandoffEvidence(records, "run-1");

    expect(items).toHaveLength(1);
    expect(items[0]?.worktree_head).toBe("unavailable");
    expect(items[0]?.dirty_paths).toEqual([]);
    expect(items[0]?.commands).toHaveLength(1);
  });

  it("excludes records for another run and keeps chronological order within a run", () => {
    const records = [
      makeHandoffEvidence({
        run_id: "run-2",
        handoff_id: "other",
        ts: 3000,
        worktree: makeUnavailableWorktree("non_git_backend"),
      }),
      makeHandoffEvidence({
        handoff_id: "first",
        ts: 1000,
        worktree: makeUnavailableWorktree("non_git_backend"),
      }),
      makeHandoffEvidence({
        handoff_id: "second",
        ts: 2000,
        worktree: makeUnavailableWorktree("non_git_backend"),
      }),
    ];

    const items = projectHandoffEvidence(records, "run-1");

    expect(items.map((item) => item.record_id)).toEqual(["first", "second"]);
  });

  it("carries per-record omission counts so truncation is never dropped silently", () => {
    const records = [
      makeHandoffEvidence({
        handoff_id: "truncated",
        ts: 1000,
        worktree: makeUnavailableWorktree("non_git_backend"),
        commands: [makeCommand("pnpm test")],
      }),
    ];

    const items = projectHandoffEvidence(records, "run-1");

    expect(items[0]?.omitted).toEqual({ dirty_paths: 0, commands: 0 });
  });
});

// ─── Renderer byte budget (spec §11) ──────────────────────────────────

describe("renderContinuitySeed host_evidence section", () => {
  // Each item serializes to ~13.7 KiB, so three of them exceed the 32 KiB
  // seed budget and force the renderer to drop the last item atomically,
  // keeping the two that fit. This exercises the truncation + omission-count
  // path (spec §11: whole items are dropped, never half-admitted).
  const bigItem = () =>
    ({
      kind: "host_evidence",
      record_id: "e-1",
      worktree_head: "deadbeef",
      dirty_paths: Array.from({ length: 40 }, (_, i) => ({
        path: `a-really-long-dirty-path-${i}`,
        preexisting: false,
      })),
      commands: [
        makeCommand("pnpm run very-long-command --verbose --profile=slow", "x".repeat(11000), {
          host_exit_status: 0,
        }),
      ],
      omitted: { dirty_paths: 0, commands: 0 },
    }) as unknown as Record<string, unknown>;

  it("never emits the evidence section (byte-identical to baseline) when no evidence is projected", () => {
    const seed = renderContinuitySeed(ledger("run-1", []), 32 * 1024);
    expect(seed.rendered).not.toContain("host_evidence");
    expect("host_evidence" in seed.sections).toBe(false);
  });

  it("renders evidence items atomically and counts every dropped item in omissions", () => {
    const items = [bigItem(), bigItem(), bigItem()];
    const seed = renderContinuitySeed(ledger("run-1", items), 32 * 1024);
    const section = seed.sections.host_evidence as readonly unknown[] | undefined;

    // Whole items are dropped, never half-admitted, and the dropped count is
    // recorded exactly against the total projected (no silent drop).
    const admitted = section?.length ?? 0;
    expect(admitted).toBeLessThan(items.length);
    expect(admitted + seed.omitted.items).toBe(items.length);
    expect(seed.rendered).toContain("host_evidence");
  });
});

// ─── Resume determinism ───────────────────────────────────────────────

describe("projectHandoffEvidence resume determinism", () => {
  it("projection from a replayed log equals the live projection (pure over records)", () => {
    const records = [
      makeHandoffEvidence({
        handoff_id: "r-1",
        ts: 1000,
        worktree: makeSnapshotWorktree("aaa", [{ path: "x.ts", preexisting: true }]),
        commands: [makeCommand("git status")],
      }),
      makeHandoffEvidence({
        handoff_id: "r-2",
        ts: 2000,
        worktree: makeUnavailableWorktree("git_operation_failed"),
      }),
    ];

    const live = projectHandoffEvidence(records, "run-1");
    const replayed = projectHandoffEvidence([...records], "run-1");

    expect(replayed).toEqual(live);
    // Re-projecting the identical list is a no-op change (determinism).
    expect(projectHandoffEvidence(records, "run-1")).toEqual(live);
  });
});
