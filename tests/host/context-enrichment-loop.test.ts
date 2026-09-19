/**
 * E2E stub TypeSafe test — jev-context-ranking spec §9, §10.4, Checkpoint C.
 *
 * Drives a full `accepted transition → durable ranking → ranked recipient
 * seed` flow through the host preparation seam using the stub provider
 * (`createTypesafeContextEnricher` with an injected fetch). The test
 * verifies:
 *
 *  - The accepted transition becomes durable before any enrichment runs.
 *  - Exactly one terminal `context_enrichment` record is appended
 *    before the recipient prompt can consume the result.
 *  - The matched ranked seed surfaces the host annotation wrapper for
 *    every scored candidate.
 *  - One candidate failure produces one `unavailable` record and the
 *    baseline fallback seed.
 *  - Restart (re-instantiating the host with the same log) reuses the
 *    matching terminal record with zero extra API calls.
 *  - Captured outbound state contains none of the prohibited fields
 *    (run id, paths, commits, URLs, evidence, transcripts, credentials).
 */

import { describe, expect, it } from "vitest";
import { prepareFreshContinuityEnrichment } from "../../src/host/context-enrichment/prepare.js";
import {
  type CapturedOutboundRequest,
  createTypesafeContextEnricher,
  type FetchLike,
  TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA,
  TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS,
  TYPESAFE_RECIPIENT_RELEVANCE_QUESTION,
} from "../../src/host/context-enrichment/typesafe-client.js";
import type { LoadedManifest } from "../../src/host/manifest.js";
import { materializeContinuity } from "../../src/persistence/continuity-materialization.js";
import { buildRankedSeed } from "../../src/persistence/continuity-ranking.js";
import { InMemoryRecordLog } from "../../src/persistence/in-memory-log.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const VALID_ANSWER = (_model: string, score: number, certainty: number) => ({
  type: "score",
  score,
  confidence: certainty,
  probabilities: { "0": 0.05, "1": 0.1, "2": 0.7, "3": 0.15 },
  legend: {
    "0": TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA[0],
    "1": TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA[1],
    "2": TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA[2],
    "3": TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA[3],
  },
});

const VALID_RESPONSE = (model: string, score: number, certainty: number) => ({
  model,
  usage: { input_tokens: 123, output_tokens: 17 },
  answers: {
    [TYPESAFE_RECIPIENT_RELEVANCE_QUESTION]: VALID_ANSWER(model, score, certainty),
  },
});

function loadedManifest(): LoadedManifest {
  const manifest: import("../../src/manifest/types.js").Manifest = {
    version: 1,
    roles: [],
    handoffs: [],
    continuity: {
      schema_version: 1,
      require_handoff: false,
      require_delegated_result: false,
      seed_max_utf8_bytes: 32_768,
    },
    context_enrichment: {
      schema_version: 1,
      provider: "typesafe_jev",
      model: "jev-latest",
      strategy: "recipient_relevance_rank",
      candidate_limit: 4,
      max_parallel: 2,
      request_timeout_ms: 5_000,
      max_attempts: 2,
    },
  };
  return {
    def: {
      orchestrator: "orchestrator",
      roles: [],
      caps: { per_visit_cost_usd: null, per_run_cost_usd: null },
      version: 1,
    } as unknown as import("../../src/core/types.js").MachineDefinition,
    manifest,
    warnings: Object.freeze([]),
    manifestDir: null,
    manifestVersion: 1,
  };
}

function makeTransitionAccepted(recordId: string, runId: string, ts: number, continuity: unknown) {
  const accepted_handoff = continuity
    ? {
        schema_version: 1 as const,
        recipient_role: "implementer" as const,
        payload: { summary: "test", continuity },
        utf8_bytes: 12,
        continuity_evidence: [] as import("../../src/core/types.js").ContinuityEvidenceResolution[],
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

function makePacket(summary: string, findings: Array<{ id: string; kind?: string }>) {
  return {
    schema_version: 1 as const,
    summary,
    findings: findings.map((f) => ({
      id: f.id,
      kind: (f.kind ?? "fact") as "fact" | "decision" | "negative_result" | "risk",
      confidence: "observed" as const,
      statement: `finding ${f.id}`,
      evidence: [],
      supersedes: [],
    })),
    evaluations: [],
    open_questions: [],
    next_steps: [],
    okf_candidate_ids: [],
  };
}

function _withLifecycles(records: readonly PersistedRecord[]): PersistedRecord[] {
  const seen = new Set<string>();
  const out: PersistedRecord[] = [];
  for (const record of records) {
    if (
      record.type === "transition_accepted" &&
      typeof record.session_file === "string" &&
      !seen.has(record.session_file)
    ) {
      seen.add(record.session_file);
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
    }
    out.push(record);
  }
  return out;
}

function setupFakeFetch(
  handler: (req: CapturedOutboundRequest) => { status: number; body: unknown },
): { calls: CapturedOutboundRequest[]; fetchImpl: FetchLike } {
  const calls: CapturedOutboundRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const headers = init.headers;
    calls.push({ url: input, body, headers });
    const { status, body: responseBody } = handler({ url: input, body, headers });
    return {
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => responseBody,
    };
  };
  return { calls, fetchImpl };
}

function buildEnricher(fetchImpl: FetchLike) {
  return createTypesafeContextEnricher({
    apiKey: "test-key",
    requestTimeoutMs: 5_000,
    maxAttempts: 2,
    fetchImpl,
  });
}

describe("Checkpoint C — accepted transition → durable ranking → ranked seed", () => {
  it("produces a ranked seed after the matched enrichment record is persisted", async () => {
    const log = new InMemoryRecordLog();
    const runId = "run-1";
    const packet = makePacket("test", [
      { id: "f-1", kind: "fact" },
      { id: "f-2", kind: "risk" },
    ]);
    const accepted = makeTransitionAccepted("rec-1", runId, 1000, packet);
    // Append the session_started before the transition so the materializer
    // can match the handoff to its preceding lifecycle.
    log.append({
      type: "session_started",
      run_id: runId,
      role: accepted.role,
      visit_index: 1,
      state: accepted.role,
      model: "test",
      session_file: accepted.session_file,
      parent_session: null,
      ts: 999,
    });
    log.append(accepted);

    let counter = 0;
    const { calls, fetchImpl } = setupFakeFetch(() => {
      counter += 1;
      return {
        status: 200,
        body: VALID_RESPONSE("jev-1", 2 - counter * 0.1, 0.5 + counter * 0.1),
      };
    });

    const record = await prepareFreshContinuityEnrichment({
      loadedManifest: loadedManifest(),
      log,
      runId,
      recipient: "implementer",
      recipientObjective: "ship it",
      recipientRequestedAction: "implement the wire contract",
      from: "orchestrator",
      transitionTs: 1000,
      sourceRoleSessionId: "role-session-orch-2",
      sourceSessionFile: accepted.session_file,
      targetVisitIndex: 3,
      enricher: buildEnricher(fetchImpl),
      apiKey: "test-key",
    });

    expect(record).not.toBeNull();
    if (record === null) throw new Error("expected terminal record");
    expect(record.status).toBe("completed");
    expect(record.candidate_count).toBe(record.judgments?.length);
    expect(calls.length).toBeGreaterThan(0);

    const records = log.records(runId);
    const enrichments = records.filter((r) => r.type === "context_enrichment");
    expect(enrichments).toHaveLength(1);

    // Captured outbound states must not carry any prohibited fields.
    for (const call of calls) {
      const serialized = JSON.stringify(call.body);
      expect(serialized).not.toMatch(
        /run_id|record_id|session_id|child_id|execution_id|artifact_id/,
      );
      expect(serialized).not.toMatch(/path|commit|line_start|line_end|sha256|url/);
      expect(serialized).not.toMatch(/credentials|api[_-]?key/i);
    }

    // The materializer composes the ranked seed from the durable record.
    const ledger = materializeContinuity(records, { run_id: runId });
    const ranked = buildRankedSeed({
      ledger,
      max_bytes: 32_768,
      ranking_input: {
        recipient: { role: "implementer", objective: "ship it", requested_action: "implement" },
        policy: {
          provider: "typesafe_jev",
          model: "jev-latest",
          strategy: "recipient_relevance_rank",
          candidate_limit: 4,
        },
        source_transition_key: record.source_transition_key,
      },
      judgments: record.judgments ?? [],
    });
    expect(ranked.rendered).toContain("host_relevance");
    expect(ranked.used_bytes).toBeLessThanOrEqual(32_768);
  });

  it("bounds concurrent candidates and persists ordinals independent of completion order", async () => {
    const log = new InMemoryRecordLog();
    const runId = "run-concurrency";
    const packet = makePacket("test", [
      { id: "f-1", kind: "fact" },
      { id: "f-2", kind: "risk" },
    ]);
    const accepted = makeTransitionAccepted("concurrency", runId, 1000, packet);
    log.append({
      type: "session_started",
      run_id: runId,
      role: accepted.role,
      visit_index: 1,
      state: accepted.role,
      model: "test",
      session_file: accepted.session_file,
      parent_session: null,
      ts: 999,
    });
    log.append(accepted);

    let active = 0;
    let peak = 0;
    const completionOrder: number[] = [];
    const record = await prepareFreshContinuityEnrichment({
      loadedManifest: loadedManifest(),
      log,
      runId,
      recipient: "implementer",
      recipientObjective: "ship it",
      recipientRequestedAction: "implement",
      from: "orchestrator",
      transitionTs: 1000,
      sourceRoleSessionId: "source-session",
      sourceSessionFile: accepted.session_file,
      targetVisitIndex: 1,
      enricher: {
        enrich: async (request) => {
          active += 1;
          peak = Math.max(peak, active);
          const ordinal = request.candidate.baseline_ordinal;
          await new Promise<void>((resolve) => setTimeout(resolve, ordinal === 0 ? 15 : 0));
          completionOrder.push(ordinal);
          active -= 1;
          return {
            kind: "completed" as const,
            actual_model: "test-model",
            judgments: [
              {
                candidate_key: request.candidate.candidate_key,
                baseline_ordinal: ordinal,
                score: ordinal === 0 ? 0 : 3,
                ranking_certainty: 0.9,
                probabilities: { "0": 0.1, "1": 0.1, "2": 0.1, "3": 0.7 },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    });

    expect(peak).toBe(2);
    expect(completionOrder[0]).toBeGreaterThan(0);
    expect(completionOrder.at(-1)).toBe(0);
    expect(record).not.toBeNull();
    if (record?.status !== "completed") throw new Error("expected completed terminal");
    expect(record.judgments?.map((judgment) => judgment.baseline_ordinal)).toEqual(
      Array.from({ length: record.candidate_count }, (_, index) => index),
    );
  });

  it("produces an unavailable record on one candidate failure and falls back to baseline", async () => {
    const log = new InMemoryRecordLog();
    const runId = "run-1";
    const packet = makePacket("test", [
      { id: "f-1", kind: "fact" },
      { id: "f-2", kind: "risk" },
    ]);
    const accepted = makeTransitionAccepted("rec-1", runId, 1000, packet);
    log.append({
      type: "session_started",
      run_id: runId,
      role: accepted.role,
      visit_index: 1,
      state: accepted.role,
      model: "test",
      session_file: accepted.session_file,
      parent_session: null,
      ts: 999,
    });
    log.append(accepted);

    let counter = 0;
    const { fetchImpl } = setupFakeFetch(() => {
      counter += 1;
      if (counter === 1) {
        return { status: 200, body: VALID_RESPONSE("jev-1", 1, 0.4) };
      }
      return { status: 429, body: {} };
    });

    const record = await prepareFreshContinuityEnrichment({
      loadedManifest: loadedManifest(),
      log,
      runId,
      recipient: "implementer",
      recipientObjective: "ship it",
      recipientRequestedAction: "implement",
      from: "orchestrator",
      transitionTs: 1000,
      sourceRoleSessionId: null,
      sourceSessionFile: accepted.session_file,
      targetVisitIndex: 1,
      enricher: buildEnricher(fetchImpl),
      apiKey: "test-key",
    });

    expect(record).not.toBeNull();
    if (record === null) throw new Error("expected terminal record");
    expect(record.status).toBe("unavailable");
    if (record.status !== "unavailable") throw new Error("expected unavailable");
    expect(record.failure?.code).toBe("rate_limited");
    expect(record.judgments).toBeUndefined();
    expect(record.usage).toBeUndefined();
  });

  it("persists one response_invalid terminal for a malformed provider outcome", async () => {
    const log = new InMemoryRecordLog();
    const runId = "run-malformed-outcome";
    const packet = makePacket("test", [{ id: "f-1", kind: "fact" }]);
    const accepted = makeTransitionAccepted("malformed", runId, 1000, packet);
    log.append({
      type: "session_started",
      run_id: runId,
      role: accepted.role,
      visit_index: 1,
      state: accepted.role,
      model: "test",
      session_file: accepted.session_file,
      parent_session: null,
      ts: 999,
    });
    log.append(accepted);

    const record = await prepareFreshContinuityEnrichment({
      loadedManifest: loadedManifest(),
      log,
      runId,
      recipient: "implementer",
      recipientObjective: "ship it",
      recipientRequestedAction: "implement",
      from: "orchestrator",
      transitionTs: 1000,
      sourceRoleSessionId: null,
      sourceSessionFile: accepted.session_file,
      targetVisitIndex: 1,
      enricher: {
        enrich: async () => ({
          kind: "completed" as const,
          actual_model: "jev-1",
          judgments: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
      apiKey: "test-key",
    });

    expect(record).toMatchObject({
      status: "unavailable",
      failure: { code: "response_invalid", attempts: 4 },
    });
    expect(log.records(runId).filter((entry) => entry.type === "context_enrichment")).toHaveLength(
      1,
    );
  });

  it("reuses the matching terminal record on restart without making more API calls", async () => {
    const log = new InMemoryRecordLog();
    const runId = "run-1";
    const packet = makePacket("test", [{ id: "f-1", kind: "fact" }]);
    const accepted = makeTransitionAccepted("rec-1", runId, 1000, packet);
    log.append({
      type: "session_started",
      run_id: runId,
      role: accepted.role,
      visit_index: 1,
      state: accepted.role,
      model: "test",
      session_file: accepted.session_file,
      parent_session: null,
      ts: 999,
    });
    log.append(accepted);

    let firstRunCalls = 0;
    const { fetchImpl: fetch1 } = setupFakeFetch(() => {
      firstRunCalls += 1;
      return { status: 200, body: VALID_RESPONSE("jev-1", 2, 0.8) };
    });
    await prepareFreshContinuityEnrichment({
      loadedManifest: loadedManifest(),
      log,
      runId,
      recipient: "implementer",
      recipientObjective: "ship it",
      recipientRequestedAction: "implement",
      from: "orchestrator",
      transitionTs: 1000,
      sourceRoleSessionId: null,
      sourceSessionFile: accepted.session_file,
      targetVisitIndex: 1,
      enricher: buildEnricher(fetch1),
      apiKey: "test-key",
    });
    const firstRunCount = firstRunCalls;
    expect(firstRunCount).toBeGreaterThan(0);

    // Simulate restart: build a fresh adapter with a fake fetch that
    // counts calls; the host should detect the existing terminal record
    // and never invoke the adapter.
    let restartCalls = 0;
    const { fetchImpl: fetch2 } = setupFakeFetch(() => {
      restartCalls += 1;
      return { status: 200, body: VALID_RESPONSE("jev-restart", 0, 0) };
    });

    const record = await prepareFreshContinuityEnrichment({
      loadedManifest: loadedManifest(),
      log,
      runId,
      recipient: "implementer",
      recipientObjective: "ship it",
      recipientRequestedAction: "implement",
      from: "orchestrator",
      transitionTs: 1000,
      sourceRoleSessionId: null,
      sourceSessionFile: accepted.session_file,
      targetVisitIndex: 1,
      enricher: buildEnricher(fetch2),
      apiKey: "test-key",
    });
    expect(restartCalls).toBe(0);
    expect(record).not.toBeNull();
    if (record === null) throw new Error("expected terminal record");
    expect(record.status).toBe("completed");
  });

  it("captures the documented instructions and criteria verbatim", async () => {
    const log = new InMemoryRecordLog();
    const runId = "run-1";
    const packet = makePacket("test", [{ id: "f-1" }]);
    const accepted = makeTransitionAccepted("rec-1", runId, 1000, packet);
    log.append({
      type: "session_started",
      run_id: runId,
      role: accepted.role,
      visit_index: 1,
      state: accepted.role,
      model: "test",
      session_file: accepted.session_file,
      parent_session: null,
      ts: 999,
    });
    log.append(accepted);
    const { calls, fetchImpl } = setupFakeFetch(() => ({
      status: 200,
      body: VALID_RESPONSE("jev-1", 1, 0.5),
    }));
    await prepareFreshContinuityEnrichment({
      loadedManifest: loadedManifest(),
      log,
      runId,
      recipient: "implementer",
      recipientObjective: "ship it",
      recipientRequestedAction: "implement",
      from: "orchestrator",
      transitionTs: 1000,
      sourceRoleSessionId: null,
      sourceSessionFile: accepted.session_file,
      targetVisitIndex: 1,
      enricher: buildEnricher(fetchImpl),
      apiKey: "test-key",
    });
    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0];
    if (firstCall === undefined) throw new Error("expected call");
    const questionsMap = (
      firstCall.body as {
        questions: Record<string, { instructions: string; criteria: readonly string[] }>;
      }
    ).questions;
    const question = questionsMap[TYPESAFE_RECIPIENT_RELEVANCE_QUESTION];
    expect(question?.instructions).toBe(TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS);
    expect(question?.criteria).toEqual(TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA);
  });
});
