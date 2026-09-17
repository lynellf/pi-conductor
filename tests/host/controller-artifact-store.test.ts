import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  type ArtifactBinding,
  ArtifactStore,
  type ArtifactStoreError,
} from "../../src/host/controller/artifact-store.js";
import { assertArtifactBinding } from "../../src/host/controller/artifact-store-contract.js";
import type { HostArtifactContextResolver } from "../../src/host/delegation/context-artifact-contract.js";
import { resolveHostArtifactContextArtifact } from "../../src/host/delegation/context-artifact-host-source.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.map(async (directory) => {
      await makeWritable(directory);
      await rm(directory, { recursive: true, force: true });
    }),
  );
  directories.length = 0;
});

function digest(char: string): string {
  return char.repeat(64);
}

function binding(overrides: Partial<ArtifactBinding> = {}): ArtifactBinding {
  return {
    runId: "run-115",
    definitionDigest: digest("a"),
    actionId: "publish-result",
    requestDigest: digest("b"),
    producer: { kind: "source_cursor", ordinal: 41, recordDigest: digest("c") },
    outputSchema: { id: "packet-v1", digest: digest("d") },
    capabilityDigest: digest("e"),
    mediaType: "application/json",
    allowedConsumerProfileIds: ["worker"],
    ...overrides,
  };
}

async function store(): Promise<ArtifactStore> {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-artifacts-"));
  directories.push(root);
  return ArtifactStore.open({ root });
}

describe("Issue #115 immutable controller artifact publication", () => {
  it("rechecks recovery envelope bytes after immutable binding lookup", async () => {
    const artifacts = await store();
    const staging = await artifacts.createStaging("publish-result");
    await writeFile(staging.outputPath, '{"valid":true}');
    const published = await artifacts.publish({ staging, binding: binding(), validate: validJson });
    const recover = artifacts.recoverAction.bind(artifacts);
    artifacts.recoverAction = async (authority) => {
      const verified = await recover(authority);
      const payloadPath = join(artifacts.pathForTest(published.ref), "output", "result.json");
      await chmod(payloadPath, 0o600);
      await writeFile(payloadPath, '{"valid":false}');
      await chmod(payloadPath, 0o400);
      return verified;
    };
    await expect(artifacts.recoverActionPayload(binding())).rejects.toMatchObject({
      code: "artifact-corrupt",
    });
  });

  it("keeps derived private adapter bytes from the controller and unrelated native profiles", async () => {
    const artifacts = await store();
    const staging = await artifacts.createStaging("publish-result");
    await writeFile(staging.outputPath, '{"private":"review-canary"}');
    const published = await artifacts.publish({
      staging,
      binding: binding({
        audience: [
          { kind: "adapter", adapter_id: "integrator" },
          { kind: "native", profile_id: "reviewer" },
        ],
      }),
      validate: validJson,
    });
    const request = {
      ref: published.ref,
      runId: "run-115",
      definitionDigest: digest("a"),
      offset: 0,
      length: 1024,
    };
    await expect(artifacts.rangeReadForController(request)).rejects.toMatchObject({
      code: "artifact-consumer-denied",
    });
    await expect(
      artifacts.rangeRead({ ...request, consumerProfileId: "worker" }),
    ).rejects.toMatchObject({ code: "artifact-consumer-denied" });
    expect(
      (await artifacts.rangeRead({ ...request, consumerProfileId: "reviewer" })).bytes.toString(),
    ).toContain("review-canary");
    expect(
      (
        await artifacts.rangeReadForPrincipal({
          ...request,
          principal: { kind: "adapter", adapter_id: "integrator" },
        })
      ).bytes.toString(),
    ).toContain("review-canary");
    await expect(
      artifacts.rangeReadForPrincipal({
        ...request,
        principal: { kind: "effect", effect_id: "integrator" },
      }),
    ).rejects.toMatchObject({ code: "artifact-consumer-denied" });
  });

  it("recovers request, selected source, and result independently under the same real action", async () => {
    const artifacts = await store();
    const request = binding();
    const source = binding({
      publication: { kind: "effect_source", operationId: digest("a"), effectId: "integrate" },
    });
    const result = binding({
      publication: { kind: "effect_result", operationId: digest("a"), effectId: "integrate" },
    });
    const published = [];
    for (const [index, authority] of [request, source, result].entries()) {
      const staging = await artifacts.createStaging(authority.actionId);
      await writeFile(staging.outputPath, JSON.stringify({ slot: index }));
      published.push(await artifacts.publish({ staging, binding: authority, validate: validJson }));
    }
    expect(new Set(published.map((artifact) => artifact.ref)).size).toBe(3);
    for (const [index, authority] of [request, source, result].entries()) {
      const recovered = await artifacts.recoverAction(authority);
      expect(recovered).toEqual(published[index]);
      expect(recovered?.binding.actionId).toBe("publish-result");
    }
    await expect(
      artifacts.recoverAction(
        binding({
          publication: { kind: "effect_result", operationId: digest("b"), effectId: "integrate" },
        }),
      ),
    ).rejects.toMatchObject({ code: "artifact-missing" });
  });

  it("publishes host-created staging bytes and authorizes an exact bounded native read", async () => {
    const artifacts = await store();
    const staging = await artifacts.createStaging("publish-result");
    await writeFile(staging.outputPath, '{"packet":"ready"}');

    const published = await artifacts.publish({ staging, binding: binding(), validate: validJson });
    const read = await artifacts.rangeRead({
      ref: published.ref,
      runId: "run-115",
      definitionDigest: digest("a"),
      consumerProfileId: "worker",
      offset: 2,
      length: 8,
    });
    const controllerRead = await artifacts.rangeReadForController({
      ref: published.ref,
      runId: "run-115",
      definitionDigest: digest("a"),
      offset: 2,
      length: 8,
    });

    expect(read.bytes.toString("utf8")).toBe('packet":');
    expect(controllerRead.bytes).toEqual(read.bytes);
    expect(read.binding).toEqual(binding());
    expect(published.byteLength).toBe(Buffer.byteLength('{"packet":"ready"}'));
    await expect(artifacts.recoverAction(binding())).resolves.toEqual(published);

    const nativeResolver: HostArtifactContextResolver = {
      resolve: async (input) => {
        const result = await artifacts.rangeRead({
          ref: input.ref,
          runId: "run-115",
          definitionDigest: digest("a"),
          consumerProfileId: input.consumerProfileId,
          offset: 0,
          length: input.maxBytes,
        });
        return {
          bytes: result.bytes,
          sha256: result.sha256,
          byteLength: result.byteLength,
          producingActionId: result.binding.actionId,
          mediaType: result.mediaType,
        };
      },
    };
    await expect(
      resolveHostArtifactContextArtifact(
        nativeResolver,
        "native-task",
        "worker",
        {
          id: "published-output",
          source: "host_artifact",
          ref: published.ref,
          sha256: published.sha256,
          byte_length: published.byteLength,
          media_type: published.mediaType,
        },
        32 * 1024,
      ),
    ).resolves.toMatchObject({
      provenance: { ref: published.ref, artifact_sha256: published.sha256 },
    });

    const conflicting = await artifacts.createStaging("publish-result");
    await writeFile(conflicting.outputPath, '{"packet":"changed"}');
    await expect(
      artifacts.publish({
        staging: conflicting,
        binding: binding({ requestDigest: digest("f") }),
        validate: validJson,
      }),
    ).rejects.toMatchObject({ code: "artifact-conflict" } satisfies Partial<ArtifactStoreError>);
  });

  it("rejects a symlink or hardlink staging payload and retains failed evidence", async () => {
    const artifacts = await store();
    const staging = await artifacts.createStaging("publish-result");
    const outside = join(tmpdir(), `pi-conductor-artifact-outside-${Date.now()}`);
    directories.push(outside);
    await writeFile(outside, "outside");
    await symlink(outside, staging.outputPath);

    await expect(
      artifacts.publish({ staging, binding: binding(), validate: validJson }),
    ).rejects.toMatchObject({
      code: "artifact-symlink",
    } satisfies Partial<ArtifactStoreError>);
    await expect(readFile(staging.outputPath, "utf8")).resolves.toBe("outside");

    await rm(staging.outputPath);
    await link(outside, staging.outputPath);
    await expect(
      artifacts.publish({ staging, binding: binding(), validate: validJson }),
    ).rejects.toMatchObject({
      code: "artifact-hardlink",
    } satisfies Partial<ArtifactStoreError>);
  });

  it("retains invalid staged bytes without promoting a receipt-visible reference", async () => {
    const artifacts = await store();
    const staging = await artifacts.createStaging("publish-result");
    await writeFile(staging.outputPath, "not-json");

    await expect(
      artifacts.publish({
        staging,
        binding: binding(),
        validate: async (bytes) => {
          JSON.parse(bytes.toString("utf8"));
        },
      }),
    ).rejects.toMatchObject({
      code: "artifact-schema-invalid",
    } satisfies Partial<ArtifactStoreError>);
    await expect(readFile(staging.outputPath, "utf8")).resolves.toBe("not-json");
    await expect(
      artifacts.recover({ binding: binding(), ref: "artifact/v1/unknown/unknown" }),
    ).rejects.toMatchObject({ code: "artifact-missing" } satisfies Partial<ArtifactStoreError>);
  });

  it("reopens an existing private root and refuses publication when the owner epoch closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-artifacts-reopen-"));
    directories.push(root);
    let open = true;
    const first = await ArtifactStore.open({
      root,
      assertPublicationOpen: () => {
        if (!open) throw new Error("controller activation is closed");
      },
    });
    const second = await ArtifactStore.open({ root });
    const staging = await first.createStaging("publish-result");
    await writeFile(staging.outputPath, '{"sealed":true}');
    open = false;

    await expect(
      first.publish({ staging, binding: binding(), validate: validJson }),
    ).rejects.toThrow("controller activation is closed");
    await expect(readFile(staging.outputPath, "utf8")).resolves.toBe('{"sealed":true}');
    expect(second).toBeInstanceOf(ArtifactStore);
  });

  it("rejects a root reached through a symlink instead of canonicalizing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-artifacts-root-"));
    const linkPath = join(tmpdir(), `pi-conductor-artifacts-link-${Date.now()}`);
    directories.push(root, linkPath);
    await symlink(root, linkPath);

    await expect(ArtifactStore.open({ root: linkPath })).rejects.toMatchObject({
      code: "artifact-storage-failure",
    } satisfies Partial<ArtifactStoreError>);
  });

  it("rechecks operation cancellation immediately before rename and retains sealed staging", async () => {
    const artifacts = await store();
    const staging = await artifacts.createStaging("publish-result");
    await writeFile(staging.outputPath, '{"sealed":true}');
    let checks = 0;
    await expect(
      artifacts.publish({
        staging,
        binding: binding(),
        validate: validJson,
        assertPublicationOpen: () => {
          checks += 1;
          if (checks === 2) throw new Error("adapter cancelled before publication");
        },
      }),
    ).rejects.toThrow("adapter cancelled before publication");
    expect(checks).toBe(2);
    await expect(readFile(staging.outputPath, "utf8")).resolves.toBe('{"sealed":true}');
    await expect(artifacts.recoverAction(binding())).rejects.toMatchObject({
      code: "artifact-missing",
    });
  });

  it("does not allow callers to raise fixed artifact or native-read bounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-artifacts-limits-"));
    directories.push(root);
    await expect(
      ArtifactStore.open({ root, maxArtifactBytes: 1024 * 1024 + 1 }),
    ).rejects.toMatchObject({
      code: "artifact-storage-failure",
    } satisfies Partial<ArtifactStoreError>);
    await expect(
      ArtifactStore.open({ root, maxRangeReadBytes: 32 * 1024 + 1 }),
    ).rejects.toMatchObject({
      code: "artifact-storage-failure",
    } satisfies Partial<ArtifactStoreError>);
  });

  it("rejects a consumer or binding mismatch and detects canonical payload corruption on recovery", async () => {
    const artifacts = await store();
    const staging = await artifacts.createStaging("publish-result");
    await writeFile(staging.outputPath, '{"verified":true}');
    const published = await artifacts.publish({ staging, binding: binding(), validate: validJson });

    await expect(
      artifacts.rangeRead({
        ref: published.ref,
        runId: "run-115",
        definitionDigest: digest("a"),
        consumerProfileId: "other",
        offset: 0,
        length: 1,
      }),
    ).rejects.toMatchObject({
      code: "artifact-consumer-denied",
    } satisfies Partial<ArtifactStoreError>);
    await expect(
      artifacts.recover({ binding: binding({ requestDigest: digest("f") }), ref: published.ref }),
    ).rejects.toMatchObject({
      code: "artifact-binding-mismatch",
    } satisfies Partial<ArtifactStoreError>);

    const publishedPath = artifacts.pathForTest(published.ref);
    await chmod(publishedPath, 0o700);
    const payloadPath = join(publishedPath, "output", "result.json");
    await chmod(payloadPath, 0o600);
    await writeFile(payloadPath, "tampered");
    await expect(
      artifacts.recover({ binding: binding(), ref: published.ref }),
    ).rejects.toMatchObject({
      code: "artifact-corrupt",
    } satisfies Partial<ArtifactStoreError>);
  });

  it("recovers a sealed publication after parent-sync failure leaves no successful receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-artifacts-recovery-"));
    directories.push(root);
    const artifacts = await ArtifactStore.open({
      root,
      testHook: (stage) => {
        if (stage === "after-rename-before-parent-sync") throw new Error("parent sync failed");
      },
    });
    const staging = await artifacts.createStaging("publish-result");
    await writeFile(staging.outputPath, '{"result":"durable"}');

    await expect(
      artifacts.publish({ staging, binding: binding(), validate: validJson }),
    ).rejects.toThrow("parent sync failed");
    await expect(artifacts.recoverAction(binding())).resolves.toMatchObject({
      binding: binding(),
    });
  });

  it("rejects unknown binding fields before any staging read", () => {
    try {
      assertArtifactBinding({ ...binding(), unintended_authority: "untrusted" });
      throw new Error("expected binding rejection");
    } catch (cause) {
      expect(cause).toMatchObject({
        code: "artifact-binding-invalid",
      } satisfies Partial<ArtifactStoreError>);
    }
  });

  it("permits a controller-only output with no native consumer grant", () => {
    expect(() => assertArtifactBinding(binding({ allowedConsumerProfileIds: [] }))).not.toThrow();
  });
});

async function makeWritable(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory()) return;
  await chmod(path, 0o700);
  await Promise.all((await readdir(path)).map((entry) => makeWritable(join(path, entry))));
}

function validJson(bytes: Buffer): void {
  JSON.parse(bytes.toString("utf8"));
}
