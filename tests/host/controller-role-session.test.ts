import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerActionDispatcher } from "../../src/host/controller/action-dispatcher.js";
import { TypedControllerProtocolError } from "../../src/host/controller/protocol-codec.js";
import { createDelegationAdmissionService } from "../../src/host/delegation/admission-service.js";
import { DelegationScheduler } from "../../src/host/delegation/scheduler.js";
import type {
  ControllerAction,
  ControllerRequest,
} from "../../src/manifest/controller-protocol.js";
import { controllerLogicalParentId } from "../../src/persistence/delegation-task.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import {
  child,
  completed,
  deferred,
  terminalRecord,
} from "./delegation-scheduler-review-fixture.js";
import { controllerSessionFixture, response } from "./fixtures/controller-role-session-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("controller role session", () => {
  it("runs A/B/C through native maxParallel scheduling", async () => {
    const a = deferred<ReturnType<typeof completed>>();
    const c = deferred<ReturnType<typeof completed>>();
    const starts: string[] = [];
    let sawBTerminal = false;
    let plannerCalls = 0;
    const fixture = await controllerSessionFixture({
      runtime: ({ activation, records, persist, fence, wake }) => {
        const scheduler = new DelegationScheduler({
          identity: {
            runId: activation.run_id,
            logicalParentId: controllerLogicalParentId(
              activation.run_id,
              activation.controller_id,
              activation.definition_digest,
            ),
            parentRole: "orchestrator",
            parentVisitIndex: 1,
            origin: {
              kind: "controller",
              controllerId: activation.controller_id,
              definitionDigest: activation.definition_digest,
            },
          },
          maxParallel: 2,
          maxChildren: 3,
          records: () => records,
          persistRecord: persist,
          prepareSubmission: async (input) => ({
            baseCommit: "base",
            materializedParentPaths: [],
            tasks: input.tasks.map((task) => child(task.id)),
          }),
          runTask: async (task) => {
            const actionId = task.taskId.replace(/^task-/, "");
            starts.push(actionId);
            persist({
              type: "subagent_started",
              run_id: activation.run_id,
              child_id: task.childId,
              task_id: task.taskId,
              subagent: task.profile.name,
              parent_role: "orchestrator",
              parent_visit_index: 1,
              model: "stub:model",
              session_file: `/tmp/${task.childId}.jsonl`,
              worktree_path: task.worktreePath,
              branch: task.branch,
              base_commit: task.baseCommit,
              ts: Date.now(),
            });
            if (actionId === "A") return a.promise;
            if (actionId === "C") return c.promise;
            return completed(task);
          },
          onTerminal: (result) => {
            const terminal = terminalRecord(result);
            if (terminal.type !== "subagent_completed" && terminal.type !== "subagent_failed")
              throw new Error("expected a child terminal record");
            persist({ ...terminal, run_id: activation.run_id });
          },
        });
        const admission = createDelegationAdmissionService(scheduler);
        const unused = async () => {
          throw new Error("unused");
        };
        const dispatcher = createControllerActionDispatcher({
          activation,
          readRecords: () => records,
          persist,
          admission,
          executables: { invokeAdapter: unused },
          artifacts: { rangeReadForController: unused, createStaging: unused, publish: unused },
          assertOpen: () => fence.assertOpen(),
          runNativePreparation: async (_action, operation) => operation(),
          wake,
          onFatal: (cause) => {
            throw cause;
          },
        });
        return { dispatcher, admission };
      },
      invokePlanner: async (request) => {
        plannerCalls += 1;
        if (plannerCalls === 1) return plan(request, [delegate("A"), delegate("B")]);
        const bTerminal = request.events.some(
          (event) =>
            event.kind === "child_terminal" && controllerEventChildId(event.payload) === "child-B",
        );
        if (bTerminal && !starts.includes("C")) {
          sawBTerminal = true;
          return plan(request, [delegate("C")]);
        }
        if (!starts.includes("C")) return response(request, "wait");
        return response(request, "finish");
      },
    });
    roots.push(fixture.root);
    const prompting = fixture.session.prompt("ignored");
    await until(() => starts.includes("C"));
    expect(starts).toEqual(["A", "B", "C"]);
    expect(sawBTerminal).toBe(true);
    const bTerminalOrdinal = fixture.records.findIndex(
      (record) => record.type === "subagent_completed" && record.child_id === "child-B",
    );
    const cStartedOrdinal = fixture.records.findIndex(
      (record) => record.type === "subagent_started" && record.child_id === "child-C",
    );
    expect(bTerminalOrdinal).toBeGreaterThan(-1);
    expect(cStartedOrdinal).toBeGreaterThan(bTerminalOrdinal);
    expect(
      fixture.records.some(
        (record) => record.type === "subagent_completed" && record.child_id === "child-A",
      ),
    ).toBe(false);
    a.resolve(completed(child("A")));
    c.resolve(completed(child("C")));
    await prompting;
    expect(
      fixture.records.filter(
        (record) => record.type === "delegation_submission_accepted" && record.schema_version === 2,
      ),
    ).toHaveLength(3);
    expect(fixture.records.filter((record) => record.type === "subagent_started")).toHaveLength(3);
    expect(fixture.records.filter((record) => record.type === "subagent_completed")).toHaveLength(
      3,
    );
    expect(fixture.session.model).toBeNull();
    await fixture.session.dispose();
  });

  it("starts C after B settles while A remains active without SDK model turns", async () => {
    const started: string[] = [];
    const running = new Set<string>();
    let fixture!: Awaited<ReturnType<typeof controllerSessionFixture>>;
    let releaseA!: () => void;
    const aDone = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let plannerCalls = 0;
    fixture = await controllerSessionFixture({
      admission: {
        status: () =>
          [...running].map((childId) => ({
            childId,
            taskId: childId,
            submissionId: `submission-${childId}`,
            status: "running" as const,
          })),
      },
      dispatcher: {
        dispatchCommitted: (actionId) => {
          started.push(actionId);
          running.add(actionId);
          if (actionId === "B") {
            queueMicrotask(() => {
              running.delete("B");
              appendReceipt(fixture, "B", "pending");
              appendReceipt(fixture, "B", "completed");
            });
          }
          if (actionId === "C") {
            queueMicrotask(() => {
              fixture.persist({
                type: "end_guard_finished",
                schema_version: 1,
                run_id: fixture.activation.run_id,
                attempt_id: "attempt-c",
                supervision_id: "supervision-c",
                request_id: "request-c",
                role: "orchestrator",
                role_session_id: fixture.session.sessionId,
                session_file: fixture.session.sessionFile,
                elapsed_ms: 1,
                outcome: "failed",
                exit_code: 1,
                signal: null,
                diagnostic: "retry",
                truncated: false,
                cleanup: "confirmed",
                ts: Date.now(),
              });
            });
          }
        },
        settle: async () => {
          if (running.has("A")) await aDone;
        },
      },
      invokePlanner: async (request) => {
        plannerCalls += 1;
        if (plannerCalls === 1) return plan(request, [delegate("A"), delegate("B")]);
        if (!running.has("B") && !started.includes("C")) return plan(request, [delegate("C")]);
        return response(request, "finish");
      },
    });
    roots.push(fixture.root);
    fixture.persist(controllerStarted(fixture));

    const prompting = fixture.session.prompt("ignored");
    await until(() => started.includes("C"));
    expect(started.slice(0, 3)).toEqual(["A", "B", "C"]);
    expect(running.has("A")).toBe(true);
    expect(
      fixture.records.some(
        (record) =>
          record.type === "controller_action_receipt" &&
          record.action_id === "B" &&
          record.outcome === "completed",
      ),
    ).toBe(true);
    releaseA();
    running.delete("A");
    running.delete("C");
    await prompting;
    expect(fixture.session.model).toBeNull();
    expect(fixture.session.sessionOrigin?.kind).toBe("controller");
    await fixture.session.dispose();
  });

  it("fails after three unchanged plans without redispatching known work", async () => {
    let fixture!: Awaited<ReturnType<typeof controllerSessionFixture>>;
    let calls = 0;
    let dispatches = 0;
    fixture = await controllerSessionFixture({
      dispatcher: {
        dispatchCommitted: (actionId) => {
          dispatches += 1;
          queueMicrotask(() => {
            appendReceipt(fixture, actionId, "pending");
            appendReceipt(fixture, actionId, "completed");
          });
        },
      },
      invokePlanner: async (request) => {
        calls += 1;
        return plan(request, [delegate("known")]);
      },
    });
    roots.push(fixture.root);

    await expect(fixture.session.prompt("ignored")).rejects.toThrow(
      "three unchanged decisions without new work",
    );
    expect(calls).toBe(4);
    expect(dispatches).toBe(1);
    await fixture.session.dispose();
  });

  it("bounds repeated stale planner identities to three attempts", async () => {
    let calls = 0;
    const fixture = await controllerSessionFixture({
      invokePlanner: async () => {
        calls += 1;
        throw new TypedControllerProtocolError("stale_identity", "stale");
      },
    });
    roots.push(fixture.root);

    await expect(fixture.session.prompt("ignored")).rejects.toThrow(/stale/u);
    expect(calls).toBe(3);
    await fixture.session.dispose();
  });

  it("waits without polling and wakes into a cost-cap termination", async () => {
    let calls = 0;
    let capped = false;
    const fixture = await controllerSessionFixture({
      invokePlanner: async (request) => {
        calls += 1;
        return response(request, "wait");
      },
      isRunCostCapReached: () => capped,
    });
    roots.push(fixture.root);
    const prompting = fixture.session.prompt("ignored");
    await until(() => calls === 1);
    await ticks(10);
    expect(calls).toBe(1);

    capped = true;
    fixture.session.wake();
    await prompting;
    expect(fixture.session.getHostTermination?.()).toEqual({ kind: "run_cost_cap" });
    expect(fixture.session.readCaptureBuffer()).toEqual([]);
    await fixture.session.dispose();
  });

  it("aborts and settles an active planner before exposing cost-cap termination", async () => {
    let observedAbort = false;
    let settled = false;
    const fixture = await controllerSessionFixture({
      invokePlanner: async (_request, signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          ),
        );
        settled = true;
        throw new Error("aborted planner");
      },
    });
    roots.push(fixture.root);
    const prompting = fixture.session.prompt("ignored");
    await ticks(2);
    fixture.session.stopForRunCostCap();
    await prompting;
    expect(observedAbort).toBe(true);
    expect(settled).toBe(true);
    expect(fixture.session.getHostTermination?.()).toEqual({ kind: "run_cost_cap" });
    await fixture.session.dispose();
  });

  it("preserves cleanup failure over a simultaneously reached cost cap", async () => {
    let capped = false;
    let calls = 0;
    const fixture = await controllerSessionFixture({
      invokePlanner: async (request) => {
        calls += 1;
        return response(request, "wait");
      },
      isRunCostCapReached: () => capped,
      closeOwnedWork: async () => {
        throw new Error("owned cleanup remains unconfirmed");
      },
    });
    roots.push(fixture.root);
    const prompting = fixture.session.prompt("ignored");
    const failed = expect(prompting).rejects.toThrow("cleanup remains unconfirmed");
    await until(() => calls === 1);
    capped = true;
    fixture.session.wake();
    await failed;
    expect(fixture.session.getHostTermination?.()).toBeNull();
    await expect(fixture.session.dispose()).rejects.toThrow("cleanup remains unconfirmed");
  });

  it("commits one atomic decision while retaining facts appended during planning", async () => {
    const requests: ControllerRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await controllerSessionFixture({
      invokePlanner: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          await gate;
          return response(request, "wait");
        }
        return response(request, "finish");
      },
    });
    roots.push(fixture.root);
    const prompting = fixture.session.prompt("ignored");
    await until(() => requests.length === 1);
    fixture.persist({
      type: "session_started",
      run_id: fixture.activation.run_id,
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: null,
      model_effort: "off",
      session_file: fixture.session.sessionFile,
      parent_session: null,
      role_session_id: fixture.session.sessionId,
      session_origin: "controller",
      controller_id: fixture.activation.controller_id,
      controller_definition_digest: fixture.activation.definition_digest,
      controller_activation_id: fixture.activation.activation_id,
      controller_owner_epoch: fixture.activation.owner_epoch,
      ts: 3,
    });
    const rejected = {
      type: "transition_rejected",
      run_id: fixture.activation.run_id,
      state: "orchestrator",
      event: "end",
      target_role: null,
      request_end: false,
      reason: "guard_failed",
      legal_targets: { handoff: ["worker"], end: true },
      role: "orchestrator",
      session_file: fixture.session.sessionFile,
      ts: 4,
    } as const;
    fixture.persist(rejected);
    release();
    await until(() => requests.length === 2);
    await prompting;

    expect(
      fixture.records.filter((record) => record.type === "controller_decision_committed"),
    ).toHaveLength(2);
    expect(requests[1]?.event_cursor).not.toEqual(requests[0]?.event_cursor);
    const finishRejected = requests[1]?.events.find((event) => event.kind === "finish_rejected");
    if (finishRejected?.source === null || finishRejected?.source === undefined)
      throw new Error("expected finish rejection with a durable source");
    expect(finishRejected?.source.ordinal).toBe(fixture.records.indexOf(rejected));
    expect(finishRejected?.source.record_digest).toBe(sha256Canonical(rejected));
    expect(fixture.session.readCaptureBuffer()).toEqual([
      { toolName: "end", args: { reason: "controller complete" } },
    ]);
    await fixture.session.dispose();
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 1000; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition did not become true");
}

async function ticks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function delegate(action_id: string): Extract<ControllerAction, { kind: "delegate" }> {
  return {
    kind: "delegate",
    action_id,
    tasks: [{ id: action_id, subagent: "worker", objective: "do", expected_output: "done" }],
  };
}

function controllerEventChildId(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null && "child_id" in payload
    ? payload.child_id
    : undefined;
}

function plan(request: ControllerRequest, actions: readonly ControllerAction[]) {
  return {
    protocol_version: 1 as const,
    run_id: request.run_id,
    controller_id: request.controller_id,
    definition_digest: request.definition_digest,
    activation_id: request.activation_id,
    owner_epoch: request.owner_epoch,
    state_revision: request.state_revision,
    event_cursor: request.page_cursor,
    state: request.state,
    decision: "plan" as const,
    actions: [...actions],
  };
}

function controllerStarted(fixture: Awaited<ReturnType<typeof controllerSessionFixture>>) {
  return {
    type: "session_started" as const,
    run_id: fixture.activation.run_id,
    role: "orchestrator",
    visit_index: 1,
    state: "orchestrator" as const,
    model: null,
    model_effort: "off" as const,
    session_file: fixture.session.sessionFile,
    parent_session: null,
    role_session_id: fixture.session.sessionId,
    session_origin: "controller" as const,
    controller_id: fixture.activation.controller_id,
    controller_definition_digest: fixture.activation.definition_digest,
    controller_activation_id: fixture.activation.activation_id,
    controller_owner_epoch: fixture.activation.owner_epoch,
    ts: Date.now(),
  };
}

function appendReceipt(
  fixture: Awaited<ReturnType<typeof controllerSessionFixture>>,
  actionId: string,
  outcome: "pending" | "completed",
): void {
  const decision = [...fixture.records]
    .reverse()
    .find(
      (record) =>
        record.type === "controller_decision_committed" &&
        record.actions.some((action) => action.action_id === actionId),
    );
  if (decision?.type !== "controller_decision_committed") throw new Error("missing action intent");
  const intent = decision.actions.find((action) => action.action_id === actionId);
  if (intent === undefined) throw new Error("missing action intent");
  fixture.persist({
    type: "controller_action_receipt",
    schema_version: 1,
    run_id: fixture.activation.run_id,
    controller_id: fixture.activation.controller_id,
    definition_digest: fixture.activation.definition_digest,
    action_id: actionId,
    activation_id: fixture.activation.activation_id,
    owner_epoch: fixture.activation.owner_epoch,
    intent_activation_id: decision.activation_id,
    causal_revision: decision.state_revision,
    request_sha256: intent.request_sha256,
    kind: intent.kind,
    outcome,
    operation_id: null,
    result_refs: [],
    diagnostic: null,
    ts: Date.now(),
  });
}
