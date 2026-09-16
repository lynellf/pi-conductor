import { describe, expect, it } from "vitest";

import {
  assertControllerRecord,
  type ControllerActionReceiptRecord,
  type ControllerActivationStartedRecord,
  type ControllerDecisionCommittedRecord,
  type ControllerDefinitionPinnedRecord,
  ControllerRecordError,
  type ControllerRepairRecord,
  controllerDefinitionDigest,
} from "../../src/persistence/controller-records.js";
import {
  getControllerAction,
  materializeControllerRecovery,
  reconstructControllerTimeline,
} from "../../src/persistence/controller-timeline.js";
import { InMemoryRecordLog } from "../../src/persistence/in-memory-log.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const pinnedDefinition = {
  protocol_version: 1,
  executable: "/opt/controller/bin/controller",
  argv: ["--json"],
};

const definitionWithoutDigest: Omit<ControllerDefinitionPinnedRecord, "definition_digest"> = {
  type: "controller_definition_pinned",
  schema_version: 1,
  run_id: "run-1",
  controller_id: "repo-controller",
  pinned_definition: pinnedDefinition,
  controller_authority: {
    registration_id: "controller-runtime",
    approval_id: "operator-approval",
    runtime_digest: "a".repeat(64),
    executable_digest: "b".repeat(64),
    capability_digest: "c".repeat(64),
  },
  adapter_authorities: [],
  limits: { max_decisions: 100, max_actions: 100, max_outstanding_actions: 8 },
  ts: 1,
};
const definition: ControllerDefinitionPinnedRecord = {
  ...definitionWithoutDigest,
  definition_digest: controllerDefinitionDigest(definitionWithoutDigest),
};

const activation: ControllerActivationStartedRecord = {
  type: "controller_activation_started",
  schema_version: 1,
  run_id: "run-1",
  controller_id: "repo-controller",
  definition_digest: definition.definition_digest,
  activation_id: "activation-1",
  owner_epoch: 1,
  reason: "start",
  previous_activation_id: null,
  ts: 2,
};

const request = {
  kind: "delegate" as const,
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

const decision: ControllerDecisionCommittedRecord = {
  type: "controller_decision_committed",
  schema_version: 1,
  run_id: "run-1",
  controller_id: "repo-controller",
  definition_digest: definition.definition_digest,
  activation_id: "activation-1",
  owner_epoch: 1,
  decision_id: "decision-1",
  prior_revision: 0,
  state_revision: 1,
  prior_cursor: null,
  consumed_cursor: { ordinal: 1, record_digest: sha256Canonical(activation) },
  response_kind: "plan",
  controller_state: { phase: "discovery" },
  decision_payload: null,
  actions: [
    {
      action_id: "delegate-a",
      kind: "delegate",
      request_sha256: sha256Canonical(request),
      request,
    },
  ],
  ts: 3,
};
const actionIntent = requireFirstAction(decision);

function requireFirstAction(record: ControllerDecisionCommittedRecord) {
  const intent = record.actions[0];
  if (intent === undefined) throw new Error("controller test fixture is missing its action");
  return intent;
}

function receipt(
  outcome: ControllerActionReceiptRecord["outcome"],
  overrides: Partial<ControllerActionReceiptRecord> = {},
): ControllerActionReceiptRecord {
  return {
    type: "controller_action_receipt",
    schema_version: 1,
    run_id: "run-1",
    controller_id: "repo-controller",
    definition_digest: definition.definition_digest,
    action_id: "delegate-a",
    activation_id: "activation-1",
    owner_epoch: 1,
    intent_activation_id: "activation-1",
    causal_revision: 1,
    request_sha256: actionIntent.request_sha256,
    kind: "delegate",
    outcome,
    operation_id: "submission-a",
    result_refs: [],
    diagnostic: null,
    ts: 4,
    ...overrides,
  };
}

describe("controller durable timeline", () => {
  it("materializes strict controller records through the shared log boundary", () => {
    const log = new InMemoryRecordLog();
    try {
      log.append(definition);
      log.append(activation);
      log.append(decision);
      expect(log.records("run-1")).toEqual([definition, activation, decision]);
      expect(() => log.append({ ...decision, controller_state: undefined })).toThrow(
        ControllerRecordError,
      );
    } finally {
      log.close();
    }
  });

  it("reconstructs decision state and requires host evidence for an undispatched intent", () => {
    const timeline = reconstructControllerTimeline([definition, activation, decision]);
    const recovery = materializeControllerRecovery(timeline);

    expect(timeline.nextRevision).toBe(2);
    expect(timeline.consumedCursor).toEqual(decision.consumed_cursor);
    expect(getControllerAction(timeline, "delegate-a")).toMatchObject({
      actionId: "delegate-a",
      originalRevision: 1,
      latestReceipt: null,
    });
    expect(recovery.requirements).toEqual([
      { kind: "host_evidence_required", actionId: "delegate-a", lastOutcome: null },
    ]);
  });

  it("keeps action identity stable across activations and returns its original receipt", () => {
    const accepted = receipt("accepted");
    const resumed: ControllerActivationStartedRecord = {
      ...activation,
      activation_id: "activation-2",
      owner_epoch: 2,
      reason: "resume",
      previous_activation_id: "activation-1",
      ts: 5,
    };
    const duplicate: ControllerDecisionCommittedRecord = {
      ...decision,
      activation_id: "activation-2",
      owner_epoch: 2,
      decision_id: "decision-2",
      prior_revision: 1,
      state_revision: 2,
      prior_cursor: decision.consumed_cursor,
      consumed_cursor: { ordinal: 4, record_digest: sha256Canonical(resumed) },
      ts: 6,
    };

    const timeline = reconstructControllerTimeline([
      definition,
      activation,
      decision,
      accepted,
      resumed,
      duplicate,
    ]);

    expect(timeline.actions).toHaveLength(1);
    expect(getControllerAction(timeline, "delegate-a")?.latestReceipt).toEqual(accepted);
    expect(getControllerAction(timeline, "delegate-a")?.originalRevision).toBe(1);
  });

  it("rejects changed requests that reuse a stable action ID", () => {
    const changedRequest = {
      kind: "delegate" as const,
      action_id: "delegate-a",
      tasks: [
        {
          id: "task-b",
          subagent: "worker",
          objective: "Change the target.",
          expected_output: "A bounded report.",
        },
      ],
    };
    const changed: ControllerDecisionCommittedRecord = {
      ...decision,
      decision_id: "decision-2",
      prior_revision: 1,
      state_revision: 2,
      prior_cursor: decision.consumed_cursor,
      consumed_cursor: decision.consumed_cursor,
      actions: [
        {
          ...actionIntent,
          request: changedRequest,
          request_sha256: sha256Canonical(changedRequest),
        },
      ],
      ts: 4,
    };

    expect(() =>
      reconstructControllerTimeline([definition, activation, decision, changed]),
    ).toThrow("action identity was reused with a different request");
  });

  it("rejects noncontiguous revisions and cursor discontinuity", () => {
    expect(() =>
      reconstructControllerTimeline([
        definition,
        activation,
        { ...decision, prior_revision: 1, state_revision: 2 },
      ]),
    ).toThrow("decision revision is not contiguous");
    expect(() =>
      reconstructControllerTimeline([
        definition,
        activation,
        decision,
        {
          ...decision,
          decision_id: "decision-2",
          prior_revision: 1,
          state_revision: 2,
          prior_cursor: null,
          actions: [],
          response_kind: "wait",
          ts: 4,
        },
      ]),
    ).toThrow("decision cursor does not continue");
  });

  it("rejects duplicate action IDs within one decision before materializing intent", () => {
    expect(() =>
      reconstructControllerTimeline([
        definition,
        activation,
        { ...decision, actions: [actionIntent, actionIntent] },
      ]),
    ).toThrow("duplicate action identity in one decision");
  });

  it("does not infer native acceptance from an intent", () => {
    const timeline = reconstructControllerTimeline([definition, activation, decision]);
    expect(getControllerAction(timeline, "delegate-a")?.latestReceipt).toBeNull();
    expect(materializeControllerRecovery(timeline).canActivate).toBe(false);
    expect(materializeControllerRecovery(timeline).requirements[0]?.kind).toBe(
      "host_evidence_required",
    );
  });

  it("blocks activation for uncertainty until a strict repair record resolves ownership", () => {
    const uncertain = receipt("uncertain", { operation_id: "operation-a" });
    const blocked = reconstructControllerTimeline([definition, activation, decision, uncertain]);
    expect(materializeControllerRecovery(blocked)).toMatchObject({ canActivate: false });

    const repair: ControllerRepairRecord = {
      type: "controller_operation_repaired",
      schema_version: 1,
      run_id: "run-1",
      controller_id: "repo-controller",
      definition_digest: definition.definition_digest,
      action_id: "delegate-a",
      operation_id: "operation-a",
      original_activation_id: "activation-1",
      original_record_digest: sha256Canonical(uncertain),
      cleanup: "confirmed",
      partial_effects: "inspected_unpublished",
      operator: "operator",
      operator_note: "Verified cleanup and inspected private preparation effects.",
      ts: 5,
    };
    const repaired = reconstructControllerTimeline([
      definition,
      activation,
      decision,
      uncertain,
      repair,
    ]);
    expect(materializeControllerRecovery(repaired)).toMatchObject({
      canActivate: true,
      requirements: [{ kind: "fresh_action_required", actionId: "delegate-a" }],
    });
    expect(getControllerAction(repaired, "delegate-a")?.latestReceipt?.outcome).toBe("uncertain");
  });

  it.each([
    ["receipt without intent", [definition, activation, receipt("accepted")]],
    [
      "repair without uncertainty",
      [
        definition,
        activation,
        decision,
        {
          type: "controller_operation_repaired",
          schema_version: 1,
          run_id: "run-1",
          controller_id: "repo-controller",
          definition_digest: definition.definition_digest,
          action_id: "delegate-a",
          operation_id: "operation-a",
          original_activation_id: "activation-1",
          original_record_digest: "f".repeat(64),
          cleanup: "confirmed",
          partial_effects: "inspected_unpublished",
          operator: "operator",
          operator_note: "Inspected",
          ts: 5,
        } satisfies ControllerRepairRecord,
      ],
    ],
  ] as const)("rejects %s", (_name, records) => {
    expect(() => reconstructControllerTimeline(records)).toThrow(ControllerRecordError);
  });

  it("validates pinned definition digest and canonical inline request digest", () => {
    expect(() =>
      assertControllerRecord({ ...definition, definition_digest: "0".repeat(64) }),
    ).toThrow(ControllerRecordError);
    expect(() =>
      assertControllerRecord({
        ...decision,
        actions: [{ ...actionIntent, request_sha256: "0".repeat(64) }],
      }),
    ).toThrow(ControllerRecordError);
  });

  it("verifies the exact source ordinal and digest before committing a decision", () => {
    expect(() =>
      reconstructControllerTimeline([
        definition,
        activation,
        { ...decision, consumed_cursor: { ordinal: 1, record_digest: "0".repeat(64) } },
      ]),
    ).toThrow("source cursor digest does not match");
    expect(() =>
      reconstructControllerTimeline([
        definition,
        activation,
        { ...decision, consumed_cursor: { ordinal: 2, record_digest: sha256Canonical(decision) } },
      ]),
    ).toThrow("source cursor does not precede");
  });

  it("allows recovery under a new owner while rejecting a late old-owner receipt", () => {
    const resumed: ControllerActivationStartedRecord = {
      ...activation,
      activation_id: "activation-2",
      owner_epoch: 2,
      reason: "resume",
      previous_activation_id: "activation-1",
      ts: 4,
    };
    expect(() =>
      reconstructControllerTimeline([
        definition,
        activation,
        decision,
        resumed,
        receipt("interrupted"),
      ]),
    ).toThrow("receipt does not belong to the active owner epoch");

    const recovered = receipt("interrupted", {
      activation_id: "activation-2",
      owner_epoch: 2,
      ts: 5,
    });
    expect(
      getControllerAction(
        reconstructControllerTimeline([definition, activation, decision, resumed, recovered]),
        "delegate-a",
      )?.latestReceipt,
    ).toEqual(recovered);
  });

  it("rejects an empty plan and enforces the aggregate outstanding-action limit", () => {
    expect(() => assertControllerRecord({ ...decision, actions: [] })).toThrow(
      "plan decision requires at least one action",
    );
    const secondRequest = {
      kind: "cancel" as const,
      action_id: "cancel-a",
      child_ids: ["child-a"],
    };
    const constrainedWithoutDigest = {
      ...definition,
      limits: { ...definition.limits, max_outstanding_actions: 1 },
    };
    const constrained = {
      ...constrainedWithoutDigest,
      definition_digest: controllerDefinitionDigest(constrainedWithoutDigest),
    };
    const constrainedActivation = {
      ...activation,
      definition_digest: constrained.definition_digest,
    };
    const constrainedDecision = {
      ...decision,
      definition_digest: constrained.definition_digest,
      consumed_cursor: { ordinal: 1, record_digest: sha256Canonical(constrainedActivation) },
    };
    const twoActions: ControllerDecisionCommittedRecord = {
      ...constrainedDecision,
      actions: [
        actionIntent,
        {
          action_id: "cancel-a",
          kind: "cancel",
          request: secondRequest,
          request_sha256: sha256Canonical(secondRequest),
        },
      ],
    };
    expect(() =>
      reconstructControllerTimeline([constrained, constrainedActivation, twoActions]),
    ).toThrow("outstanding-action limit exceeded");
  });

  it("accepts receipt recovery transitions but rejects a second terminal", () => {
    const pending = receipt("pending");
    const accepted = receipt("accepted", { ts: 5 });
    const completed = receipt("completed", { ts: 6 });
    expect(
      getControllerAction(
        reconstructControllerTimeline([
          definition,
          activation,
          decision,
          pending,
          accepted,
          completed,
        ]),
        "delegate-a",
      )?.latestReceipt,
    ).toEqual(completed);
    expect(() =>
      reconstructControllerTimeline([
        definition,
        activation,
        decision,
        pending,
        completed,
        receipt("failed", { ts: 7 }),
      ]),
    ).toThrow("invalid controller action receipt transition");
  });

  it("rejects noncanonical JSON and wrapper/request disagreement", () => {
    expect(() =>
      assertControllerRecord({ ...decision, controller_state: { invalid: Number.NaN } }),
    ).toThrow("non-finite number");
    expect(() =>
      assertControllerRecord({
        ...decision,
        actions: [{ ...actionIntent, kind: "read" }],
      }),
    ).toThrow(ControllerRecordError);
    expect(() =>
      assertControllerRecord({
        ...decision,
        actions: [
          {
            ...actionIntent,
            action_id: "é".repeat(65),
            request: { ...actionIntent.request, action_id: "é".repeat(65) },
          },
        ],
      }),
    ).toThrow("exceeds 128 UTF-8 bytes");
    expect(() =>
      assertControllerRecord(receipt("failed", { diagnostic: "é".repeat(2049) })),
    ).toThrow("diagnostic exceeds its byte limit");
  });
});
