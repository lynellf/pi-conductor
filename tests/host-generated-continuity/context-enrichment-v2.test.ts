import { describe, expect, it } from "vitest";
import type { ContextEnricher } from "../../src/host/context-enrichment/contracts.js";
import { materializeFreshHostContinuitySeed } from "../../src/host/context-enrichment/materialize-v2.js";
import { prepareFreshHostContinuityEnrichment } from "../../src/host/context-enrichment/prepare-v2.js";
import { executeWorkObservationEnrichmentAttempt } from "../../src/host/context-enrichment/v2-attempt.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import {
  assertContextEnrichmentRecordV2,
  buildWorkObservationRankingCandidates,
  ContextEnrichmentV2Error,
  computeWorkObservationEnrichmentInputFingerprint,
  findContextEnrichmentTerminalsV2,
  orderWorkObservationHistory,
} from "../../src/persistence/context-enrichment-v2.js";
import { InMemoryRecordLog, type PersistedRecord } from "../../src/persistence/log.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import {
  materializeWorkObservations,
  type WorkObservationV2,
} from "../../src/persistence/work-observation.js";
import type { ContextEnrichmentOutcome } from "../../src/seam/context-enrichment.js";

const policy = {
  schema_version: 2 as const,
  provider: "typesafe_jev" as const,
  model: "test:jev",
  strategy: "work_observation_relevance_rank" as const,
  candidate_limit: 2,
  max_parallel: 2,
  request_timeout_ms: 100,
  max_attempts: 1,
  max_observations: 2,
};

function observation(seed: string, role = "worker"): WorkObservationV2 {
  return {
    schema_version: 2,
    observation_key: sha256Canonical({ seed }),
    source: "role_return",
    provenance: {
      record_key: seed,
      run_id: "run-v2",
      role,
      visit: 1,
      accepted_at: "1970-01-01T00:00:00.000Z",
    },
    task: { host_directive: `Assess ${seed}.` },
    reported_hints: {},
    observed: {
      terminal: "returned_control",
      changed_paths: [],
      executions: [],
      artifacts: [],
    },
    omitted: { changed_paths: 0, executions: 0, artifacts: 0 },
  };
}

function acceptedTransition(
  index: number,
): Extract<PersistedRecord, { type: "transition_accepted" }> {
  return {
    type: "transition_accepted",
    run_id: "run-v2",
    from: "orchestrator",
    to: "worker",
    event: "handoff",
    target_role: "worker",
    request_end: false,
    end_authority: null,
    end_requested_by: null,
    role: "orchestrator",
    suggests_next: null,
    payload_summary: { field_names: [] },
    guard: null,
    effect: [],
    session_file: `session-${index}`,
    accepted_control: {
      schema_version: 2,
      direction: "dispatch",
      recipient_role: "worker",
      task: { host_directive: "Perform the assigned work." },
      reported_hints: {},
      ignored_hint_fields: [],
      utf8_bytes: 186,
    },
    ts: index,
  };
}

function cleanupFailureRecords(): readonly PersistedRecord[] {
  return [
    {
      type: "session_started",
      run_id: "run-v2",
      role: "worker",
      visit_index: 1,
      state: "worker",
      model: "test:model",
      session_file: "worker-session",
      parent_session: "session-3",
      ts: 5,
    },
    {
      type: "tool_execution_started",
      schema_version: 1,
      run_id: "run-v2",
      execution_id: "execution-1",
      supervision_id: "supervision-1",
      logical_session_id: "logical-1",
      role_session_id: "worker-session",
      tool_call_id: "call-1",
      tool_name: "bash",
      timeout_ms: 1000,
      recovery_count: 0,
      ts: 6,
    },
    {
      type: "tool_execution_finished",
      schema_version: 1,
      run_id: "run-v2",
      execution_id: "execution-1",
      supervision_id: "supervision-1",
      logical_session_id: "logical-1",
      role_session_id: "worker-session",
      tool_call_id: "call-1",
      tool_name: "bash",
      elapsed_ms: 10,
      recovery_count: 0,
      outcome: "cleanup_unconfirmed",
      cleanup: "unconfirmed",
      ts: 7,
    },
    {
      type: "session_failed",
      run_id: "run-v2",
      role: "worker",
      visit_index: 1,
      state: "worker",
      model: "test:model",
      session_file: "worker-session",
      parent_session: "session-3",
      failure_reason: "tool_cleanup_unconfirmed",
      usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, tokens: 2, cost: 0 },
      ts: 8,
    },
    {
      type: "tool_execution_cleanup_confirmed",
      schema_version: 1,
      run_id: "run-v2",
      execution_id: "execution-1",
      supervision_id: "supervision-1",
      logical_session_id: "logical-1",
      role_session_id: "worker-session",
      tool_call_id: "call-1",
      tool_name: "bash",
      cleanup: "confirmed",
      verification: "operator_confirmed_owner_marker_absent",
      operator_note: "The original process and partial effects were inspected.",
      operator: "operator",
      ts: 9,
    },
  ];
}

function recipient() {
  return {
    role: "orchestrator" as const,
    run_goal: "ship the service",
    task: {
      host_directive:
        "Assess the returned work against the run goal and choose the next legal action.",
    },
  };
}

describe("v2 work-observation Jev enrichment", () => {
  it("builds a newest-first candidate prefix without the direct predecessor", () => {
    const observations = [
      observation("oldest"),
      observation("middle"),
      observation("newest-history"),
      observation("direct"),
    ];
    const built = buildWorkObservationRankingCandidates({
      observations,
      maxObservations: 3,
      candidateLimit: 2,
    });
    expect(built.direct?.source_role).toBe("worker");
    expect(built.candidates.map((candidate) => candidate.observation_key)).toEqual([
      observations[2]?.observation_key,
      observations[1]?.observation_key,
    ]);
    expect(built.candidates.map((candidate) => candidate.baseline_ordinal)).toEqual([0, 1]);
  });

  it("persists one validated terminal and ranks equal-score ties by newer append order", async () => {
    const observations = [observation("oldest"), observation("newer"), observation("direct")];
    const built = buildWorkObservationRankingCandidates({
      observations,
      maxObservations: 2,
      candidateLimit: 2,
    });
    const fingerprint = computeWorkObservationEnrichmentInputFingerprint({
      ...policy,
      recipient: recipient(),
      candidates: built.candidates,
    });
    const requests: string[] = [];
    const enricher: ContextEnricher = {
      async enrich(request): Promise<ContextEnrichmentOutcome> {
        requests.push(request.candidate.candidate_key);
        return {
          kind: "completed",
          actual_model: "test:jev-actual",
          judgments: [
            {
              candidate_key: request.candidate.candidate_key,
              baseline_ordinal: request.candidate.baseline_ordinal,
              score: 2,
              ranking_certainty: 0.75,
              probabilities: { "0": 0.05, "1": 0.1, "2": 0.75, "3": 0.1 },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 4 },
          attempts: 1,
        };
      },
    };
    const record = await executeWorkObservationEnrichmentAttempt({
      enricher,
      policy,
      runId: "run-v2",
      recipient: recipient(),
      recipientVisit: 1,
      candidates: built.candidates,
      inputFingerprint: fingerprint,
      now: () => 10,
    });
    expect(record?.status).toBe("completed");
    expect(requests).toHaveLength(2);
    expect(record?.judgments?.map((judgment) => judgment.observation_key)).toEqual(
      built.candidates.map((candidate) => candidate.observation_key),
    );
    if (record === null || record.status !== "completed")
      throw new Error("expected completed record");
    const ordered = orderWorkObservationHistory({
      observations,
      maxObservations: 2,
      candidates: built.candidates,
      record,
    });
    expect(ordered.map((item) => item.provenance.record_key)).toEqual(["newer", "oldest"]);
  });

  it("reuses one durable terminal without another provider call", async () => {
    const loadedManifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [test:model]
  - name: worker
    max_visits: 3
    models: [test:model]
continuity:
  schema_version: 2
  seed_max_utf8_bytes: 32768
  max_observations: 64
context_enrichment:
  schema_version: 2
  provider: typesafe_jev
  model: test:jev
  strategy: work_observation_relevance_rank
  candidate_limit: 2
  max_parallel: 2
  request_timeout_ms: 100
  max_attempts: 1
`);
    const log = new InMemoryRecordLog();
    log.append(acceptedTransition(1));
    log.append(acceptedTransition(2));
    log.append(acceptedTransition(3));
    let calls = 0;
    const enricher: ContextEnricher = {
      async enrich(request): Promise<ContextEnrichmentOutcome> {
        calls += 1;
        return {
          kind: "completed",
          actual_model: "test:jev",
          judgments: [
            {
              candidate_key: request.candidate.candidate_key,
              baseline_ordinal: request.candidate.baseline_ordinal,
              score: request.candidate.baseline_ordinal,
              ranking_certainty: 1,
              probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
          attempts: 1,
        };
      },
    };
    const args = {
      loadedManifest,
      log,
      runId: "run-v2",
      recipient: "worker" as const,
      recipientVisit: 1,
      runGoal: "ship the service",
      task: { host_directive: "Assess the returned work." },
      enricher,
    };
    const first = await prepareFreshHostContinuityEnrichment(args);
    const second = await prepareFreshHostContinuityEnrichment(args);
    expect(first?.status).toBe("completed");
    expect(second).toEqual(first);
    expect(calls).toBe(2);
    expect(
      log.records("run-v2").filter((record) => record.type === "context_enrichment"),
    ).toHaveLength(1);
  });

  it("replays the same visit after cleanup confirmation and ranks the recovery on a later visit", async () => {
    const loadedManifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [test:model]
  - name: worker
    max_visits: 3
    models: [test:model]
continuity:
  schema_version: 2
  seed_max_utf8_bytes: 32768
  max_observations: 64
context_enrichment:
  schema_version: 2
  provider: typesafe_jev
  model: test:jev
  strategy: work_observation_relevance_rank
  candidate_limit: 2
  max_parallel: 2
  request_timeout_ms: 100
  max_attempts: 1
`);
    const log = new InMemoryRecordLog();
    log.append(acceptedTransition(1));
    log.append(acceptedTransition(2));
    log.append(acceptedTransition(3));
    const requestedKeys: string[] = [];
    const enricher: ContextEnricher = {
      async enrich(request): Promise<ContextEnrichmentOutcome> {
        requestedKeys.push(request.candidate.candidate_key);
        return {
          kind: "completed",
          actual_model: "test:jev",
          judgments: [
            {
              candidate_key: request.candidate.candidate_key,
              baseline_ordinal: request.candidate.baseline_ordinal,
              score: request.candidate.baseline_ordinal,
              ranking_certainty: 1,
              probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
          attempts: 1,
        };
      },
    };
    const task = { host_directive: "Retry the failed worker visit safely." };
    const args = {
      loadedManifest,
      log,
      runId: "run-v2",
      recipient: "worker" as const,
      recipientVisit: 1,
      runGoal: "ship the service",
      task,
      enricher,
      now: () => 4,
    };

    const first = await prepareFreshHostContinuityEnrichment(args);
    expect(first?.status).toBe("completed");
    expect(requestedKeys).toHaveLength(2);

    for (const record of cleanupFailureRecords()) log.append(record);
    const recordsAfterCleanup = log.records("run-v2");
    const failureObservation = materializeWorkObservations(recordsAfterCleanup, "run-v2").find(
      (observation) => observation.source === "host_failure",
    );
    expect(failureObservation).toBeDefined();

    const resumed = await prepareFreshHostContinuityEnrichment(args);
    expect(resumed).toEqual(first);
    expect(requestedKeys).toHaveLength(2);

    const resumedSeed = materializeFreshHostContinuitySeed(
      { loadedManifest, log, runId: "run-v2" },
      { role: "worker", visitIndex: 1, runGoal: "ship the service", task },
    );
    expect(resumedSeed?.direct_observation?.terminal).toBe("failed");

    log.append(acceptedTransition(10));
    const callsBeforeLaterVisit = requestedKeys.length;
    await prepareFreshHostContinuityEnrichment({
      ...args,
      recipientVisit: 2,
      now: () => 11,
    });
    expect(requestedKeys.length).toBeGreaterThan(callsBeforeLaterVisit);
    expect(requestedKeys.slice(callsBeforeLaterVisit)).toContain(
      failureObservation?.observation_key,
    );
  });

  it("rejects duplicate terminals and reordered candidate identities during replay", async () => {
    const observations = [observation("oldest"), observation("newer"), observation("direct")];
    const built = buildWorkObservationRankingCandidates({
      observations,
      maxObservations: 2,
      candidateLimit: 2,
    });
    const fingerprint = computeWorkObservationEnrichmentInputFingerprint({
      ...policy,
      recipient: recipient(),
      candidates: built.candidates,
    });
    const record = {
      type: "context_enrichment" as const,
      schema_version: 2 as const,
      run_id: "run-v2",
      input_sha256: fingerprint,
      recipient_role: "orchestrator",
      recipient_visit: 1,
      status: "unavailable" as const,
      provider: "typesafe_jev" as const,
      requested_model: policy.model,
      strategy: "work_observation_relevance_rank" as const,
      candidate_count: built.candidates.length,
      candidate_keys: built.candidates.map((candidate) => candidate.observation_key),
      failure: { code: "network_error" as const, attempts: 1 },
      ts: 1,
    };
    expect(() =>
      assertContextEnrichmentRecordV2(record, {
        expectedFingerprint: fingerprint,
        expectedKeys: new Set(record.candidate_keys),
        expectedOrderedKeys: [...record.candidate_keys].reverse(),
      }),
    ).toThrowError(new ContextEnrichmentV2Error("context_enrichment_v2_input_mismatch"));
    const records = [record, { ...record, ts: 2 }];
    expect(() => findContextEnrichmentTerminalsV2(records, "run-v2")).toThrowError(
      new ContextEnrichmentV2Error("context_enrichment_v2_duplicate_terminal"),
    );
  });

  it("turns one malformed candidate outcome into unavailable without partial ranking", async () => {
    const observations = [observation("oldest"), observation("newer"), observation("direct")];
    const built = buildWorkObservationRankingCandidates({
      observations,
      maxObservations: 2,
      candidateLimit: 2,
    });
    const fingerprint = computeWorkObservationEnrichmentInputFingerprint({
      ...policy,
      recipient: recipient(),
      candidates: built.candidates,
    });
    let calls = 0;
    const enricher: ContextEnricher = {
      async enrich(request): Promise<ContextEnrichmentOutcome> {
        calls += 1;
        return {
          kind: "completed",
          actual_model: "test:jev",
          judgments: [
            {
              candidate_key: request.candidate.candidate_key,
              baseline_ordinal: request.candidate.baseline_ordinal + (calls === 2 ? 1 : 0),
              score: 3,
              ranking_certainty: 1,
              probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
          attempts: 1,
        };
      },
    };
    const record = await executeWorkObservationEnrichmentAttempt({
      enricher,
      policy,
      runId: "run-v2",
      recipient: recipient(),
      recipientVisit: 1,
      candidates: built.candidates,
      inputFingerprint: fingerprint,
    });
    expect(record?.status).toBe("unavailable");
    expect(record?.failure?.code).toBe("input_mismatch");
    expect(record?.judgments).toBeUndefined();
  });
});
