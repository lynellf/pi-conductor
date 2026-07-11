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
  listRuns,
  type MachineDefinition,
  resumeRun,
  type SessionLifecycleEvent,
  startRun,
  type TransitionAccepted,
} from "../../src/index.js";

// ─── Helpers ───────────────────────────────────────────────────────────

function makeDef(): MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze(["worker"]),
    max_visits: Object.freeze({ worker: 3 }),
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
});
