import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { HostArtifactContextResolver } from "../../src/host/delegation/context-artifact-contract.js";
import { resolveHostArtifactContextArtifact } from "../../src/host/delegation/context-artifact-host-source.js";
import { hostArtifactContextArtifactSchema } from "../../src/seam/schema.js";

const ref = `artifact/v1/${"a".repeat(64)}/${"b".repeat(64)}`;
const bytes = Buffer.from('{"packet":"verified"}', "utf8");
const sha256 = createHash("sha256").update(bytes).digest("hex");

function descriptor() {
  return {
    id: "adapter-output",
    source: "host_artifact" as const,
    ref,
    sha256,
    byte_length: bytes.byteLength,
    media_type: "application/json" as const,
  };
}

function resolver(
  overrides: Partial<Awaited<ReturnType<HostArtifactContextResolver["resolve"]>>> = {},
) {
  return {
    resolve: async () => ({
      bytes,
      sha256,
      byteLength: bytes.byteLength,
      producingActionId: "validate-packet",
      mediaType: "application/json" as const,
      ...overrides,
    }),
  } satisfies HostArtifactContextResolver;
}

describe("Issue #115 host artifact context source", () => {
  it("resolves only host-verified bytes and retains opaque ref and producer digest provenance", async () => {
    const resolved = await resolveHostArtifactContextArtifact(
      resolver(),
      "native-task",
      "worker",
      descriptor(),
      32 * 1024,
    );

    expect(resolved).toMatchObject({
      source: "host_artifact",
      text: '{"packet":"verified"}',
      provenance: {
        kind: "controller_artifact",
        ref,
        artifact_sha256: sha256,
        producing_action_id: "validate-packet",
      },
    });
  });

  it.each([
    ["no host resolver", undefined, descriptor(), "host-artifact-resolver-unavailable"],
    [
      "changed digest",
      resolver({ sha256: "c".repeat(64) }),
      descriptor(),
      "host-artifact-binding-mismatch",
    ],
    [
      "changed byte count",
      resolver({ byteLength: bytes.byteLength + 1 }),
      descriptor(),
      "host-artifact-binding-mismatch",
    ],
  ] as const)("rejects %s before child context construction", async (_name, source, input, code) => {
    const resolved = await resolveHostArtifactContextArtifact(
      source,
      "native-task",
      "worker",
      input,
      32 * 1024,
    );

    expect(resolved).toMatchObject({ code });
  });

  it("has a closed descriptor schema with no path field", () => {
    expect(Value.Check(hostArtifactContextArtifactSchema, descriptor())).toBe(true);
    expect(
      Value.Check(hostArtifactContextArtifactSchema, {
        ...descriptor(),
        path: "../staging/result",
      }),
    ).toBe(false);
  });
});
