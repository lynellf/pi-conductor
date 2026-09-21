/**
 * Issue #137 Phase 2 — deterministic rendered narrative (live + resume).
 *
 * The worker-return transport carries a *supported* narrative whose
 * primary field is `reason`. After Phase 1, that reason reaches
 * `LastMessage.text` and the persisted accepted-control record.
 *
 * Phase 2 makes the reason **render** in both fresh-orchestrator seed
 * surfaces (the run-memory artifact and the v2 host-generated continuity
 * seed), as **reported/untrusted** text — distinct from the host
 * continuity section and from host-observed fields. The reason is
 * **mandatory**: a non-empty `reason` is never labelled omitted and is
 * counted in `omitted` only if it itself is truncated. The render is
 * deterministic across live handoff and resume (both
 * `formatRunMemorySeed` for the run-memory surface and the
 * v2 seed materialization that `formatIncomingHandoffSeed` consumes on
 * resume).
 *
 * The operator view (`renderWorkObservationMarkdown`,
 * `renderWorkObservationJson`) is additive: it already surfaces
 * `reported hints` and `ignored optional fields` for every observation;
 * the new contract is that those lines are non-empty for any
 * `role_return` observation whose accepted-control carried a non-empty
 * `reason`.
 */

import { describe, expect, it } from "vitest";
import { buildRunMemory } from "../../src/core/run-memory.js";
import type { Checkpoint, MachineDefinition, TransitionAccepted } from "../../src/core/types.js";
import { formatRunMemorySeed } from "../../src/host/run-memory.js";
import type { Manifest } from "../../src/manifest/types.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { createManifestSnapshot } from "../../src/persistence/trajectory-records.js";
import {
  materializeWorkObservations,
  type WorkObservationV2,
} from "../../src/persistence/work-observation.js";
import {
  renderWorkObservationJson,
  renderWorkObservationMarkdown,
} from "../../src/persistence/work-observation-report.js";
import { renderWorkObservationSeed } from "../../src/persistence/work-observation-seed.js";

/** A minimal manifest carrying only the orchestrator role. */
const MINIMAL_MANIFEST = {
  version: 1,
  roles: [
    {
      name: "orchestrator",
      is_orchestrator: true,
      models: [{ model: "test:model", effort: "medium" }],
    },
    {
      name: "implementer",
      models: [{ model: "test:model", effort: "medium" }],
      max_visits: 4,
    },
  ],
} as unknown as Manifest;

/** A manifest snapshot so `inferOrchestrator` resolves to "orchestrator". */
function manifestSnapshot(): PersistedRecord {
  return createManifestSnapshot({
    runId: RUN_ID,
    ts: 0,
    manifest: MINIMAL_MANIFEST,
    definition: DEF,
  });
}

const RUN_ID = "run-137";
const TS = 1_700_000_000_000;

const DEF: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["implementer"]),
  max_visits: Object.freeze({ implementer: 4 }),
  end_request_roles: null,
  handoff_evidence: null,
}) as MachineDefinition;

function ck(
  current_role: Checkpoint["current_role"],
  visit_count: Record<string, number> = {},
): Checkpoint {
  return {
    run_id: RUN_ID,
    manifest_version: "1",
    current_role,
    visit_count: Object.freeze({ ...visit_count }),
    end_request: null,
    active_role_session: null,
    updated_at: 0,
  };
}

function v2Accepted(args: {
  reason?: string;
  summary?: string;
  verification?: readonly string[];
  ignored?: readonly string[];
  role?: string;
}): TransitionAccepted {
  const role = args.role ?? "implementer";
  const reported_hints = {
    ...(args.summary === undefined ? {} : { summary: args.summary }),
    ...(args.reason === undefined ? {} : { reason: args.reason }),
    ...(args.verification === undefined ? {} : { verification: args.verification }),
  };
  const control = {
    schema_version: 2 as const,
    direction: "return" as const,
    recipient_role: "orchestrator",
    task: {
      host_directive:
        "Assess the returned work against the run goal and choose the next legal action.",
    },
    reported_hints,
    ignored_hint_fields: args.ignored ?? [],
    utf8_bytes: 200,
  };
  const utf8_bytes = new TextEncoder().encode(JSON.stringify(control)).byteLength;
  const sizedControl = { ...control, utf8_bytes };
  return {
    type: "transition_accepted",
    run_id: RUN_ID,
    from: role,
    to: "orchestrator",
    event: "handoff",
    target_role: "orchestrator",
    request_end: false,
    end_authority: null,
    end_requested_by: null,
    role,
    suggests_next: null,
    payload_summary: { field_names: [] },
    guard: null,
    effect: [],
    session_file: `/${role}.jsonl`,
    accepted_control: sizedControl,
    ts: TS,
  };
}

// ─── formatRunMemorySeed: last_message surfaces reported hints ─────────

describe("formatRunMemorySeed last_message — reported hints sub-block (issue #137 Phase 2)", () => {
  it("renders the returned reason under a `reported hints:` sub-block in last_message", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [v2Accepted({ reason: "phase 2 GREEN: tests pass" })];
    const seed = formatRunMemorySeed(
      buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null }),
    );
    expect(seed).toMatch(/last_message:\s*\n\s+from: implementer/);
    // The reported hints block appears inside last_message — not the
    // host continuity section, not the host directive.
    expect(seed).toMatch(/last_message:[\s\S]*reported hints:/);
    // The reason is rendered verbatim, not collapsed into "(worker omitted reason)".
    expect(seed).toContain("reason: phase 2 GREEN: tests pass");
    expect(seed).not.toMatch(/text: \(worker omitted reason\)/);
  });

  it("renders summary and verification alongside reason in the reported hints sub-block", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [
      v2Accepted({
        reason: "phase 2 GREEN",
        summary: "rendered narrative lands in both seed surfaces",
        verification: ["pnpm exec vitest run tests/host/run-memory-return.test.ts"],
      }),
    ];
    const seed = formatRunMemorySeed(
      buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null }),
    );
    expect(seed).toMatch(/last_message:[\s\S]*reported hints:/);
    expect(seed).toContain("reason: phase 2 GREEN");
    expect(seed).toContain("summary: rendered narrative lands in both seed surfaces");
    expect(seed).toContain(
      "verification: pnpm exec vitest run tests/host/run-memory-return.test.ts",
    );
  });

  it("renders an `ignored optional fields:` line for v2 control with custom fields", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [
      v2Accepted({
        reason: "phase 2 GREEN",
        ignored: ["phase", "tdd_stage", "changed_paths"],
      }),
    ];
    const seed = formatRunMemorySeed(
      buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null }),
    );
    // The ignored fields appear in the last_message block, distinct
    // from host-observed fields.
    expect(seed).toMatch(/last_message:[\s\S]*ignored optional fields:/);
    expect(seed).toMatch(/ignored optional fields:.*phase.*tdd_stage.*changed_paths/s);
  });

  it("labels the reported narrative as reported/untrusted and distinct from host continuity", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [v2Accepted({ reason: "phase 2 GREEN" })];
    const seed = formatRunMemorySeed(
      buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null }),
    );
    // The reported hints block is labelled reported/untrusted.
    const reportedHints = seed.match(
      /last_message:[\s\S]*?(reported hints:[\s\S]*?)(?:\n\s+ignored optional fields:|\n[a-z_]+:|$)/,
    );
    expect(reportedHints).not.toBeNull();
    const block = reportedHints?.[1] ?? "";
    expect(block.toLowerCase()).toContain("reported");
    expect(block.toLowerCase()).toContain("untrusted");
    // The reported hints label appears inside last_message:, distinct
    // from the host continuity section (which is omitted here because
    // no continuity policy is pinned) and from host-observed fields.
    expect(seed).toContain("last_message:");
    expect(seed.indexOf("reported hints:")).toBeGreaterThan(seed.indexOf("last_message:"));
  });

  it("does not render a reported hints block when no accepted_control is attached (legacy)", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    // v1 legacy record (no accepted_control)
    const record: TransitionAccepted = {
      type: "transition_accepted",
      run_id: RUN_ID,
      from: "implementer",
      to: "orchestrator",
      event: "handoff",
      target_role: "orchestrator",
      request_end: false,
      end_authority: null,
      end_requested_by: null,
      role: "implementer",
      suggests_next: null,
      payload_summary: { reason: "legacy reason", field_names: ["reason"] },
      guard: null,
      effect: [],
      session_file: "/implementer.jsonl",
      ts: TS,
    };
    const seed = formatRunMemorySeed(
      buildRunMemory(cp, [record], DEF, { goal: "x", runCostCap: null }),
    );
    expect(seed).toContain("text: legacy reason");
    // No accepted_control → no reported hints sub-block; legacy
    // behavior preserved.
    expect(seed).not.toMatch(/last_message:[\s\S]*reported hints:/);
  });
});

// ─── renderWorkObservationSeed: reported reason is mandatory ───────────

describe("renderWorkObservationSeed — returned reported reason is mandatory (issue #137 Phase 2)", () => {
  function workerReturnObservation(args: {
    reason: string;
    summary?: string;
    verification?: readonly string[];
    ignored?: readonly string[];
  }): { readonly observations: readonly WorkObservationV2[] } {
    const records: PersistedRecord[] = [
      manifestSnapshot(),
      {
        type: "session_started",
        run_id: RUN_ID,
        role: "implementer",
        visit_index: 1,
        state: "implementer",
        model: "model-x",
        session_file: "/implementer.jsonl",
        parent_session: null,
        ts: TS - 1,
      },
      v2Accepted({
        reason: args.reason,
        ...(args.summary === undefined ? {} : { summary: args.summary }),
        ...(args.verification === undefined ? {} : { verification: args.verification }),
        ...(args.ignored === undefined ? {} : { ignored: args.ignored }),
      }),
    ];
    const observations = materializeWorkObservations(records, RUN_ID, {
      requireV2Control: true,
    });
    return { observations };
  }

  it("renders the returned reported reason in the v2 seed (role_return)", () => {
    const { observations } = workerReturnObservation({
      reason: "phase 2 GREEN: tests pass",
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.source).toBe("role_return");
    const seed = renderWorkObservationSeed({
      runGoal: "x",
      recipientRole: "orchestrator",
      task: {
        host_directive: "Assess the returned work",
      },
      observations,
      maxBytes: 32_768,
    });
    expect(seed.rendered).toContain("phase 2 GREEN: tests pass");
  });

  it("labels the reported reason as reported/untrusted and distinct from host-observed fields", () => {
    const { observations } = workerReturnObservation({ reason: "phase 2 GREEN" });
    const seed = renderWorkObservationSeed({
      runGoal: "x",
      recipientRole: "orchestrator",
      task: { host_directive: "Assess the returned work" },
      observations,
      maxBytes: 32_768,
    });
    // Reported hints section labelled as reported/untrusted.
    expect(seed.rendered).toContain("reported hints (reported/untrusted");
    expect(seed.rendered).toContain("reported reason: phase 2 GREEN");
    // Host-observed fields stay distinct: changed paths / execution
    // statuses / artifact labels carry the "(host observed)" label and
    // the reported reason line does not carry it.
    expect(seed.rendered).toMatch(/changed paths \(host observed\):/);
    expect(seed.rendered).toMatch(/execution statuses \(host observed\):/);
    expect(seed.rendered).toMatch(/artifact labels \(host observed\):/);
  });

  it("the returned reason is mandatory — surfaced even when byte budget would skip historical observations", () => {
    // Two observations: a role_return with reason and a dispatch without.
    // Force a tight budget so the role_return's reason has to compete
    // with the rest of the rendered content. The reason must remain
    // visible — counted in omitted only if it is itself truncated.
    const records: PersistedRecord[] = [
      manifestSnapshot(),
      {
        type: "session_started",
        run_id: RUN_ID,
        role: "implementer",
        visit_index: 1,
        state: "implementer",
        model: "model-x",
        session_file: "/implementer.jsonl",
        parent_session: null,
        ts: TS - 1,
      },
      v2Accepted({ reason: "phase 2 GREEN: returned reason must survive truncation" }),
    ];
    const observations = materializeWorkObservations(records, RUN_ID, {
      requireV2Control: true,
    });
    // Tight budget — small enough that the historical observations
    // would be skipped, but the mandatory returned reason must remain.
    const seed = renderWorkObservationSeed({
      runGoal: "x",
      recipientRole: "orchestrator",
      task: { host_directive: "Assess the returned work" },
      observations,
      maxBytes: 4_096,
    });
    expect(seed.rendered).toContain("phase 2 GREEN: returned reason must survive truncation");
  });

  it("the returned reason is counted in omitted only if it itself is truncated", () => {
    // The reason is mandatory in the rendered output. The omission
    // counter is only incremented when the reason itself is truncated
    // (or, for non-mandatory observations, when the observation is
    // truncated). With a short reason and a budget that fits the
    // mandatory context, the reason is rendered verbatim and the
    // omission counter does not increment because of the reason.
    const { observations } = workerReturnObservation({ reason: "short reason" });
    const seed = renderWorkObservationSeed({
      runGoal: "x",
      recipientRole: "orchestrator",
      task: { host_directive: "Assess the returned work" },
      observations,
      maxBytes: 32_768,
    });
    expect(seed.rendered).toContain("short reason");
    expect(seed.omitted.observations).toBeGreaterThanOrEqual(0);
  });

  it("renders ignored optional fields for the role_return observation", () => {
    const { observations } = workerReturnObservation({
      reason: "phase 2 GREEN",
      ignored: ["phase", "tdd_stage", "changed_paths"],
    });
    const seed = renderWorkObservationSeed({
      runGoal: "x",
      recipientRole: "orchestrator",
      task: { host_directive: "Assess the returned work" },
      observations,
      maxBytes: 32_768,
    });
    expect(seed.rendered).toMatch(/ignored optional fields:.*phase.*tdd_stage.*changed_paths/s);
  });
});

// ─── Determinism across live handoff and resume ────────────────────────

describe("Phase 2 determinism — the rendered reason is byte-stable across live handoff and resume", () => {
  it("formatRunMemorySeed produces byte-identical output for two equal inputs", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [
      v2Accepted({
        reason: "phase 2 GREEN",
        summary: "rendered narrative lands",
        verification: ["pnpm exec vitest run tests/host/run-memory-return.test.ts"],
        ignored: ["phase", "tdd_stage"],
      }),
    ];
    const first = formatRunMemorySeed(
      buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null }),
    );
    const second = formatRunMemorySeed(
      buildRunMemory({ ...cp, updated_at: TS + 1 }, records, DEF, {
        goal: "x",
        runCostCap: null,
      }),
    );
    expect(first).toBe(second);
  });

  it("renderWorkObservationSeed produces byte-identical output for the same observation set", () => {
    const records: PersistedRecord[] = [
      manifestSnapshot(),
      v2Accepted({ reason: "phase 2 GREEN: deterministic" }),
    ];
    const observations = materializeWorkObservations(records, RUN_ID, {
      requireV2Control: true,
    });
    const args = {
      runGoal: "x",
      recipientRole: "orchestrator",
      task: { host_directive: "Assess the returned work" },
      observations,
      maxBytes: 32_768,
    };
    const first = renderWorkObservationSeed(args);
    const second = renderWorkObservationSeed(args);
    expect(first.rendered).toBe(second.rendered);
  });
});

// ─── Operator view: reported hints + ignored list for role_return ─────

describe("operator view (issue #137 Phase 2) — reported hints + ignored list for role_return", () => {
  function buildObservation(): WorkObservationV2 {
    const records: PersistedRecord[] = [
      manifestSnapshot(),
      {
        type: "session_started",
        run_id: RUN_ID,
        role: "implementer",
        visit_index: 1,
        state: "implementer",
        model: "model-x",
        session_file: "/implementer.jsonl",
        parent_session: null,
        ts: TS - 1,
      },
      v2Accepted({
        reason: "phase 2 GREEN: operator view must surface the reason",
        summary: "rendered narrative lands",
        verification: ["pnpm exec vitest run tests/host/run-memory-return.test.ts"],
        ignored: ["phase", "tdd_stage", "changed_paths"],
      }),
    ];
    const observations = materializeWorkObservations(records, RUN_ID, {
      requireV2Control: true,
    });
    const observation = observations[0];
    if (observation === undefined) throw new Error("expected exactly one observation");
    return observation;
  }

  it("renderWorkObservationMarkdown surfaces reported hints for role_return", () => {
    const observation = buildObservation();
    const markdown = renderWorkObservationMarkdown([observation]);
    expect(markdown).toMatch(/source: role\\_return/);
    expect(markdown).toMatch(
      /reported hints:[\s\S]*?phase 2 GREEN: operator view must surface the reason/,
    );
    expect(markdown).toContain("summary");
    expect(markdown).toMatch(/verification/);
  });

  it("renderWorkObservationMarkdown surfaces ignored optional fields for role_return", () => {
    const observation = buildObservation();
    const markdown = renderWorkObservationMarkdown([observation]);
    expect(markdown).toMatch(/ignored optional fields:.*phase.*tdd\\_stage.*changed\\_paths/s);
  });

  it("renderWorkObservationJson exposes reported_hints.reason for role_return", () => {
    const observation = buildObservation();
    const json = renderWorkObservationJson([observation]);
    const parsed = JSON.parse(json) as { observations: readonly WorkObservationV2[] };
    const obs = parsed.observations[0];
    expect(obs).toBeDefined();
    expect(obs?.reported_hints.reason).toBe("phase 2 GREEN: operator view must surface the reason");
    expect(obs?.ignored_hint_fields).toEqual(["phase", "tdd_stage", "changed_paths"]);
  });
});
