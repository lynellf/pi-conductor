/**
 * Task 15 orchestration-loop tests — spec §7.2, §11.3, §11.4, §12.1.
 *
 * Covers Task 15's acceptance criteria:
 *   1. `orchestrator → worker → orchestrator` handoffs each spawn a
 *      fresh session seeded with the prior payload.
 *   2. `parent_session` links form the session tree (§11.4).
 *   3. The loop terminates on `end`.
 *   4. A role session that emits zero machine events is recorded as
 *      `session_failed` (`no_emission`), one that emits two as
 *      `session_failed` (`extra_emission`), and one with a
 *      schema-invalid single capture as `session_failed`
 *      (`schema_invalid`) — NONE of these produce a
 *      `transition_rejected`, and `reduce` is not called for any of
 *      them.
 *   5. Only a valid single capture reaches `reduce`.
 *   6. The canonical reducer call order (§12.1) is followed on an
 *      accepted transition: `reduce` first, then `session_ended` for
 *      the prev active session id, then the next session's
 *      `session_started`.
 *   7. On a reducer `rejected` result, persist the
 *      `transition_rejected` record, surface `legal_targets` back
 *      into the same active session, do NOT call terminal lifecycle.
 *
 * Tested against a fake host + scripted session factory (no `pi` CLI,
 * no API keys). Task 16 promotes that into a reusable stub provider
 * for E2E.
 */

import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/host/loop.js";
import {
  type Checkpoint,
  type CheckpointSnapshot,
  createInitialCheckpoint,
  type EmissionCapture,
  type Host,
  InMemoryRecordLog,
  type MachineDefinition,
  type PersistedRecord,
  type Role,
  type RoleSession,
  type SessionLifecycleEvent,
  type SpawnRoleOptions,
  type TransitionAccepted,
  type TransitionRejected,
  type UsageRecord,
} from "../../src/index.js";

// ─── Test fakes ────────────────────────────────────────────────────────

/** A scripted emission the fake session produces on its next `prompt()`. */
type ScriptedEmission =
  | { kind: "emit_handoff"; target_role: string; reason?: string; suggests_next?: string }
  | { kind: "emit_end"; reason?: string }
  /** Emit a handoff that the reducer will reject (illegal target or
   *  guard_failed). Used to drive the §11.3 retry path. */
  | { kind: "emit_illegal_handoff"; target_role: string }
  | { kind: "no_emission" };

/**
 * A scripted role session. Each `prompt()` call consumes the next
 * emission in `script` and pushes it to the capture buffer (the same
 * effect the handoff/end tool wrappers have in production, Task 14).
 * The session's per-call state (capture buffer, sealed flag) lives on
 * the host's SessionSeam in production; here we track it inline since
 * the seam is host-internal.
 */
class FakeSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly role: Role;
  script: ScriptedEmission[];
  captureBuffer: EmissionCapture[] = [];
  sealed = false;
  prompts: string[] = [];
  /** Subscribers for `subscribe()` — exercised in Task 17; here we just
   *  record them so we can assert the loop subscribes once. */
  subscribers: Array<(event: unknown) => void> = [];
  disposed = false;

  constructor(role: Role, sessionId: string, script: ScriptedEmission[]) {
    this.role = role;
    this.sessionId = sessionId;
    this.sessionFile = `/tmp/fake-${sessionId}.jsonl`;
    this.script = script;
  }

  toRoleSession(): RoleSession {
    return {
      role: this.role,
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      model: null,
      readCaptureBuffer: () => Object.freeze([...this.captureBuffer]),
      resetCaptureBuffer: () => {
        this.captureBuffer.length = 0;
      },
      subscribe: (listener) => {
        this.subscribers.push(listener as (event: unknown) => void);
        return () => {
          const i = this.subscribers.indexOf(listener as (event: unknown) => void);
          if (i >= 0) this.subscribers.splice(i, 1);
        };
      },
      prompt: async (text) => {
        this.prompts.push(text);
        const next = this.script.shift();
        if (next === undefined || next.kind === "no_emission") return;
        if (next.kind === "emit_handoff" || next.kind === "emit_illegal_handoff") {
          this.captureBuffer.push({
            toolName: "handoff",
            args: {
              target_role: next.target_role,
              ...(next.kind === "emit_handoff" &&
                next.reason !== undefined && {
                  reason: next.reason,
                }),
              ...(next.kind === "emit_handoff" &&
                next.suggests_next !== undefined && {
                  suggests_next: next.suggests_next,
                }),
            },
          });
          this.sealed = true;
        } else {
          // emit_end
          this.captureBuffer.push({
            toolName: "end",
            args: { ...(next.reason !== undefined && { reason: next.reason }) },
          });
          this.sealed = true;
        }
      },
      dispose: async () => {
        this.disposed = true;
      },
    };
  }
}

/** A scripted host that consumes sessions from a queue. */
class FakeHost implements Host {
  readonly log: InMemoryRecordLog;
  readonly sessionQueue: FakeSession[] = [];
  sessionCounter = 0;
  spawnedSessions: FakeSession[] = [];
  aborted: Array<{ sessionId: string; reason: string }> = [];
  sealed: string[] = [];
  // Captures for assertions about what was called.
  seedRunMemoryCalls: number = 0;

  constructor(runId: string, log: InMemoryRecordLog) {
    this.log = log;
    // Pre-bind runId by stubbing log.records(runId) filter; the
    // fake host uses the runId stored in the initial checkpoint,
    // not the one passed here. We pass runId only for clarity.
    void runId;
  }

  enqueue(session: FakeSession): void {
    this.sessionQueue.push(session);
  }

  async spawnRole(role: Role, _opts: SpawnRoleOptions = {}): Promise<RoleSession> {
    const next = this.sessionQueue.shift();
    if (next === undefined) {
      throw new Error(`scripted session queue exhausted for role '${role}'`);
    }
    this.spawnedSessions.push(next);
    return next.toRoleSession();
  }

  captureUsage(_session: RoleSession): UsageRecord {
    return ZERO_USAGE;
  }

  persistRecord(record: PersistedRecord): void {
    this.log.append(record);
  }

  seedRunMemory(args: {
    checkpoint: Checkpoint;
    def: MachineDefinition;
    goal: string;
    runCostCap: number | null;
  }): unknown {
    this.seedRunMemoryCalls += 1;
    return {
      run_id: "fake-run",
      goal: args.goal,
      current_role: "orchestrator",
      state: "orchestrator",
      visit_history: [],
      run_cost_to_date: 0,
      run_cost_cap: args.runCostCap,
      remaining_budget: args.runCostCap,
      per_role_cost: {},
      next_candidates: [],
    };
  }

  async abortSession(session: RoleSession, reason: string): Promise<void> {
    this.aborted.push({ sessionId: session.sessionId, reason });
  }

  sealSession(session: RoleSession): void {
    this.sealed.push(session.sessionId);
  }

  sessionTerminalReason(_session: RoleSession): null {
    // Loop-test default: no host-driven termination. Loop tests
    // exercise the contract-breach path (no_emission /
    // extra_emission / schema_invalid), not the cap/model_error
    // paths (Task 17 / Task 18). Cost tests cover the latter.
    return null;
  }

  runCostSoFar(): number {
    // Loop-test default: zero. Cost tests assert a non-zero
    // runCostSoFar against a real cap.
    return 0;
  }

  getNextModel(_role: Role, _currentModelIndex: number): string | null {
    // Loop-test default: no next model. Fallback tests (Task 18)
    // override FakeHost to return configured models per role.
    return null;
  }

  nextVisitIndex(role: Role): number {
    // Count session_started records for `role` in the log + 1.
    const startedForRole = this.log
      .records(this.runId())
      .filter((r) => r.type === "session_started" && r.role === role);
    return startedForRole.length + 1;
  }

  private runId(): string {
    // Read the run_id off the latest checkpoint snapshot. If none,
    // fall back to the first session_started record.
    const ckpt = this.log.latestCheckpoint("__loop_probe__");
    void ckpt; // unused; we want the records filtered by run_id

    // Find any record with run_id; they all share one in a single run.
    const records = this.log.listRunIds();
    for (const id of records) {
      const recs = this.log.records(id);
      if (recs.length > 0) return id;
    }
    return "__no_records__";
  }
}

const ZERO_USAGE: UsageRecord = Object.freeze({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
}) as UsageRecord;

// ─── Helpers ───────────────────────────────────────────────────────────

function makeDef(): MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze(["worker"]),
    max_visits: Object.freeze({ worker: 3 }),
  }) as MachineDefinition;
}

function makeRun(initialCheckpoint: Checkpoint, host: FakeHost) {
  return runLoop({
    def: makeDef(),
    initialCheckpoint,
    host,
    initialGoal: "do the thing",
  });
}

// ─── Happy path: orchestrator → worker → orchestrator → end ───────────

describe("runLoop — happy path", () => {
  it("orchestrator → worker → orchestrator → end", async () => {
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    // Visit 1: orchestrator emits handoff → worker.
    host.enqueue(
      new FakeSession("orchestrator", "sess-1", [
        { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
      ]),
    );
    // Visit 1: worker emits handoff → orchestrator.
    host.enqueue(
      new FakeSession("worker", "sess-2", [
        { kind: "emit_handoff", target_role: "orchestrator", reason: "done" },
      ]),
    );
    // Visit 2: orchestrator emits end.
    host.enqueue(
      new FakeSession("orchestrator", "sess-3", [{ kind: "emit_end", reason: "all done" }]),
    );

    const result = await makeRun(initialCheckpoint, host);

    expect(result.exitReason).toBe("done");
    expect(result.finalCheckpoint.current_role).toBe("done");
    expect(result.finalCheckpoint.active_role_session).toBeNull();

    // Visit counts: worker 1 (only visited once).
    expect(result.finalCheckpoint.visit_count.worker).toBe(1);

    // Record shape: 3 × (session_started, transition_accepted,
    // checkpoint_snapshot, session_ended) = 12 records.
    const records = log.records(initialCheckpoint.run_id);
    const byType = records.reduce<Record<string, number>>((acc, r) => {
      acc[r.type] = (acc[r.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType.session_started).toBe(3);
    expect(byType.session_ended).toBe(3);
    expect(byType.transition_accepted).toBe(3);
    // 3 visits × 3 snapshots per visit = 9.
    expect(byType.checkpoint_snapshot).toBe(9);
    expect(byType.session_failed).toBeUndefined();
    expect(byType.transition_rejected).toBeUndefined();
  });

  it("parent_session links form a chain (§11.4)", async () => {
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    host.enqueue(
      new FakeSession("orchestrator", "sess-1", [{ kind: "emit_handoff", target_role: "worker" }]),
    );
    host.enqueue(
      new FakeSession("worker", "sess-2", [{ kind: "emit_handoff", target_role: "orchestrator" }]),
    );
    host.enqueue(new FakeSession("orchestrator", "sess-3", [{ kind: "emit_end" }]));

    await makeRun(initialCheckpoint, host);

    const startedRecords = log
      .records(initialCheckpoint.run_id)
      .filter((r): r is SessionLifecycleEvent => r.type === "session_started");
    expect(startedRecords.map((r) => r.parent_session)).toEqual([
      null, // orchestrator's first visit
      "sess-1", // worker visits orch first
      "sess-2", // orchestrator's second visit
    ]);
  });

  it("visit_index is 1-based and counts session_started records per role", async () => {
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    // Two orchestrator visits (1st and 2nd), one worker visit (1st).
    host.enqueue(
      new FakeSession("orchestrator", "sess-1", [{ kind: "emit_handoff", target_role: "worker" }]),
    );
    host.enqueue(
      new FakeSession("worker", "sess-2", [{ kind: "emit_handoff", target_role: "orchestrator" }]),
    );
    host.enqueue(new FakeSession("orchestrator", "sess-3", [{ kind: "emit_end" }]));

    await makeRun(initialCheckpoint, host);

    const started = log
      .records(initialCheckpoint.run_id)
      .filter((r): r is SessionLifecycleEvent => r.type === "session_started");
    expect(started.map((r) => ({ role: r.role, visit: r.visit_index }))).toEqual([
      { role: "orchestrator", visit: 1 },
      { role: "worker", visit: 1 },
      { role: "orchestrator", visit: 2 },
    ]);
  });
});

// ─── §11.3 contract breach: NO reduce call ────────────────────────────

describe("runLoop — contract breach (§11.3)", () => {
  it("zero captures → session_failed(no_emission), no reduce, no transition_rejected", async () => {
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    host.enqueue(new FakeSession("orchestrator", "sess-1", [{ kind: "no_emission" }]));

    const result = await makeRun(initialCheckpoint, host);

    expect(result.exitReason).toBe("session_failed");
    // active_role_session cleared by session_failed lifecycle.
    expect(result.finalCheckpoint.active_role_session).toBeNull();

    const records = log.records(initialCheckpoint.run_id);
    expect(records.some((r) => r.type === "session_started")).toBe(true);
    const failed = records.find((r): r is SessionLifecycleEvent => r.type === "session_failed");
    expect(failed).toBeDefined();
    expect(failed?.failure_reason).toBe("no_emission");
    expect(failed?.role).toBe("orchestrator");

    // CRITICAL: no transition_rejected record and no checkpoint_snapshot
    // for this session (the reducer was never called).
    expect(records.some((r) => r.type === "transition_rejected")).toBe(false);
    expect(records.some((r) => r.type === "transition_accepted")).toBe(false);
  });

  it("schema-invalid capture → session_failed(schema_invalid), no reduce", async () => {
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    // A schema-invalid capture (missing target_role) is recorded in
    // the buffer the same way Task 14's tool wrapper would do it.
    const sess = new FakeSession("orchestrator", "sess-1", []);
    sess.captureBuffer.push({ toolName: "handoff", args: { reason: "missing target_role" } });
    sess.sealed = false;
    host.enqueue(sess);

    const result = await makeRun(initialCheckpoint, host);

    expect(result.exitReason).toBe("session_failed");

    const records = log.records(initialCheckpoint.run_id);
    const failed = records.find((r): r is SessionLifecycleEvent => r.type === "session_failed");
    expect(failed?.failure_reason).toBe("schema_invalid");
    expect(records.some((r) => r.type === "transition_rejected")).toBe(false);
    expect(records.some((r) => r.type === "transition_accepted")).toBe(false);
  });

  it("extra emission (buffer length > 1) → session_failed(extra_emission), no reduce", async () => {
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    // Two captures pre-populated in the buffer simulate what Task 14's
    // tool wrapper would write if the model emitted twice without the
    // loop intervening. validateEmission reads length > 1 →
    // extra_emission; the loop never calls reduce.
    const sess = new FakeSession("orchestrator", "sess-1", []);
    sess.captureBuffer.push({ toolName: "handoff", args: { target_role: "worker" } });
    sess.captureBuffer.push({ toolName: "end", args: {} });
    sess.sealed = true;
    host.enqueue(sess);

    const result = await makeRun(initialCheckpoint, host);

    expect(result.exitReason).toBe("session_failed");

    const records = log.records(initialCheckpoint.run_id);
    const failed = records.find((r): r is SessionLifecycleEvent => r.type === "session_failed");
    expect(failed?.failure_reason).toBe("extra_emission");
    expect(records.some((r) => r.type === "transition_rejected")).toBe(false);
    expect(records.some((r) => r.type === "transition_accepted")).toBe(false);
  });
});

// ─── Reducer rejection: retry in-session, surface legal_targets ────────

describe("runLoop — reducer rejection (§11.3 retry path)", () => {
  it("worker → orchestrator handoff is legal; orchestrator → worker is legal; verify rejectable path", async () => {
    // To trigger a reducer rejection, we need an illegal transition
    // for the current role. For an orchestrator, illegal transitions
    // include handoff → undeclared-role (illegal_event).
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    // Visit 1: orchestrator emits handoff → undeclared (illegal).
    // Retry: orchestrator emits end (legal).
    const sess1 = new FakeSession("orchestrator", "sess-1", [
      { kind: "emit_illegal_handoff", target_role: "undeclared-role" },
      { kind: "emit_end", reason: "give up" },
    ]);
    host.enqueue(sess1);

    const result = await makeRun(initialCheckpoint, host);

    // Reduce rejected the first attempt; the loop re-prompted; the
    // model emitted end; reduce accepted end → state "done".
    expect(result.exitReason).toBe("done");
    expect(result.finalCheckpoint.current_role).toBe("done");

    const records = log.records(initialCheckpoint.run_id);
    // 1 transition_rejected (the illegal handoff), 1 transition_accepted (end).
    const rejected = records.filter(
      (r): r is TransitionRejected => r.type === "transition_rejected",
    );
    const accepted = records.filter(
      (r): r is TransitionAccepted => r.type === "transition_accepted",
    );
    expect(rejected).toHaveLength(1);
    expect(accepted).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("illegal_event");
    expect(rejected[0]?.legal_targets.handoff).toEqual(["worker"]);
    expect(rejected[0]?.legal_targets.end).toBe(true);
    expect(accepted[0]?.event).toBe("end");

    // The session was prompted twice (once with the goal, once with the
    // rejection message surfacing legal_targets).
    expect(sess1.prompts).toHaveLength(2);
    expect(sess1.prompts[0]).toContain("do the thing");
    expect(sess1.prompts[1]).toContain("Legal targets");
    expect(sess1.prompts[1]).toContain("worker");

    // No session_failed was recorded — the retry path succeeded.
    expect(records.some((r) => r.type === "session_failed")).toBe(false);
  });

  it("reducer-rejected retry that breaches: persist transition_rejected AND session_failed", async () => {
    // After a rejected handoff, the loop re-prompts. If the model
    // emits nothing on the retry (no_emission), the loop records
    // session_failed(no_emission) and terminates.
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    const sess1 = new FakeSession("orchestrator", "sess-1", [
      { kind: "emit_illegal_handoff", target_role: "undeclared-role" },
      { kind: "no_emission" },
    ]);
    host.enqueue(sess1);

    const result = await makeRun(initialCheckpoint, host);

    expect(result.exitReason).toBe("session_failed");

    const records = log.records(initialCheckpoint.run_id);
    // 1 transition_rejected (the original illegal handoff),
    // 1 session_failed (no_emission on retry).
    expect(records.some((r): r is TransitionRejected => r.type === "transition_rejected")).toBe(
      true,
    );
    const failed = records.find((r): r is SessionLifecycleEvent => r.type === "session_failed");
    expect(failed?.failure_reason).toBe("no_emission");
  });

  it("a reducer-rejected transition does NOT fire session_ended (session continues)", async () => {
    // The retry path keeps the session alive: session_started is the
    // only lifecycle record before the transition_rejected; no
    // session_ended until the accepted transition (or session_failed).
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    const sess1 = new FakeSession("orchestrator", "sess-1", [
      { kind: "emit_illegal_handoff", target_role: "undeclared-role" },
      { kind: "emit_end" },
    ]);
    host.enqueue(sess1);

    await makeRun(initialCheckpoint, host);

    const records = log.records(initialCheckpoint.run_id);
    const order = records.map((r) => r.type);
    // The order should be: session_started, checkpoint_snapshot
    // (post-session_started), transition_rejected (rejected),
    // transition_accepted (accepted on retry), checkpoint_snapshot
    // (post-reduce), session_ended, checkpoint_snapshot
    // (post-session-ended).
    expect(order).toEqual([
      "session_started",
      "checkpoint_snapshot",
      "transition_rejected",
      "transition_accepted",
      "checkpoint_snapshot",
      "session_ended",
      "checkpoint_snapshot",
    ]);
  });
});

// ─── Canonical reducer call order (§12.1) ──────────────────────────────

describe("runLoop — canonical reducer call order (§12.1)", () => {
  it("accepted handoff: reduce → checkpoint_snapshot → session_ended(prev) → session_started(next)", async () => {
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    host.enqueue(
      new FakeSession("orchestrator", "sess-1", [{ kind: "emit_handoff", target_role: "worker" }]),
    );
    host.enqueue(
      new FakeSession("worker", "sess-2", [{ kind: "emit_handoff", target_role: "orchestrator" }]),
    );
    host.enqueue(new FakeSession("orchestrator", "sess-3", [{ kind: "emit_end" }]));

    await makeRun(initialCheckpoint, host);

    const records = log.records(initialCheckpoint.run_id);
    const order = records.map((r) => r.type);

    // Per §11.1 "each transition produces a snapshot", the loop
    // persists a checkpoint_snapshot after every reducer call
    // (session_started, reduce, session_ended). Per visit the order is:
    //   session_started, checkpoint_snapshot (active set),
    //   transition_accepted, checkpoint_snapshot (current advanced),
    //   session_ended, checkpoint_snapshot (active cleared).
    // 3 visits × 6 records each = 18 records.
    expect(order).toEqual([
      "session_started",
      "checkpoint_snapshot",
      "transition_accepted",
      "checkpoint_snapshot",
      "session_ended",
      "checkpoint_snapshot",
      "session_started",
      "checkpoint_snapshot",
      "transition_accepted",
      "checkpoint_snapshot",
      "session_ended",
      "checkpoint_snapshot",
      "session_started",
      "checkpoint_snapshot",
      "transition_accepted",
      "checkpoint_snapshot",
      "session_ended",
      "checkpoint_snapshot",
    ]);
  });

  it("checkpoint_snapshot.checkpoint.current_role reflects the post-transition state", async () => {
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    host.enqueue(
      new FakeSession("orchestrator", "sess-1", [{ kind: "emit_handoff", target_role: "worker" }]),
    );
    host.enqueue(
      new FakeSession("worker", "sess-2", [{ kind: "emit_handoff", target_role: "orchestrator" }]),
    );
    host.enqueue(new FakeSession("orchestrator", "sess-3", [{ kind: "emit_end" }]));

    await makeRun(initialCheckpoint, host);

    const snapshots = log
      .records(initialCheckpoint.run_id)
      .filter((r): r is CheckpointSnapshot => r.type === "checkpoint_snapshot");
    // 3 visits × 3 snapshots per visit (post-session_started,
    // post-reduce, post-session-ended) = 9.
    expect(snapshots).toHaveLength(9);
    // Snapshot at indices [1, 4, 7] are the post-reduce snapshots
    // (current_role advanced to the next role).
    expect(snapshots[1]?.checkpoint.current_role).toBe("worker");
    expect(snapshots[4]?.checkpoint.current_role).toBe("orchestrator");
    expect(snapshots[7]?.checkpoint.current_role).toBe("done");
    // Snapshot at indices [2, 5, 8] are the post-session-ended
    // snapshots (active_role_session cleared).
    expect(snapshots[2]?.checkpoint.active_role_session).toBeNull();
    expect(snapshots[5]?.checkpoint.active_role_session).toBeNull();
    expect(snapshots[8]?.checkpoint.active_role_session).toBeNull();
  });
});

// ─── Session seal / abort hooks (Task 15.5 / 18 contracts) ────────────

// ─── Session disposal: §12.1 lifecycle step 7 ────────────────────────

// `runLoop` must call `session.dispose()` exactly once per spawned
// session, on every terminal path (accepted / failed / done / run-cap
// early return / thrown invariant). Without it, each session's runtime,
// listeners, and file handles persist until the Vitest worker exits —
// the dominant memory-pressure driver observed during Phase 5.
// `FakeSession.disposed` is the regression sentinel.
describe("runLoop — session disposal (§12.1 step 7)", () => {
  it("disposes every spawned session on the happy path", async () => {
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    host.enqueue(
      new FakeSession("orchestrator", "sess-1", [{ kind: "emit_handoff", target_role: "worker" }]),
    );
    host.enqueue(
      new FakeSession("worker", "sess-2", [{ kind: "emit_handoff", target_role: "orchestrator" }]),
    );
    host.enqueue(new FakeSession("orchestrator", "sess-3", [{ kind: "emit_end" }]));

    await makeRun(initialCheckpoint, host);

    expect(host.spawnedSessions).toHaveLength(3);
    expect(host.spawnedSessions.every((s) => s.disposed)).toBe(true);
  });

  it("disposes the session on a session_failed (no_emission) path", async () => {
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    host.enqueue(new FakeSession("orchestrator", "sess-1", [{ kind: "no_emission" }]));

    const result = await makeRun(initialCheckpoint, host);

    expect(result.exitReason).toBe("session_failed");
    expect(host.spawnedSessions).toHaveLength(1);
    expect(host.spawnedSessions[0]?.disposed).toBe(true);
  });

  it("does NOT dispose mid-retry; disposes once after an accepted end", async () => {
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    host.enqueue(
      new FakeSession("orchestrator", "sess-1", [
        { kind: "emit_illegal_handoff", target_role: "undeclared-role" },
        { kind: "emit_end" },
      ]),
    );

    const result = await makeRun(initialCheckpoint, host);

    expect(result.exitReason).toBe("done");
    expect(host.spawnedSessions).toHaveLength(1);
    // The retry path kept the session alive across two prompts; disposal
    // happens once, after the accepted end — not between prompts.
    expect(host.spawnedSessions[0]?.disposed).toBe(true);
    expect(host.spawnedSessions[0]?.prompts).toHaveLength(2);
  });

  it("disposes the session when a reducer-rejected retry breaches", async () => {
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    host.enqueue(
      new FakeSession("orchestrator", "sess-1", [
        { kind: "emit_illegal_handoff", target_role: "undeclared-role" },
        { kind: "no_emission" },
      ]),
    );

    const result = await makeRun(initialCheckpoint, host);

    expect(result.exitReason).toBe("session_failed");
    expect(host.spawnedSessions).toHaveLength(1);
    expect(host.spawnedSessions[0]?.disposed).toBe(true);
  });
});

describe("runLoop — host hook usage", () => {
  it("does not call sealSession or abortSession on the happy path", async () => {
    // The loop never directly calls sealSession (Task 15.5's wrapper
    // does, via the tool wrapper); it doesn't call abortSession either
    // unless a cost cap fires (Task 17/18).
    const log = new InMemoryRecordLog();
    const host = new FakeHost("run-1", log);
    const initialCheckpoint = createInitialCheckpoint(makeDef());

    host.enqueue(
      new FakeSession("orchestrator", "sess-1", [{ kind: "emit_handoff", target_role: "worker" }]),
    );
    host.enqueue(
      new FakeSession("worker", "sess-2", [{ kind: "emit_handoff", target_role: "orchestrator" }]),
    );
    host.enqueue(new FakeSession("orchestrator", "sess-3", [{ kind: "emit_end" }]));

    await makeRun(initialCheckpoint, host);

    expect(host.sealed).toEqual([]);
    expect(host.aborted).toEqual([]);
  });
});
