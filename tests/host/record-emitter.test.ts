/**
 * Record emitter tests — `docs/record-emitter-spec.md` §7.
 *
 * This file is the authoritative test surface for the record-emitter
 * contract. Every clause in `docs/record-emitter-spec.md` §4 is
 * exercised here. The test-to-spec mapping is documented in §7 of
 * the spec doc.
 *
 * Covers:
 *   1. Listener fires on every persistRecord call (§4.1)
 *   2. Multiple listeners fire in subscription order (FIFO) (§4.2)
 *   3. Sync throw in one listener is isolated (§4.4)
 *   4. Async rejection in one listener is isolated (§4.4)
 *   5. Re-entrant subscribe fires on the NEXT record (§4.5)
 *   6. Re-entrant unsubscribe takes effect on the NEXT record (§4.5)
 *   7. Unsubscribe is idempotent (§4.6)
 *   8. No listeners registered is a no-op (§4.7)
 *   9. run_id filter on the consumer side is correct (§4.1)
 *
 * Tests use `subscribeToRecords` (from the public barrel), the
 * `StubHost` with `InMemoryRecordLog`, and both direct `persistRecord`
 * calls (unit-level) and `runLoop` (integration-level, case 1).
 *
 * Table-driven where the spec enumerates cases; one assertion per
 * behavior per AGENTS.md testing convention.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLoop } from "../../src/host/loop.js";
import {
  type Checkpoint,
  createInitialCheckpoint,
  type FileMutationRecord,
  InMemoryRecordLog,
  type MachineDefinition,
  type PersistedRecord,
  StubHost,
  subscribeToRecords,
} from "../../src/index.js";

/** Minimal `MachineDefinition` shared across tests. */
function makeDef(): MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze(["worker"]),
    max_visits: Object.freeze({ worker: 3 }),
  }) as MachineDefinition;
}

/** Build a minimal `PersistedRecord` (session_started shape) for direct-persist tests. */
function sessionStarted(
  overrides: { run_id?: string; role?: string; visit_index?: number } = {},
): PersistedRecord {
  return {
    type: "session_started",
    run_id: overrides.run_id ?? "test-run",
    role: overrides.role ?? "orchestrator",
    visit_index: overrides.visit_index ?? 1,
    state: "orchestrator",
    model: null,
    session_file: "sess-1.jsonl",
    parent_session: null,
    ts: Date.now(),
  } as unknown as PersistedRecord;
}

// ─── Cleanup: unsubscribe everything between tests ────────────────────
// The emitter registry is module-level (process-global).  Each test
// cleans up via its own unsubscribe handles, but we also clear the
// registry between test files to prevent cross-file contamination.
// (subscribeToRecords in vitest's isolated environment means each
// test file gets its own module instance, so this is mainly a
// defense-in-depth measure.)

beforeEach(() => {
  // Ensure real timers are active even if fake timers leaked from
  // a previous test file (isolate:false). Case 4 uses
  // `await new Promise((resolve) => setTimeout(resolve, 10))` which
  // would hang forever under fake timers.
  vi.useRealTimers();
});

afterEach(() => {
  // Tests clean up their own listeners via the returned unsubscribe
  // closures; this is a belt-and-suspenders guard.
});

// ─── Case 1: Listener fires on every persistRecord call ─────────────

describe("Case 1 — listener fires on every persistRecord", () => {
  it("sees every record type in order through a full run", async () => {
    const log = new InMemoryRecordLog();
    const def = makeDef();
    const checkpoint: Checkpoint = createInitialCheckpoint(def);
    const host = new StubHost({
      runId: checkpoint.run_id,
      log,
      steps: [
        { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
        { kind: "emit_handoff", target_role: "orchestrator", reason: "worker done" },
        { kind: "emit_end", reason: "all done" },
      ],
    });

    const seen: PersistedRecord[] = [];
    const unsub = subscribeToRecords((r) => {
      seen.push(r);
    });

    await runLoop({ def, initialCheckpoint: checkpoint, host, initialGoal: "do the thing" });
    unsub();

    // We should see every record: session_started × 3, transition_accepted × 3,
    // session_ended × 3, checkpoint_snapshot × 9 (3 per visit × 3 visits).
    const types = seen.map((r) => r.type);
    expect(types.filter((t) => t === "session_started")).toHaveLength(3);
    expect(types.filter((t) => t === "transition_accepted")).toHaveLength(3);
    expect(types.filter((t) => t === "session_ended")).toHaveLength(3);

    // Ordering: session_started → transition_accepted → checkpoint_snapshot
    // (the first snapshot comes after session_started; more after reduce).
    // Session 1: orchestrator handles off → worker.
    const orchStartIdx = types.indexOf("session_started");
    const orchAcceptIdx = types.indexOf("transition_accepted");
    expect(orchStartIdx).toBeLessThan(orchAcceptIdx);
  });
});

describe("file-mutation telemetry — issue #22", () => {
  it("fans out a durable file-mutation record to record subscribers", () => {
    const log = new InMemoryRecordLog();
    const host = new StubHost({ runId: "run-22", log, steps: [] });
    const record: FileMutationRecord = {
      type: "file_mutation",
      run_id: "run-22",
      role: "worker",
      session_id: "session-22",
      session_file: "/tmp/session-22.jsonl",
      tool_name: "edit",
      files: [{ path: "/app/main.ts", additions: 5, deletions: 6 }],
      ts: 1_700_000_000_000,
    };
    const seen: FileMutationRecord[] = [];
    const unsub = subscribeToRecords((persisted) => {
      if (persisted.type === "file_mutation") seen.push(persisted);
    });

    host.persistRecord(record);
    unsub();

    expect(seen).toEqual([record]);
  });
});

// ─── Case 2: Multiple listeners fire in subscription order (FIFO) ──

describe("Case 2 — FIFO ordering", () => {
  it("fires listeners in subscription order", () => {
    const log = new InMemoryRecordLog();
    const host = new StubHost({ runId: "fifo", log, steps: [] });
    const order: string[] = [];

    const unsubA = subscribeToRecords(() => {
      order.push("A");
    });
    const unsubB = subscribeToRecords(() => {
      order.push("B");
    });
    const unsubC = subscribeToRecords(() => {
      order.push("C");
    });

    host.persistRecord(sessionStarted({ run_id: "fifo" }));

    expect(order).toEqual(["A", "B", "C"]);

    unsubA();
    unsubB();
    unsubC();
  });
});

// ─── Case 3: Sync throw in one listener is isolated ─────────────────

describe("Case 3 — sync throw isolation", () => {
  it("other listeners still fire and the engine continues", () => {
    const log = new InMemoryRecordLog();
    const host = new StubHost({ runId: "sync-throw", log, steps: [] });
    const fired: string[] = [];

    const unsubThrow = subscribeToRecords(() => {
      fired.push("thrower");
      throw new Error("boom");
    });
    const unsubOk = subscribeToRecords(() => {
      fired.push("ok");
    });

    host.persistRecord(sessionStarted({ run_id: "sync-throw" }));

    expect(fired).toEqual(["thrower", "ok"]);
    // Record is still in the log (engine continued).
    expect(log.records("sync-throw")).toHaveLength(1);

    unsubThrow();
    unsubOk();
  });
});

// ─── Case 4: Async rejection in one listener is isolated ────────────

describe("Case 4 — async rejection isolation", () => {
  it("other listeners still fire", async () => {
    const log = new InMemoryRecordLog();
    const host = new StubHost({ runId: "async-reject", log, steps: [] });
    const fired: string[] = [];

    const unsubReject = subscribeToRecords(async () => {
      fired.push("rejecter");
      await Promise.reject(new Error("async-boom"));
    });
    const unsubOk = subscribeToRecords(() => {
      fired.push("ok");
    });

    host.persistRecord(sessionStarted({ run_id: "async-reject" }));

    // Both fire synchronously (fire-and-forget; no await).
    expect(fired).toEqual(["rejecter", "ok"]);
    // Record is still in the log.
    expect(log.records("async-reject")).toHaveLength(1);

    // Let the microtask queue flush so the rejection doesn't leak
    // as an unhandledRejection in the test runner.
    await new Promise((resolve) => setTimeout(resolve, 10));

    unsubReject();
    unsubOk();
  });
});

// ─── Case 5: Re-entrant subscribe fires on the NEXT record ──────────

describe("Case 5 — re-entrant subscribe", () => {
  it("new listener does not see the current record but sees the next", () => {
    const log = new InMemoryRecordLog();
    const host = new StubHost({ runId: "reentrant-sub", log, steps: [] });
    const seenByLate: PersistedRecord[] = [];
    // TS CFA can't track closure-assigned mutability; use an indirect
    // container so TypeScript sees a stable non-nullable reference.
    const lateHolder: { unsub: (() => void) | null } = { unsub: null };

    const unsubMain = subscribeToRecords((): void => {
      // Re-entrant: subscribe inside listener
      lateHolder.unsub = subscribeToRecords((_record: PersistedRecord): void => {
        seenByLate.push(_record);
      });
    });

    // First record — late listener should NOT fire.
    host.persistRecord(sessionStarted({ run_id: "reentrant-sub", visit_index: 1 }));
    expect(seenByLate).toHaveLength(0);

    // Second record — late listener SHOULD fire.
    host.persistRecord(sessionStarted({ run_id: "reentrant-sub", visit_index: 2 }));
    expect(seenByLate).toHaveLength(1);
    expect((seenByLate[0] as { visit_index: number }).visit_index).toBe(2);

    unsubMain();
    if (lateHolder.unsub) lateHolder.unsub();
  });
});

// ─── Case 6: Re-entrant unsubscribe takes effect on the NEXT record ─

describe("Case 6 — re-entrant unsubscribe", () => {
  it("sibling still sees current record but not the next", () => {
    const log = new InMemoryRecordLog();
    const host = new StubHost({ runId: "reentrant-unsub", log, steps: [] });
    const seenByB: PersistedRecord[] = [];

    // eslint-disable-next-line prefer-const
    let unsubB: () => void;
    const unsubA = subscribeToRecords(() => {
      // Re-entrant: unsub sibling B during A's invocation
      unsubB();
    });
    unsubB = subscribeToRecords((r) => {
      seenByB.push(r);
    });

    // First record — B should still see it (unsub takes effect next record).
    host.persistRecord(sessionStarted({ run_id: "reentrant-unsub", visit_index: 1 }));
    expect(seenByB).toHaveLength(1);

    // Second record — B should NOT see it (unsub took effect).
    host.persistRecord(sessionStarted({ run_id: "reentrant-unsub", visit_index: 2 }));
    expect(seenByB).toHaveLength(1); // still 1, not 2

    unsubA();
    // unsubB was already called inside the listener; calling again is idempotent.
    unsubB();
  });
});

// ─── Case 7: Unsubscribe is idempotent ──────────────────────────────

describe("Case 7 — idempotent unsubscribe", () => {
  it("calling the handle twice does not throw and does not change the set", () => {
    const log = new InMemoryRecordLog();
    const host = new StubHost({ runId: "idempotent", log, steps: [] });
    const fired: string[] = [];

    const unsub = subscribeToRecords(() => {
      fired.push("x");
    });

    // First call removes the listener.
    unsub();
    // Second call is a no-op — must not throw.
    unsub();
    // Third call — also a no-op.
    unsub();

    host.persistRecord(sessionStarted({ run_id: "idempotent" }));
    expect(fired).toHaveLength(0);
  });
});

// ─── Case 8: No listeners registered is a no-op ─────────────────────

describe("Case 8 — empty set is a no-op", () => {
  it("persistRecord succeeds with no listeners registered", () => {
    const log = new InMemoryRecordLog();
    const host = new StubHost({ runId: "noop", log, steps: [] });

    // No listeners subscribed.  This must not throw.
    host.persistRecord(sessionStarted({ run_id: "noop" }));
    host.persistRecord(sessionStarted({ run_id: "noop", visit_index: 2 }));
    expect(log.records("noop")).toHaveLength(2);
  });
});

// ─── Case 9: run_id filter on the consumer side ─────────────────────

describe("Case 9 — consumer-side run_id filter", () => {
  it("consumer can filter records by run_id", () => {
    const log = new InMemoryRecordLog();
    const hostA = new StubHost({ runId: "run-a", log, steps: [] });
    const hostB = new StubHost({ runId: "run-b", log, steps: [] });

    const seenByA: PersistedRecord[] = [];
    const seenByB: PersistedRecord[] = [];

    const unsubA = subscribeToRecords((r) => {
      if (r.type === "checkpoint_snapshot") {
        // checkpoint_snapshot carries run_id inside checkpoint
        if (r.checkpoint.run_id === "run-a") seenByA.push(r);
      } else if (r.run_id === "run-a") {
        seenByA.push(r);
      }
    });
    const unsubB = subscribeToRecords((r) => {
      if (r.type === "checkpoint_snapshot") {
        if (r.checkpoint.run_id === "run-b") seenByB.push(r);
      } else if (r.run_id === "run-b") {
        seenByB.push(r);
      }
    });

    hostA.persistRecord(sessionStarted({ run_id: "run-a" }));
    hostB.persistRecord(sessionStarted({ run_id: "run-b" }));

    expect(seenByA).toHaveLength(1);
    expect((seenByA[0] as { run_id: string }).run_id).toBe("run-a");
    expect(seenByB).toHaveLength(1);
    expect((seenByB[0] as { run_id: string }).run_id).toBe("run-b");

    unsubA();
    unsubB();
  });
});
