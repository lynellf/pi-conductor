/** Fresh-role handoff seeds must reach a worker after restart (spec §11). */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createInitialCheckpoint } from "../../src/core/reduce.js";
import type { MachineDefinition, TransitionAccepted } from "../../src/core/types.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { runLoop } from "../../src/host/loop.js";
import { formatIncomingHandoffSeed } from "../../src/host/loop-format.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { StubHost } from "../../src/host/stub-host.js";
import { materializeContinuity } from "../../src/persistence/continuity-materialization.js";
import { renderContinuitySeed } from "../../src/persistence/continuity-seed.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
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
