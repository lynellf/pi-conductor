import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { approveControllerDefinition } from "../../src/host/controller/approved-definition.js";
import {
  type ArtifactBinding,
  ArtifactStore,
  type ArtifactStoreError,
} from "../../src/host/controller/artifact-store.js";
import { validateControllerHostApproval } from "../../src/host/controller/host-approval.js";
import {
  appendControllerRecovery,
  planControllerRecovery,
} from "../../src/host/controller/recovery.js";
import { recoverControllerAdapterAction } from "../../src/host/controller/recovery-adapter.js";
import { parseControllerConfig } from "../../src/manifest/controller.js";
import type { ControllerAction } from "../../src/manifest/controller-protocol.js";
import {
  type ControllerActivationStartedRecord,
  type ControllerDecisionCommittedRecord,
  controllerActionRequestDigest,
} from "../../src/persistence/controller-records.js";
import type { ControllerActionState } from "../../src/persistence/controller-timeline.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import type {
  ControllerToolExecutionFinishedRecord,
  ControllerToolExecutionStartedRecord,
} from "../../src/persistence/tool-execution.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const roots: string[] = [];
const exec = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await exec("chmod", ["-R", "u+w", root]);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("controller adapter publication recovery", () => {
  it("recovers one existing immutable publication without appending a duplicate receipt", async () => {
    const fixture = await adapterFixture();
    await publish(fixture.artifacts, fixture.binding);
    const records = [...fixture.records, fixture.start, fixture.finished];
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.definition,
      records,
      artifacts: fixture.artifacts,
    });

    expect(plan).toMatchObject({
      canActivate: true,
      receipts: [
        {
          actionId: "adapter-a",
          outcome: "completed",
          operationId: fixture.start.origin.operation_id,
        },
      ],
    });
    const appended: PersistedRecord[] = [];
    appendControllerRecovery(plan, fixture.resumeActivation, (record) => appended.push(record));
    const afterRecovery = await planControllerRecovery({
      approvedDefinition: fixture.definition,
      records: [...records, ...appended],
      artifacts: fixture.artifacts,
    });
    expect(afterRecovery.receipts).toEqual([]);
  });

  it("reconstructs the exact private-input audience before recovering an adapter artifact", async () => {
    const fixture = await adapterFixture();
    const audience = [{ kind: "native" as const, profile_id: "worker" }];
    await publish(fixture.artifacts, { ...fixture.binding, audience });
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.definition,
      records: [...fixture.records, fixture.start, fixture.finished],
      artifacts: {
        recoverAction: (binding) => fixture.artifacts.recoverAction(binding),
        rangeReadForController: (request) => fixture.artifacts.rangeReadForController(request),
        async getInputAudience(ref, principal) {
          expect(ref).toBe("input-a");
          expect(principal).toEqual({ kind: "adapter", adapter_id: "adapter" });
          return audience;
        },
      },
    });

    expect(plan).toMatchObject({
      canActivate: true,
      receipts: [{ actionId: "adapter-a", outcome: "completed" }],
    });
  });

  it("does not silently use legacy authority for a configured output without a resolver", async () => {
    const fixture = await adapterFixture();
    const configuredDefinition = {
      ...fixture.definition,
      config: {
        ...fixture.definition.config,
        adapters: fixture.definition.config.adapters.map((adapter) => ({
          ...adapter,
          output_consumers: [{ kind: "controller" as const }],
        })),
      },
    };

    await expect(
      planControllerRecovery({
        approvedDefinition: configuredDefinition,
        records: [...fixture.records, fixture.start, fixture.finished],
        artifacts: fixture.artifacts,
      }),
    ).rejects.toThrow("requires an output audience resolver");
  });

  it("does not claim an effect-backed adapter completed without journal reconciliation", async () => {
    const fixture = await adapterFixture();
    const audience = [{ kind: "effect" as const, effect_id: "git-integrate" }];
    await publish(fixture.artifacts, { ...fixture.binding, audience });
    const effectDefinition = {
      ...fixture.definition,
      config: {
        ...fixture.definition.config,
        adapters: fixture.definition.config.adapters.map((adapter) => ({
          ...adapter,
          effect_id: "git-integrate",
          output_consumers: audience,
        })),
      },
    };
    const plan = await planControllerRecovery({
      approvedDefinition: effectDefinition,
      records: [...fixture.records, fixture.start, fixture.finished],
      artifacts: {
        recoverAction: (binding) => fixture.artifacts.recoverAction(binding),
        rangeReadForController: (request) => fixture.artifacts.rangeReadForController(request),
        async getInputAudience() {
          return null;
        },
      },
    });

    expect(plan.receipts).toEqual([]);
    expect(plan.blocked).toContain(
      "effect-backed adapter action adapter-a has no effect recovery authority",
    );
    expect(plan.canActivate).toBe(false);
  });

  it("uses the effect journal recovery receipt instead of treating its request artifact as success", async () => {
    const fixture = await adapterFixture();
    const audience = [{ kind: "effect" as const, effect_id: "git-integrate" }];
    await publish(fixture.artifacts, { ...fixture.binding, audience });
    const effectDefinition = {
      ...fixture.definition,
      config: {
        ...fixture.definition.config,
        adapters: fixture.definition.config.adapters.map((adapter) => ({
          ...adapter,
          effect_id: "git-integrate",
          output_consumers: audience,
        })),
      },
    };
    let reconciled = false;
    const plan = await planControllerRecovery({
      approvedDefinition: effectDefinition,
      records: [...fixture.records, fixture.start, fixture.finished],
      artifacts: {
        recoverAction: (binding) => fixture.artifacts.recoverAction(binding),
        rangeReadForController: (request) => fixture.artifacts.rangeReadForController(request),
        async getInputAudience() {
          return null;
        },
        async recoverEffectAction(action, artifact) {
          reconciled = true;
          expect(artifact.binding.actionId).toBe("adapter-a");
          return {
            receipts: [
              {
                actionId: action.actionId,
                outcome: "completed" as const,
                operationId: "effect-operation",
                resultRefs: ["artifact/v1/effect-result"],
                diagnostic: null,
                intentActivationId: action.intentActivationId,
                causalRevision: action.originalRevision,
                requestSha256: action.intent.request_sha256,
                kind: action.intent.kind,
              },
            ],
            blocked: [],
          };
        },
      },
    });

    expect(reconciled).toBe(true);
    expect(plan.receipts).toMatchObject([
      { outcome: "completed", resultRefs: ["artifact/v1/effect-result"] },
    ]);
  });

  it("rejects a publication whose binding changed after the adapter execution", async () => {
    const fixture = await adapterFixture();
    await publish(fixture.artifacts, { ...fixture.binding, capabilityDigest: "f".repeat(64) });

    await expect(
      planControllerRecovery({
        approvedDefinition: fixture.definition,
        records: [...fixture.records, fixture.start, fixture.finished],
        artifacts: fixture.artifacts,
      }),
    ).rejects.toMatchObject({
      code: "artifact-binding-mismatch",
    } satisfies Partial<ArtifactStoreError>);
  });

  it("blocks a started adapter without terminal cleanup evidence", async () => {
    const fixture = await adapterFixture();
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.definition,
      records: [...fixture.records, fixture.start],
      artifacts: fixture.artifacts,
    });

    expect(plan.canActivate).toBe(false);
    expect(plan.blocked).toContain("controller executable execution-a has unresolved ownership");
  });

  it("does not replay a source adapter when capture evidence is incomplete", async () => {
    const fixture = await adapterFixture();
    const request: Extract<ControllerAction, { readonly kind: "adapter" }> = {
      kind: "adapter",
      action_id: "adapter-a",
      adapter_id: "adapter",
      input_refs: [],
      source_workspace_ref: `source-workspace/v1/${"a".repeat(64)}/${"b".repeat(64)}`,
    };
    const requestSha256 = controllerActionRequestDigest(
      fixture.definition.record.definition_digest,
      request,
    );
    const action: ControllerActionState = {
      actionId: request.action_id,
      intent: {
        action_id: request.action_id,
        kind: request.kind,
        request_sha256: requestSha256,
        request,
      },
      intentActivationId: fixture.start.origin.activation_id,
      originalRevision: 1,
      latestReceipt: null,
      receipts: [],
      repair: null,
    };
    const started = {
      ...fixture.start,
      origin: { ...fixture.start.origin, request_sha256: requestSha256 },
    };
    const finished = {
      ...fixture.finished,
      origin: started.origin,
      sandbox: {
        category: "output_incomplete" as const,
        normalized_status: 7,
        signal: "unknown" as const,
        termination_requested: false,
        cleanup: "confirmed" as const,
      },
    };
    const recoverActionPayload = vi.fn();

    const recovered = await recoverControllerAdapterAction(
      {
        recoverAction: fixture.artifacts.recoverAction.bind(fixture.artifacts),
        recoverActionPayload,
        rangeReadForController: fixture.artifacts.rangeReadForController.bind(fixture.artifacts),
        getInputAudience: async () => [{ kind: "adapter" as const, adapter_id: "adapter" }],
      },
      fixture.definition,
      action,
      { entries: [{ started, finished }], unfinished: [], unresolved: [], timeout_count: 0 },
    );

    expect(recovered.blocked).toContain(
      "source adapter action adapter-a lacks complete captured execution evidence; requires action repair",
    );
    expect(recoverActionPayload).not.toHaveBeenCalled();
  });

  it("recovers a complete source envelope only when it matches the durable execution", async () => {
    const fixture = await adapterFixture();
    const request: Extract<ControllerAction, { readonly kind: "adapter" }> = {
      kind: "adapter",
      action_id: "adapter-a",
      adapter_id: "adapter",
      input_refs: [],
      source_workspace_ref: `source-workspace/v1/${"a".repeat(64)}/${"b".repeat(64)}`,
    };
    const requestSha256 = controllerActionRequestDigest(
      fixture.definition.record.definition_digest,
      request,
    );
    const action: ControllerActionState = {
      actionId: request.action_id,
      intent: {
        action_id: request.action_id,
        kind: request.kind,
        request_sha256: requestSha256,
        request,
      },
      intentActivationId: fixture.start.origin.activation_id,
      originalRevision: 1,
      latestReceipt: null,
      receipts: [],
      repair: null,
    };
    const started = {
      ...fixture.start,
      origin: { ...fixture.start.origin, request_sha256: requestSha256 },
    };
    const binding = {
      ...fixture.binding,
      requestDigest: requestSha256,
      producer: {
        kind: "operation" as const,
        operationId: started.origin.operation_id,
        requestDigest: requestSha256,
      },
      outputSchema: {
        id: "source-adapter-envelope-v1",
        digest: sha256Canonical({ schema_version: 1, kind: "source-adapter-envelope" }),
      },
      audience: [{ kind: "adapter" as const, adapter_id: "adapter" }],
    };
    const envelope = {
      schema_version: 1,
      source: {
        ref: request.source_workspace_ref,
        base_commit: "base",
        head_commit: "head",
        tree_id: "tree",
        inventory_digest: "inventory",
        policy_digest: "policy",
      },
      execution: {
        execution_id: started.execution_id,
        normalized_status: 7,
        capture: "complete",
        cleanup: "confirmed",
      },
      result: null,
    };
    await publish(fixture.artifacts, binding, JSON.stringify(envelope));
    const finished = {
      ...fixture.finished,
      origin: started.origin,
      sandbox: {
        category: "command_status" as const,
        normalized_status: 7,
        signal: "unknown" as const,
        termination_requested: false,
        cleanup: "confirmed" as const,
        output: {
          schemaVersion: 1 as const,
          outputRef: "00000000-0000-4000-8000-000000000000",
          capture: "complete" as const,
          stdout: { byteCount: 1, retainedVerified: true as const, sha256: "a".repeat(64) },
          stderr: { byteCount: 0, retainedVerified: true as const, sha256: "b".repeat(64) },
        },
      },
    };

    const recovered = await recoverControllerAdapterAction(
      {
        recoverAction: fixture.artifacts.recoverAction.bind(fixture.artifacts),
        recoverActionPayload: fixture.artifacts.recoverActionPayload.bind(fixture.artifacts),
        rangeReadForController: fixture.artifacts.rangeReadForController.bind(fixture.artifacts),
        getInputAudience: async () => [{ kind: "adapter" as const, adapter_id: "adapter" }],
      },
      fixture.definition,
      action,
      { entries: [{ started, finished }], unfinished: [], unresolved: [], timeout_count: 0 },
    );

    expect(recovered.receipts).toMatchObject([{ actionId: "adapter-a", outcome: "completed" }]);
  });

  it("requires action repair when a clean adapter has no immutable publication", async () => {
    const fixture = await adapterFixture();
    const plan = await planControllerRecovery({
      approvedDefinition: fixture.definition,
      records: [...fixture.records, fixture.start, fixture.finished],
      artifacts: fixture.artifacts,
    });

    expect(plan.canActivate).toBe(false);
    expect(plan.blocked).toContain(
      "adapter action adapter-a has no immutable publication; requires action repair",
    );
  });
});

async function adapterFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-controller-recovery-"));
  roots.push(root);
  const inputSchema = Type.Object(
    {
      protocol_version: Type.Literal(1),
      run_id: Type.String(),
      controller_id: Type.String(),
      definition_digest: Type.String(),
      action_id: Type.String(),
      input_refs: Type.Array(Type.Object({ ref: Type.String(), value: Type.Unknown() })),
    },
    { additionalProperties: false },
  );
  const outputSchema = Type.Object({ packet: Type.String() }, { additionalProperties: false });
  const config = parseControllerConfig({
    protocol_version: 1,
    controller_id: "planner",
    runtime_id: "runtime",
    executable: "/bin/planner",
    argv: ["--fixed"],
    adapters: [
      {
        id: "adapter",
        runtime_id: "runtime",
        executable: "/bin/adapter",
        argv: ["--fixed"],
        input_schema_id: "adapter-input",
        output_schema_id: "adapter-output",
        capability: "private_staging",
      },
    ],
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
            { path: "bin/adapter", sha256: "d".repeat(64) },
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
    adapters: config.adapters,
    schemas: [
      {
        schema_id: "adapter-input",
        schema_digest: sha256Canonical(inputSchema),
        schema: inputSchema,
      },
      {
        schema_id: "adapter-output",
        schema_digest: sha256Canonical(outputSchema),
        schema: outputSchema,
      },
    ],
  });
  const definition = approveControllerDefinition("run-a", config, approval, 1);
  const activation: ControllerActivationStartedRecord = {
    type: "controller_activation_started",
    schema_version: 1,
    run_id: definition.record.run_id,
    controller_id: definition.record.controller_id,
    definition_digest: definition.record.definition_digest,
    activation_id: "activation-a",
    owner_epoch: 1,
    reason: "start",
    previous_activation_id: null,
    ts: 2,
  };
  const action: Extract<ControllerAction, { readonly kind: "adapter" }> = {
    kind: "adapter",
    action_id: "adapter-a",
    adapter_id: "adapter",
    input_refs: ["input-a"],
  };
  const requestDigest = controllerActionRequestDigest(definition.record.definition_digest, action);
  const decision: ControllerDecisionCommittedRecord = {
    type: "controller_decision_committed",
    schema_version: 1,
    run_id: definition.record.run_id,
    controller_id: definition.record.controller_id,
    definition_digest: definition.record.definition_digest,
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
        request_sha256: requestDigest,
        request: action,
      },
    ],
    ts: 3,
  };
  const start: ControllerToolExecutionStartedRecord = {
    type: "tool_execution_started",
    schema_version: 2,
    run_id: definition.record.run_id,
    execution_id: "execution-a",
    supervision_id: "supervision-a",
    origin: {
      kind: "controller_operation",
      controller_id: definition.record.controller_id,
      definition_digest: definition.record.definition_digest,
      activation_id: activation.activation_id,
      owner_epoch: activation.owner_epoch,
      operation_id: "operation-a",
      operation_kind: "adapter",
      action_id: action.action_id,
      request_sha256: requestDigest,
    },
    timeout_ms: 30_000,
    recovery_count: 0,
    ts: 4,
  };
  const finished: ControllerToolExecutionFinishedRecord = {
    type: "tool_execution_finished",
    schema_version: 2,
    run_id: definition.record.run_id,
    execution_id: start.execution_id,
    supervision_id: start.supervision_id,
    origin: start.origin,
    elapsed_ms: 20,
    recovery_count: 0,
    outcome: "completed",
    cleanup: "confirmed",
    ts: 5,
  };
  const adapter = config.adapters[0];
  const authority = definition.record.adapter_authorities[0];
  const output = approval.schemas.find((entry) => entry.schema_id === adapter?.output_schema_id);
  if (adapter === undefined || authority === undefined || output === undefined)
    throw new Error("adapter fixture authority is incomplete");
  const binding: ArtifactBinding = {
    runId: definition.record.run_id,
    definitionDigest: definition.record.definition_digest,
    actionId: action.action_id,
    requestDigest,
    producer: { kind: "operation", operationId: start.origin.operation_id, requestDigest },
    outputSchema: { id: adapter.output_schema_id, digest: output.schema_digest },
    capabilityDigest: authority.capability_digest,
    mediaType: "application/json",
    allowedConsumerProfileIds: [...config.delegation.allowed_subagents],
  };
  const artifacts = await ArtifactStore.open({ root });
  const resumeActivation: ControllerActivationStartedRecord = {
    ...activation,
    activation_id: "activation-b",
    owner_epoch: 2,
    reason: "resume",
    previous_activation_id: activation.activation_id,
    ts: 6,
  };
  return {
    definition,
    artifacts,
    binding,
    start,
    finished,
    resumeActivation,
    records: [definition.record, activation, decision] as readonly PersistedRecord[],
  };
}

async function publish(
  artifacts: ArtifactStore,
  binding: ArtifactBinding,
  payload = '{"packet":"ready"}',
): Promise<void> {
  const staging = await artifacts.createStaging(binding.actionId);
  await writeFile(staging.outputPath, payload);
  await artifacts.publish({ staging, binding, validate: () => {} });
}
