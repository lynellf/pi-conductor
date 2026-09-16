import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  effectRequestArtifact,
  intersectEffectConsumers,
  parseHeadEvidence,
} from "../../src/host/controller/effect-artifacts.js";
import { resultConsumers } from "../../src/host/controller/production-effect-support.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const d = "a".repeat(64);

describe("controller effect artifacts", () => {
  it("binds a request to its real adapter operation and pinned schema", () => {
    const artifact = effectRequestArtifact(
      {
        runId: "run",
        definitionDigest: d,
        actionId: "action",
        adapterId: "review",
        effectId: "promote",
      },
      {
        operationId: "adapter-operation",
        artifact: {
          ref: `artifact/v1/${d}/${d}`,
          sha256: d,
          byteLength: 2,
          mediaType: "application/json",
          binding: {
            runId: "run",
            definitionDigest: d,
            actionId: "action",
            requestDigest: d,
            producer: { kind: "operation", operationId: "adapter-operation", requestDigest: d },
            outputSchema: { id: "git-promote-request-v1", digest: d },
            capabilityDigest: d,
            mediaType: "application/json",
            allowedConsumerProfileIds: [],
            audience: [{ kind: "effect", effect_id: "promote" }],
          },
        },
      },
      { id: "git-promote-request-v1", digest: d },
    );
    expect(artifact.producer).toEqual({
      adapter_id: "review",
      action_id: "action",
      operation_id: "adapter-operation",
    });
  });

  it("rejects approved evidence with extra unreviewed fields", () => {
    const bytes = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        subject_head: "b".repeat(40),
        verdict: "approved",
        command: "ignored",
      }),
    );
    expect(() =>
      parseHeadEvidence(bytes, {
        artifact_ref: "ref",
        sha256: sha(bytes.toString()),
        producer_id: "review",
        schema_id: "review-v1",
        subject_head: "b".repeat(40),
      }),
    ).toThrow("payload is invalid");
  });

  it("keeps interleaved operations with disjoint patch audiences isolated", () => {
    const left = { kind: "adapter", adapter_id: "left" } as const;
    const right = { kind: "adapter", adapter_id: "right" } as const;
    expect(intersectEffectConsumers([left, right], [[left]])).toEqual([left]);
    expect(intersectEffectConsumers([left, right], [[right]])).toEqual([right]);
  });

  it("does not grant completed effect metadata to the controller by default", () => {
    expect(
      resultConsumers({ config: { adapters: [{ id: "promote" }] } } as never, "promote"),
    ).toEqual([]);
  });
});
