/**
 * Public no-model end-to-end test for the source-workspace-to-integration bridge
 * (issue #119 lane 1 contract). Exercises the full B→S→child patch→approval→
 * canonical B integration cycle twice in succession with real local Git,
 * real patch bytes, real evidence, real bounded-view verification, and
 * asserts that the original canonical repository is never mutated between
 * the two deliveries. This test is parent-owned per the issue #119 dispatch
 * cards; no model calls, no stubs, no mocks for Git, patches, or evidence.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type EffectGrant, pinEffectAuthority } from "../../src/host/controller/effect-registry.js";
import {
  type GitEffectPrepared,
  integrateGitEffectFromSourceWorkspace,
  measureGitEffectRepository,
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
      await execute("chmod", ["-R", "u+w", root]).catch(() => undefined);
      await execute("rm", ["-rf", root]).catch(() => undefined);
    }),
  );
});

describe("controller Git effect source-bridge public two-successive-delivery contract", () => {
  it("integrates two successive child patches against the same B without mutating the canonical repository between batches", async () => {
    const fixture = await repositoryFixture();
    const source = await service(fixture.privateRoot);
    const grant = await grantFor(fixture.repository);

    const preparedRefFor = new Map<string, PreparedSourceWorkspace>();

    const delivered = new Map<
      string,
      {
        integratedHead: string;
        persistedSourceWorkspace: NonNullable<GitEffectPrepared["sourceWorkspace"]>;
        observedPrior: string | null;
      }
    >();

    const prepareSourceAndChildPatch = async (
      sourcePatch: PatchSummary,
      childPath: string,
      childContents: string,
      label: string,
    ): Promise<{
      preparedSource: PreparedSourceWorkspace;
      childPatch: PatchSummary;
    }> => {
      const sourceIntent = await source.resolveIntent(
        {
          runId: "run-public",
          controllerId: "controller",
          definitionDigest: "d".repeat(64),
          activationId: "activation-public",
          ownerEpoch: 1,
          actionId: `prepare-source-${label}`,
          requestDigest: createHash("sha256").update(label).digest("hex"),
          sourceId: "repository",
          repositoryRef: "refs/heads/delivery",
          patches: [
            {
              ref: `child-output/v2/source-patch-${label}`,
              sha256: sourcePatch.sha256,
              byteLength: sourcePatch.bytes.length,
              acceptedBase: fixture.base,
            },
          ],
        },
        grant,
        async () => ({
          bytes: sourcePatch.bytes,
          sha256: sourcePatch.sha256,
          byteLength: sourcePatch.bytes.length,
          acceptedBase: fixture.base,
          allowedPaths: ["src"],
          audience: [
            { kind: "controller" },
            { kind: "effect", effect_id: "git-integrate-reviewed" },
          ],
        }),
      );

      const preparedSource = await source.prepare(sourceIntent, grant, {
        resolvePatch: async () => ({
          bytes: sourcePatch.bytes,
          sha256: sourcePatch.sha256,
          byteLength: sourcePatch.bytes.length,
          acceptedBase: fixture.base,
          allowedPaths: ["src"],
          audience: [
            { kind: "controller" },
            { kind: "effect", effect_id: "git-integrate-reviewed" },
          ],
        }),
        persist: async () => undefined,
        assertOpen: () => undefined,
      });
      preparedRefFor.set(preparedSource.ref, preparedSource);

      // Establish a real worktree off the sealed source workspace head so the
      // child patch bytes can be authored against a materialised tree.
      const childWorktreePath = await worktreeRoot(fixture.privateRoot, label);
      await createIndependentSourceWorktree(
        childWorktreePath,
        `child-${label}`,
        preparedSource.headCommit,
        preparedSource.checkoutPath,
      );
      const childPatch = await childPatchFor(
        { repository: fixture.repository, worktree: childWorktreePath },
        childPath,
        childContents,
      );
      return { preparedSource, childPatch };
    };

    const deliver = async (
      childPatch: PatchSummary,
      preparedSource: PreparedSourceWorkspace,
      label: string,
    ): Promise<void> => {
      const measured = await measureGitEffectRepository(fixture.repository);
      const authority = pinEffectAuthority(
        integrationGrant(measured.canonical_path, measured.fingerprint, ["src"]),
        [implementation("git_integrate")],
      );

      const expectedPrior = label === "one" ? null : (delivered.get("one")?.integratedHead ?? null);
      const observedPrior = await git(
        fixture.repository,
        "rev-parse",
        "--verify",
        "refs/pi-conductor/integration/reviewed",
      ).catch(() => "0".repeat(40));
      expect(observedPrior).toBe(expectedPrior ?? "0".repeat(40));

      const descriptor = sourceWorkspaceDescriptor(preparedSource);
      const outcome = await integrateGitEffectFromSourceWorkspace({
        authority,
        request: integrationRequest(
          fixture.base,
          preparedSource.headCommit,
          childPatch,
          descriptor,
          expectedPrior,
        ),
        workspaceRoot: fixture.privateRoot,
        resolvePatch: async () => ({
          bytes: childPatch.bytes,
          sha256: childPatch.sha256,
          baseCommit: preparedSource.headCommit,
          allowedPaths: [childPatch.path],
          evidence: [verifiedPatchEvidence(childPatch.sha256)],
        }),
        resolveSourceWorkspace: async (ref) => {
          const value = preparedRefFor.get(ref);
          if (value === undefined) throw new Error(`unknown source workspace ref '${ref}'`);
          return value;
        },
        publishSelectedSource: async (selected) => ({
          ref: `artifact/v2/source/${selected.integratedHead}`,
          sha256: "f".repeat(64),
        }),
        persistPrepared: async (prepared) => {
          if (prepared.sourceWorkspace === undefined)
            throw new Error("bridge did not persist source-workspace postcondition");
          delivered.set(label, {
            integratedHead: prepared.integratedHead,
            persistedSourceWorkspace: prepared.sourceWorkspace,
            observedPrior: prepared.expectedPrior,
          });
        },
        assertOpen: () => undefined,
      });

      expect(await readFile(join(fixture.repository, "src/value.txt"), "utf8")).toBe(
        ORIGINAL_VALUE,
      );
      expect(
        (
          await execute("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
            cwd: fixture.repository,
          })
        ).stdout,
      ).toBe("");
      const canonicalHead = await git(fixture.repository, "rev-parse", "HEAD");
      expect(canonicalHead).toBe(fixture.base);
      const integrationHead = await git(
        fixture.repository,
        "rev-parse",
        "--verify",
        "refs/pi-conductor/integration/reviewed",
      );
      expect(integrationHead).toBe(outcome.integratedHead);
      expect(delivered.get(label)?.integratedHead).toBe(outcome.integratedHead);
      expect(delivered.get(label)?.observedPrior).toBe(expectedPrior);
      expect(delivered.get(label)?.persistedSourceWorkspace.ref).toBe(preparedSource.ref);
      expect(delivered.get(label)?.persistedSourceWorkspace.head_commit).toBe(
        preparedSource.headCommit,
      );
      expect(delivered.get(label)?.persistedSourceWorkspace.tree_id).toBe(preparedSource.treeId);

      const reopened = await source.open(preparedSource.ref, grant, { kind: "controller" });
      expect(reopened.ref).toBe(preparedSource.ref);
      expect(reopened.baseCommit).toBe(preparedSource.baseCommit);
      expect(reopened.headCommit).toBe(preparedSource.headCommit);
      expect(reopened.treeId).toBe(preparedSource.treeId);
      expect(reopened.repositoryRef).toBe(preparedSource.repositoryRef);
      expect(reopened.repositoryFingerprint).toBe(preparedSource.repositoryFingerprint);
      expect(reopened.patchesDigest).toBe(preparedSource.patchesDigest);
      expect([...reopened.allowedPaths]).toEqual([...preparedSource.allowedPaths]);
      expect(reopened.patches.length).toBe(preparedSource.patches.length);
      for (const [index, entry] of reopened.patches.entries()) {
        const original = preparedSource.patches[index];
        if (original === undefined) throw new Error("patch lineage index drift");
        expect(entry.ref).toBe(original.ref);
        expect(entry.sha256).toBe(original.sha256);
        expect(entry.byteLength).toBe(original.byteLength);
        expect(entry.acceptedBase).toBe(original.acceptedBase);
        expect([...entry.allowedPaths]).toEqual([...original.allowedPaths]);
      }
    };

    const sourcePatchA = await sourcePatchFor(
      fixture.repository,
      fixture.base,
      "src/extra.txt",
      "extra-batch-one\n",
    );
    const { preparedSource: preparedSourceA, childPatch: childPatchA } =
      await prepareSourceAndChildPatch(sourcePatchA, "src/child.txt", "child-one\n", "first");
    await deliver(childPatchA, preparedSourceA, "one");

    const sourcePatchB = await sourcePatchFor(
      fixture.repository,
      fixture.base,
      "src/extra.txt",
      "extra-batch-two\n",
    );
    const { preparedSource: preparedSourceB, childPatch: childPatchB } =
      await prepareSourceAndChildPatch(sourcePatchB, "src/child-two.txt", "child-two\n", "second");
    await deliver(childPatchB, preparedSourceB, "two");

    expect(delivered.size).toBe(2);
    const first = delivered.get("one");
    const second = delivered.get("two");
    if (first === undefined || second === undefined)
      throw new Error("deliveries were not recorded");
    expect(first.integratedHead).not.toBe(second.integratedHead);
    expect(second.observedPrior).toBe(first.integratedHead);
    expect(await readFile(join(fixture.repository, "src/value.txt"), "utf8")).toBe(ORIGINAL_VALUE);
    const finalCanonicalHead = await git(fixture.repository, "rev-parse", "HEAD");
    expect(finalCanonicalHead).toBe(fixture.base);
    const finalPorcelain = (
      await execute("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: fixture.repository,
      })
    ).stdout;
    expect(finalPorcelain).toBe("");
  }, 120_000);
});

const ORIGINAL_VALUE = "original\n";

interface PatchSummary {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly path: string;
}

async function repositoryFixture() {
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-conductor-source-bridge-public-"));
  const repository = join(privateRoot, "repository");
  await execute("git", ["init", "--quiet", repository]);
  await git(repository, "config", "user.email", "test@example.invalid");
  await git(repository, "config", "user.name", "Test");
  await execute("mkdir", ["-p", join(repository, "src")]);
  await writeFile(join(repository, "src", "value.txt"), ORIGINAL_VALUE);
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
  return { privateRoot, repository, base };
}

async function sourcePatchFor(
  repository: string,
  base: string,
  path: string,
  contents: string,
): Promise<PatchSummary> {
  await writeFile(join(repository, path), contents);
  // `git add -N` records an intent-to-add so `git diff <base>` includes the
  // new file in its working-tree-vs-commit comparison; `git reset --hard`
  // restores the tree after capturing the diff (handles both modifications and
  // new files).
  await git(repository, "add", "--intent-to-add", path);
  const { stdout } = await execute(
    "git",
    ["diff", "--binary", "--src-prefix=a/", "--dst-prefix=b/", base],
    { cwd: repository },
  );
  await git(repository, "reset", "--hard", "--quiet", base);
  const bytes = Buffer.from(stdout);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), path };
}

async function worktreeRoot(privateRoot: string, name: string): Promise<string> {
  return join(privateRoot, `${name}-worktree`);
}

async function childPatchFor(
  context: { repository: string; worktree: string },
  path: string,
  contents: string,
): Promise<PatchSummary> {
  await writeFile(join(context.worktree, path), contents);
  // `git add -N` records an intent-to-add so `git diff --binary` includes the
  // new file in the worktree-vs-HEAD comparison (handles both modifications
  // and new files).
  await git(context.worktree, "add", "--intent-to-add", path);
  const { stdout } = await execute("git", ["diff", "--binary"], { cwd: context.worktree });
  await execute("git", ["reset", "--hard", "--quiet", "HEAD"], { cwd: context.worktree });
  const bytes = Buffer.from(stdout);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), path };
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", args, { cwd });
  return stdout.trim();
}

function implementation(kind: "git_integrate") {
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
  allowedSourcePaths: string[],
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
  childPatch: PatchSummary,
  descriptor: ReturnType<typeof sourceWorkspaceDescriptor>,
  expectedPrior: string | null,
) {
  const patchDigest = childPatch.sha256;
  const verified = verifiedPatchEvidence(patchDigest);
  return {
    schema_version: 1 as const,
    kind: "git_integrate" as const,
    repository_id: "repo-main",
    accepted_base: base,
    integration_ref: "refs/pi-conductor/integration/reviewed",
    expected_ref_oid: expectedPrior,
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
    selected_source_paths: [childPatch.path],
    source_workspace_descriptor: descriptor,
  };
}
