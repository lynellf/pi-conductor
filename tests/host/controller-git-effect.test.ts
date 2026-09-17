import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type EffectGrant, pinEffectAuthority } from "../../src/host/controller/effect-registry.js";
import {
  assertDeliverySource,
  type GitEffectPrepared,
  integrateGitEffect,
  integrateGitEffectFromSourceWorkspace,
  measureGitEffectRepository,
  promoteGitEffect,
  reconcileGitEffect,
} from "../../src/host/controller/git-effect.js";
import type { PreparedSourceWorkspace } from "../../src/host/controller/source-workspace-contract.js";
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
      await execute("/usr/bin/chmod", ["-R", "u+w", root]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("controller Git effects", () => {
  it("integrates ordered patches in isolated state and CAS-updates only the approved ref", async () => {
    const fixture = await repositoryFixture();
    await git(fixture.repository, "config", "url.https://attacker.invalid/.insteadOf", "/");
    await git(fixture.repository, "config", "maintenance.auto", "true");
    await git(fixture.repository, "config", "gc.auto", "1");
    await git(fixture.repository, "config", "gc.recentObjectsHook", "/untrusted/hook");
    const patch = await patchFor(fixture.repository, fixture.base, "src/value.txt", "two\n");
    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint),
      [implementation("git_integrate")],
    );
    const prepared: GitEffectPrepared[] = [];
    let effectOpenChecks = 0;
    const outcome = await integrateGitEffect({
      authority,
      request: integrationRequest(fixture.base, patch.sha256),
      workspaceRoot: fixture.privateRoot,
      resolvePatch: async () => ({
        bytes: patch.bytes,
        sha256: patch.sha256,
        baseCommit: fixture.base,
        allowedPaths: ["src/value.txt"],
        evidence: [verifiedPatchEvidence(patch.sha256)],
      }),
      publishSelectedSource: publishSource,
      persistPrepared: async (value) => {
        prepared.push(value);
      },
      assertEffectOpen: async () => {
        effectOpenChecks += 1;
      },
      assertOpen: () => undefined,
    });
    expect(prepared).toHaveLength(1);
    expect(effectOpenChecks).toBe(2);
    expect(
      await git(fixture.repository, "rev-parse", "refs/pi-conductor/integration/reviewed"),
    ).toBe(outcome.integratedHead);
    expect(outcome.selectedSource.files).toEqual([
      expect.objectContaining({ path: "src/value.txt", bytes: Buffer.from("two\n") }),
    ]);
    expect(await readFile(join(fixture.repository, "src/value.txt"), "utf8")).toBe("one\n");
    const preparedRecord = prepared[0];
    if (preparedRecord === undefined) throw new Error("prepared state was not captured");
    expect(await reconcileGitEffect(authority, preparedRecord)).toEqual({
      kind: "applied",
      observedHead: outcome.integratedHead,
    });
  });

  it("reconciles a crash after prepared persistence but before canonical CAS as not applied", async () => {
    const fixture = await repositoryFixture();
    const patch = await patchFor(fixture.repository, fixture.base, "src/value.txt", "two\n");
    const measured = await measureGitEffectRepository(fixture.repository);
    const authority = pinEffectAuthority(
      integrationGrant(measured.canonical_path, measured.fingerprint),
      [implementation("git_integrate")],
    );
    let prepared: GitEffectPrepared | undefined;
    await expect(
      integrateGitEffect({
        authority,
        request: integrationRequest(fixture.base, patch.sha256),
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: patch.bytes,
          sha256: patch.sha256,
          baseCommit: fixture.base,
          allowedPaths: ["src/value.txt"],
          evidence: [verifiedPatchEvidence(patch.sha256)],
        }),
        publishSelectedSource: publishSource,
        persistPrepared: async (value) => {
          prepared = value;
          throw new Error("append acknowledgment lost");
        },
        assertOpen: () => undefined,
      }),
    ).rejects.toThrow("append acknowledgment lost");
    if (prepared === undefined) throw new Error("prepared state was not captured");
    expect(await reconcileGitEffect(authority, prepared)).toEqual({
      kind: "not_applied",
      observedHead: null,
    });
  });

  it("rejects a patch that changes paths outside its verified artifact binding", async () => {
    const fixture = await repositoryFixture();
    const patch = await patchFor(fixture.repository, fixture.base, "other.txt", "changed\n");
    const measured = await measureGitEffectRepository(fixture.repository);
    await expect(
      integrateGitEffect({
        authority: pinEffectAuthority(
          integrationGrant(measured.canonical_path, measured.fingerprint),
          [implementation("git_integrate")],
        ),
        request: integrationRequest(fixture.base, patch.sha256),
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: patch.bytes,
          sha256: patch.sha256,
          baseCommit: fixture.base,
          allowedPaths: ["src/value.txt"],
          evidence: [verifiedPatchEvidence(patch.sha256)],
        }),
        publishSelectedSource: publishSource,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toThrow("outside verified patch paths");
  });

  it("fails closed on conflicting ordered patches before preparing or updating a ref", async () => {
    const fixture = await repositoryFixture();
    const first = await patchFor(fixture.repository, fixture.base, "src/value.txt", "two\n");
    const second = await patchFor(fixture.repository, fixture.base, "src/value.txt", "three\n");
    const measured = await measureGitEffectRepository(fixture.repository);
    const prepared: string[] = [];
    const request = integrationRequest(fixture.base, first.sha256);
    const secondEvidence = verifiedPatchEvidence(second.sha256);
    const combined = {
      ...request,
      patches: [
        ...request.patches,
        {
          artifact_ref: "artifact/v2/patch-second",
          sha256: second.sha256,
          base_commit: fixture.base,
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
      integrateGitEffect({
        authority: pinEffectAuthority(
          integrationGrant(measured.canonical_path, measured.fingerprint),
          [implementation("git_integrate")],
        ),
        request: combined,
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async (claim) => {
          const selected = claim.sha256 === first.sha256 ? first : second;
          return {
            bytes: selected.bytes,
            sha256: selected.sha256,
            baseCommit: fixture.base,
            allowedPaths: ["src/value.txt"],
            evidence: [verifiedPatchEvidence(selected.sha256)],
          };
        },
        publishSelectedSource: publishSource,
        persistPrepared: async (value) => {
          prepared.push(value.integratedHead);
        },
        assertOpen: () => undefined,
      }),
    ).rejects.toThrow();
    expect(prepared).toEqual([]);
    await expect(
      git(fixture.repository, "rev-parse", "--verify", "refs/pi-conductor/integration/reviewed"),
    ).rejects.toThrow();
  });

  it("merges compatible independently base-bound patches that overlap one file", async () => {
    const fixture = await repositoryFixture();
    const baseLines = Array.from({ length: 14 }, (_, index) => `line-${index + 1}`);
    const firstLines = [...baseLines];
    firstLines[1] = "first-reviewed-change";
    const secondLines = [...baseLines];
    secondLines[12] = "second-reviewed-change";
    const first = await patchFor(
      fixture.repository,
      fixture.base,
      "overlap.txt",
      `${firstLines.join("\n")}\n`,
    );
    const second = await patchFor(
      fixture.repository,
      fixture.base,
      "overlap.txt",
      `${secondLines.join("\n")}\n`,
    );
    const measured = await measureGitEffectRepository(fixture.repository);
    const request = integrationRequest(fixture.base, first.sha256);
    const secondEvidence = verifiedPatchEvidence(second.sha256);
    const outcome = await integrateGitEffect({
      authority: pinEffectAuthority(
        integrationGrant(measured.canonical_path, measured.fingerprint, ["overlap.txt"]),
        [implementation("git_integrate")],
      ),
      request: {
        ...request,
        selected_source_paths: ["overlap.txt"],
        patches: [
          ...request.patches,
          {
            artifact_ref: "artifact/v2/patch-second",
            sha256: second.sha256,
            base_commit: fixture.base,
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
      },
      workspaceRoot: fixture.privateRoot,
      resolvePatch: async (claim) => {
        const selected = claim.sha256 === first.sha256 ? first : second;
        return {
          bytes: selected.bytes,
          sha256: selected.sha256,
          baseCommit: fixture.base,
          allowedPaths: ["overlap.txt"],
          evidence: [verifiedPatchEvidence(selected.sha256)],
        };
      },
      publishSelectedSource: publishSource,
      persistPrepared: async () => undefined,
      assertOpen: () => undefined,
    });
    const combined = outcome.selectedSource.files[0]?.bytes.toString();
    expect(combined).toContain("first-reviewed-change");
    expect(combined).toContain("second-reviewed-change");
  });

  it("promotes an exact reviewed head by CAS and refuses a checked-out target", async () => {
    const fixture = await repositoryFixture();
    const integrated = await commitFile(fixture.repository, "src/value.txt", "reviewed\n");
    await git(fixture.repository, "branch", "integration", integrated);
    await git(fixture.repository, "checkout", "-q", "main");
    const measured = await measureGitEffectRepository(fixture.repository);
    const promotionGrant: EffectGrant = {
      ...commonGrant("git_promote", measured.canonical_path, measured.fingerprint),
      kind: "git_promote",
      allowed_source_refs: ["refs/heads/integration"],
      allowed_target_refs: ["refs/heads/release"],
      required_evidence: [{ producer_id: "validate-integrated", schema_id: "validation-v1" }],
    };
    const authority = pinEffectAuthority(promotionGrant, [implementation("git_promote")]);
    const evidence = verifiedHeadEvidence(integrated);
    await git(fixture.repository, "branch", "release", fixture.base);
    await promoteGitEffect({
      authority,
      request: {
        schema_version: 1,
        kind: "git_promote",
        repository_id: "repo-main",
        source_ref: "refs/heads/integration",
        reviewed_head: integrated,
        target_ref: "refs/heads/release",
        expected_target_oid: fixture.base,
        evidence: [evidence.claim],
      },
      resolveEvidence: async () => evidence.verified,
      persistPrepared: async () => undefined,
      assertOpen: () => undefined,
    });
    expect(await git(fixture.repository, "rev-parse", "refs/heads/release")).toBe(integrated);

    await expect(
      promoteGitEffect({
        authority: pinEffectAuthority(
          { ...promotionGrant, allowed_target_refs: ["refs/heads/main"] },
          [implementation("git_promote")],
        ),
        request: {
          schema_version: 1,
          kind: "git_promote",
          repository_id: "repo-main",
          source_ref: "refs/heads/integration",
          reviewed_head: integrated,
          target_ref: "refs/heads/main",
          expected_target_oid: fixture.base,
          evidence: [evidence.claim],
        },
        resolveEvidence: async () => evidence.verified,
        persistPrepared: async () => undefined,
        assertOpen: () => undefined,
      }),
    ).rejects.toThrow("checked out in a worktree");
  });

  it("verifies delivery evidence against the canonical source ref", async () => {
    const fixture = await repositoryFixture();
    const reviewed = await commitFile(fixture.repository, "src/value.txt", "reviewed\n");
    await git(fixture.repository, "branch", "integration", reviewed);
    const measured = await measureGitEffectRepository(fixture.repository);
    const deliverImplementation = {
      id: "builtin-deliver-ref-v1",
      kind: "deliver_ref" as const,
      digest: "1".repeat(64),
      request_schema_id: "deliver_ref-request-v1",
      request_schema_digest: effectRequestSchemaDigest("deliver_ref"),
      output_schema_id: "deliver_ref-result-v1",
      output_schema_digest: effectResultSchemaDigest("deliver_ref"),
    };
    const deliveryGrant: EffectGrant = {
      ...commonGrant("deliver_ref", measured.canonical_path, measured.fingerprint),
      kind: "deliver_ref",
      remote: {
        id: "origin",
        exact_origin: "https://delivery.invalid",
        exact_path: "/v1/ref",
        method: "PUT",
        credential_source_id: "credential",
      },
      allowed_source_refs: ["refs/heads/integration"],
      allowed_target_refs: ["refs/heads/main"],
      required_evidence: [{ producer_id: "validate-integrated", schema_id: "validation-v1" }],
    };
    const evidence = verifiedHeadEvidence(reviewed);
    const deliveryRequest = {
      schema_version: 1 as const,
      kind: "deliver_ref" as const,
      repository_id: "repo-main",
      source_ref: "refs/heads/integration",
      reviewed_head: reviewed,
      remote_id: "origin",
      target_ref: "refs/heads/main",
      expected_remote_oid: null,
      idempotency_key: "delivery-1",
      evidence: [evidence.claim],
    };
    const deliveryAuthority = pinEffectAuthority(deliveryGrant, [deliverImplementation]);
    await expect(
      assertDeliverySource({
        authority: deliveryAuthority,
        request: deliveryRequest,
        resolveEvidence: async () => evidence.verified,
      }),
    ).resolves.toBeUndefined();
    const wrongHeadEvidence = verifiedHeadEvidence(fixture.base);
    await expect(
      assertDeliverySource({
        authority: deliveryAuthority,
        request: {
          ...deliveryRequest,
          reviewed_head: fixture.base,
          evidence: [wrongHeadEvidence.claim],
        },
        resolveEvidence: async () => wrongHeadEvidence.verified,
      }),
    ).rejects.toThrow("source ref does not identify the reviewed head");
  });

  it("integrates a real child patch over the source prefix through the bridge without rewriting the original base", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = {
      ...(await grantFor(fixture.repository)),
      // The fixture includes `other.txt` and `overlap.txt` (used by other tests
      // in this file); the bridge test wants to add a new file under `src/`,
      // so the source-workspace allowed paths must cover every tracked path
      // copied into the synthetic prefix.
      allowedPaths: ["other.txt", "overlap.txt", "src"],
      consumers: [
        { kind: "controller" as const },
        { kind: "effect" as const, effect_id: "git_integrate-reviewed" },
      ],
    };
    const sourcePatch = await patchFor(
      fixture.repository,
      fixture.base,
      "src/extra.txt",
      "extra\n",
    );
    const sourceIntent = await source.resolveIntent(
      sourceRequest({
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
        audience: [{ kind: "controller" }, { kind: "effect", effect_id: "git_integrate-reviewed" }],
      }),
    );
    const preparedSource = await source.prepare(sourceIntent, grant, {
      resolvePatch: async () => ({
        bytes: sourcePatch.bytes,
        sha256: sourcePatch.sha256,
        byteLength: sourcePatch.bytes.length,
        acceptedBase: fixture.base,
        allowedPaths: ["src"],
        audience: [{ kind: "controller" }, { kind: "effect", effect_id: "git_integrate-reviewed" }],
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
    const prepared: GitEffectPrepared[] = [];
    const outcome = await integrateGitEffectFromSourceWorkspace({
      authority,
      request: bridgeRequest(
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
    expect(
      await git(fixture.repository, "rev-parse", "refs/pi-conductor/integration/reviewed"),
    ).toBe(outcome.integratedHead);
    expect(await readFile(join(fixture.repository, "src/value.txt"), "utf8")).toBe("one\n");
    // The bridge integrates the sealed prefix into
    // `refs/pi-conductor/integration/reviewed` only; the canonical repository
    // working tree stays at `B`, so `src/extra.txt` (introduced by the source
    // patch) must not exist on disk there.
    await expect(readFile(join(fixture.repository, "src/extra.txt"), "utf8")).rejects.toThrow();
    const workingTreePorcelain = (
      await execute("/usr/bin/git", [
        "-C",
        fixture.repository,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])
    ).stdout;
    expect(workingTreePorcelain).toBe("");
    const canonicalHead = await git(fixture.repository, "rev-parse", "HEAD");
    expect(canonicalHead).toBe(fixture.base);
  });
});

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-git-effect-"));
  roots.push(root);
  const repository = join(root, "repository");
  const privateRoot = join(root, "private");
  await mkdir(repository, { mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  await git(repository, "init", "-q", "-b", "main");
  await writeFile(join(repository, "other.txt"), "original\n");
  await writeFile(
    join(repository, "overlap.txt"),
    `${Array.from({ length: 14 }, (_, index) => `line-${index + 1}`).join("\n")}\n`,
  );
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src/value.txt"), "one\n");
  const base = await commit(repository, "base");
  return { repository, privateRoot, base };
}

async function patchFor(repository: string, base: string, path: string, contents: string) {
  await writeFile(join(repository, path), contents);
  // `git add -N` records an intent-to-add so `git diff <base>` includes the new
  // file in its working-tree-vs-commit comparison; `git reset --hard --quiet`
  // restores the tree after capturing the diff (handles both modifications and
  // new files).
  await git(repository, "add", "--intent-to-add", path);
  const { stdout } = await execute("/usr/bin/git", ["-C", repository, "diff", "--binary", base]);
  await git(repository, "reset", "--hard", "--quiet", base);
  const bytes = Buffer.from(stdout);
  const { createHash } = await import("node:crypto");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function commitFile(repository: string, path: string, contents: string): Promise<string> {
  await writeFile(join(repository, path), contents);
  return commit(repository, "change");
}

async function commit(repository: string, message: string): Promise<string> {
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
    message,
  ]);
  return git(repository, "rev-parse", "HEAD");
}

async function git(repository: string, ...args: string[]): Promise<string> {
  return (await execute("/usr/bin/git", ["-C", repository, ...args])).stdout.trim();
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

function commonGrant(
  kind: "git_integrate" | "git_promote" | "deliver_ref",
  path: string,
  fingerprint: string,
) {
  return {
    schema_version: 1 as const,
    id: `${kind}-reviewed`,
    adapter_id: `choose-${kind}`,
    implementation_id: implementation(kind).id,
    implementation_digest: "1".repeat(64),
    request_schema_id: `${kind}-request-v1`,
    request_schema_digest: effectRequestSchemaDigest(kind),
    output_schema_id: `${kind}-result-v1`,
    output_schema_digest: effectResultSchemaDigest(kind),
    repository: { id: "repo-main", canonical_path: path, fingerprint },
    max_input_bytes: 524_288,
    max_output_bytes: 524_288,
    timeout_seconds: 120,
  };
}

function integrationGrant(
  path: string,
  fingerprint: string,
  allowedSourcePaths = ["src/value.txt"],
): EffectGrant {
  return {
    ...commonGrant("git_integrate", path, fingerprint),
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

function integrationRequest(base: string, patchDigest: string) {
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
        base_commit: base,
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
    selected_source_paths: ["src/value.txt"],
  };
}

function verifiedHeadEvidence(head: string) {
  const claim = {
    artifact_ref: "artifact/v2/validation",
    sha256: "6".repeat(64),
    producer_id: "validate-integrated",
    schema_id: "validation-v1",
    subject_head: head,
    verdict: "approved" as const,
  };
  return {
    claim,
    verified: {
      artifactRef: claim.artifact_ref,
      sha256: claim.sha256,
      producerId: claim.producer_id,
      schemaId: claim.schema_id,
      subjectHead: head,
      verdict: claim.verdict,
    },
  };
}

async function publishSource(source: { readonly integratedHead: string }) {
  return {
    ref: `artifact/v2/source/${source.integratedHead}`,
    sha256: "f".repeat(64),
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
    allowedRefs: ["refs/heads/main"],
    allowedPaths: ["src"],
    maxFiles: 100,
    maxBytes: 1024 * 1024,
    consumers: [{ kind: "controller" as const }],
    allowGitView: true,
  };
}

function sourceRequest(
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
    repositoryRef: "refs/heads/main",
    patches: [],
    ...overrides,
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

function bridgeRequest(
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
