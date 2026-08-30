/**
 * Task 13.5 resume tests — spec §11.1, §11.9.
 *
 * Covers Task 13.5's acceptance criteria:
 *   - A run started via `startRun` writes a `run_id`-keyed log whose
 *     latest snapshot reconstructs to the in-memory checkpoint
 *     bit-for-bit.
 *   - A run killed (process-simulated by dropping the in-memory
 *     `RunHandle` and re-deriving from the file log) mid-worker-
 *     session resumes via `resumeRun(run_id)`, records a `crashed`
 *     `session_failed` for the interrupted session, and reaches the
 *     same terminal state (`done` via the same transition path) as a
 *     non-killed equivalent run.
 *   - `listRuns()` enumerates the log.
 *
 * The host is `StubHost` (Task 16, refactored out in Task 13.5).
 * The manifest is written to a tempdir; the log goes to a sibling
 * tempdir. `startRun` mints the `run_id`; `resumeRun` reuses it.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubHost } from "../../src/host/index.js";
import {
  type CheckpointSnapshot,
  createInitialCheckpoint,
  FileRecordLog,
  type HostFactoryContext,
  InMemoryRecordLog,
  listRuns,
  type MachineDefinition,
  type PersistedRecord,
  type RoleTurnRecord,
  resumeRun,
  type SessionLifecycleEvent,
  startRun,
  subscribeToRecords,
  type TransitionAccepted,
} from "../../src/index.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

// ─── Helpers ───────────────────────────────────────────────────────────

function makeDef(): MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze(["worker"]),
    max_visits: Object.freeze({ worker: 3 }),
    end_request_roles: null,
  }) as MachineDefinition;
}

const VALID_MANIFEST_YAML = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: worker
    max_visits: 3
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
`;

const GATED_MANIFEST_YAML = `
version: 1
end_request_roles: [worker]
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: worker
    max_visits: 3
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
`;

/** Write a manifest YAML to a temp file; return its path. */
async function writeManifest(workdir: string): Promise<string> {
  const piDir = join(workdir, ".pi");
  await mkdir(piDir, { recursive: true });
  const manifestPath = join(piDir, "conductor.yaml");
  await writeFile(manifestPath, VALID_MANIFEST_YAML, "utf8");
  return manifestPath;
}

// ─── Suite ─────────────────────────────────────────────────────────────

describe("Task 13.5 — file-backed log + resume", () => {
  let workdir: string;
  let baseDir: string;
  let manifestPath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-resume-"));
    baseDir = join(workdir, "runs");
    manifestPath = await writeManifest(workdir);
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("startRun writes a run_id-keyed log whose latest snapshot reconstructs the checkpoint", async () => {
    // 3 visits: orch -> worker, worker -> orch, orch -> end.
    const handle = await startRun(manifestPath, {
      goal: "do the thing",
      baseDir,
      hostFactory: ({ runId, log }) =>
        new StubHost({
          runId,
          log,
          steps: [
            { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
            { kind: "emit_handoff", target_role: "orchestrator", reason: "worker done" },
            { kind: "emit_end", reason: "all done" },
          ],
          // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-resume-"),
        }),
    });

    const result = await handle.completion();
    expect(result.exitReason).toBe("done");

    // The log file exists.
    const log = new FileRecordLog({ baseDir });
    expect(log.listRunIds()).toContain(handle.runId);

    // The latest snapshot reconstructs to the in-memory final
    // checkpoint (bit-for-bit: same run_id, same current_role,
    // same visit_count, same manifest_version).
    const reconstructed = log.latestCheckpoint(handle.runId);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed?.run_id).toBe(result.finalCheckpoint.run_id);
    expect(reconstructed?.current_role).toBe(result.finalCheckpoint.current_role);
    expect(reconstructed?.visit_count).toEqual(result.finalCheckpoint.visit_count);
    expect(reconstructed?.manifest_version).toBe(result.finalCheckpoint.manifest_version);
    expect(reconstructed?.active_role_session).toBeNull();
  });

  it("resumeRun after a mid-worker-session crash reaches the same terminal state as a non-killed run", async () => {
    // Step 1: start a run and KILL it mid-worker-session (drop the
    // in-memory handle before completion). The worker has a
    // session_started record but no terminal.
    //
    // Implementation: start the run, but kill it BEFORE the loop
    // gets to the worker. We can't truly drop a `runLoop` mid-
    // execution — instead we simulate the crash by:
    //   - Building the start manually: persist the initial snapshot,
    //     session_started for orchestrator, transition_accepted,
    //     checkpoint_snapshot, session_ended for orchestrator,
    //     session_started for worker (with no terminal).
    //   - Then resumeRun picks up from current_role=worker and
    //     reconciles.
    //
    // For determinism, drive the loop manually to the right point
    // by stubbing the host to crash after one handoff.

    const killedLog = new FileRecordLog({ baseDir });

    // Manual write of "crashed state" records.
    const initialCheckpoint = createInitialCheckpoint(makeDef());
    const initialSnapshot: CheckpointSnapshot = {
      type: "checkpoint_snapshot",
      checkpoint: initialCheckpoint,
    };
    killedLog.append(initialSnapshot);

    // Orchestrator session_started + handoff + session_ended.
    const orchId = "orch-session-1";
    const orchSessionFile = "/tmp/orch-1.jsonl";
    killedLog.append({
      type: "session_started",
      run_id: initialCheckpoint.run_id,
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: null,
      session_file: orchSessionFile,
      parent_session: null,
      ts: 1,
    });
    killedLog.append({
      type: "transition_accepted",
      run_id: initialCheckpoint.run_id,
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
      session_file: orchSessionFile,
      ts: 2,
    } as TransitionAccepted);
    killedLog.append({
      type: "checkpoint_snapshot",
      checkpoint: {
        ...initialCheckpoint,
        current_role: "worker",
        visit_count: { worker: 1 },
        updated_at: 3,
      },
    });
    killedLog.append({
      type: "session_ended",
      run_id: initialCheckpoint.run_id,
      role: "orchestrator",
      visit_index: 1,
      state: "worker",
      model: null,
      session_file: orchSessionFile,
      parent_session: null,
      usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
      ts: 4,
    });

    // Worker session_started (NO terminal — the crash point).
    const workerSessionFile = "/tmp/worker-killed.jsonl";
    const workerId = "worker-session-killed";
    killedLog.append({
      type: "session_started",
      run_id: initialCheckpoint.run_id,
      role: "worker",
      visit_index: 1,
      state: "worker",
      model: null,
      session_file: workerSessionFile,
      parent_session: orchId,
      ts: 5,
    });
    // Per §11.1, every reducer call produces a snapshot. The
    // post-session_started snapshot here is what resumeRun's
    // crash detector reads — without it, the latest snapshot
    // would still be the post-orch-session-ended (active=null)
    // snapshot and the crash would go undetected.
    killedLog.append({
      type: "checkpoint_snapshot",
      checkpoint: {
        ...initialCheckpoint,
        current_role: "worker",
        visit_count: { worker: 1 },
        end_request: null,
        active_role_session: {
          id: workerId,
          role: "worker",
          session_file: workerSessionFile,
        },
        updated_at: 6,
      },
    });

    // Latest snapshot has active_role_session set to the worker
    // session that never produced a terminal.
    const latestBeforeResume = killedLog.latestCheckpoint(initialCheckpoint.run_id);
    expect(latestBeforeResume?.active_role_session).toEqual({
      id: workerId,
      role: "worker",
      session_file: workerSessionFile,
    });

    // Step 2: resumeRun. The reconciler should record
    // session_failed("crashed") for the worker, then drive the rest
    // of the run to completion (worker -> orchestrator -> end).
    let resumedWorkerOptions: unknown;
    const resumedHandle = await resumeRun(manifestPath, initialCheckpoint.run_id, {
      goal: "do the thing",
      baseDir,
      hostFactory: ({ runId, log }) => {
        const host = new StubHost({
          runId,
          log,
          // Script provides emissions for the NEW worker session
          // (after the crash) + the orchestrator's second visit.
          // The killed worker session did not consume a step
          // because the loop never reached `prompt()` for it.
          steps: [
            { kind: "emit_handoff", target_role: "orchestrator", reason: "worker resumed" },
            { kind: "emit_end", reason: "all done" },
          ],
          // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-resume-"),
        });
        const originalSpawn = host.spawnRole.bind(host);
        host.spawnRole = async (role, options) => {
          if (role === "worker") resumedWorkerOptions = options;
          return originalSpawn(role, options);
        };
        return host;
      },
    });

    const result = await resumedHandle.completion();
    expect(result.exitReason).toBe("done");
    expect(result.finalCheckpoint.current_role).toBe("done");
    expect(result.finalCheckpoint.active_role_session).toBeNull();

    // Verify the reconciler recorded session_failed("crashed") for
    // the killed worker session.
    const records = killedLog.records(initialCheckpoint.run_id);
    const crashed = records.find(
      (r): r is SessionLifecycleEvent =>
        r.type === "session_failed" && r.session_file === workerSessionFile,
    );
    expect(crashed).toBeDefined();
    expect(crashed?.failure_reason).toBe("crashed");
    expect(crashed?.role).toBe("worker");

    // The resumed run produced a fresh worker session_started
    // (different session_file than the crashed one).
    const workerStarts = records.filter(
      (r): r is SessionLifecycleEvent => r.type === "session_started" && r.role === "worker",
    );
    expect(workerStarts.length).toBeGreaterThanOrEqual(2);
    const newWorker = workerStarts.find((s) => s.session_file !== workerSessionFile);
    expect(newWorker).toBeDefined();
    // The handoff predates the context_ref field, so resume derives the
    // trusted predecessor pointer from the older role/session fields.
    expect(resumedWorkerOptions).toMatchObject({
      handoffContextRef: {
        run_id: initialCheckpoint.run_id,
        source_role: "orchestrator",
        source_session_file: orchSessionFile,
      },
    });
  });

  it("resumeRun with no orphaned session is a no-op (no extra session_failed)", async () => {
    // Drive a complete run via startRun, then resumeRun with the
    // same run_id. The reconciler should find a terminal for every
    // session_started (no orphans) and not write extra records.
    const handle = await startRun(manifestPath, {
      goal: "do the thing",
      baseDir,
      hostFactory: ({ runId, log }) =>
        new StubHost({
          runId,
          log,
          steps: [
            { kind: "emit_handoff", target_role: "worker" },
            { kind: "emit_handoff", target_role: "orchestrator" },
            { kind: "emit_end" },
          ],
          // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-resume-"),
        }),
    });
    const first = await handle.completion();
    expect(first.exitReason).toBe("done");

    const recordsBefore = new FileRecordLog({ baseDir }).records(handle.runId);
    const failedBefore = recordsBefore.filter((r) => r.type === "session_failed");
    expect(failedBefore).toHaveLength(0);

    // The latest snapshot has active_role_session === null (clean
    // terminal state). resumeRun's reconciler should detect this
    // and skip crash handling.
    const resumedHandle = await resumeRun(manifestPath, handle.runId, {
      goal: "do the thing",
      baseDir,
      hostFactory: ({ runId, log }) =>
        new StubHost({
          runId,
          log,
          // Resume would re-enter the loop. Since current_role is
          // 'done' the loop terminates immediately (no script
          // consumed).
          steps: [],
          // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-resume-"),
        }),
    });
    const result = await resumedHandle.completion();
    expect(result.exitReason).toBe("done");
    expect(result.finalCheckpoint.current_role).toBe("done");

    // No additional session_failed records were written by the
    // reconciler (the active_role_session was already null).
    const recordsAfter = new FileRecordLog({ baseDir }).records(handle.runId);
    const failedAfter = recordsAfter.filter((r) => r.type === "session_failed");
    expect(failedAfter).toHaveLength(0);
  });

  it("resume emits recovered child cancellation once and does not duplicate it", async () => {
    const checkpoint = {
      ...createInitialCheckpoint(makeDef()),
      current_role: "done" as const,
    };
    const log = new FileRecordLog({ baseDir });
    log.append({ type: "checkpoint_snapshot", checkpoint });
    log.append({
      type: "subagent_started",
      run_id: checkpoint.run_id,
      child_id: "child-1",
      task_id: "task-1",
      subagent: "implementer",
      model: "stub:model",
      session_file: "child.jsonl",
      worktree_path: "/tmp/child-worktree",
      branch: "conductor/run/child-1",
      base_commit: "base",
      ts: 1,
    });

    const seen: PersistedRecord[] = [];
    const unsubscribe = subscribeToRecords((record) => {
      if (record.type === "subagent_failed") seen.push(record);
    });
    try {
      const hostFactory = ({ runId, log: resumedLog, loadedManifest }: HostFactoryContext) =>
        new StubHost({
          runId,
          log: resumedLog,
          loadedManifest,
          steps: [],
          // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-resume-"),
        });
      const first = await resumeRun(manifestPath, checkpoint.run_id, {
        goal: "",
        baseDir,
        hostFactory,
      });
      await first.completion();
      const second = await resumeRun(manifestPath, checkpoint.run_id, {
        goal: "",
        baseDir,
        hostFactory,
      });
      await second.completion();
    } finally {
      unsubscribe();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "subagent_failed",
      child_id: "child-1",
      status: "cancelled",
      failure_reason: "recovered_child_lost",
    });
  });

  it("resume preserves a pending end request and lets the orchestrator consume it", async () => {
    await writeFile(manifestPath, GATED_MANIFEST_YAML, "utf8");
    const def: MachineDefinition = {
      ...makeDef(),
      end_request_roles: ["worker"],
    };
    const checkpoint = {
      ...createInitialCheckpoint(def),
      end_request: { role: "worker", session_file: "/tmp/worker-review.jsonl" },
    };
    const log = new FileRecordLog({ baseDir });
    log.append({ type: "checkpoint_snapshot", checkpoint });
    log.append({
      type: "run_seeded",
      run_id: checkpoint.run_id,
      goal: "finish after worker approval",
      ts: 1,
    });

    const handle = await resumeRun(manifestPath, checkpoint.run_id, {
      goal: "",
      baseDir,
      hostFactory: ({ runId, log: resumedLog, loadedManifest }) =>
        new StubHost({
          runId,
          log: resumedLog,
          loadedManifest,
          steps: [{ kind: "emit_end", reason: "approved" }],
          // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-resume-"),
        }),
    });
    const result = await handle.completion();

    expect(result.exitReason).toBe("done");
    expect(result.finalCheckpoint.end_request).toBeNull();
    const end = new FileRecordLog({ baseDir })
      .records(checkpoint.run_id)
      .find(
        (record): record is TransitionAccepted =>
          record.type === "transition_accepted" && record.event === "end",
      );
    expect(end?.end_requested_by).toBe("worker");
    expect(end?.end_authority).toBe("role");
  });

  it("listRuns enumerates the runs in a baseDir", async () => {
    // Run 1: complete run.
    const handle1 = await startRun(manifestPath, {
      goal: "run 1",
      baseDir,
      hostFactory: ({ runId, log }) =>
        new StubHost({
          runId,
          log,
          steps: [{ kind: "emit_end" }],
          // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-resume-"),
        }),
    });
    await handle1.completion();

    // listRuns should now have at least one entry.
    expect(listRuns(baseDir)).toContain(handle1.runId);

    // Run 2: another complete run.
    const handle2 = await startRun(manifestPath, {
      goal: "run 2",
      baseDir,
      hostFactory: ({ runId, log }) =>
        new StubHost({
          runId,
          log,
          steps: [{ kind: "emit_end" }],
          // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-resume-"),
        }),
    });
    await handle2.completion();

    const all = listRuns(baseDir);
    expect(all).toContain(handle1.runId);
    expect(all).toContain(handle2.runId);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("RunHandle.runStats reflects persisted records + final checkpoint", async () => {
    const handle = await startRun(manifestPath, {
      goal: "stats test",
      baseDir,
      hostFactory: ({ runId, log }) =>
        new StubHost({
          runId,
          log,
          steps: [{ kind: "emit_end" }],
          // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
          agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-resume-"),
        }),
    });
    const result = await handle.completion();
    expect(result.exitReason).toBe("done");

    const stats = handle.runStats();
    expect(stats.runId).toBe(handle.runId);
    expect(stats.exitReason).toBe("done");
    expect(stats.latestCheckpoint?.current_role).toBe("done");
    expect(stats.recordsCount).toBeGreaterThan(0);
  });

  // ─── Issue #68 remediation ────────────────────────────────────────────
  // Recreated StubHost on the same run/log must continue the durable
  // `role_turn` sequence with a fresh per-invocation logical id rather than
  // reusing the prior logical id (which the fail-closed producer would reject).

  const TEXT = "first durable turn";
  const encoder = new TextEncoder();
  const expectedTextBlock = (text: string) => ({
    kind: "text" as const,
    text,
    original_utf8_bytes: encoder.encode(text).byteLength,
    original_characters: Array.from(text).length,
    truncated: false,
    truncated_by: [] as const,
  });

  it("recreated StubHost on the same run/log continues the role_turn sequence with a fresh logical id", async () => {
    const runId = "run-recreate-stub";
    const log = new InMemoryRecordLog();

    // Host A: first logical invocation writes the first durable role_turn (seq 1).
    const hostA = new StubHost({
      runId,
      log,
      steps: [{ kind: "emit_text", text: TEXT }],
      // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-resume-"),
    });
    const sessionA = await hostA.spawnRole("worker");
    await sessionA.prompt("do work");

    // Host B: a fresh host recreated on the SAME run/log simulates resume.
    const hostB = new StubHost({
      runId,
      log,
      steps: [{ kind: "emit_text", text: "second durable turn" }],
      // Issue #70: keep the SDK extension runner out of the developer's real agent dir.
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-stub-host-resume-"),
    });
    const sessionB = await hostB.spawnRole("worker");
    await sessionB.prompt("do work");

    const roleTurns = log.records(runId).filter((r): r is RoleTurnRecord => r.type === "role_turn");

    // Two distinct durable role_turn records, continuous run-scoped sequence [1,2].
    expect(roleTurns.map((r) => r.sequence)).toEqual([1, 2]);

    // Fresh per-invocation logical identity — the recreated host did NOT reuse
    // A's logical role_session_id (the prior counter-reset bug), so the
    // fail-closed producer accepted the continuation instead of rejecting it.
    const logicalIds = roleTurns.map((r) => r.role_session_id);
    expect(new Set(logicalIds).size).toBe(2);

    // No duplication: exactly one record per captured assistant message.
    expect(roleTurns).toHaveLength(2);

    // Fully-resolved default limits, identical across both records (spec §5.1).
    const limits = roleTurns[0]?.capture.limits;
    expect(limits).toEqual(roleTurns[1]?.capture.limits);
    expect(limits?.max_block_utf8_bytes).toBe(8192);
    expect(limits?.max_turn_utf8_bytes).toBe(32768);
    expect(limits?.max_turn_blocks).toBe(64);
    expect(limits?.max_session_utf8_bytes).toBe(262144);
    expect(limits?.max_session_turns).toBe(128);
    expect(limits?.max_run_utf8_bytes).toBe(1048576);
    expect(limits?.max_run_turns).toBe(512);

    // Each record retains only its own message's readable text block, with
    // precise original measures and no truncation (spec §4.1 / §5.2).
    const blocksA = roleTurns[0]?.blocks;
    const blocksB = roleTurns[1]?.blocks;
    expect(blocksA).toEqual([expectedTextBlock(TEXT)]);
    expect(blocksB).toEqual([expectedTextBlock("second durable turn")]);
    expect(roleTurns[0]?.conversation_id).toBeDefined();
    expect(roleTurns[1]?.conversation_id).toBeDefined();
  });
});
