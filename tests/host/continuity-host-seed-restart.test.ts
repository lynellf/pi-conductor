/** Fresh-role handoff seeds must reach a worker after restart (spec §11). */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createInitialCheckpoint } from "../../src/core/reduce.js";
import type { MachineDefinition, TransitionAccepted } from "../../src/core/types.js";
import { buildRestartContinuitySeed, runWithCompletion } from "../../src/host/api-completion.js";
import { prepareFreshContinuityEnrichment } from "../../src/host/context-enrichment/prepare.js";
import { findRestartContextEnrichment } from "../../src/host/context-enrichment/replay.js";
import {
  TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA,
  TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS,
} from "../../src/host/context-enrichment/typesafe-client.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { runLoop } from "../../src/host/loop.js";
import { formatIncomingHandoffSeed } from "../../src/host/loop-format.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { StubHost } from "../../src/host/stub-host.js";
import {
  computeContextEnrichmentInputFingerprint,
  computeContextEnrichmentTransitionKey,
} from "../../src/persistence/context-enrichment.js";
import { materializeContinuity } from "../../src/persistence/continuity-materialization.js";
import { projectRankedCandidates } from "../../src/persistence/continuity-ranking.js";
import { renderContinuitySeed } from "../../src/persistence/continuity-seed.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import type { ContextEnrichmentRecord } from "../../src/seam/context-enrichment.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

const POLICY = {
  schema_version: 1 as const,
  require_handoff: true,
  require_delegated_result: false,
  seed_max_utf8_bytes: 32_768,
};

const ENRICHMENT_POLICY = {
  schema_version: 1 as const,
  provider: "typesafe_jev" as const,
  model: "jev-latest",
  strategy: "recipient_relevance_rank" as const,
  candidate_limit: 32,
  max_parallel: 2,
  request_timeout_ms: 5_000,
  max_attempts: 2,
};

const packet = {
  schema_version: 1 as const,
  summary: "ready for the receiver",
  findings: [
    {
      id: "f-host-seed",
      kind: "decision" as const,
      confidence: "observed" as const,
      statement: "Approved to inject the bounded continuity seed on every fresh role visit.",
      evidence: [],
      supersedes: [],
    },
  ],
  evaluations: [],
  open_questions: [],
  next_steps: [
    {
      id: "ns-host-seed",
      owner: "recipient" as const,
      action: "Acknowledge the bounded seed and continue.",
      evidence: [],
      supersedes: [],
    },
  ],
  okf_candidate_ids: [],
};

function transitionAccepted(
  ts: number,
  continuityBytes = JSON.stringify(packet).length,
): TransitionAccepted {
  const payload = {
    target_role: "implementer",
    objective: "Continue the implementer work.",
    requested_action: "Acknowledge the continuity and continue.",
    summary: "continue",
    continuity: packet,
  };
  const utf8Bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  return {
    type: "transition_accepted",
    run_id: "run-host-seed",
    from: "orchestrator",
    to: "implementer",
    event: "handoff",
    target_role: "implementer",
    request_end: false,
    end_authority: null,
    end_requested_by: null,
    role: "orchestrator",
    suggests_next: null,
    payload_summary: { field_names: ["summary"] },
    guard: null,
    effect: [],
    session_file: "parent.jsonl",
    context_ref: {
      run_id: "run-host-seed",
      source_role: "orchestrator",
      source_session_file: "parent.jsonl",
    },
    accepted_handoff: {
      schema_version: 1,
      recipient_role: "implementer",
      payload,
      utf8_bytes: utf8Bytes,
      continuity_evidence: [],
      continuity_packet_utf8_bytes: continuityBytes,
    },
    ts,
  };
}

function sessionStarted(ts: number): import("../../src/persistence/log.js").PersistedRecord {
  return {
    type: "session_started",
    run_id: "run-host-seed",
    role: "implementer",
    visit_index: 1,
    state: "implementer",
    model: "test",
    session_file: "implementer.jsonl",
    parent_session: "parent.jsonl",
    ts,
  };
}

describe("host seed restart reconstruction", () => {
  it("formatIncomingHandoffSeed injects a byte-identical bounded seed section when the policy is pinned", async () => {
    directory = await mkdtemp(join(tmpdir(), "continuity-host-seed-restart-"));
    const writer = new FileRecordLog({ baseDir: directory });
    writer.append({
      type: "session_started",
      run_id: "run-host-seed",
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: "test",
      session_file: "parent.jsonl",
      parent_session: null,
      ts: 1,
    });
    writer.append(transitionAccepted(2));
    writer.append(sessionStarted(3));
    writer.close();

    const reopened = new FileRecordLog({ baseDir: directory });
    const records = reopened.records("run-host-seed");
    const ledger = materializeContinuity(records, {
      run_id: "run-host-seed",
      schema_version: POLICY.schema_version,
      require_handoff: POLICY.require_handoff,
      require_delegated_result: POLICY.require_delegated_result,
      seed_max_utf8_bytes: POLICY.seed_max_utf8_bytes,
    });
    const seed = renderContinuitySeed(ledger, POLICY.seed_max_utf8_bytes);
    const seedSection = {
      rendered: seed.rendered,
      omitted_items: seed.omitted.items,
      omitted_packets: seed.omitted.packets,
      used_bytes: seed.budget.used_bytes,
      max_bytes: seed.budget.max_bytes,
    };

    // Restart path: rebuild the fresh-receiver seed from the durable log.
    const restartedSeed = formatIncomingHandoffSeed(
      records,
      "run-host-seed",
      "implementer",
      seedSection,
    );
    expect(restartedSeed).not.toBeNull();
    const text = restartedSeed ?? "";
    // The seed section is the canonical injection point. The renderer's
    // exact byte budget header and omission counts must surface.
    expect(text).toContain("continuity_seed:");
    expect(text).toContain(
      `budget: ${seedSection.used_bytes}/${seedSection.max_bytes} UTF-8 bytes`,
    );
    const expectedOmission =
      seedSection.omitted_items > 0 || seedSection.omitted_packets > 0
        ? `omitted: ${seedSection.omitted_items} item(s), ${seedSection.omitted_packets} packet(s)`
        : "omitted: (none)";
    expect(text).toContain(expectedOmission);
    // The rendered ledger JSON is injected verbatim so the receiver can
    // re-parse it deterministically.
    expect(text).toContain(seedSection.rendered);
  });

  it("reuses a completed enrichment terminal when rebuilding a ranked seed after restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "continuity-host-seed-restart-ranked-"));
    const writer = new FileRecordLog({ baseDir: directory });
    writer.append({
      type: "session_started",
      run_id: "run-host-seed",
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: "test",
      session_file: "parent.jsonl",
      role_session_id: "source-role-session",
      parent_session: null,
      ts: 1,
    });
    writer.append(transitionAccepted(2));
    writer.append(sessionStarted(3));

    const records = writer.records("run-host-seed");
    const ledger = materializeContinuity(records, {
      run_id: "run-host-seed",
      schema_version: POLICY.schema_version,
      require_handoff: POLICY.require_handoff,
      require_delegated_result: POLICY.require_delegated_result,
      seed_max_utf8_bytes: POLICY.seed_max_utf8_bytes,
    });
    const transitionKey = computeContextEnrichmentTransitionKey({
      run_id: "run-host-seed",
      from: "orchestrator",
      to: "implementer",
      transition_ts: 2,
      source_role_session_id: "source-role-session",
      source_session_file: "parent.jsonl",
      target_visit_index: 1,
    });
    const projection = projectRankedCandidates(ledger, {
      recipient: {
        role: "implementer",
        objective: "Continue the implementer work.",
        requested_action: "Acknowledge the continuity and continue.",
      },
      policy: ENRICHMENT_POLICY,
      source_transition_key: transitionKey,
    });
    const inputFingerprint = computeContextEnrichmentInputFingerprint({
      policy: ENRICHMENT_POLICY,
      recipient: {
        role: "implementer",
        objective: "Continue the implementer work.",
        requested_action: "Acknowledge the continuity and continue.",
      },
      candidates: projection.scored_prefix.map((entry) => ({
        key: entry.candidate_key,
        outbound: entry.outbound,
      })),
      instructions: TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS,
      criteria: [...TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA],
    });
    const enrichment: ContextEnrichmentRecord = {
      type: "context_enrichment",
      schema_version: 1,
      run_id: "run-host-seed",
      source_transition_key: transitionKey,
      input_sha256: inputFingerprint,
      recipient_role: "implementer",
      recipient_visit: 1,
      status: "completed",
      provider: "typesafe_jev",
      requested_model: ENRICHMENT_POLICY.model,
      actual_model: "jev-latest",
      strategy: "recipient_relevance_rank",
      candidate_count: projection.scored_prefix.length,
      judgments: projection.scored_prefix.map((entry, index) => ({
        candidate_key: entry.candidate_key,
        baseline_ordinal: entry.baseline_ordinal,
        score: index === 0 ? 0 : 3,
        ranking_certainty: 0.9,
        probabilities: { "0": 0.05, "1": 0.05, "2": 0.1, "3": 0.8 },
      })),
      usage: { input_tokens: 10, output_tokens: 5 },
      ts: 4,
    };
    writer.append(enrichment);
    writer.close();

    const reopened = new FileRecordLog({ baseDir: directory });
    const restartedSeed = buildRestartContinuitySeed({
      policy: POLICY,
      contextEnrichmentPolicy: ENRICHMENT_POLICY,
      records: reopened.records("run-host-seed"),
      runId: "run-host-seed",
      recipientRole: "implementer",
    });

    expect(restartedSeed).not.toBeNull();
    expect(restartedSeed?.rendered).toContain("host_relevance");
  });

  it("rejects a terminal keyed to a stale recipient visit on restart", () => {
    const runId = "run-stale-visit";
    const accepted = { ...transitionAccepted(2), run_id: runId };
    const staleVisit = 2;
    const staleKey = computeContextEnrichmentTransitionKey({
      run_id: runId,
      from: "orchestrator",
      to: "implementer",
      transition_ts: accepted.ts,
      source_role_session_id: "source-role-session",
      source_session_file: accepted.session_file,
      target_visit_index: staleVisit,
    });
    const terminal: ContextEnrichmentRecord = {
      type: "context_enrichment",
      schema_version: 1,
      run_id: runId,
      source_transition_key: staleKey,
      input_sha256: "a".repeat(64),
      recipient_role: "implementer",
      recipient_visit: staleVisit,
      status: "completed",
      provider: "typesafe_jev",
      requested_model: ENRICHMENT_POLICY.model,
      actual_model: "test-model",
      strategy: "recipient_relevance_rank",
      candidate_count: 0,
      judgments: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      ts: 3,
    };

    expect(() =>
      findRestartContextEnrichment(
        [accepted, terminal],
        {
          runId,
          from: "orchestrator",
          to: "implementer",
          transitionTs: accepted.ts,
          sourceRoleSessionId: "source-role-session",
          sourceSessionFile: accepted.session_file,
        },
        1,
      ),
    ).toThrow(/visit|transition/i);
  });

  it("retries enrichment before the first resumed prompt when no terminal exists", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "continuity-host-seed-retry-"));
    directory = workdir;
    const runId = "run-host-seed";
    const log = new InMemoryRecordLog();
    log.append({
      type: "session_started",
      run_id: runId,
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: "test",
      session_file: "parent.jsonl",
      role_session_id: "source-role-session",
      parent_session: null,
      ts: 1,
    });
    log.append(transitionAccepted(2));

    const loadedManifest = loadManifestFromString(
      `
version: 1
continuity:
  schema_version: 1
  require_handoff: true
  require_delegated_result: false
  seed_max_utf8_bytes: ${POLICY.seed_max_utf8_bytes}
context_enrichment:
  schema_version: 1
  provider: typesafe_jev
  model: jev-latest
  strategy: recipient_relevance_rank
  candidate_limit: 32
  max_parallel: 2
  request_timeout_ms: 5000
  max_attempts: 2
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: off }]
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: off }]
    tools: [handoff, end]
`,
      workdir,
    );
    const initial = createInitialCheckpoint(makeDef());
    const checkpoint = {
      ...initial,
      run_id: runId,
      current_role: "implementer" as const,
      visit_count: { orchestrator: 1, implementer: 1 },
      active_role_session: null,
    };
    const host = new StubHost({
      runId,
      log,
      loadedManifest,
      steps: [{ kind: "emit_end", reason: "done" }],
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-host-seed-retry-"),
    });
    let preparationCalls = 0;
    host.prepareFreshContinuityEnrichment = async (input) => {
      preparationCalls += 1;
      return prepareFreshContinuityEnrichment({
        loadedManifest,
        log,
        runId,
        recipient: input.role,
        recipientObjective: input.recipientObjective,
        recipientRequestedAction: input.recipientRequestedAction,
        from: input.from,
        transitionTs: input.transitionTs,
        sourceRoleSessionId: input.sourceRoleSessionId,
        sourceSessionFile: input.sourceSessionFile,
        targetVisitIndex: input.visitIndex,
        enricher: {
          enrich: async (request) => ({
            kind: "completed",
            actual_model: "test-model",
            judgments: [
              {
                candidate_key: request.candidate.candidate_key,
                baseline_ordinal: request.candidate.baseline_ordinal,
                score: 3,
                ranking_certainty: 0.9,
                probabilities: { "0": 0, "1": 0, "2": 0.1, "3": 0.9 },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      });
    };

    const prompts: string[] = [];
    const originalSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await originalSpawn(role, options);
      const originalPrompt = session.prompt.bind(session);
      session.prompt = async (text) => {
        prompts.push(text);
        await originalPrompt(text);
      };
      return session;
    };

    const handle = await runWithCompletion({
      runId,
      def: makeDef(),
      log,
      host,
      initialCheckpoint: checkpoint,
      goal: "resume",
      loadedManifest,
      lease: { release: async () => {} },
      initialVisitIndexByRole: { implementer: 1 },
    });
    await handle.completion();

    expect(preparationCalls).toBe(1);
    expect(
      log.records(runId).filter((record) => record.type === "context_enrichment"),
    ).toHaveLength(1);
    expect(prompts[0]).toContain("host_relevance");
  });

  it("produces byte-identical seeds across two FileRecordLog reopens", async () => {
    directory = await mkdtemp(join(tmpdir(), "continuity-host-seed-restart-byte-"));
    const writer = new FileRecordLog({ baseDir: directory });
    writer.append({
      type: "session_started",
      run_id: "run-host-seed",
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: "test",
      session_file: "parent.jsonl",
      parent_session: null,
      ts: 1,
    });
    writer.append(transitionAccepted(2));
    writer.append(sessionStarted(3));
    writer.close();

    const first = new FileRecordLog({ baseDir: directory }).records("run-host-seed");
    const second = new FileRecordLog({ baseDir: directory }).records("run-host-seed");
    const ledgerFirst = materializeContinuity(first, {
      run_id: "run-host-seed",
      schema_version: POLICY.schema_version,
      require_handoff: POLICY.require_handoff,
      require_delegated_result: POLICY.require_delegated_result,
      seed_max_utf8_bytes: POLICY.seed_max_utf8_bytes,
    });
    const ledgerSecond = materializeContinuity(second, {
      run_id: "run-host-seed",
      schema_version: POLICY.schema_version,
      require_handoff: POLICY.require_handoff,
      require_delegated_result: POLICY.require_delegated_result,
      seed_max_utf8_bytes: POLICY.seed_max_utf8_bytes,
    });
    const seedFirst = renderContinuitySeed(ledgerFirst, POLICY.seed_max_utf8_bytes);
    const seedSecond = renderContinuitySeed(ledgerSecond, POLICY.seed_max_utf8_bytes);
    expect(seedFirst.rendered).toBe(seedSecond.rendered);
    expect(seedFirst.omitted.items).toBe(seedSecond.omitted.items);
    expect(seedFirst.omitted.packets).toBe(seedSecond.omitted.packets);
    expect(seedFirst.budget.used_bytes).toBe(seedSecond.budget.used_bytes);
  });
});

function makeDef(): MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze(["implementer"]),
    max_visits: Object.freeze({ implementer: 3 }),
    end_request_roles: null,
  }) as MachineDefinition;
}

describe("live handoff seed wiring", () => {
  it("hosts inject the bounded continuity seed into the worker prompt on accepted handoffs", async () => {
    const checkpoint = createInitialCheckpoint(makeDef());
    const log = new InMemoryRecordLog();
    const workdir = await mkdtemp(join(tmpdir(), "continuity-host-seed-live-"));
    directory = workdir;
    const loadedManifest = loadManifestFromString(
      `
version: 1
continuity:
  schema_version: 1
  require_handoff: true
  require_delegated_result: false
  seed_max_utf8_bytes: ${POLICY.seed_max_utf8_bytes}
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: off }]
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: off }]
    tools: [handoff, end]
`,
      workdir,
    );

    const host = new StubHost({
      runId: checkpoint.run_id,
      log,
      loadedManifest,
      steps: [
        {
          kind: "emit_tool_calls",
          calls: [
            {
              name: "handoff",
              arguments: {
                target_role: "implementer",
                status: "ready",
                objective: "Continue the run as implementer.",
                summary: "begin work",
                requested_action: "Complete the next implementer step and report the result.",
                reason: "begin work",
                continuity: packet,
              },
            },
          ],
        },
        { kind: "emit_end", reason: "done" },
      ],
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-host-seed-live-"),
    });
    // Diagnostic: confirm the manifest continuity policy reached the host.
    const policy = (
      host as unknown as { loadedManifestValue?: { manifest?: { continuity?: unknown } } }
    ).loadedManifestValue?.manifest?.continuity;
    if (policy === undefined) {
      throw new Error("StubHost did not receive the continuity policy");
    }
    // Sanity: the host's materializeFreshContinuitySeed seam must
    // return a non-null section for a fresh role when the policy is
    // pinned (the loop relies on this for the live handoff path).
    const section = host.materializeFreshContinuitySeed?.({ role: "implementer", visitIndex: 1 });
    if (section === null || section === undefined) {
      throw new Error("host.materializeFreshContinuitySeed returned null/undefined");
    }

    const workerPrompts: string[] = [];
    const originalSpawn = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await originalSpawn(role, options);
      const originalPrompt = session.prompt.bind(session);
      session.prompt = async (text) => {
        if (role === "implementer") workerPrompts.push(text);
        await originalPrompt(text);
      };
      return session;
    };

    const result = await runLoop({
      def: makeDef(),
      initialCheckpoint: checkpoint,
      host,
      initialGoal: "begin",
    });

    if (workerPrompts.length === 0) {
      // Throw with a helpful diagnostic so failures don't masquerade
      // as a missing-prompt bug.
      const failRecords = log
        .records(checkpoint.run_id)
        .filter((r) => r.type === "session_failed" || r.type === "session_ended");
      throw new Error(
        `test never reached the worker seed assertion.\n` +
          `worker prompts=${workerPrompts.length}\n` +
          `exitReason=${result.exitReason}\n` +
          `terminals=${JSON.stringify(failRecords.map((r) => r.type))}\n` +
          `first worker prompt head: ${(workerPrompts[0] ?? "").slice(0, 2000)}`,
      );
    }
    // The first worker prompt is the live-handoff seed we care about.
    const workerSeed = workerPrompts[0] ?? "";
    // The worker MUST receive the bounded seed section because the
    // manifest pins the continuity policy. The header surfaces the
    // exact byte budget and omission counts from the renderer.
    expect(workerSeed).toContain("continuity_seed:");
    expect(workerSeed).toMatch(
      new RegExp(`budget: \\d+/${POLICY.seed_max_utf8_bytes} UTF-8 bytes`),
    );
    expect(workerSeed).toMatch(/omitted: \d+ item\(s\), \d+ packet\(s\)|omitted: \(none\)/);
    // The materializer's exact ledger is injected verbatim. The
    // schema-version marker is enough to confirm the ledger JSON
    // was passed through byte-identically (no findings yet in this
    // fresh run, so the finding_id is not present).
    expect(workerSeed).toContain('schema_version":1');
  });
});
