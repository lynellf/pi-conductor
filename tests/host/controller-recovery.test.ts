import { describe, expect, it } from "vitest";

import { prepareControllerActionRepair } from "../../src/host/controller/action-reconciliation.js";
import { approveControllerDefinition } from "../../src/host/controller/approved-definition.js";
import {
  type ArtifactBinding,
  ArtifactStoreError,
} from "../../src/host/controller/artifact-store.js";
import { validateControllerHostApproval } from "../../src/host/controller/host-approval.js";
import {
  appendControllerRecovery,
  planControllerRecovery,
} from "../../src/host/controller/recovery.js";
import { parseControllerConfig } from "../../src/manifest/controller.js";
import type { ControllerAction } from "../../src/manifest/controller-protocol.js";
import {
  type ControllerActionReceiptRecord,
  type ControllerActivationStartedRecord,
  type ControllerDecisionCommittedRecord,
  type ControllerRecord,
  controllerActionRequestDigest,
} from "../../src/persistence/controller-records.js";
import {
  controllerDelegationSubmissionId,
  controllerLogicalParentId,
  type DelegationSubmissionAcceptedRecord,
} from "../../src/persistence/delegation-task.js";
import type { PersistedRecord, SubagentFailedRecord } from "../../src/persistence/log.js";
import type {
  ControllerToolExecutionFinishedRecord,
  ControllerToolExecutionStartedRecord,
} from "../../src/persistence/tool-execution.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const action: Extract<ControllerAction, { readonly kind: "delegate" }> = {
  kind: "delegate",
  action_id: "delegate-a",
  tasks: [
    {
      id: "task-a",
      subagent: "worker",
      objective: "Inspect the target.",
      expected_output: "A bounded report.",
    },
  ],
};

const noArtifacts = {
  async recoverAction() {
    throw new ArtifactStoreError("artifact-missing");
  },
  async rangeReadForController() {
    throw new Error("test does not recover an artifact");
  },
};

describe("controller durable recovery", () => {
  it("marks an intent without an effect start as interrupted before the next activation", async () => {
    const fixture = controllerFixture();
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: fixture.records,
      artifacts: noArtifacts,
    });

    expect(plan).toMatchObject({
      canActivate: true,
      receipts: [{ actionId: "delegate-a", outcome: "interrupted" }],
    });

    const persisted: ControllerRecord[] = [];
    const receipts = appendControllerRecovery(plan, fixture.resumeActivation, (record) => {
      persisted.push(record);
    });
    expect(persisted.map((record) => record.type)).toEqual([
      "controller_activation_started",
      "controller_action_receipt",
    ]);
    expect(receipts[0]).toMatchObject({
      intent_activation_id: fixture.activation.activation_id,
      causal_revision: fixture.decision.state_revision,
      request_sha256: fixture.requestSha256,
      outcome: "interrupted",
    });
  });

  it("derives a terminal receipt from accepted native work and its terminal child fact", async () => {
    const fixture = controllerFixture();
    const records = [...fixture.records, acceptedSubmission(fixture), failedChild(fixture)];

    const plan = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records,
      artifacts: noArtifacts,
    });

    expect(plan).toMatchObject({
      canActivate: true,
      receipts: [
        {
          actionId: "delegate-a",
          outcome: "failed",
          resultRefs: [expect.stringContaining("/accepted/"), expect.stringContaining("/record/")],
        },
      ],
    });
  });

  it("does not re-emit a receipt whose prior terminal notification was lost", async () => {
    const fixture = controllerFixture();
    const terminalReceipt = actionReceipt(fixture, "failed", null);
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: [
        ...fixture.records,
        acceptedSubmission(fixture),
        failedChild(fixture),
        terminalReceipt,
      ],
      artifacts: noArtifacts,
    });

    expect(plan).toMatchObject({ canActivate: true, receipts: [], freshActionRequired: [] });
    const appended: ControllerRecord[] = [];
    appendControllerRecovery(plan, fixture.resumeActivation, (record) => appended.push(record));
    expect(appended).toEqual([fixture.resumeActivation]);
  });

  it("blocks activation when an accepted native child has no terminal fact", async () => {
    const fixture = controllerFixture();
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: [...fixture.records, acceptedSubmission(fixture)],
      artifacts: noArtifacts,
    });

    expect(plan.canActivate).toBe(false);
    expect(plan.blocked).toContain(
      "action delegate-a has accepted children without terminal evidence; requires action repair",
    );
    expect(() => appendControllerRecovery(plan, fixture.resumeActivation, () => {})).toThrow(
      "controller recovery remains blocked",
    );
  });

  it("always blocks a controller executable whose ownership is unresolved", async () => {
    const fixture = controllerFixture();
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: [...fixture.records, executionStart(fixture)],
      artifacts: noArtifacts,
    });

    expect(plan.canActivate).toBe(false);
    expect(plan.blocked).toContain("controller executable execution-a has unresolved ownership");
  });

  it("blocks an uncommitted planner start, then resumes without reconstructing its response", async () => {
    const fixture = controllerFixture();
    const planner = {
      ...executionStart(fixture),
      origin: {
        ...executionStart(fixture).origin,
        operation_kind: "planner" as const,
        action_id: null,
      },
    };
    const beforeDecision = [fixture.definition, fixture.activation] as const;
    const blocked = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: [...beforeDecision, planner],
      artifacts: noArtifacts,
    });
    expect(blocked.canActivate).toBe(false);

    const resolved = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: [...beforeDecision, planner, executionTerminal(planner)],
      artifacts: noArtifacts,
    });
    expect(resolved).toMatchObject({
      canActivate: true,
      nextOwnerEpoch: 2,
      receipts: [],
      freshActionRequired: [],
    });
    const appended: ControllerRecord[] = [];
    appendControllerRecovery(resolved, fixture.resumeActivation, (record) => appended.push(record));
    expect(appended).toEqual([fixture.resumeActivation]);
  });

  it("keeps repaired uncertain work as a fresh action requirement", async () => {
    const fixture = controllerFixture();
    const uncertain = actionReceipt(fixture, "uncertain", "operation-a");
    const repair = {
      type: "controller_operation_repaired" as const,
      schema_version: 1 as const,
      run_id: fixture.definition.run_id,
      controller_id: fixture.definition.controller_id,
      definition_digest: fixture.definition.definition_digest,
      action_id: "delegate-a",
      operation_id: "operation-a",
      original_activation_id: fixture.activation.activation_id,
      original_record_digest: sha256Canonical(uncertain),
      cleanup: "confirmed" as const,
      partial_effects: "none_observed" as const,
      operator: "operator",
      operator_note: "cleanup inspected",
      ts: 5,
    };
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: [...fixture.records, uncertain, repair],
      artifacts: noArtifacts,
    });

    expect(plan.canActivate).toBe(true);
    expect(plan.freshActionRequired).toEqual(["delegate-a"]);
    expect(plan.receipts).toEqual([]);
  });

  it.each([
    "pending",
    "accepted",
  ] as const)("reconciles a %s receipt against the durable native authority", async (outcome) => {
    const fixture = controllerFixture();
    const prior = actionReceipt(fixture, outcome, null);
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: [...fixture.records, prior],
      artifacts: noArtifacts,
    });

    expect(plan).toMatchObject({
      canActivate: true,
      receipts: [{ actionId: "delegate-a", outcome: "interrupted" }],
    });
  });

  it("blocks an unrepaired uncertain action", async () => {
    const fixture = controllerFixture();
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: [...fixture.records, actionReceipt(fixture, "uncertain", "operation-a")],
      artifacts: noArtifacts,
    });

    expect(plan.canActivate).toBe(false);
    expect(plan.blocked).toContain(
      "action delegate-a has an unrepaired uncertain operation; requires action repair",
    );
  });

  it("marks a never-executed read as interrupted without replaying it", async () => {
    const fixture = controllerFixture();
    const read: Extract<ControllerAction, { readonly kind: "read" }> = {
      kind: "read",
      action_id: "read-a",
      ref: "controller/v1/ref",
    };
    const decision: ControllerDecisionCommittedRecord = {
      ...fixture.decision,
      actions: [
        {
          action_id: read.action_id,
          kind: read.kind,
          request_sha256: controllerActionRequestDigest(fixture.definition.definition_digest, read),
          request: read,
        },
      ],
    };
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: [fixture.definition, fixture.activation, decision],
      artifacts: noArtifacts,
    });

    expect(plan).toMatchObject({
      canActivate: true,
      receipts: [
        {
          actionId: "read-a",
          outcome: "interrupted",
          diagnostic: "read publication is absent and will not be replayed",
        },
      ],
    });
  });

  it("recovers a published read result with its exact durable cursor binding", async () => {
    const fixture = controllerFixture();
    const read: Extract<ControllerAction, { readonly kind: "read" }> = {
      kind: "read",
      action_id: "read-a",
      ref: "controller/v1/ref",
    };
    const decision = decisionFor(fixture, read);
    const bytes = Buffer.from('{"source_ref":"controller/v1/ref","result":{"eof":true}}');
    let currentBinding: ArtifactBinding | undefined;
    const artifacts = {
      async recoverAction(binding: ArtifactBinding) {
        expect(binding).toMatchObject({
          actionId: "read-a",
          producer: { kind: "source_cursor", ordinal: 2 },
        });
        currentBinding = binding;
        return {
          ref: "artifact/v1/read-result",
          sha256: "a".repeat(64),
          byteLength: bytes.byteLength,
          mediaType: "application/json" as const,
          binding,
        };
      },
      async rangeReadForController() {
        if (currentBinding === undefined) throw new Error("read binding was not recovered");
        return {
          bytes,
          binding: currentBinding,
          sha256: "a".repeat(64),
          byteLength: bytes.byteLength,
          mediaType: "application/json" as const,
        };
      },
    };
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: [fixture.definition, fixture.activation, decision],
      artifacts,
    });

    expect(plan).toMatchObject({
      canActivate: true,
      receipts: [
        {
          actionId: "read-a",
          outcome: "completed",
          resultRefs: ["artifact/v1/read-result"],
          result: { source_ref: "controller/v1/ref", result: { eof: true } },
        },
      ],
    });
  });

  it("marks a reconciled cancel as interrupted without issuing a second cancellation", async () => {
    const fixture = controllerFixture();
    const cancel: Extract<ControllerAction, { readonly kind: "cancel" }> = {
      kind: "cancel",
      action_id: "cancel-a",
      child_ids: ["child-a"],
    };
    const delegateIntent = fixture.decision.actions.at(0);
    if (delegateIntent === undefined) throw new Error("controller fixture has no delegate action");
    const decision: ControllerDecisionCommittedRecord = {
      ...fixture.decision,
      actions: [delegateIntent, actionIntent(fixture, cancel)],
    };
    const completedDelegate = actionReceipt(fixture, "failed", null);
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: [
        fixture.definition,
        fixture.activation,
        decision,
        acceptedSubmission(fixture),
        failedChild(fixture),
        completedDelegate,
      ],
      artifacts: noArtifacts,
    });

    expect(plan).toMatchObject({
      canActivate: true,
      receipts: [{ actionId: "cancel-a", outcome: "interrupted" }],
    });
  });

  it("refuses action repair while its preparation execution is still owned", () => {
    const fixture = controllerFixture();
    const preparation = executionStart(fixture, "preparation");

    expect(() =>
      prepareControllerActionRepair([...fixture.records, preparation], "delegate-a", {
        operator: "operator",
        note: "inspected preparation",
        partialEffects: "none_observed",
        ts: 5,
      }),
    ).toThrow("executable ownership is unresolved");
  });

  it("refuses synthetic repair for accepted native work with terminal child facts", () => {
    const fixture = controllerFixture();

    expect(() =>
      prepareControllerActionRepair(
        [...fixture.records, acceptedSubmission(fixture), failedChild(fixture)],
        "delegate-a",
        {
          operator: "operator",
          note: "unnecessary repair",
          partialEffects: "none_observed",
          ts: 6,
        },
      ),
    ).toThrow("accepted native results are authoritative");
  });

  it("turns a clean repaired preparation into a fresh action requirement", async () => {
    const fixture = controllerFixture();
    const preparation = executionStart(fixture, "preparation");
    const terminal = executionTerminal(preparation);
    const pending = actionReceipt(fixture, "pending", null);
    const repaired = prepareControllerActionRepair(
      [...fixture.records, preparation, terminal, pending],
      "delegate-a",
      {
        operator: "operator",
        note: "staging inspected",
        partialEffects: "inspected_unpublished",
        ts: 6,
      },
    );

    expect(repaired).toMatchObject([
      { type: "controller_action_receipt", outcome: "uncertain", operation_id: "operation-a" },
      { type: "controller_operation_repaired", operation_id: "operation-a" },
    ]);
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.approvedDefinition,
      records: [...fixture.records, preparation, terminal, pending, ...repaired],
      artifacts: noArtifacts,
    });
    expect(plan).toMatchObject({ canActivate: true, freshActionRequired: ["delegate-a"] });
    expect(plan.receipts).toEqual([]);
  });
});

function controllerFixture() {
  const config = parseControllerConfig({
    protocol_version: 1,
    controller_id: "planner",
    runtime_id: "runtime",
    executable: "/bin/planner",
    argv: ["--fixed"],
    adapters: [],
    delegation: { allowed_subagents: ["worker"], max_children_per_session: 1, max_parallel: 1 },
  });
  const approval = validateControllerHostApproval({
    schema_version: 1,
    approval_id: "approval",
    runtimes: [
      {
        runtime_id: "runtime",
        source_root: "/operator/runtime",
        inventory_sha256: "a".repeat(64),
        bootstrap_approval: {
          approvalId: "bootstrap",
          files: [
            { path: "bin/bash", sha256: "b".repeat(64) },
            { path: "bin/planner", sha256: "c".repeat(64) },
          ],
        },
      },
    ],
    controllers: [
      {
        controller_id: "planner",
        runtime_id: "runtime",
        executable: "/bin/planner",
        argv: ["--fixed"],
      },
    ],
    adapters: [],
    schemas: [],
  });
  const approvedDefinition = approveControllerDefinition("run-a", config, approval, 1);
  const definition = approvedDefinition.record;
  const activation: ControllerActivationStartedRecord = {
    type: "controller_activation_started",
    schema_version: 1,
    run_id: definition.run_id,
    controller_id: definition.controller_id,
    definition_digest: definition.definition_digest,
    activation_id: "activation-a",
    owner_epoch: 1,
    reason: "start",
    previous_activation_id: null,
    ts: 2,
  };
  const requestSha256 = controllerActionRequestDigest(definition.definition_digest, action);
  const decision: ControllerDecisionCommittedRecord = {
    type: "controller_decision_committed",
    schema_version: 1,
    run_id: definition.run_id,
    controller_id: definition.controller_id,
    definition_digest: definition.definition_digest,
    activation_id: activation.activation_id,
    owner_epoch: activation.owner_epoch,
    decision_id: "decision-a",
    prior_revision: 0,
    state_revision: 1,
    prior_cursor: null,
    consumed_cursor: { ordinal: 1, record_digest: sha256Canonical(activation) },
    response_kind: "plan",
    controller_state: {},
    decision_payload: null,
    actions: [
      {
        action_id: action.action_id,
        kind: action.kind,
        request_sha256: requestSha256,
        request: action,
      },
    ],
    ts: 3,
  };
  const resumeActivation: ControllerActivationStartedRecord = {
    ...activation,
    activation_id: "activation-b",
    owner_epoch: 2,
    reason: "resume",
    previous_activation_id: activation.activation_id,
    ts: 6,
  };
  return {
    approvedDefinition,
    definition,
    activation,
    decision,
    requestSha256,
    resumeActivation,
    records: [definition, activation, decision] as readonly PersistedRecord[],
  };
}

function decisionFor(
  fixture: ReturnType<typeof controllerFixture>,
  request: ControllerAction,
): ControllerDecisionCommittedRecord {
  return { ...fixture.decision, actions: [actionIntent(fixture, request)] };
}

function actionIntent(fixture: ReturnType<typeof controllerFixture>, request: ControllerAction) {
  return {
    action_id: request.action_id,
    kind: request.kind,
    request_sha256: controllerActionRequestDigest(fixture.definition.definition_digest, request),
    request,
  };
}

function acceptedSubmission(
  fixture: ReturnType<typeof controllerFixture>,
): DelegationSubmissionAcceptedRecord {
  const acceptedArgs = { tasks: action.tasks };
  const child = childFact();
  const logicalParentId = controllerLogicalParentId(
    fixture.definition.run_id,
    fixture.definition.controller_id,
    fixture.definition.definition_digest,
  );
  return {
    type: "delegation_submission_accepted",
    schema_version: 2,
    run_id: fixture.definition.run_id,
    submission_id: controllerDelegationSubmissionId(
      fixture.definition.run_id,
      logicalParentId,
      action.action_id,
    ),
    logical_parent_id: logicalParentId,
    parent_role: "orchestrator",
    parent_visit_index: 0,
    origin: {
      kind: "controller_action",
      controller_id: fixture.definition.controller_id,
      definition_digest: fixture.definition.definition_digest,
      action_id: action.action_id,
      activation_id: fixture.activation.activation_id,
    },
    input_fingerprint: sha256Canonical(acceptedArgs),
    accepted_args: acceptedArgs,
    children: [child],
    ts: 4,
  };
}

function failedChild(fixture: ReturnType<typeof controllerFixture>): SubagentFailedRecord {
  const child = childFact();
  return {
    type: "subagent_failed",
    run_id: fixture.definition.run_id,
    child_id: child.child_id,
    task_id: child.task_id,
    subagent: child.subagent,
    model: child.model,
    status: "cancelled",
    failure_reason: "queued cancellation",
    branch: child.branch,
    worktree_path: child.worktree_path,
    base_commit: child.base_commit,
    head_commit: null,
    session_file: null,
    usage: null,
    ts: 5,
  };
}

function executionStart(
  fixture: ReturnType<typeof controllerFixture>,
  operationKind: "adapter" | "preparation" = "adapter",
): ControllerToolExecutionStartedRecord {
  return {
    type: "tool_execution_started",
    schema_version: 2,
    run_id: fixture.definition.run_id,
    execution_id: "execution-a",
    supervision_id: "supervision-a",
    origin: {
      kind: "controller_operation",
      controller_id: fixture.definition.controller_id,
      definition_digest: fixture.definition.definition_digest,
      activation_id: fixture.activation.activation_id,
      owner_epoch: fixture.activation.owner_epoch,
      operation_id: "operation-a",
      operation_kind: operationKind,
      action_id: action.action_id,
      request_sha256: fixture.requestSha256,
    },
    timeout_ms: 30_000,
    recovery_count: 0,
    ts: 4,
  };
}

function executionTerminal(
  start: ControllerToolExecutionStartedRecord,
): ControllerToolExecutionFinishedRecord {
  return {
    type: "tool_execution_finished",
    schema_version: 2,
    run_id: start.run_id,
    execution_id: start.execution_id,
    supervision_id: start.supervision_id,
    origin: start.origin,
    elapsed_ms: 10,
    recovery_count: 0,
    outcome: "failed",
    cleanup: "confirmed",
    ts: 5,
  };
}

function actionReceipt(
  fixture: ReturnType<typeof controllerFixture>,
  outcome: ControllerActionReceiptRecord["outcome"],
  operationId: string | null,
): ControllerActionReceiptRecord {
  return {
    type: "controller_action_receipt",
    schema_version: 1,
    run_id: fixture.definition.run_id,
    controller_id: fixture.definition.controller_id,
    definition_digest: fixture.definition.definition_digest,
    action_id: action.action_id,
    activation_id: fixture.activation.activation_id,
    owner_epoch: fixture.activation.owner_epoch,
    intent_activation_id: fixture.activation.activation_id,
    causal_revision: fixture.decision.state_revision,
    request_sha256: fixture.requestSha256,
    kind: "delegate",
    outcome,
    operation_id: operationId,
    result_refs: [],
    diagnostic: "cleanup needs inspection",
    ts: 4,
  };
}

function childFact() {
  return {
    child_id: "child-a",
    task_id: "task-a",
    subagent: "worker",
    model: "stub:model",
    branch: "delegation/child-a",
    worktree_path: "/operator/worktree-a",
    base_commit: "d".repeat(40),
    task_fingerprint: "e".repeat(64),
    profile_fingerprint: "f".repeat(64),
    context_fingerprint: "1".repeat(64),
    prompt_fingerprint: "2".repeat(64),
    projection_fingerprint: { kind: "exact" as const, path_count: 1, sha256: "3".repeat(64) },
  };
}
