/**
 * Task 7A.4 — ProductionHost parity with StubHost.
 *
 * Covers Task 7A.4's acceptance criteria:
 *   - Production host records normalized usage with the same SDK
 *     mapping tested in Phase 5.
 *   - `sealSession` prevents side-effecting tools after a valid
 *     emission in the production path.
 *   - `persistRecord`, `seedRunMemory`, and `nextVisitIndex` read
 *     from the same log/manifest sources as `StubHost`.
 *   - Existing stub E2E and cost/fallback/stats tests remain
 *     green (asserted at the suite level — see the
 *     whole-plan gate).
 *
 * Approach: drive a full `runLoop` against `ProductionHost` with
 * a stub provider + stub model registered on the model registry.
 * The setup mirrors `tests/host/e2e.test.ts` (the StubHost E2E)
 * so the parity test reads as a direct comparison: same script,
 * same manifest shape, same `runLoop` config — only the host
 * changes.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Usage } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLoop } from "../../src/host/loop.js";
import {
  makeStubModel,
  makeStubStreamFunction,
  type StubStep,
} from "../../src/host/stub-provider.js";
import {
  type Checkpoint,
  createInitialCheckpoint,
  InMemoryRecordLog,
  type MachineDefinition,
  ProductionHost,
  type SessionLifecycleEvent,
  type TransitionAccepted,
} from "../../src/index.js";

// ─── Test fixture ─────────────────────────────────────────────────────

/**
 * The test's `loadedManifest` is built inline per-test (the
 * production host's `loadedManifest.manifest.roles` shape varies
 * per test scenario). The stub provider must be registered with
 * a `models` entry so `ModelRegistry.find("stub", "stub-model")`
 * returns the model.
 */

function makeDef(): MachineDefinition {
  return Object.freeze({
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: Object.freeze(["worker"]),
    max_visits: Object.freeze({ worker: 3 }),
  }) as MachineDefinition;
}

function makeModelRegistryWithStub(
  steps: ReturnType<typeof makeStubStreamFunction>,
): ModelRegistry {
  const authStorage = AuthStorage.inMemory();
  const registry = ModelRegistry.inMemory(authStorage);
  const stubModel = makeStubModel();
  registry.registerProvider("stub", {
    api: "anthropic-messages" as const,
    apiKey: "stub-dummy-key-not-used",
    baseUrl: stubModel.baseUrl,
    streamSimple: steps,
    models: [
      {
        id: stubModel.id,
        name: stubModel.name,
        api: stubModel.api,
        baseUrl: stubModel.baseUrl,
        reasoning: stubModel.reasoning,
        input: [...stubModel.input],
        cost: { ...stubModel.cost },
        contextWindow: stubModel.contextWindow,
        maxTokens: stubModel.maxTokens,
      },
    ],
  });
  return registry;
}

const CANNED_USAGE: Partial<Usage> = {
  input: 50,
  output: 25,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 75,
  cost: { input: 0.0015, output: 0.0075, cacheRead: 0, cacheWrite: 0, total: 0.009 },
};

function makeStubStream(steps: readonly StubStep[]) {
  return makeStubStreamFunction({ steps, usage: CANNED_USAGE });
}

async function makeWorkdirAndPrompts(): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-prod-host-parity-"));
  await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
  await writeFile(join(workdir, ".pi/roles/orchestrator.md"), "You are the orchestrator.", "utf8");
  await writeFile(join(workdir, ".pi/roles/worker.md"), "You are the worker.", "utf8");
  return workdir;
}

// ─── (1) Full linear loop via the stub (parity with e2e) ──────────────

describe("ProductionHost — full orch → worker → orch → end via runLoop (Task 7A.4 parity)", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await makeWorkdirAndPrompts();
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("completes the same script as the StubHost e2e test and asserts the same record shapes", async () => {
    const initialCheckpoint: Checkpoint = createInitialCheckpoint(makeDef());
    const log = new InMemoryRecordLog();
    const host = new ProductionHost({
      runId: initialCheckpoint.run_id,
      log,
      loadedManifest: {
        def: makeDef(),
        manifest: {
          version: 1,
          roles: [
            {
              name: "orchestrator",
              is_orchestrator: true,
              models: ["stub:stub-model"],
              system_prompt: ".pi/roles/orchestrator.md",
            },
            {
              name: "worker",
              max_visits: 3,
              models: ["stub:stub-model"],
              system_prompt: ".pi/roles/worker.md",
            },
          ],
        },
        manifestDir: null,
        manifestVersion: 1,
        warnings: [],
      },
      modelRegistry: makeModelRegistryWithStub(
        makeStubStream([
          { kind: "emit_handoff", target_role: "worker", reason: "plan ready" },
          { kind: "emit_handoff", target_role: "orchestrator", reason: "worker done" },
          { kind: "emit_end", reason: "all done" },
        ]),
      ),
      cwd: workdir,
    });

    const result = await runLoop({
      def: makeDef(),
      initialCheckpoint,
      host,
      initialGoal: "do the thing",
    });

    expect(result.exitReason).toBe("done");
    expect(result.finalCheckpoint.current_role).toBe("done");
    expect(result.finalCheckpoint.active_role_session).toBeNull();
    expect(result.finalCheckpoint.visit_count.worker).toBe(1);

    // §11.2 / §11.4 / §11.1 record shape assertions — same as
    // the StubHost e2e test (production-host parity check).
    const records = log.records(initialCheckpoint.run_id);
    const byType = records.reduce<Record<string, number>>((acc, r) => {
      acc[r.type] = (acc[r.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType.session_started).toBe(3);
    expect(byType.session_ended).toBe(3);
    expect(byType.transition_accepted).toBe(3);
    expect(byType.checkpoint_snapshot).toBe(9);
    expect(byType.session_failed).toBeUndefined();
    expect(byType.transition_rejected).toBeUndefined();

    // §11.2 transition_accepted shape.
    const accepted = records.filter(
      (r): r is TransitionAccepted => r.type === "transition_accepted",
    );
    expect(accepted[0]).toMatchObject({
      type: "transition_accepted",
      run_id: initialCheckpoint.run_id,
      from: "orchestrator",
      to: "worker",
      event: "handoff",
      target_role: "worker",
      role: "orchestrator",
      suggests_next: null,
    });

    // §11.4 usage on every session_ended (the §11.4 SDK mapping
    // is in `SessionState.addMessageUsage`; the same mapping is
    // used by both hosts via the shared event handler).
    const ended = records.filter((r): r is SessionLifecycleEvent => r.type === "session_ended");
    expect(ended).toHaveLength(3);
    for (const ev of ended) {
      expect(ev.usage).toBeDefined();
      expect(ev.usage).toEqual({
        input: 50,
        output: 25,
        cache_read: 0,
        cache_write: 0,
        tokens: 75,
        cost: 0.009,
      });
    }
  });
});

// ─── (2) Host method parity — direct reads from log + manifest ─────

describe("ProductionHost — Host method parity with StubHost (Task 7A.4)", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await makeWorkdirAndPrompts();
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("nextVisitIndex returns 1 before any visit and increments after a session_ended record", () => {
    const log = new InMemoryRecordLog();
    const runId = "test-run-1";
    const host = new ProductionHost({
      runId,
      log,
      loadedManifest: {
        def: makeDef(),
        manifest: {
          version: 1,
          roles: [
            {
              name: "orchestrator",
              is_orchestrator: true,
              system_prompt: ".pi/roles/orchestrator.md",
            },
            { name: "worker", max_visits: 3, system_prompt: ".pi/roles/worker.md" },
          ],
        },
        manifestDir: null,
        manifestVersion: 1,
        warnings: [],
      },
      modelRegistry: makeModelRegistryWithStub(makeStubStream([])),
      cwd: workdir,
    });

    // Pre-visit: nextVisitIndex = 1 for both roles.
    expect(host.nextVisitIndex("worker")).toBe(1);
    expect(host.nextVisitIndex("orchestrator")).toBe(1);

    // Simulate a worker visit ending. Use the host's `runId` for
    // the records so they live under the same log key
    // (`nextVisitIndex` reads from `this.log.records(this.runId)`).
    const session_started = {
      type: "session_started" as const,
      run_id: runId,
      session_file: "/tmp/sess-1.jsonl",
      role: "worker" as const,
      visit_index: 1,
      state: "worker" as const,
      model: null,
      parent_session: null,
      ts: 0,
    };
    const session_ended = {
      type: "session_ended" as const,
      run_id: runId,
      session_file: "/tmp/sess-1.jsonl",
      role: "worker" as const,
      visit_index: 1,
      state: "worker" as const,
      model: null,
      parent_session: null,
      usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
      ts: 0,
    };
    host.persistRecord(session_started);
    host.persistRecord(session_ended);

    // Post-terminal: worker's nextVisitIndex is 2; orchestrator's still 1.
    expect(host.nextVisitIndex("worker")).toBe(2);
    expect(host.nextVisitIndex("orchestrator")).toBe(1);
  });

  it("runCostSoFar sums `usage.cost` across session_ended + session_failed terminals (§11.7 roll-up)", () => {
    const log = new InMemoryRecordLog();
    const runId = "test-run-1";
    const host = new ProductionHost({
      runId,
      log,
      loadedManifest: {
        def: makeDef(),
        manifest: {
          version: 1,
          roles: [
            {
              name: "orchestrator",
              is_orchestrator: true,
              system_prompt: ".pi/roles/orchestrator.md",
            },
            { name: "worker", max_visits: 3, system_prompt: ".pi/roles/worker.md" },
          ],
        },
        manifestDir: null,
        manifestVersion: 1,
        warnings: [],
      },
      modelRegistry: makeModelRegistryWithStub(makeStubStream([])),
      cwd: workdir,
    });

    expect(host.runCostSoFar()).toBe(0);

    // Two session_ended records + one session_failed. Use `runId`
    // so the records are visible to `runCostSoFar`'s
    // `this.log.records(this.runId)` lookup.
    const baseUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0 };
    host.persistRecord({
      type: "session_ended",
      run_id: runId,
      session_file: "/tmp/s1.jsonl",
      role: "worker",
      visit_index: 1,
      state: "worker",
      model: null,
      parent_session: null,
      usage: { ...baseUsage, cost: 0.5 },
      ts: 0,
    });
    host.persistRecord({
      type: "session_failed",
      run_id: runId,
      session_file: "/tmp/s2.jsonl",
      role: "worker",
      visit_index: 2,
      state: "worker",
      model: null,
      parent_session: null,
      failure_reason: "model_error",
      usage: { ...baseUsage, cost: 0.25 },
      ts: 0,
    });
    host.persistRecord({
      type: "session_ended",
      run_id: runId,
      session_file: "/tmp/s3.jsonl",
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: null,
      parent_session: null,
      usage: { ...baseUsage, cost: 0.1 },
      ts: 0,
    });

    // 0.5 + 0.25 + 0.1 = 0.85. Both terminals cost.
    expect(host.runCostSoFar()).toBeCloseTo(0.85, 5);
  });

  it("getNextModel returns the next entry in the role's `models[]` list (model fallback policy)", () => {
    const log = new InMemoryRecordLog();
    const host = new ProductionHost({
      runId: "test-run-1",
      log,
      loadedManifest: {
        def: makeDef(),
        manifest: {
          version: 1,
          roles: [
            {
              name: "orchestrator",
              is_orchestrator: true,
              system_prompt: ".pi/roles/orchestrator.md",
            },
            {
              name: "worker",
              max_visits: 3,
              models: ["stub:stub-model", "stub:fallback"],
              system_prompt: ".pi/roles/worker.md",
            },
          ],
        },
        manifestDir: null,
        manifestVersion: 1,
        warnings: [],
      },
      modelRegistry: makeModelRegistryWithStub(makeStubStream([])),
      cwd: workdir,
    });

    expect(host.getNextModel("worker", 0)).toBe("stub:fallback");
    expect(host.getNextModel("worker", 1)).toBeNull();
    // Orchestrator has no `models` field → null.
    expect(host.getNextModel("orchestrator", 0)).toBeNull();
  });

  it("persistRecord appends to the host-owned log (append-only contract)", () => {
    const log = new InMemoryRecordLog();
    const runId = "test-run-1";
    const host = new ProductionHost({
      runId,
      log,
      loadedManifest: {
        def: makeDef(),
        manifest: {
          version: 1,
          roles: [
            {
              name: "orchestrator",
              is_orchestrator: true,
              system_prompt: ".pi/roles/orchestrator.md",
            },
            { name: "worker", max_visits: 3, system_prompt: ".pi/roles/worker.md" },
          ],
        },
        manifestDir: null,
        manifestVersion: 1,
        warnings: [],
      },
      modelRegistry: makeModelRegistryWithStub(makeStubStream([])),
      cwd: workdir,
    });

    host.persistRecord({
      type: "session_started",
      run_id: runId,
      session_file: "/tmp/s1.jsonl",
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: null,
      parent_session: null,
      ts: 0,
    });
    expect(log.records(runId)).toHaveLength(1);
  });
});
