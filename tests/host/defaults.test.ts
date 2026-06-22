/**
 * Task 20 default v1 role bundle tests — spec §6, §15.4, §15.5.
 *
 * Covers Task 20's acceptance criteria:
 *  - The shipped default manifest (fixture) validates with the
 *    Phase 1 manifest checks — no hard errors, no soft warnings.
 *  - The linear `orchestrator → worker → orchestrator → end` run
 *    passes using the default bundle (proves the shipped default
 *    path, not only hand-built test objects).
 *  - The remediation loop revisits the worker until `max_visits`
 *    forces the orchestrator to end (the visit cap is enforced
 *    on the default bundle's `max_visits: 3`).
 *
 * The bundle is a **scaffold / template**, not implicit reducer
 * state: a real run still requires exactly one declared
 * `is_orchestrator: true` role. Missing orchestrator remains a
 * manifest error. The default's behavior comes from the YAML +
 * role prompts, not from implicit defaults in the reducer.
 *
 * `src/host/defaults.ts` reads the fixture files and exposes them
 * as strings. The test uses `loadManifestFromString` to parse the
 * default YAML, then runs the loop via `StubHost` + the stub
 * provider.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  getDefaultBundle,
  getDefaultConductorYaml,
  getDefaultOrchestratorPrompt,
  getDefaultWorkerPrompt,
} from "../../src/host/defaults.js";
import { runLoop } from "../../src/host/loop.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import {
  type Checkpoint,
  createInitialCheckpoint,
  InMemoryRecordLog,
  type LoadedManifest,
  type MachineDefinition,
  type SessionLifecycleEvent,
  StubHost,
  type TransitionAccepted,
  type TransitionRejected,
} from "../../src/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function hasExitStatus(error: unknown): error is { status: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
  );
}

function gitCheckIgnore(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", path], {
      cwd: REPO_ROOT,
    });
    return true;
  } catch (error: unknown) {
    if (hasExitStatus(error) && error.status === 1) {
      return false;
    }
    throw error;
  }
}

/** Load the default manifest and return the parsed `LoadedManifest`. */
function loadDefaultManifest(): LoadedManifest {
  return loadManifestFromString(getDefaultConductorYaml());
}

// ─── Test 1: default manifest validates with Phase 1 manifest checks ───

describe("Default v1 bundle (§15.4) — manifest validates with Phase 1 checks", () => {
  it("parses without throwing and exposes the expected def shape", () => {
    const loaded = loadDefaultManifest();
    expect(loaded.def.manifest_version).toBe("1");
    expect(loaded.def.orchestrator).toBe("orchestrator");
    expect(loaded.def.workers).toEqual(["worker"]);
    // max_visits is finite per §7.4; the default declares worker: 3.
    expect(loaded.def.max_visits.worker).toBe(3);
    // No hard errors → no warnings expected for a clean default.
    expect(loaded.warnings).toEqual([]);
  });

  it("rejects a manifest with no orchestrator (default is a scaffold, not implicit state)", () => {
    // A real run must declare `is_orchestrator: true`. The
    // default bundle provides one; stripping it must fail the
    // Phase 1 checks. This is the "missing orchestrator remains
    // a manifest error" invariant from Task 20.
    const yaml = `
version: 1
roles:
  - name: worker
    max_visits: 3
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
`;
    expect(() => loadManifestFromString(yaml)).toThrow();
  });

  it("exposes both role system prompts via the bundle helpers", () => {
    const bundle = getDefaultBundle();
    expect(bundle.yaml).toContain("is_orchestrator: true");
    expect(bundle.prompts.orchestrator).toMatch(/# Orchestrator/);
    expect(bundle.prompts.worker).toMatch(/# Worker/);
    // Sanity: the individual accessors return the same content.
    expect(getDefaultOrchestratorPrompt()).toBe(bundle.prompts.orchestrator);
    expect(getDefaultWorkerPrompt()).toBe(bundle.prompts.worker);
  });
});

// ─── Test 1b: default fixture keeps runtime `.pi/` state ignored ───────

describe("Default v1 bundle (§15.4) — fixture is tracked while runtime .pi stays ignored", () => {
  it("unignores the shipped default-conductor fixture but still ignores .pi/settings.json", () => {
    expect(gitCheckIgnore("tests/fixtures/default-conductor/.pi/conductor.yaml")).toBe(false);
    expect(gitCheckIgnore("tests/fixtures/default-conductor/.pi/roles/orchestrator.md")).toBe(
      false,
    );
    expect(gitCheckIgnore("tests/fixtures/default-conductor/.pi/roles/worker.md")).toBe(false);
    expect(gitCheckIgnore(".pi/settings.json")).toBe(true);
  });
});

// ─── Test 2: linear run with the default bundle ───────────────────────

describe("Default v1 bundle (§15.5) — linear orchestrator → worker → orchestrator → end", () => {
  it("completes a linear run using the shipped default manifest", async () => {
    const loaded = loadDefaultManifest();
    const initialCheckpoint: Checkpoint = createInitialCheckpoint(loaded.def as MachineDefinition);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [
        // [0] orchestrator visit 1 — dispatch to the worker.
        { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
        // [1] worker visit 1 — return to the orchestrator.
        { kind: "emit_handoff", target_role: "orchestrator", reason: "done" },
        // [2] orchestrator visit 2 — end the run.
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

    // Records: 2 session_started (orch + worker), 3 session_ended
    // (the orchestrator is visited twice: once to dispatch, once
    // to emit end; the worker is visited once to return).
    // 3 transition_accepted: orch→worker (handoff), worker→orch
    // (handoff), orch→end. No rejected transitions.
    const records = log.records(initialCheckpoint.run_id);
    const ended = records.filter((r): r is SessionLifecycleEvent => r.type === "session_ended");
    expect(ended).toHaveLength(3);

    const started = records.filter((r): r is SessionLifecycleEvent => r.type === "session_started");
    expect(started).toHaveLength(3);

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

    expect(records.some((r) => r.type === "transition_rejected")).toBe(false);
    expect(records.some((r) => r.type === "model_fallback")).toBe(false);
  });
});

// ─── Test 3: remediation loop — max_visits forces the orchestrator to end

describe("Default v1 bundle (§15.5) — remediation loop exhausts max_visits then ends", () => {
  it("revisits the worker until the visit cap forces the orchestrator to emit end", async () => {
    // The default bundle has max_visits: 3. The stub drives 3
    // worker visits, then the orchestrator's 4th handoff is
    // rejected by the visit-cap guard (§7.4), and the orchestrator
    // emits `end` on the next attempt.
    const loaded = loadDefaultManifest();
    const initialCheckpoint: Checkpoint = createInitialCheckpoint(loaded.def as MachineDefinition);
    const log = new InMemoryRecordLog();
    const host = new StubHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: loaded,
      steps: [
        // ── Worker visit 1 ─────────────────────────────────────
        { kind: "emit_handoff", target_role: "worker", reason: "attempt 1" },
        { kind: "emit_handoff", target_role: "orchestrator", reason: "needs more" },
        // ── Worker visit 2 ─────────────────────────────────────
        { kind: "emit_handoff", target_role: "worker", reason: "attempt 2" },
        { kind: "emit_handoff", target_role: "orchestrator", reason: "needs more" },
        // ── Worker visit 3 (last allowed) ──────────────────────
        { kind: "emit_handoff", target_role: "worker", reason: "attempt 3" },
        { kind: "emit_handoff", target_role: "orchestrator", reason: "needs more" },
        // ── Worker visit 4 (rejected by visit cap) ─────────────
        // The orchestrator tries again; the reducer rejects with
        // guard_failed (§7.4). The loop surfaces legal_targets
        // (which excludes worker); the orchestrator emits `end`.
        { kind: "emit_handoff", target_role: "worker", reason: "attempt 4" },
        { kind: "emit_end", reason: "visit cap reached, ending run" },
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

    // 3 worker session_started (visits 1, 2, 3) and 4 orchestrator
    // session_started (visits 1, 2, 3, 4 — the 4th is the rejected
    // handoff's same-session retry after the rejection message).
    // The exact orchestrator visit count depends on the loop's
    // session block: the rejected handoff is in the same session
    // as the previous `end`-retry attempt. Verify the worker
    // count strictly instead.
    const workerStarted = records.filter(
      (r): r is SessionLifecycleEvent => r.type === "session_started" && r.role === "worker",
    );
    expect(workerStarted).toHaveLength(3);

    // 3 worker session_ended (each visit ended with a handoff to
    // orchestrator). No session_failed for the worker.
    const workerEnded = records.filter(
      (r): r is SessionLifecycleEvent => r.type === "session_ended" && r.role === "worker",
    );
    expect(workerEnded).toHaveLength(3);
    expect(records.some((r) => r.type === "session_failed" && r.role === "worker")).toBe(false);

    // 3 transition_accepted for the worker handoffs (orch→worker × 3)
    // plus 3 transition_accepted for the worker→orch handoffs
    // plus 1 transition_accepted for the final orch→end.
    // Plus 1 transition_rejected for the 4th orch→worker attempt.
    const accepted = records.filter(
      (r): r is TransitionAccepted => r.type === "transition_accepted",
    );
    const acceptedHandoffs = accepted.filter((r) => r.event === "handoff");
    expect(acceptedHandoffs).toHaveLength(6);
    // 3 orch→worker accepted, 3 worker→orch accepted.
    const orchToWorker = acceptedHandoffs.filter(
      (r) => r.from === "orchestrator" && r.to === "worker",
    );
    const workerToOrch = acceptedHandoffs.filter(
      (r) => r.from === "worker" && r.to === "orchestrator",
    );
    expect(orchToWorker).toHaveLength(3);
    expect(workerToOrch).toHaveLength(3);

    // 1 rejected handoff (the 4th orch→worker attempt).
    const rejected = records.filter(
      (r): r is TransitionRejected => r.type === "transition_rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.event).toBe("handoff");
    expect(rejected[0]?.role).toBe("orchestrator"); // emitting role
    expect(rejected[0]?.target_role).toBe("worker");
    expect(rejected[0]?.reason).toBe("guard_failed");
    // The legal_targets on the rejection excludes worker and
    // permits end (so the orchestrator can recover by emitting
    // end instead).
    expect(rejected[0]?.legal_targets.handoff).not.toContain("worker");
    expect(rejected[0]?.legal_targets.end).toBe(true);

    // 1 final transition_accepted (orch→end) — accepted after the
    // rejection surfaced legal_targets.
    const endAccepted = accepted.filter(
      (r) => r.event === "end" && r.from === "orchestrator" && r.to === "done",
    );
    expect(endAccepted).toHaveLength(1);

    // No model_fallback records (no model errors in this run).
    expect(records.some((r) => r.type === "model_fallback")).toBe(false);
  });
});
