import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../../src/host/controller/artifact-store.js";
import { createControllerOutputResolver } from "../../src/host/controller/output-resolver.js";

const roots: string[] = [];
const digest = "a".repeat(64);

afterEach(async () => {
  await Promise.all(roots.map(makeWritable));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Issue #116 controller output resolver", () => {
  it("returns exact v1 bytes for the adapter principal while denying the controller private input", async () => {
    const artifacts = await store();
    const staging = await artifacts.createStaging("action");
    const bytes = Buffer.from('{"canary":"private"}');
    await writeFile(staging.outputPath, bytes);
    const artifact = await artifacts.publish({
      staging,
      binding: {
        runId: "run",
        definitionDigest: digest,
        actionId: "action",
        requestDigest: digest,
        producer: { kind: "operation", operationId: "operation", requestDigest: digest },
        outputSchema: { id: "result", digest },
        capabilityDigest: digest,
        mediaType: "application/json",
        allowedConsumerProfileIds: [],
        audience: [{ kind: "adapter", adapter_id: "review" }],
      },
      validate: () => undefined,
    });
    const resolver = createControllerOutputResolver({
      artifactStore: artifacts,
      childOutputStore: { read: async () => Promise.reject(new Error("unexpected child read")) },
      records: () => [],
      runId: "run",
      definitionDigest: digest,
    });

    await expect(resolver.resolveRef(artifact.ref, { kind: "controller" })).rejects.toMatchObject({
      code: "artifact-consumer-denied",
    });
    await expect(
      resolver.resolveRef(artifact.ref, { kind: "adapter", adapter_id: "review" }),
    ).resolves.toMatchObject({ bytes, audience: [{ kind: "adapter", adapter_id: "review" }] });
  });

  it("refuses a v2 reference until a matching published journal descriptor exists", async () => {
    const artifacts = await store();
    const resolver = createControllerOutputResolver({
      artifactStore: artifacts,
      childOutputStore: {
        read: async () => Promise.reject(new Error("must not read unpublished bytes")),
      },
      records: () => [],
      runId: "run",
      definitionDigest: digest,
    });

    await expect(
      resolver.resolveRef(`child-output/v2/${digest}/${digest}`, {
        kind: "adapter",
        adapter_id: "review",
      }),
    ).rejects.toThrow("not durably published");
  });
});

async function store(): Promise<ArtifactStore> {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-output-resolver-"));
  roots.push(root);
  return ArtifactStore.open({ root });
}

async function makeWritable(path: string): Promise<void> {
  const entries = await readdir(path).catch(() => [] as string[]);
  await chmod(path, 0o700).catch(() => undefined);
  await Promise.all(entries.map((entry) => makeWritable(join(path, entry))));
}
