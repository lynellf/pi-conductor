import { describe, expect, it } from "vitest";
import { createControllerActionDispatcher } from "../../src/host/controller/action-dispatcher.js";
import type {
  CreateControllerActionDispatcherOptions,
  ReceiptFields,
} from "../../src/host/controller/action-dispatcher-contract.js";
import { controllerActionRef } from "../../src/host/controller/controller-refs.js";
import { ControllerEffectPendingError } from "../../src/host/controller/production-effects.js";
import { SourceWorkspaceError } from "../../src/host/controller/source-workspace-contract.js";
import { ToolExecutionError } from "../../src/host/execution/tool-execution-controller.js";
import type { ControllerAction } from "../../src/manifest/controller-protocol.js";
import {
  type ControllerActivationStartedRecord,
  type ControllerDecisionCommittedRecord,
  type ControllerDefinitionPinnedRecord,
  controllerActionRequestDigest,
  controllerDefinitionDigest,
} from "../../src/persistence/controller-records.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const definitionBase = {
  type: "controller_definition_pinned" as const,
  schema_version: 1 as const,
  run_id: "run-dispatch",
  controller_id: "controller",
  pinned_definition: { protocol_version: 1 },
  controller_authority: authority("a"),
  adapter_authorities: [],
  limits: { max_decisions: 20, max_actions: 20, max_outstanding_actions: 20 },
  ts: 1,
};
const definition: ControllerDefinitionPinnedRecord = {
  ...definitionBase,
  definition_digest: controllerDefinitionDigest(definitionBase),
};
const activation: ControllerActivationStartedRecord = {
  type: "controller_activation_started",
  schema_version: 1,
  run_id: definition.run_id,
  controller_id: definition.controller_id,
  definition_digest: definition.definition_digest,
  activation_id: "activation",
  owner_epoch: 1,
  reason: "start",
  previous_activation_id: null,
  ts: 2,
};

describe("controller action dispatcher", () => {
  it("reports bounded source failure codes through the execution wrapper", async () => {
    const fixture = dispatcherFixture(
      [
        {
          kind: "prepare_source",
          action_id: "conflict",
          source_id: "repo",
          repository_ref: "refs/heads/main",
        },
      ],
      false,
      {},
      {
        sources: {
          validate: async () => undefined,
          resolve: async () => {
            throw new Error("unused");
          },
          prepare: async () => {
            throw new ToolExecutionError("tool_failed", "tool execution failed", {
              cause: new SourceWorkspaceError("patch-conflict", "private host path must not leak"),
            });
          },
        },
      },
    );
    fixture.dispatcher.dispatchCommitted("conflict");
    await fixture.dispatcher.settle();
    expect(
      [...fixture.records].reverse().find((record) => record.type === "controller_action_receipt"),
    ).toMatchObject({ outcome: "failed", diagnostic: "source preparation failed: patch-conflict" });
  });

  it("prepares source while an unrelated delivery is pending", async () => {
    let release: ((fields: ReceiptFields) => void) | undefined;
    const gate = new Promise<ReceiptFields>((resolve) => {
      release = resolve;
    });
    const prepare: ControllerAction = {
      kind: "prepare_source",
      action_id: "source-a",
      source_id: "repo",
      repository_ref: "refs/heads/main",
    };
    const fixture = dispatcherFixture(
      [adapterAction("deliver"), prepare],
      false,
      {},
      {
        runAdapterEffect: () => gate,
        sources: {
          validate: async () => undefined,
          resolve: async () => ({
            descriptor: { head_commit: "a".repeat(40) },
            audience: [{ kind: "controller" }],
          }),
          prepare: async () => ({
            outcome: "completed",
            operation_id: "source-op",
            result_refs: ["source-workspace/v1/a/b"],
            diagnostic: null,
          }),
        },
      },
    );
    fixture.dispatcher.dispatchCommitted("deliver");
    fixture.dispatcher.dispatchCommitted("source-a");
    await until(() => fixture.receipts("source-a").includes("completed"));
    expect(fixture.receipts("deliver")).toEqual(["pending"]);
    release?.({ outcome: "completed", operation_id: "effect", result_refs: [], diagnostic: null });
    await fixture.dispatcher.settle();
  });

  it.each([
    [-1, 1],
    [0.5, 1],
    [Number.NaN, 1],
    [0, 0],
    [0, 0.5],
    [0, 32769],
  ])("rejects output range %s/%s before reading private bytes", async (offset, limit) => {
    const fixture = dispatcherFixture(
      [],
      false,
      {},
      {
        outputResolver: {
          resolveRef: async () => {
            throw new Error("must not read bytes");
          },
          getInputAudience: async () => null,
        },
      },
    );
    await expect(fixture.dispatcher.read("child-output/v2/example", offset, limit)).rejects.toThrow(
      "controller read range is invalid",
    );
  });

  it("validates adapter record inputs through the record reader when output resolution is installed", async () => {
    const adapter: Extract<ControllerAction, { kind: "adapter" }> = {
      kind: "adapter",
      action_id: "validate-record",
      adapter_id: "adapter",
      input_refs: [controllerActionRef(activation, "validate-record")],
    };
    const fixture = dispatcherFixture(
      [adapter],
      false,
      {},
      {
        outputResolver: {
          resolveRef: async () => {
            throw new Error("record is not an artifact");
          },
          getInputAudience: async () => {
            throw new Error("record has no artifact audience");
          },
        },
      },
    );
    await expect(fixture.dispatcher.validateReferences([adapter])).resolves.toBeUndefined();
    await expect(
      fixture.dispatcher.resolveRef(adapter.input_refs[0] ?? "", {
        kind: "adapter",
        adapter_id: "adapter",
      }),
    ).resolves.toHaveProperty("actionId", "validate-record");
  });

  it("releases the adapter slot while a delivery effect is gated and admits a native successor", async () => {
    let release: ((fields: ReceiptFields) => void) | undefined;
    const gate = new Promise<ReceiptFields>((resolve) => {
      release = resolve;
    });
    const fixture = dispatcherFixture(
      [adapterAction("deliver"), adapterAction("validate"), delegateAction("successor")],
      false,
      {},
      {
        maxAdapters: 1,
        runAdapterEffect: (request) => (request.action_id === "deliver" ? gate : null),
      },
    );
    fixture.dispatcher.dispatchCommitted("deliver");
    fixture.dispatcher.dispatchCommitted("validate");
    fixture.dispatcher.dispatchCommitted("successor");
    await until(() => fixture.adapterCalls === 2 && fixture.submits.length === 1);
    await until(() => fixture.receipts("validate").includes("completed"));
    expect(fixture.receipts("deliver")).toEqual(["pending"]);
    expect(fixture.submits).toEqual(["successor"]);
    await until(() => fixture.receipts("successor").includes("accepted"));
    release?.({ outcome: "completed", operation_id: "effect", result_refs: [], diagnostic: null });
    fixture.finishChildren();
    await fixture.dispatcher.settle();
    expect(fixture.receipts("deliver")).toEqual(["pending", "completed"]);
  });
  it("keeps uncertain delivery pending for journal reconciliation instead of claiming failure", async () => {
    const failures: unknown[] = [];
    const fixture = dispatcherFixture(
      [adapterAction("deliver")],
      false,
      {},
      {
        runAdapterEffect: async () => {
          throw new ControllerEffectPendingError("a".repeat(64));
        },
        onFatal: (cause) => {
          failures.push(cause);
        },
      },
    );
    fixture.dispatcher.dispatchCommitted("deliver");
    await fixture.dispatcher.settle();
    expect(fixture.receipts("deliver")).toEqual(["pending"]);
    expect(failures.some((cause) => cause instanceof ControllerEffectPendingError)).toBe(true);
  });

  it("binds an uncertain receipt to the operation rather than the supervision execution ID", async () => {
    const action = adapterAction("adapter-a");
    const failures: unknown[] = [];
    const fixture = dispatcherFixture(
      [action],
      false,
      {},
      {
        onFatal: (cause) => {
          failures.push(cause);
        },
        executables: {
          invokeAdapter: async () => {
            fixture.records.push({
              type: "tool_execution_started",
              schema_version: 2,
              run_id: activation.run_id,
              execution_id: "exec-1",
              supervision_id: "supervision-1",
              timeout_ms: 1000,
              recovery_count: 0,
              ts: 5,
              origin: {
                kind: "controller_operation",
                controller_id: activation.controller_id,
                definition_digest: activation.definition_digest,
                activation_id: activation.activation_id,
                owner_epoch: activation.owner_epoch,
                operation_id: "operation-1",
                operation_kind: "adapter",
                action_id: action.action_id,
                request_sha256: controllerActionRequestDigest(activation.definition_digest, action),
              },
            });
            throw new ToolExecutionError("tool_cleanup_unconfirmed", "unresolved owner", {
              cleanup: "unconfirmed",
              executionId: "exec-1",
            });
          },
        },
      },
    );
    fixture.dispatcher.dispatchCommitted(action.action_id);
    await fixture.dispatcher.settle();
    expect(fixture.receipts(action.action_id)).toEqual(["pending", "uncertain"]);
    expect(fixture.records.at(-1)).toMatchObject({ operation_id: "operation-1" });
    expect(failures).toHaveLength(1);
  });

  it("poisons an ambiguous receipt append without attempting a second failure receipt", async () => {
    const failures: unknown[] = [];
    const fixture = dispatcherFixture(
      [adapterAction("adapter-a")],
      false,
      {},
      {
        onFatal: (cause) => {
          failures.push(cause);
        },
        persist: (record) => {
          fixture.records.push(record);
          if (record.type === "controller_action_receipt" && record.outcome === "completed")
            throw new Error("append acknowledgment lost");
        },
      },
    );
    fixture.dispatcher.dispatchCommitted("adapter-a");
    await fixture.dispatcher.settle();
    expect(fixture.receipts("adapter-a")).toEqual(["pending", "completed"]);
    expect(
      failures.some(
        (cause) =>
          cause instanceof ToolExecutionError && cause.code === "tool_persistence_ambiguous",
      ),
    ).toBe(true);
  });
  it("does not replay construction and dispatches a duplicate action only once", async () => {
    const adapter = adapterAction("adapter-a");
    const fixture = dispatcherFixture([adapter]);
    const dispatcher = fixture.dispatcher;
    expect(fixture.adapterCalls).toBe(0);
    dispatcher.dispatchCommitted("adapter-a");
    dispatcher.dispatchCommitted("adapter-a");
    await dispatcher.settle();
    expect(fixture.adapterCalls).toBe(1);
    expect(fixture.receipts("adapter-a")).toEqual(["pending", "completed"]);
  });

  it("keeps native preparation FIFO while child A waits and B submits", async () => {
    const fixture = dispatcherFixture([delegateAction("native-a"), delegateAction("native-b")]);
    fixture.dispatcher.dispatchCommitted("native-a");
    fixture.dispatcher.dispatchCommitted("native-b");
    await until(() => fixture.submits.length === 2);
    await until(() => fixture.receipts("native-b").length === 2);
    expect(fixture.submits).toEqual(["native-a", "native-b"]);
    expect(fixture.receipts("native-a")).toEqual(["pending", "accepted"]);
    expect(fixture.receipts("native-b")).toEqual(["pending", "accepted"]);
    fixture.finishChildren();
    await fixture.dispatcher.settle();
  });

  it("does not append a conflicting native terminal after losing its append acknowledgment", async () => {
    const failures: unknown[] = [];
    const fixture = dispatcherFixture(
      [delegateAction("native-a")],
      false,
      {},
      {
        onFatal: (cause) => {
          failures.push(cause);
        },
        persist: (record) => {
          fixture.records.push(record);
          if (record.type === "controller_action_receipt" && record.outcome === "completed")
            throw new Error("native terminal append acknowledgment lost");
        },
      },
    );
    fixture.dispatcher.dispatchCommitted("native-a");
    await until(() => fixture.receipts("native-a").includes("accepted"));
    fixture.finishChildren();
    await fixture.dispatcher.settle();
    expect(fixture.receipts("native-a")).toEqual(["pending", "accepted", "completed"]);
    expect(
      failures.some(
        (cause) =>
          cause instanceof ToolExecutionError && cause.code === "tool_persistence_ambiguous",
      ),
    ).toBe(true);
  });

  it("runs one adapter FIFO independently while native children remain active", async () => {
    const fixture = dispatcherFixture(
      [delegateAction("native-a"), adapterAction("adapter-a"), adapterAction("adapter-b")],
      true,
    );
    fixture.dispatcher.dispatchCommitted("native-a");
    fixture.dispatcher.dispatchCommitted("adapter-a");
    fixture.dispatcher.dispatchCommitted("adapter-b");
    await until(() => fixture.adapterCalls === 1 && fixture.submits.length === 1);
    fixture.releaseAdapter();
    await until(() => fixture.adapterCalls === 2);
    fixture.releaseAdapter();
    fixture.finishChildren();
    await fixture.dispatcher.settle();
    expect(fixture.adapterOrder).toEqual(["adapter-a", "adapter-b"]);
  });

  it("resolves a full artifact across verified 32KiB range pages", async () => {
    const payload = { prefix: "x".repeat(33_000), trailing: "preserved" };
    const fixture = dispatcherFixture([adapterAction("adapter-a")], false, payload);
    await expect(
      fixture.dispatcher.resolveRef(`artifact/v1/${"a".repeat(64)}/${"b".repeat(64)}`),
    ).resolves.toEqual(payload);
    expect(fixture.artifactReads).toBeGreaterThanOrEqual(2);
  });

  it("returns bounded non-artifact pages at the requested offset", async () => {
    const fixture = dispatcherFixture([adapterAction("adapter-a")]);
    const page = await fixture.dispatcher.read(controllerActionRef(activation, "adapter-a"), 2, 5);
    if (page.kind === "artifact") throw new Error("expected controller page");
    expect(page.value.offset).toBe(2);
    expect(Buffer.from(page.value.data, "base64").byteLength).toBeLessThanOrEqual(5);
  });

  it("completes a record read when an output resolver is installed", async () => {
    const action: Extract<ControllerAction, { readonly kind: "read" }> = {
      kind: "read",
      action_id: "read-record",
      ref: controllerActionRef(activation, "read-record"),
    };
    const fixture = dispatcherFixture(
      [action],
      false,
      {},
      {
        outputResolver: {
          resolveRef: async () => {
            throw new Error("record reads must not resolve an output");
          },
          getInputAudience: async () => {
            throw new Error("record reads must not query output audience");
          },
        },
        artifacts: {
          rangeReadForController: async () => {
            throw new Error("not used");
          },
          createStaging: async () => ({
            actionId: "read-record",
            directory: "/tmp",
            outputPath: `/tmp/pi-conductor-read-${process.pid}-${Date.now()}`,
          }),
          publish: async () => ({ ref: "artifact/v1/a/b" }) as never,
        },
      },
    );

    fixture.dispatcher.dispatchCommitted(action.action_id);
    await fixture.dispatcher.settle();
    expect(fixture.receipts(action.action_id)).toEqual(["pending", "completed"]);
  });
});

function dispatcherFixture(
  actions: readonly ControllerAction[],
  gateAdapters = false,
  artifact = {},
  overrides: Partial<CreateControllerActionDispatcherOptions> = {},
) {
  const decision = decisionFor(actions);
  const records: PersistedRecord[] = [definition, activation, decision];
  const childWaiters = new Map<string, () => void>();
  const submits: string[] = [];
  const adapterOrder: string[] = [];
  let adapterCalls = 0;
  let artifactReads = 0;
  let releaseAdapter: () => void = () => undefined;
  const dispatcher = createControllerActionDispatcher({
    activation,
    readRecords: () => records,
    persist: (record) => records.push(record),
    assertOpen: () => undefined,
    wake: () => undefined,
    onFatal: (cause) => {
      throw cause;
    },
    runNativePreparation: async (_action, operation) => operation(),
    admission: {
      submit: async (source) => {
        submits.push(source.actionId);
        return [`child-${source.actionId}`];
      },
      acceptedSubmission: (actionId) =>
        ({
          schema_version: 3,
          origin: { kind: "controller_action", action_id: actionId },
        }) as never,
      status: () => [],
      remainingChildren: () => 9,
      cancel: async () => undefined,
      wait: async (childId) =>
        new Promise((resolve) =>
          childWaiters.set(childId, () => {
            resolve({ status: "completed" } as never);
          }),
        ),
    },
    executables: {
      invokeAdapter: async (action) => {
        adapterCalls += 1;
        adapterOrder.push(action.action_id);
        if (gateAdapters)
          await new Promise<void>((resolve) => {
            releaseAdapter = resolve;
          });
        return {
          operationId: `op-${action.action_id}`,
          artifact: { ref: `artifact/v1/${"a".repeat(64)}/${"b".repeat(64)}` },
        } as never;
      },
    },
    artifacts: {
      rangeReadForController: async (request) => {
        artifactReads += 1;
        const bytes = Buffer.from(JSON.stringify(artifact), "utf8");
        return {
          bytes: bytes.subarray(request.offset, request.offset + request.length),
          binding: {} as never,
          sha256: "a".repeat(64),
          byteLength: bytes.byteLength,
          mediaType: "application/json" as const,
        };
      },
      createStaging: async () => {
        throw new Error("not used");
      },
      publish: async () => {
        throw new Error("not used");
      },
    },
    ...overrides,
  } satisfies CreateControllerActionDispatcherOptions);
  return {
    dispatcher,
    records,
    submits,
    adapterOrder,
    get adapterCalls() {
      return adapterCalls;
    },
    get artifactReads() {
      return artifactReads;
    },
    releaseAdapter: () => releaseAdapter(),
    finishChildren: () => {
      childWaiters.forEach((resolve) => {
        resolve();
      });
    },
    receipts: (id: string) =>
      records
        .filter(
          (r): r is Extract<PersistedRecord, { readonly type: "controller_action_receipt" }> =>
            r.type === "controller_action_receipt" && r.action_id === id,
        )
        .map((r) => r.outcome),
  };
}

function decisionFor(actions: readonly ControllerAction[]): ControllerDecisionCommittedRecord {
  return {
    type: "controller_decision_committed",
    schema_version: 1,
    run_id: definition.run_id,
    controller_id: definition.controller_id,
    definition_digest: definition.definition_digest,
    activation_id: activation.activation_id,
    owner_epoch: 1,
    decision_id: `decision-${actions.map((a) => a.action_id).join("-")}`,
    prior_revision: 0,
    state_revision: 1,
    prior_cursor: null,
    consumed_cursor: { ordinal: 1, record_digest: sha256Canonical(activation) },
    response_kind: "plan",
    controller_state: {},
    decision_payload: null,
    actions: actions.map((request) => ({
      action_id: request.action_id,
      kind: request.kind,
      request,
      request_sha256: controllerActionRequestDigest(definition.definition_digest, request),
    })),
    ts: 3,
  };
}
function adapterAction(action_id: string): Extract<ControllerAction, { readonly kind: "adapter" }> {
  return { kind: "adapter", action_id, adapter_id: "adapter", input_refs: [] };
}
function delegateAction(
  action_id: string,
): Extract<ControllerAction, { readonly kind: "delegate" }> {
  return {
    kind: "delegate",
    action_id,
    tasks: [
      { id: `task-${action_id}`, subagent: "worker", objective: "do", expected_output: "done" },
    ],
  };
}
function authority(char: string) {
  return {
    registration_id: "id",
    approval_id: "approval",
    runtime_digest: char.repeat(64),
    executable_digest: char.repeat(64),
    capability_digest: char.repeat(64),
  };
}
async function until(predicate: () => boolean): Promise<void> {
  while (!predicate()) await Promise.resolve();
}
