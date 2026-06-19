/**
 * Task 18 fallback tests — spec §8.2, §9.4.
 *
 * Covers Task 18's acceptance criteria:
 *  - A failing primary model (stub configured to fail) falls through
 *    to the fallback and completes.
 *  - Exhausting the model list hands back to the orchestrator exactly
 *    once (synthesized handoff with `role_unavailable` payload).
 *  - Re-dispatching the same role after exhaustion escalates
 *    (`RoleEscalationError` thrown by the host; `runLoop` propagates).
 *
 * The host is `StubHost` (Task 16/17, extended in Task 18). The
 * manifest is built via `loadManifestFromString` so the host's
 * `models[]` lookup (Task 18) has real entries to read.
 */

import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/host/loop.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import {
  type LoadedManifest,
  type MachineDefinition,
  type ModelFallback,
  type SessionLifecycleEvent,
  StubHost,
  type TransitionAccepted,
} from "../../src/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a loaded manifest with the given orchestrator + worker configs.
 * The worker gets `models[]` for fallback testing.
 */
function makeLoadedManifest(opts: {
  workerModels: readonly string[];
  workerMaxVisits?: number;
}): LoadedManifest {
  const workerMaxVisits = opts.workerMaxVisits ?? 3;
  const yaml = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: worker
    max_visits: ${workerMaxVisits}
    models: [${opts.workerModels.map((m) => `"${m}"`).join(", ")}]
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
`;
  return loadManifestFromString(yaml);
}

// ─── Test 1: primary fails, fallback succeeds ───────────────────────

describe("Model fallback (§8.2) — primary fails, fallback succeeds", () => {
  it("records model_fallback, retries with the next model, and completes the run", async () => {
    // Steps consumed in order across all sessions:
    //   [0] orchestrator visit 1 → emit_handoff to worker
    //   [1] worker visit 1 (primary model) → fail
    //   [2] worker visit 1 (fallback model) → emit_handoff to orch
    //   [3] orchestrator visit 2 → emit_end
    const loaded = makeLoadedManifest({
      workerModels: ["stub:primary", "stub:fallback"],
    });
    const { createInitialCheckpoint, InMemoryRecordLog } = await import("../../src/index.js");
    const initialCheckpoint = createInitialCheckpoint(loaded.def);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [
        { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
        { kind: "fail", errorMessage: "primary model errored" },
        { kind: "emit_handoff", target_role: "orchestrator", reason: "worker done" },
        { kind: "emit_end", reason: "all done" },
      ],
    });

    const result = await runLoop({
      def: loaded.def as MachineDefinition,
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });

    expect(result.exitReason).toBe("done");
    expect(result.finalCheckpoint.current_role).toBe("done");

    // Records: model_fallback records the primary→fallback transition.
    const records = log.records(initialCheckpoint.run_id);
    const fallbacks = records.filter((r): r is ModelFallback => r.type === "model_fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.role).toBe("worker");
    expect(fallbacks[0]?.from_model).toBe("stub:primary");
    expect(fallbacks[0]?.to_model).toBe("stub:fallback");
    expect(fallbacks[0]?.reason).toBe("model_error");

    // Both worker sessions share visit_index 1 (model retry is the
    // same visit, different model — nextVisitIndex counts terminals,
    // not session_started).
    const workerSessions = records.filter(
      (r): r is SessionLifecycleEvent =>
        (r.type === "session_started" ||
          r.type === "session_ended" ||
          r.type === "session_failed") &&
        r.role === "worker",
    );
    const workerVisits = new Set(workerSessions.map((s) => s.visit_index));
    expect(workerVisits.size).toBe(1);
    expect(workerVisits.has(1)).toBe(true);

    // The primary session ends with `model_error`; the fallback
    // session ends normally (session_ended).
    const workerFailed = workerSessions.filter(
      (r): r is SessionLifecycleEvent => r.type === "session_failed",
    );
    expect(workerFailed).toHaveLength(1);
    expect(workerFailed[0]?.failure_reason).toBe("model_error");
    expect(workerFailed[0]?.model).toBe("stub:primary");

    const workerEnded = workerSessions.filter(
      (r): r is SessionLifecycleEvent => r.type === "session_ended",
    );
    expect(workerEnded).toHaveLength(1);
    expect(workerEnded[0]?.model).toBe("stub:fallback");

    // 3 transition_accepted: orch→worker, worker→orch, orch→end.
    const accepted = records.filter(
      (r): r is TransitionAccepted => r.type === "transition_accepted",
    );
    expect(accepted).toHaveLength(3);
    expect(accepted[0]?.event).toBe("handoff");
    expect(accepted[0]?.from).toBe("orchestrator");
    expect(accepted[0]?.to).toBe("worker");
    expect(accepted[1]?.event).toBe("handoff");
    expect(accepted[1]?.from).toBe("worker");
    expect(accepted[1]?.to).toBe("orchestrator");
    expect(accepted[2]?.event).toBe("end");
    expect(accepted[2]?.from).toBe("orchestrator");
    expect(accepted[2]?.to).toBe("done");

    // No transition_rejected, no RoleEscalationError.
    expect(records.some((r) => r.type === "transition_rejected")).toBe(false);
  });
});

// ─── Test 2: all models fail (exhaustion) ─────────────────────────────

describe("Model fallback (§9.4) — all models fail, hand to orchestrator once", () => {
  it("synthesizes a handoff to the orchestrator with role_unavailable payload when the model list is exhausted", async () => {
    // Steps:
    //   [0] orchestrator visit 1 → emit_handoff to worker
    //   [1] worker visit 1 (primary) → fail
    //   [2] worker visit 1 (fallback) → fail (exhaustion)
    //   [3] orchestrator visit 2 → emit_end (the orchestrator decides to end)
    const loaded = makeLoadedManifest({
      workerModels: ["stub:primary", "stub:fallback"],
    });
    const { createInitialCheckpoint, InMemoryRecordLog } = await import("../../src/index.js");
    const initialCheckpoint = createInitialCheckpoint(loaded.def);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [
        { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
        { kind: "fail", errorMessage: "primary model errored" },
        { kind: "fail", errorMessage: "fallback model errored" },
        { kind: "emit_end", reason: "role unavailable, ending run" },
      ],
    });

    const result = await runLoop({
      def: loaded.def as MachineDefinition,
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });

    expect(result.exitReason).toBe("done");
    expect(result.finalCheckpoint.current_role).toBe("done");

    const records = log.records(initialCheckpoint.run_id);

    // Exactly 1 model_fallback record (primary→fallback). No
    // model_fallback for the last model's failure (exhaustion is
    // signaled by the synthesized handoff, not a model transition).
    const fallbacks = records.filter((r): r is ModelFallback => r.type === "model_fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.from_model).toBe("stub:primary");
    expect(fallbacks[0]?.to_model).toBe("stub:fallback");

    // 2 session_failed for the worker (primary + fallback), both
    // with `model_error`.
    const workerFailed = records.filter(
      (r): r is SessionLifecycleEvent => r.type === "session_failed" && r.role === "worker",
    );
    expect(workerFailed).toHaveLength(2);
    expect(workerFailed[0]?.model).toBe("stub:primary");
    expect(workerFailed[0]?.failure_reason).toBe("model_error");
    expect(workerFailed[1]?.model).toBe("stub:fallback");
    expect(workerFailed[1]?.failure_reason).toBe("model_error");

    // 3 transition_accepted:
    //   1. orch → worker (handoff)
    //   2. worker → orch (synthesized handoff with role_unavailable payload)
    //   3. orch → end
    // The synthesized handoff carries the sentinel session_file.
    const accepted = records.filter(
      (r): r is TransitionAccepted => r.type === "transition_accepted",
    );
    expect(accepted).toHaveLength(3);
    expect(accepted[0]?.event).toBe("handoff");
    expect(accepted[0]?.from).toBe("orchestrator");
    expect(accepted[0]?.to).toBe("worker");
    expect(accepted[1]?.event).toBe("handoff");
    expect(accepted[1]?.from).toBe("worker");
    expect(accepted[1]?.to).toBe("orchestrator");
    expect(accepted[1]?.session_file).toBe("<synthesized:handoff:role-unavailable>");
    expect(accepted[2]?.event).toBe("end");
    expect(accepted[2]?.from).toBe("orchestrator");
    expect(accepted[2]?.to).toBe("done");

    // 2 session_started for the worker (primary + fallback), both
    // with visit_index 1 (same visit, different model).
    const workerStarted = records.filter(
      (r): r is SessionLifecycleEvent => r.type === "session_started" && r.role === "worker",
    );
    expect(workerStarted).toHaveLength(2);
    expect(workerStarted[0]?.visit_index).toBe(1);
    expect(workerStarted[0]?.model).toBe("stub:primary");
    expect(workerStarted[1]?.visit_index).toBe(1);
    expect(workerStarted[1]?.model).toBe("stub:fallback");

    // No transition_rejected.
    expect(records.some((r) => r.type === "transition_rejected")).toBe(false);
  });
});

// ─── Test 3: orchestrator re-dispatches same role (escalation) ───────

describe("Model fallback (§9.4) — orchestrator re-dispatching the same role escalates", () => {
  it("throws RoleEscalationError when the orchestrator re-dispatches the role that just exhausted its fallback", async () => {
    // Steps:
    //   [0] orchestrator visit 1 → emit_handoff to worker
    //   [1] worker visit 1 (primary, only model) → fail
    //   [2] orchestrator visit 2 → emit_handoff to worker (re-dispatch;
    //       the "one chance" is used, and the orchestrator chose to
    //       route back to the same role)
    // The loop should throw RoleEscalationError when it tries to
    // spawn the worker for visit 2 (host's unavailableRole marker
    // is still set).
    const loaded = makeLoadedManifest({
      workerModels: ["stub:primary"],
    });
    const { createInitialCheckpoint, InMemoryRecordLog } = await import("../../src/index.js");
    const initialCheckpoint = createInitialCheckpoint(loaded.def);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [
        { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
        { kind: "fail", errorMessage: "primary model errored" },
        { kind: "emit_handoff", target_role: "worker", reason: "try again" },
      ],
    });

    await expect(
      runLoop({
        def: loaded.def as MachineDefinition,
        initialCheckpoint,
        host,
        initialGoal: "do the thing",
      }),
    ).rejects.toThrow(/RoleEscalationError/);

    // The run should have: 1 orchestrator visit 1, 1 worker visit 1
    // (failed), 1 synthesized handoff to orchestrator, 1 orchestrator
    // visit 2. The orchestrator's visit 2 emits a handoff to worker,
    // which triggers the escalation on the next spawnRole.
    const records = log.records(initialCheckpoint.run_id);
    const workerFailed = records.filter(
      (r): r is SessionLifecycleEvent => r.type === "session_failed" && r.role === "worker",
    );
    expect(workerFailed).toHaveLength(1);
    expect(workerFailed[0]?.failure_reason).toBe("model_error");

    // The synthesized handoff to orchestrator is recorded.
    const accepted = records.filter(
      (r): r is TransitionAccepted => r.type === "transition_accepted",
    );
    const synthHandoff = accepted.find(
      (r) => r.session_file === "<synthesized:handoff:role-unavailable>",
    );
    expect(synthHandoff).toBeDefined();
    expect(synthHandoff?.from).toBe("worker");
    expect(synthHandoff?.to).toBe("orchestrator");

    // No model_fallback record (only one model in the list; the
    // primary's failure is the exhaustion itself).
    const fallbacks = records.filter((r): r is ModelFallback => r.type === "model_fallback");
    expect(fallbacks).toHaveLength(0);
  });
});
