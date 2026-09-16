import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createControllerEffectBroker,
  EffectBrokerPoisonedError,
} from "../../src/host/controller/effect-broker.js";
import type {
  EffectBrokerDependencies,
  EffectBrokerExecutors,
} from "../../src/host/controller/effect-broker-contract.js";
import { inEffectLane } from "../../src/host/controller/effect-broker-support.js";
import {
  type EffectGrant,
  pinEffectAuthority,
  type SupportedEffectImplementation,
} from "../../src/host/controller/effect-registry.js";
import {
  type DeliverRefRequest,
  effectRequestSchemaDigest,
  effectResultSchemaDigest,
} from "../../src/manifest/controller-effect.js";
import type {
  ControllerEffectRecord,
  EffectRequestArtifact,
} from "../../src/persistence/controller-effect-records.js";

const sha = (character: string) => character.repeat(64);
const implementation: SupportedEffectImplementation = {
  id: "builtin-deliver-ref-v1",
  kind: "deliver_ref",
  digest: sha("1"),
  request_schema_id: "deliver-ref-request-v1",
  request_schema_digest: effectRequestSchemaDigest("deliver_ref"),
  output_schema_id: "deliver-ref-result-v1",
  output_schema_digest: effectResultSchemaDigest("deliver_ref"),
};
const grant: EffectGrant = {
  schema_version: 1,
  id: "delivery",
  adapter_id: "delivery-adapter",
  kind: "deliver_ref",
  implementation_id: implementation.id,
  implementation_digest: implementation.digest,
  request_schema_id: implementation.request_schema_id,
  request_schema_digest: implementation.request_schema_digest,
  output_schema_id: implementation.output_schema_id,
  output_schema_digest: implementation.output_schema_digest,
  repository: { id: "repo", canonical_path: "/srv/repo", fingerprint: sha("2") },
  remote: {
    id: "origin",
    exact_origin: "https://delivery.invalid",
    exact_path: "/v1/ref",
    method: "PUT",
    credential_source_id: "credential",
  },
  allowed_source_refs: ["refs/integration/reviewed"],
  allowed_target_refs: ["refs/heads/main"],
  required_evidence: [{ producer_id: "validator", schema_id: "validation-v1" }],
  max_input_bytes: 65_536,
  max_output_bytes: 65_536,
  timeout_seconds: 5,
};
const authority = pinEffectAuthority(grant, [implementation]);
const request: DeliverRefRequest = {
  schema_version: 1,
  kind: "deliver_ref",
  repository_id: "repo",
  source_ref: "refs/integration/reviewed",
  reviewed_head: sha("3"),
  remote_id: "origin",
  target_ref: "refs/heads/main",
  expected_remote_oid: sha("4"),
  idempotency_key: "delivery-1",
  evidence: [
    {
      artifact_ref: "child-output/v2/validation",
      sha256: sha("5"),
      producer_id: "validator",
      schema_id: "validation-v1",
      subject_head: sha("3"),
      verdict: "approved",
    },
  ],
};

function fixture(executors: EffectBrokerExecutors, append?: EffectBrokerDependencies["append"]) {
  const bytes = Buffer.from(JSON.stringify(request));
  const artifact: EffectRequestArtifact = {
    ref: "artifact/v1/effect-request",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.byteLength,
    producer: {
      adapter_id: "delivery-adapter",
      action_id: "action-1",
      operation_id: "adapter-operation-1",
    },
    schema: { id: implementation.request_schema_id, digest: implementation.request_schema_digest },
    run_id: "run-1",
    definition_digest: sha("6"),
  };
  const records: ControllerEffectRecord[] = [];
  const dependencies: EffectBrokerDependencies = {
    runId: "run-1",
    controllerId: "controller-1",
    definitionDigest: sha("6"),
    activationId: "activation-1",
    ownerEpoch: 1,
    isKnownOwner: (activationId, ownerEpoch) => activationId === "activation-1" && ownerEpoch === 1,
    records: () => records,
    append:
      append ??
      ((record) => {
        records.push(record);
      }),
    assertActionIntent: () => undefined,
    resolveRequestArtifact: async (requested) => ({ artifact: requested, bytes }),
    currentEffectGrants: async () => [grant],
    pinnedAuthority: () => authority,
    currentSupportedImplementations: async () => [implementation],
    resolvePatch: async () => {
      throw new Error("not used");
    },
    resolveHeadEvidence: async () => {
      throw new Error("not used");
    },
    publishIntegratedSource: async () => {
      throw new Error("not used");
    },
    workspaceRoot: "/private",
    credentialFiles: {},
    assertOpen: () => undefined,
    now: () => 17,
    executors,
  };
  return { artifact, dependencies, records };
}

function input(artifact: EffectRequestArtifact, actionId = "action-1") {
  return {
    actionId,
    adapterId: "delivery-adapter",
    effectId: "delivery",
    requestArtifact: {
      ...artifact,
      producer: { ...artifact.producer, action_id: actionId },
    },
    pinnedAuthority: authority,
  };
}

function appliedExecutors(): EffectBrokerExecutors {
  return {
    verifyDeliverySource: async () => undefined,
    deliver: async (options) => {
      await options.persistPrepared({
        operationId: options.operationId,
        authorityDigest: authority.authority_digest,
        requestDigest: sha("7"),
        remoteId: "origin",
        exactOrigin: "https://delivery.invalid",
        exactPath: "/v1/ref",
        targetRef: "refs/heads/main",
        reviewedHead: sha("3"),
        expectedPrior: sha("4"),
        idempotencyKey: "delivery-1",
        credentialSourceId: "credential",
      });
      return {
        kind: "applied",
        result: {
          schema_version: 1,
          kind: "deliver_ref",
          repository_id: "repo",
          remote_id: "origin",
          target_ref: "refs/heads/main",
          reviewed_head: sha("3"),
          prior_remote_oid: sha("4"),
          remote_object_oid: sha("3"),
          idempotency_key: "delivery-1",
        },
        remoteObjectOid: sha("3"),
        priorOid: sha("4"),
      };
    },
  };
}

describe("controller effect broker", () => {
  it("verifies the immutable adapter artifact and journals intent, preparation, then application", async () => {
    const state = fixture(appliedExecutors());
    await expect(
      createControllerEffectBroker(state.dependencies).execute(input(state.artifact)),
    ).resolves.toMatchObject({ type: "controller_effect_settled", outcome: "applied" });
    expect(state.records.map((record) => record.type)).toEqual([
      "controller_effect_intent",
      "controller_effect_prepared",
      "controller_effect_settled",
    ]);
  });

  it("rejects changed artifact bytes before durable intent or execution", async () => {
    let called = false;
    const state = fixture({
      deliver: async () => {
        called = true;
        throw new Error("must not execute");
      },
    });
    await expect(
      createControllerEffectBroker({
        ...state.dependencies,
        resolveRequestArtifact: async () => ({
          artifact: state.artifact,
          bytes: Buffer.from("{}"),
        }),
      }).execute(input(state.artifact)),
    ).rejects.toThrow("binding is not verified");
    expect(state.records).toEqual([]);
    expect(called).toBe(false);
  });

  it("poisons the broker after an ambiguous terminal append and never executes twice", async () => {
    let executions = 0;
    const records: ControllerEffectRecord[] = [];
    const delegate = appliedExecutors().deliver;
    if (delegate === undefined) throw new Error("missing test delivery executor");
    const state = fixture(
      {
        verifyDeliverySource: async () => undefined,
        deliver: async (options) => {
          executions += 1;
          return delegate(options);
        },
      },
      (record) => {
        records.push(record);
        if (record.type === "controller_effect_settled")
          throw new Error("append acknowledgement lost");
      },
    );
    const broker = createControllerEffectBroker({ ...state.dependencies, records: () => records });
    await expect(broker.execute(input(state.artifact))).rejects.toBeInstanceOf(
      EffectBrokerPoisonedError,
    );
    await expect(broker.execute(input(state.artifact))).rejects.toBeInstanceOf(
      EffectBrokerPoisonedError,
    );
    expect(executions).toBe(1);
  });

  it("blocks a new action identity while the same logical effect is uncertain", async () => {
    const uncertain: EffectBrokerExecutors = {
      verifyDeliverySource: async () => undefined,
      deliver: async (options) => {
        await options.persistPrepared({
          operationId: options.operationId,
          authorityDigest: authority.authority_digest,
          requestDigest: sha("7"),
          remoteId: "origin",
          exactOrigin: "https://delivery.invalid",
          exactPath: "/v1/ref",
          targetRef: "refs/heads/main",
          reviewedHead: sha("3"),
          expectedPrior: sha("4"),
          idempotencyKey: "delivery-1",
          credentialSourceId: "credential",
        });
        return { kind: "unknown", diagnosticCode: "transport_ambiguous" };
      },
    };
    const state = fixture(uncertain);
    const broker = createControllerEffectBroker(state.dependencies);
    await broker.execute(input(state.artifact));
    await expect(broker.execute(input(state.artifact, "action-2"))).rejects.toThrow(
      "logical effect is already pending, applied, or uncertain",
    );
  });

  it("reconciles an uncertain write read-only and links the prior intent and preparation", async () => {
    const state = fixture({
      ...appliedExecutors(),
      deliver: async (options) => {
        await options.persistPrepared({
          operationId: options.operationId,
          authorityDigest: authority.authority_digest,
          requestDigest: sha("7"),
          remoteId: "origin",
          exactOrigin: "https://delivery.invalid",
          exactPath: "/v1/ref",
          targetRef: "refs/heads/main",
          reviewedHead: sha("3"),
          expectedPrior: sha("4"),
          idempotencyKey: "delivery-1",
          credentialSourceId: "credential",
        });
        return { kind: "unknown", diagnosticCode: "transport_ambiguous" };
      },
      reconcileRemote: async () => ({
        kind: "not_applied",
        observedOid: sha("4"),
      }),
    });
    const broker = createControllerEffectBroker(state.dependencies);
    const first = await broker.execute(input(state.artifact));
    await expect(broker.reconcile(first.operation_id)).resolves.toMatchObject({
      outcome: "not_applied",
      recovery: {
        prior_intent_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        prior_prepared_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("rechecks revoked authority after admission and before the executor", async () => {
    let authorityReads = 0;
    let executions = 0;
    const state = fixture({
      verifyDeliverySource: async () => undefined,
      deliver: async () => {
        executions += 1;
        throw new Error("must not execute");
      },
    });
    const broker = createControllerEffectBroker({
      ...state.dependencies,
      currentEffectGrants: async () => (++authorityReads === 1 ? [grant] : []),
    });
    await expect(broker.execute(input(state.artifact))).rejects.toThrow(
      "pinned effect authority changed or was revoked",
    );
    expect(state.records).toEqual([]);
    expect(executions).toBe(0);
  });

  it("serializes one resource lane while an independent lane continues", async () => {
    const lanes = new Map<string, Promise<void>>();
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = inEffectLane(lanes, "repository/ref-a", async () => {
      events.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first-end");
    });
    const second = inEffectLane(lanes, "repository/ref-a", async () => {
      events.push("second-start");
    });
    const independent = inEffectLane(lanes, "repository/ref-b", async () => {
      events.push("independent-start");
    });
    await independent;
    expect(events).toEqual(["first-start", "independent-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "independent-start", "first-end", "second-start"]);
  });

  it("queues a conflicting action until authoritative nonapplication releases the lane", async () => {
    let starts = 0;
    let releaseFirst: () => void = () => undefined;
    const state = fixture({
      verifyDeliverySource: async () => undefined,
      deliver: async (options) => {
        starts += 1;
        await options.persistPrepared({
          operationId: options.operationId,
          authorityDigest: authority.authority_digest,
          requestDigest: sha("7"),
          remoteId: "origin",
          exactOrigin: "https://delivery.invalid",
          exactPath: "/v1/ref",
          targetRef: "refs/heads/main",
          reviewedHead: sha("3"),
          expectedPrior: sha("4"),
          idempotencyKey: "delivery-1",
          credentialSourceId: "credential",
        });
        if (starts === 1)
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        return { kind: "not_applied", observedOid: sha("4") };
      },
    });
    const broker = createControllerEffectBroker(state.dependencies);
    const first = broker.execute(input(state.artifact));
    const second = broker.execute(input(state.artifact, "action-2"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(starts).toBe(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ outcome: "not_applied" }),
      expect.objectContaining({ outcome: "not_applied" }),
    ]);
    expect(starts).toBe(2);
  });

  it("reconciles a durable intent without preparation as authoritative nonapplication", async () => {
    const records: ControllerEffectRecord[] = [];
    const crashed = fixture(appliedExecutors(), (record) => {
      records.push(record);
      if (record.type === "controller_effect_intent") throw new Error("crash after durable intent");
    });
    await expect(
      createControllerEffectBroker({ ...crashed.dependencies, records: () => records }).execute(
        input(crashed.artifact),
      ),
    ).rejects.toBeInstanceOf(EffectBrokerPoisonedError);
    const resumed = fixture(appliedExecutors());
    const broker = createControllerEffectBroker({
      ...resumed.dependencies,
      records: () => records,
      append: (record) => {
        records.push(record);
      },
    });
    const journaled = records[0];
    if (journaled?.type !== "controller_effect_intent") throw new Error("missing durable intent");
    await expect(broker.reconcile(journaled.operation_id)).resolves.toMatchObject({
      outcome: "not_applied",
      prepared_digest: null,
      recovery: { prior_prepared_digest: null },
    });
  });

  it("rereads settlement after waiting so concurrent reconciliation appends once", async () => {
    let queries = 0;
    let releaseQuery: () => void = () => undefined;
    const state = fixture({
      verifyDeliverySource: async () => undefined,
      deliver: async (options) => {
        await options.persistPrepared({
          operationId: options.operationId,
          authorityDigest: authority.authority_digest,
          requestDigest: sha("7"),
          remoteId: "origin",
          exactOrigin: "https://delivery.invalid",
          exactPath: "/v1/ref",
          targetRef: "refs/heads/main",
          reviewedHead: sha("3"),
          expectedPrior: sha("4"),
          idempotencyKey: "delivery-1",
          credentialSourceId: "credential",
        });
        return { kind: "unknown", diagnosticCode: "transport_ambiguous" };
      },
      reconcileRemote: async () => {
        queries += 1;
        await new Promise<void>((resolve) => {
          releaseQuery = resolve;
        });
        return { kind: "not_applied", observedOid: sha("4") };
      },
    });
    const broker = createControllerEffectBroker(state.dependencies);
    const uncertain = await broker.execute(input(state.artifact));
    const first = broker.reconcile(uncertain.operation_id);
    const second = broker.reconcile(uncertain.operation_id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(queries).toBe(1);
    releaseQuery();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ outcome: "not_applied" }),
      expect.objectContaining({ outcome: "not_applied" }),
    ]);
    expect(queries).toBe(1);
    expect(
      state.records.filter((record) => record.type === "controller_effect_settled"),
    ).toHaveLength(2);
  });

  it("enforces the pinned overall deadline before an executor can prepare a mutation", async () => {
    vi.useFakeTimers();
    try {
      const shortGrant = { ...grant, timeout_seconds: 1 };
      const shortAuthority = pinEffectAuthority(shortGrant, [implementation]);
      let prepared = false;
      const state = fixture({
        verifyDeliverySource: async () => undefined,
        deliver: async (options) => {
          await new Promise<void>((resolve) =>
            options.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          options.signal?.throwIfAborted();
          prepared = true;
          throw new Error("unreachable");
        },
      });
      const broker = createControllerEffectBroker({
        ...state.dependencies,
        currentEffectGrants: async () => [shortGrant],
        pinnedAuthority: () => shortAuthority,
      });
      const running = broker.execute({
        ...input(state.artifact),
        pinnedAuthority: shortAuthority,
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(running).resolves.toMatchObject({ outcome: "not_applied" });
      expect(prepared).toBe(false);
      expect(state.records.map((record) => record.type)).toEqual([
        "controller_effect_intent",
        "controller_effect_settled",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
