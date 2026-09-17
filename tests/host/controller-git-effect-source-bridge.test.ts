import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gitPostcondition } from "../../src/host/controller/effect-broker-support.js";
import { type EffectGrant, pinEffectAuthority } from "../../src/host/controller/effect-registry.js";
import {
  type GitEffectPrepared,
  integrateGitEffectFromSourceWorkspace,
  measureGitEffectRepository,
} from "../../src/host/controller/git-effect.js";
import type {
  PreparedSourceWorkspace,
  SourceWorkspaceGrant,
} from "../../src/host/controller/source-workspace-contract.js";
import { createSourceWorkspaceService } from "../../src/host/controller/source-workspace-service.js";
import { SourceWorkspaceStore } from "../../src/host/controller/source-workspace-store.js";
import { createIndependentSourceWorktree } from "../../src/host/delegation/worktree.js";
import {
  effectRequestSchemaDigest,
  effectResultSchemaDigest,
} from "../../src/manifest/controller-effect.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await execute("chmod", ["-R", "u+w", root]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("controller Git effect source-bridge", () => {
  it("preserves the pre-bridge git_integrate request schema digest", () => {
    expect(effectRequestSchemaDigest("git_integrate")).toBe(
      "cb34adbf0d2b8f6e2c8f1da7da3457eb483ac18b4c96fee95b940141f8c77802",
    );
  });

  it("integrates a child patch against a reconstructed source prefix without mutating the original repository", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const sourcePatch = await patchFor(
      fixture.repository,
      fixture.base,
      "src/extra.txt",
      "extra\n",
    );
    const sourceIntent = await source.resolveIntent(
      request({
        patches: [
          {
            ref: "child-output/v2/source-patch",
            sha256: sourcePatch.sha256,
            byteLength: sourcePatch.bytes.length,
            acceptedBase: fixture.base,
          },
        ],
      }),
      grant,
      async () => ({
        bytes: sourcePatch.bytes,
        sha256: sourcePatch.sha256,
        byteLength: sourcePatch.bytes.length,
        acceptedBase: fixture.base,
        allowedPaths: ["src"],
        audience: [{ kind: "controller" }, { kind: "effect", effect_id: "git-integrate-reviewed" }],
      }),
    );
    const preparedSource = await source.prepare(sourceIntent, grant, {
      resolvePatch: async () => ({
        bytes: sourcePatch.bytes,
        sha256: sourcePatch.sha256,
        byteLength: sourcePatch.bytes.length,
        acceptedBase: fixture.base,
        allowedPaths: ["src"],
        audience: [{ kind: "controller" }, { kind: "effect", effect_id: "git-integrate-reviewed" }],
      }),
      persist: async () => undefined,
      assertOpen: () => undefined,
    });

    const childPath = join(fixture.privateRoot, "child");
    await createIndependentSourceWorktree(
      childPath,
      "child",
      preparedSource.headCommit,
      preparedSource.checkoutPath,
    );
    const childPatch = await patchFor(
      childPath,
      preparedSource.headCommit,
      "src/child.txt",
      "child\n",
    );

    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint, ["src"]),
      [implementation("git_integrate")],
    );
    const descriptor = sourceWorkspaceDescriptor(preparedSource);
    const prepared: Array<GitEffectPrepared & { sourceWorkspace?: unknown }> = [];
    const outcome = await integrateGitEffectFromSourceWorkspace({
      authority,
      request: integrationRequest(
        fixture.base,
        preparedSource.headCommit,
        childPatch.sha256,
        descriptor,
      ),
      workspaceRoot: fixture.privateRoot,
      resolvePatch: async () => ({
        bytes: childPatch.bytes,
        sha256: childPatch.sha256,
        baseCommit: preparedSource.headCommit,
        allowedPaths: ["src/child.txt"],
        evidence: [verifiedPatchEvidence(childPatch.sha256)],
      }),
      resolveSourceWorkspace: async () => preparedSource,
      publishSelectedSource: publishSource,
      persistPrepared: async (value) => {
        prepared.push(value);
      },
      assertOpen: () => undefined,
    });
    expect(prepared).toHaveLength(1);
    const persisted = prepared[0];
    if (persisted === undefined) throw new Error("prepared state was not captured");
    expect(persisted.sourceWorkspace).toBeDefined();
    expect(persisted.sourceWorkspace?.head_commit).toBe(preparedSource.headCommit);
    expect(gitPostcondition(persisted)).toMatchObject({
      source_workspace: { head_commit: preparedSource.headCommit },
    });
    expect(
      await git(fixture.repository, "rev-parse", "refs/pi-conductor/integration/reviewed"),
    ).toBe(outcome.integratedHead);
    expect(await readFile(join(fixture.repository, "src/value.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(fixture.repository, "src/extra.txt"), "utf8")).toBe("original\n");
    const childPatchDigest = childPatch.sha256;
    const verify = await Promise.all([
      git(fixture.repository, "cat-file", "-p", `${outcome.integratedHead}:src/child.txt`),
      git(fixture.repository, "rev-parse", `${outcome.integratedHead}^`),
    ]);
    expect(verify[0]).toBe("child");
    expect(verify[1]).toBe(fixture.base);
    expect(outcome.selectedSource.files).toEqual([
      expect.objectContaining({ path: "src/child.txt", bytes: Buffer.from("child\n") }),
    ]);
    expect(childPatchDigest).toBe(childPatch.sha256);
  });

  it("rejects a forged descriptor whose base_commit differs from the request accepted_base", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const preparedSource = await preparePlainSource(source, grant);
    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint),
      [implementation("git_integrate")],
    );
    const forgedDescriptor = {
      ...sourceWorkspaceDescriptor(preparedSource),
      base_commit: fixture.altBase,
    };
    const child = await patchFor(fixture.repository, fixture.base, "src/child.txt", "child\n");
    await expect(
      integrateGitEffectFromSourceWorkspace({
        authority,
        request: integrationRequest(
          fixture.base,
          preparedSource.headCommit,
          child.sha256,
          forgedDescriptor,
        ),
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: child.bytes,
          sha256: child.sha256,
          baseCommit: preparedSource.headCommit,
          allowedPaths: ["src/child.txt"],
          evidence: [verifiedPatchEvidence(child.sha256)],
        }),
        resolveSourceWorkspace: async () => preparedSource,
        publishSelectedSource: publishSource,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "descriptor-base-mismatch",
    });
  });

  it("rejects a descriptor with a forged head_commit that does not match the sealed workspace", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const preparedSource = await preparePlainSource(source, grant);
    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint),
      [implementation("git_integrate")],
    );
    const forgedDescriptor = {
      ...sourceWorkspaceDescriptor(preparedSource),
      head_commit: "f".repeat(40),
    };
    const child = await patchFor(fixture.repository, fixture.base, "src/child.txt", "child\n");
    await expect(
      integrateGitEffectFromSourceWorkspace({
        authority,
        request: integrationRequest(
          fixture.base,
          forgedDescriptor.head_commit,
          child.sha256,
          forgedDescriptor,
        ),
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: child.bytes,
          sha256: child.sha256,
          baseCommit: preparedSource.headCommit,
          allowedPaths: ["src/child.txt"],
          evidence: [verifiedPatchEvidence(child.sha256)],
        }),
        resolveSourceWorkspace: async () => preparedSource,
        publishSelectedSource: publishSource,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "descriptor-revoked",
    });
  });

  it.each([
    {
      field: "allowed paths",
      mutate: (prepared: PreparedSourceWorkspace): PreparedSourceWorkspace =>
        Object.freeze({ ...prepared, allowedPaths: Object.freeze(["src/value.txt"]) }),
    },
    {
      field: "audience",
      mutate: (prepared: PreparedSourceWorkspace): PreparedSourceWorkspace =>
        Object.freeze({
          ...prepared,
          audience: Object.freeze([{ kind: "controller" as const }]),
        }),
    },
  ])("rejects $field drift in the resolved sealed workspace", async ({ mutate }) => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const preparedSource = await preparePlainSource(source, grant);
    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint),
      [implementation("git_integrate")],
    );
    const descriptor = sourceWorkspaceDescriptor(preparedSource);
    const child = await patchFor(fixture.repository, fixture.base, "src/child.txt", "child\n");

    await expect(
      integrateGitEffectFromSourceWorkspace({
        authority,
        request: integrationRequest(
          fixture.base,
          preparedSource.headCommit,
          child.sha256,
          descriptor,
        ),
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: child.bytes,
          sha256: child.sha256,
          baseCommit: preparedSource.headCommit,
          allowedPaths: ["src/child.txt"],
          evidence: [verifiedPatchEvidence(child.sha256)],
        }),
        resolveSourceWorkspace: async () => mutate(preparedSource),
        publishSelectedSource: publishSource,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "descriptor-revoked" });
  });

  it("rejects a reconstructed prefix whose inventory differs from the sealed descriptor", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const preparedSource = await preparePlainSource(source, grant);
    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint),
      [implementation("git_integrate")],
    );
    const forgedInventory = "f".repeat(64);
    const descriptor = {
      ...sourceWorkspaceDescriptor(preparedSource),
      inventory_digest: forgedInventory,
    };
    const forgedWorkspace = Object.freeze({
      ...preparedSource,
      inventoryDigest: forgedInventory,
    });
    const child = await patchFor(fixture.repository, fixture.base, "src/child.txt", "child\n");

    await expect(
      integrateGitEffectFromSourceWorkspace({
        authority,
        request: integrationRequest(
          fixture.base,
          preparedSource.headCommit,
          child.sha256,
          descriptor,
        ),
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: child.bytes,
          sha256: child.sha256,
          baseCommit: preparedSource.headCommit,
          allowedPaths: ["src/child.txt"],
          evidence: [verifiedPatchEvidence(child.sha256)],
        }),
        resolveSourceWorkspace: async () => forgedWorkspace,
        publishSelectedSource: publishSource,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "bridge-reconstruction-mismatch" });
  });

  it("rejects an integration_ref inside the source-prefix namespace", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const preparedSource = await preparePlainSource(source, grant);
    const measured = await measureGitEffectRepository(fixture.repository);
    const integrationAuthority = integrationGrant(measured.canonical_path, measured.fingerprint);
    const authority = pinEffectAuthority(
      {
        ...integrationAuthority,
        allowed_integration_refs: ["refs/pi-conductor/source-prefix/anything"],
      },
      [implementation("git_integrate")],
    );
    const descriptor = sourceWorkspaceDescriptor(preparedSource);
    const child = await patchFor(fixture.repository, fixture.base, "src/child.txt", "child\n");
    await expect(
      integrateGitEffectFromSourceWorkspace({
        authority,
        request: {
          ...integrationRequest(fixture.base, preparedSource.headCommit, child.sha256, descriptor),
          integration_ref: "refs/pi-conductor/source-prefix/anything",
        },
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: child.bytes,
          sha256: child.sha256,
          baseCommit: preparedSource.headCommit,
          allowedPaths: ["src/child.txt"],
          evidence: [verifiedPatchEvidence(child.sha256)],
        }),
        resolveSourceWorkspace: async () => preparedSource,
        publishSelectedSource: publishSource,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "integration-ref-in-source-prefix",
    });
  });

  it("rejects a descriptor whose audience does not include the effect authority", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const preparedSource = await preparePlainSource(source, grant);
    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint),
      [implementation("git_integrate")],
    );
    const descriptor = {
      ...sourceWorkspaceDescriptor(preparedSource),
      audience: [{ kind: "native" as const, profile_id: "reviewer" }],
    };
    const child = await patchFor(fixture.repository, fixture.base, "src/child.txt", "child\n");
    await expect(
      integrateGitEffectFromSourceWorkspace({
        authority,
        request: integrationRequest(
          fixture.base,
          preparedSource.headCommit,
          child.sha256,
          descriptor,
        ),
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: child.bytes,
          sha256: child.sha256,
          baseCommit: preparedSource.headCommit,
          allowedPaths: ["src/child.txt"],
          evidence: [verifiedPatchEvidence(child.sha256)],
        }),
        resolveSourceWorkspace: async () => preparedSource,
        publishSelectedSource: publishSource,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "audience-denied",
    });
  });

  it("rejects a bounded view whose sealed HEAD was tampered with", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const preparedSource = await preparePlainSource(source, grant);
    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint),
      [implementation("git_integrate")],
    );
    const descriptor = sourceWorkspaceDescriptor(preparedSource);
    // Tamper the bounded view's HEAD ref directly so `git rev-parse HEAD` returns
    // a forged value while the descriptor still claims the sealed head.
    // The bounded view was prepared with a 0o700 directory and 0o600 ref file
    // so we chmod the parent directories first to allow writing.
    const refsHeadsSource = join(preparedSource.checkoutPath, ".git", "refs", "heads", "source");
    await execute("chmod", ["-R", "u+w", join(preparedSource.checkoutPath, ".git")]);
    await writeFile(refsHeadsSource, "1".repeat(40));
    const child = await patchFor(fixture.repository, fixture.base, "src/child.txt", "child\n");
    await expect(
      integrateGitEffectFromSourceWorkspace({
        authority,
        request: integrationRequest(
          fixture.base,
          preparedSource.headCommit,
          child.sha256,
          descriptor,
        ),
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: child.bytes,
          sha256: child.sha256,
          baseCommit: preparedSource.headCommit,
          allowedPaths: ["src/child.txt"],
          evidence: [verifiedPatchEvidence(child.sha256)],
        }),
        resolveSourceWorkspace: async () => preparedSource,
        publishSelectedSource: publishSource,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "descriptor-sealed-tampered",
    });
    expect(await readFile(join(fixture.repository, "src/value.txt"), "utf8")).toBe("one\n");
  });

  it("rejects a forged patch evidence subject_digest before any canonical state is mutated", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const preparedSource = await preparePlainSource(source, grant);
    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint),
      [implementation("git_integrate")],
    );
    const descriptor = sourceWorkspaceDescriptor(preparedSource);
    const child = await patchFor(fixture.repository, fixture.base, "src/child.txt", "child\n");
    const request = integrationRequest(
      fixture.base,
      preparedSource.headCommit,
      child.sha256,
      descriptor,
    );
    const requestedPatch = request.patches[0];
    const requestedEvidence = requestedPatch?.evidence[0];
    if (requestedPatch === undefined || requestedEvidence === undefined)
      throw new Error("test request patch evidence is missing");
    const forgedEvidence = {
      ...requestedEvidence,
      subject_digest: "2".repeat(64),
    };
    const forgedRequest = {
      ...request,
      patches: [
        {
          ...requestedPatch,
          evidence: [forgedEvidence],
        },
      ],
    };
    await expect(
      integrateGitEffectFromSourceWorkspace({
        authority,
        request: forgedRequest as typeof request,
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: child.bytes,
          sha256: child.sha256,
          baseCommit: preparedSource.headCommit,
          allowedPaths: ["src/child.txt"],
          evidence: [verifiedPatchEvidence(child.sha256)],
        }),
        resolveSourceWorkspace: async () => preparedSource,
        publishSelectedSource: publishSource,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toThrow();
    expect(await readFile(join(fixture.repository, "src/value.txt"), "utf8")).toBe("one\n");
  });

  it("detects reconstruction mismatch when the prefix does not match the sealed S tree", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const sourcePatch = await patchFor(
      fixture.repository,
      fixture.base,
      "src/extra.txt",
      "extra\n",
    );
    const sourceIntent = await source.resolveIntent(
      request({
        patches: [
          {
            ref: "child-output/v2/source-patch",
            sha256: sourcePatch.sha256,
            byteLength: sourcePatch.bytes.length,
            acceptedBase: fixture.base,
          },
        ],
      }),
      grant,
      async () => ({
        bytes: sourcePatch.bytes,
        sha256: sourcePatch.sha256,
        byteLength: sourcePatch.bytes.length,
        acceptedBase: fixture.base,
        allowedPaths: ["src"],
        audience: [{ kind: "controller" }, { kind: "effect", effect_id: "git-integrate-reviewed" }],
      }),
    );
    const preparedSource = await source.prepare(sourceIntent, grant, {
      resolvePatch: async () => ({
        bytes: sourcePatch.bytes,
        sha256: sourcePatch.sha256,
        byteLength: sourcePatch.bytes.length,
        acceptedBase: fixture.base,
        allowedPaths: ["src"],
        audience: [{ kind: "controller" }, { kind: "effect", effect_id: "git-integrate-reviewed" }],
      }),
      persist: async () => undefined,
      assertOpen: () => undefined,
    });
    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint),
      [implementation("git_integrate")],
    );
    // Build a workspace with a tampered treeId that matches the descriptor
    // (so descriptor-revoked passes) but write the original S objects back
    // into the bounded view so `git rev-parse HEAD^{tree}` still returns
    // the original sealed tree id. The bridge then rejects at step 10.
    const tamperedDescriptor = {
      ...sourceWorkspaceDescriptor(preparedSource),
      tree_id: "9".repeat(40),
    };
    const tamperedWorkspace: PreparedSourceWorkspace = Object.freeze({
      ...preparedSource,
      treeId: "9".repeat(40),
    });
    const child = await patchFor(fixture.repository, fixture.base, "src/child.txt", "child\n");
    await expect(
      integrateGitEffectFromSourceWorkspace({
        authority,
        request: integrationRequest(
          fixture.base,
          preparedSource.headCommit,
          child.sha256,
          tamperedDescriptor,
        ),
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: child.bytes,
          sha256: child.sha256,
          baseCommit: preparedSource.headCommit,
          allowedPaths: ["src/child.txt"],
          evidence: [verifiedPatchEvidence(child.sha256)],
        }),
        resolveSourceWorkspace: async () => tamperedWorkspace,
        publishSelectedSource: publishSource,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "descriptor-sealed-tampered",
    });
    expect(await readFile(join(fixture.repository, "src/value.txt"), "utf8")).toBe("one\n");
  });

  it("rejects multi-patch integration with the source-bridge descriptor", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const preparedSource = await preparePlainSource(source, grant);
    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint),
      [implementation("git_integrate")],
    );
    const descriptor = sourceWorkspaceDescriptor(preparedSource);
    const child = await patchFor(fixture.repository, fixture.base, "src/child.txt", "child\n");
    const request = integrationRequest(
      fixture.base,
      preparedSource.headCommit,
      child.sha256,
      descriptor,
    );
    const secondEvidence = verifiedPatchEvidence(child.sha256);
    const multiPatchRequest = {
      ...request,
      patches: [
        ...request.patches,
        {
          artifact_ref: "artifact/v2/second",
          sha256: child.sha256,
          base_commit: preparedSource.headCommit,
          evidence: [
            {
              artifact_ref: secondEvidence.artifactRef,
              sha256: secondEvidence.sha256,
              producer_id: secondEvidence.producerId,
              schema_id: secondEvidence.schemaId,
              subject_digest: secondEvidence.subjectDigest,
              verdict: secondEvidence.verdict,
            },
          ],
        },
      ],
    };
    await expect(
      integrateGitEffectFromSourceWorkspace({
        authority,
        request: multiPatchRequest as typeof request,
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: child.bytes,
          sha256: child.sha256,
          baseCommit: preparedSource.headCommit,
          allowedPaths: ["src/child.txt"],
          evidence: [verifiedPatchEvidence(child.sha256)],
        }),
        resolveSourceWorkspace: async () => preparedSource,
        publishSelectedSource: publishSource,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toThrow();
  });

  it("preserves the original repository state when the request aborts before CAS", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const preparedSource = await preparePlainSource(source, grant);
    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint),
      [implementation("git_integrate")],
    );
    const descriptor = sourceWorkspaceDescriptor(preparedSource);
    const child = await patchFor(fixture.repository, fixture.base, "src/child.txt", "child\n");
    await expect(
      integrateGitEffectFromSourceWorkspace({
        authority,
        request: integrationRequest(
          fixture.base,
          preparedSource.headCommit,
          child.sha256,
          descriptor,
        ),
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => {
          throw new Error("append acknowledgment lost");
        },
        resolveSourceWorkspace: async () => preparedSource,
        publishSelectedSource: publishSource,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toThrow();
    expect(await readFile(join(fixture.repository, "src/value.txt"), "utf8")).toBe("one\n");
    await expect(
      git(fixture.repository, "rev-parse", "--verify", "refs/pi-conductor/integration/reviewed"),
    ).rejects.toThrow();
  });

  it("reuses the prepared source workspace through a fresh resolveSourceWorkspace call", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);
    const preparedSource = await preparePlainSource(source, grant);
    const reopened = await source.open(preparedSource.ref, grant, { kind: "controller" });
    expect(reopened.repositoryRef).toBe(grant.allowedRefs[0]);
    expect(reopened.repositoryFingerprint).toBe(grant.repositoryFingerprint);
    expect(reopened.allowedPaths).toEqual(grant.allowedPaths);
    expect(reopened.patchesDigest).toBe(preparedSource.patchesDigest);
    expect(reopened.patches).toEqual(preparedSource.patches);
  });
});

async function preparePlainSource(
  source: ReturnType<typeof createSourceWorkspaceService>,
  grant: SourceWorkspaceGrant,
): Promise<PreparedSourceWorkspace> {
  const intent = await source.resolveIntent(request({ patches: [] }), grant, async () => {
    throw new Error("no patch requested");
  });
  return source.prepare(intent, grant, {
    resolvePatch: async () => {
      throw new Error("no patch requested");
    },
    persist: async () => undefined,
    assertOpen: () => undefined,
  });
}

function request(
  overrides: Partial<{
    patches: readonly { ref: string; sha256: string; byteLength: number; acceptedBase: string }[];
    actionId: string;
  }> = {},
) {
  return {
    runId: "run-119",
    controllerId: "controller",
    definitionDigest: "d".repeat(64),
    activationId: "activation",
    ownerEpoch: 1,
    actionId: "prepare-source",
    requestDigest: "e".repeat(64),
    sourceId: "repository",
    repositoryRef: "refs/heads/delivery",
    patches: [],
    ...overrides,
  };
}

async function service(root: string) {
  const store = await SourceWorkspaceStore.open({ root: join(root, "source-workspaces") });
  return createSourceWorkspaceService(store);
}

async function grantFor(repository: string) {
  const measured = await measureGitEffectRepository(repository);
  return {
    sourceId: "repository",
    authorityDigest: "c".repeat(64),
    canonicalPath: measured.canonical_path,
    repositoryFingerprint: measured.fingerprint,
    allowedRefs: ["refs/heads/delivery"],
    allowedPaths: ["src"],
    maxFiles: 100,
    maxBytes: 1024 * 1024,
    consumers: [
      { kind: "controller" as const },
      { kind: "effect" as const, effect_id: "git-integrate-reviewed" },
    ],
    allowGitView: true,
  };
}

async function repositoryFixture() {
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-conductor-source-bridge-"));
  roots.push(privateRoot);
  const repository = join(privateRoot, "repository");
  await execute("git", ["init", "--quiet", repository]);
  await git(repository, "config", "user.email", "test@example.invalid");
  await git(repository, "config", "user.name", "Test");
  await execute("mkdir", ["-p", join(repository, "src", "a")]);
  await writeFile(join(repository, "src", "a", "nested.txt"), "nested\n");
  await writeFile(join(repository, "src", "a.txt"), "sibling\n");
  await writeFile(join(repository, "src", "value.txt"), "one\n");
  await writeFile(join(repository, "src", "extra.txt"), "original\n");
  await git(repository, "add", "-A");
  await execute("/usr/bin/git", [
    "-C",
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-q",
    "-m",
    "base",
  ]);
  const base = await git(repository, "rev-parse", "HEAD");
  await git(repository, "branch", "delivery");
  // Second base for the altBase / multi-tampered cases.
  await writeFile(join(repository, "src", "extra.txt"), "second-base\n");
  await git(repository, "add", "-A");
  await execute("/usr/bin/git", [
    "-C",
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-q",
    "-m",
    "alt",
  ]);
  const altBase = await git(repository, "rev-parse", "HEAD");
  await git(repository, "reset", "--hard", "--quiet", base);
  return { privateRoot, repository, base, altBase };
}

async function patchFor(repository: string, base: string, path: string, contents: string) {
  await writeFile(join(repository, path), contents);
  // `git add -N` records an intent-to-add so subsequent `git diff <commit>`
  // includes the new file in its working-tree-vs-commit comparison.
  await git(repository, "add", "--intent-to-add", path);
  const { stdout } = await execute("git", ["diff", "--binary", base], { cwd: repository });
  await git(repository, "reset", "--hard", "--quiet", base);
  const bytes = Buffer.from(stdout);
  const { createHash } = await import("node:crypto");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", args, { cwd });
  return stdout.trim();
}

function implementation(kind: "git_integrate" | "git_promote" | "deliver_ref") {
  return {
    id: `builtin-${kind.replace("_", "-")}-v1`,
    kind,
    digest: "1".repeat(64),
    request_schema_id: `${kind}-request-v1`,
    request_schema_digest: effectRequestSchemaDigest(kind),
    output_schema_id: `${kind}-result-v1`,
    output_schema_digest: effectResultSchemaDigest(kind),
  };
}

function integrationGrant(
  path: string,
  fingerprint: string,
  allowedSourcePaths = ["src"],
): EffectGrant {
  return {
    schema_version: 1 as const,
    id: "git-integrate-reviewed",
    adapter_id: "choose-git-integrate",
    implementation_id: implementation("git_integrate").id,
    implementation_digest: "1".repeat(64),
    request_schema_id: "git_integrate-request-v1",
    request_schema_digest: effectRequestSchemaDigest("git_integrate"),
    output_schema_id: "git_integrate-result-v1",
    output_schema_digest: effectResultSchemaDigest("git_integrate"),
    repository: { id: "repo-main", canonical_path: path, fingerprint },
    max_input_bytes: 524_288,
    max_output_bytes: 524_288,
    timeout_seconds: 120,
    kind: "git_integrate",
    allowed_integration_refs: ["refs/pi-conductor/integration/reviewed"],
    allowed_source_paths: allowedSourcePaths,
    required_patch_evidence: [{ producer_id: "review-patch", schema_id: "patch-review-v1" }],
  };
}

function verifiedPatchEvidence(subjectDigest: string) {
  return {
    artifactRef: "artifact/v2/review",
    sha256: "5".repeat(64),
    producerId: "review-patch",
    schemaId: "patch-review-v1",
    subjectDigest,
    verdict: "approved" as const,
  };
}

function sourceWorkspaceDescriptor(source: PreparedSourceWorkspace) {
  return {
    ref: source.ref,
    repository_ref: source.repositoryRef,
    repository_fingerprint: source.repositoryFingerprint,
    base_commit: source.baseCommit,
    head_commit: source.headCommit,
    tree_id: source.treeId,
    inventory_digest: source.inventoryDigest,
    file_count: source.fileCount,
    byte_length: source.byteLength,
    allowed_paths: [...source.allowedPaths],
    patches_digest: source.patchesDigest,
    patches: source.patches.map((entry) => ({
      ref: entry.ref,
      sha256: entry.sha256,
      byte_length: entry.byteLength,
      accepted_base: entry.acceptedBase,
      allowed_paths: [...entry.allowedPaths],
    })),
    audience: [...source.audience].map((entry) => ({ ...entry })),
  };
}

function integrationRequest(
  base: string,
  headCommit: string,
  patchDigest: string,
  descriptor: ReturnType<typeof sourceWorkspaceDescriptor>,
) {
  const verified = verifiedPatchEvidence(patchDigest);
  return {
    schema_version: 1 as const,
    kind: "git_integrate" as const,
    repository_id: "repo-main",
    accepted_base: base,
    integration_ref: "refs/pi-conductor/integration/reviewed",
    expected_ref_oid: null,
    patches: [
      {
        artifact_ref: "artifact/v2/patch",
        sha256: patchDigest,
        base_commit: headCommit,
        evidence: [
          {
            artifact_ref: verified.artifactRef,
            sha256: verified.sha256,
            producer_id: verified.producerId,
            schema_id: verified.schemaId,
            subject_digest: verified.subjectDigest,
            verdict: verified.verdict,
          },
        ],
      },
    ],
    selected_source_paths: ["src/child.txt"],
    source_workspace_descriptor: descriptor,
  };
}

async function publishSource(source: { readonly integratedHead: string }) {
  return {
    ref: `artifact/v2/source/${source.integratedHead}`,
    sha256: "f".repeat(64),
  };
}
