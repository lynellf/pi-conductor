/** Resolve, materialize, and open immutable bounded source workspaces — issue #118. */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ControllerOutputPrincipal } from "../../manifest/controller-output.js";
import {
  assertSourceWorkspaceRecord,
  type SourceWorkspaceIntent,
  sourceWorkspaceIntentDigest,
} from "../../persistence/source-workspace.js";
import { ToolExecutionError } from "../execution/tool-execution-controller.js";
import { measureGitEffectRepository } from "./git-effect.js";
import {
  type PreparedSourceWorkspace,
  type PrepareSourceWorkspaceOptions,
  type ResolvedSourceWorkspacePatch,
  type ResolveSourceWorkspaceInput,
  SourceWorkspaceError,
  type SourceWorkspaceGrant,
} from "./source-workspace-contract.js";
import { gitText, runSourceGit, sourceGitEnvironment } from "./source-workspace-git.js";
import {
  copySourceTree,
  materializeSourceGitView,
  validateSourceIndex,
} from "./source-workspace-materialize.js";
import { type SourceWorkspaceStore, sourceContent } from "./source-workspace-store.js";
import {
  assertCurrentSourceGrant,
  assertSourceGrant,
  assertSourceInput,
  assertSourceIntentGrant,
  intersectSourceAudience,
  resolveSourceRef,
  sourceWorkspacePatchesDigest,
  sourceWorkspacePolicyDigest,
  verifyPersistedSourcePatch,
  verifySourcePatch,
} from "./source-workspace-validation.js";

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Source-workspace protocol consumed by controller recovery, adapters, and native workers. */
export interface SourceWorkspaceService {
  resolveIntent(
    input: ResolveSourceWorkspaceInput,
    grant: SourceWorkspaceGrant,
    resolvePatch: (ref: string) => Promise<ResolvedSourceWorkspacePatch>,
  ): Promise<SourceWorkspaceIntent>;
  prepare(
    intent: SourceWorkspaceIntent,
    grant: SourceWorkspaceGrant,
    options: PrepareSourceWorkspaceOptions,
  ): Promise<PreparedSourceWorkspace>;
  open(
    ref: string,
    grant: SourceWorkspaceGrant,
    principal: ControllerOutputPrincipal,
  ): Promise<PreparedSourceWorkspace>;
}

/** Construct the host-only source workspace service. */
export function createSourceWorkspaceService(store: SourceWorkspaceStore): SourceWorkspaceService {
  return Object.freeze({
    async resolveIntent(
      input: ResolveSourceWorkspaceInput,
      grant: SourceWorkspaceGrant,
      resolvePatch: (ref: string) => Promise<ResolvedSourceWorkspacePatch>,
    ) {
      assertSourceGrant(grant);
      assertSourceInput(input, grant);
      await assertCurrentSourceGrant(grant);
      const resolvedBase = await resolveSourceRef(grant.canonicalPath, input.repositoryRef);
      const claims = input.patches ?? [];
      let audience = [...grant.consumers];
      const patches = [];
      for (const claim of claims) {
        const patch = await resolvePatch(claim.ref);
        verifySourcePatch(claim, patch, grant);
        audience = intersectSourceAudience(audience, patch.audience);
        patches.push({
          ref: claim.ref,
          sha256: claim.sha256,
          byte_length: claim.byteLength,
          accepted_base: patch.acceptedBase,
          allowed_paths: [...patch.allowedPaths].sort(),
        });
      }
      if (!audience.some((item) => item.kind === "controller"))
        throw new SourceWorkspaceError("patch-audience-denied");
      const fields = {
        run_id: input.runId,
        controller_id: input.controllerId,
        definition_digest: input.definitionDigest,
        activation_id: input.activationId,
        owner_epoch: input.ownerEpoch,
        action_id: input.actionId,
        request_sha256: input.requestDigest,
        source_id: input.sourceId,
        source_authority_digest: grant.authorityDigest,
        repository_fingerprint: grant.repositoryFingerprint,
        requested_ref: input.repositoryRef,
        resolved_base: resolvedBase,
        patches,
        audience,
        policy_digest: sourceWorkspacePolicyDigest(grant),
      };
      const intent: SourceWorkspaceIntent = {
        type: "source_workspace_intent",
        schema_version: 1,
        ...fields,
        workspace_id: sourceWorkspaceIntentDigest(fields),
        ts: Date.now(),
      };
      assertSourceWorkspaceRecord(intent);
      return freeze(intent);
    },

    async prepare(
      intent: SourceWorkspaceIntent,
      grant: SourceWorkspaceGrant,
      options: PrepareSourceWorkspaceOptions,
    ) {
      assertSourceWorkspaceRecord(intent as unknown);
      assertSourceIntentGrant(intent, grant);
      await assertCurrentSourceGrant(grant);
      assertOpen(options);
      // The caller must append this before the first private repository mutation.
      await options.persist(started(intent));
      assertOpen(options);
      const working = await store.createWorkingDirectory(intent.workspace_id);
      let published = false;
      try {
        const measured = await measureGitEffectRepository(grant.canonicalPath);
        if (measured.fingerprint !== intent.repository_fingerprint)
          throw new SourceWorkspaceError("grant-revoked");
        const repo = join(working, "repo");
        await mkdir(repo, { mode: 0o700 });
        const alternate = join(measured.common_git_dir, "objects");
        const environment = sourceGitEnvironment(alternate);
        await runSourceGit(repo, ["init", "--quiet"], { signal: options.signal, env: environment });
        await runSourceGit(repo, ["read-tree", intent.resolved_base], {
          signal: options.signal,
          env: environment,
        });
        await validateSourceIndex(repo, environment, grant, options.signal);
        await runSourceGit(repo, ["checkout-index", "-a", "-f"], {
          signal: options.signal,
          env: environment,
        });
        await runSourceGit(repo, ["update-index", "--refresh"], {
          signal: options.signal,
          env: environment,
        });
        // Establish the no-patch synthetic root before checking a first patch.
        // A native worker can legitimately emit a patch against this exact
        // independent head, while legacy/original patches still name A.
        const unpatched = await commitSyntheticPrefix(repo, environment, options.signal);
        let prefixHead = unpatched.head;
        let finalTree = unpatched.tree;
        for (const [index, claim] of intent.patches.entries()) {
          assertOpen(options);
          const patch = await options.resolvePatch(claim.ref);
          verifyPersistedSourcePatch(claim, patch, grant);
          if (claim.accepted_base !== intent.resolved_base && claim.accepted_base !== prefixHead)
            throw new SourceWorkspaceError(
              "patch-base-mismatch",
              "patch does not name the source prefix",
            );
          const patchPath = join(working, `patch-${index}.diff`);
          await writeFile(patchPath, patch.bytes, { mode: 0o600, flag: "wx" });
          try {
            try {
              await runSourceGit(repo, ["apply", "--index", "--3way", "--binary", patchPath], {
                signal: options.signal,
                env: environment,
              });
            } catch (cause) {
              throw new SourceWorkspaceError("patch-conflict", "source patch does not apply", {
                cause,
              });
            }
            // Each prefix is an execution boundary. Reject a patch-created
            // symlink, unauthorized path, or oversized tree before another
            // patch can inspect or modify that intermediate state.
            await validateSourceIndex(repo, environment, grant, options.signal);
            const committed = await commitSyntheticPrefix(repo, environment, options.signal);
            prefixHead = committed.head;
            finalTree = committed.tree;
          } finally {
            // At most one bounded patch remains in a quarantined failure
            // directory; successful prefixes retain no patch payload.
            await rm(patchPath, { force: true });
          }
        }
        await validateSourceIndex(repo, environment, grant, options.signal);
        if (!objectId.test(finalTree) || !objectId.test(prefixHead))
          throw new SourceWorkspaceError("workspace-corrupt");
        const sourcePath = join(working, "source");
        await copySourceTree(repo, sourcePath);
        const sourceContentBase = await sourceContent(sourcePath, grant);
        const patchesDigest = sourceWorkspacePatchesDigest(intent.patches);
        const content = {
          ...sourceContentBase,
          head_commit: prefixHead,
          tree_id: finalTree,
          allowed_paths: [...grant.allowedPaths].sort(),
          patches_digest: patchesDigest,
          patches: [...intent.patches],
        };
        const gitPath = join(working, "git");
        await materializeSourceGitView(repo, gitPath, prefixHead, environment, options.signal);
        assertOpen(options);
        const prepared = await store.publish(intent, sourcePath, gitPath, content);
        published = true;
        assertOpen(options);
        await options.persist({
          type: "source_workspace_prepared",
          schema_version: 1,
          workspace_id: intent.workspace_id,
          run_id: intent.run_id,
          controller_id: intent.controller_id,
          definition_digest: intent.definition_digest,
          activation_id: intent.activation_id,
          owner_epoch: intent.owner_epoch,
          ref: prepared.ref,
          intent_digest: sourceWorkspaceIntentDigest(intent),
          content: {
            head_commit: prepared.headCommit,
            tree_id: prepared.treeId,
            inventory_digest: prepared.inventoryDigest,
            file_count: prepared.fileCount,
            byte_length: prepared.byteLength,
            allowed_paths: [...prepared.allowedPaths].sort(),
            patches_digest: prepared.patchesDigest,
            patches: [...prepared.patches].map((entry) => ({
              ref: entry.ref,
              sha256: entry.sha256,
              byte_length: entry.byteLength,
              accepted_base: entry.acceptedBase,
              allowed_paths: [...entry.allowedPaths],
            })),
          },
          ts: Date.now(),
        });
        return prepared;
      } catch (cause) {
        // The execution controller marks append uncertainty as fatal. Do not
        // reinterpret it as a source failure: doing so would allow a terminal
        // outcome after an unrecorded preparation transition.
        if (cause instanceof ToolExecutionError) throw cause;
        const error = asError(cause);
        // A published workspace with a failed append is intentionally ambiguous; recovery must verify it.
        if (!published) await options.persist(failed(intent, error.code));
        throw error;
      } finally {
        if (published) await rm(working, { recursive: true, force: true });
        else await store.quarantine(working).catch(() => undefined);
      }
    },

    async open(ref: string, grant: SourceWorkspaceGrant, principal: ControllerOutputPrincipal) {
      assertSourceGrant(grant);
      await assertCurrentSourceGrant(grant);
      return store.read(ref, principal, grant.allowGitView, grant);
    },
  });
}

function assertOpen(options: PrepareSourceWorkspaceOptions): void {
  if (options.signal?.aborted) throw new SourceWorkspaceError("aborted");
  options.assertOpen();
}

/** Commit one deterministic parentless tree so later repair patches can name its exact prefix. */
async function commitSyntheticPrefix(
  repo: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ readonly head: string; readonly tree: string }> {
  const tree = gitText(await runSourceGit(repo, ["write-tree"], { signal, env: environment }));
  const head = gitText(
    await runSourceGit(repo, ["commit-tree", tree, "-m", "pi-conductor source workspace"], {
      signal,
      env: environment,
    }),
  );
  if (!objectId.test(tree) || !objectId.test(head))
    throw new SourceWorkspaceError("workspace-corrupt");
  // Retain exactly one reachable prefix. With textual patches whose aggregate
  // payload is source-bounded, pruning superseded loose objects bounds the
  // private object database instead of accumulating one full blob per patch.
  await runSourceGit(repo, ["update-ref", "refs/pi-conductor/source-prefix", head], {
    signal,
    env: environment,
  });
  await runSourceGit(repo, ["prune", "--expire=now"], { signal, env: environment });
  return { head, tree };
}

function started(intent: SourceWorkspaceIntent) {
  return {
    type: "source_workspace_started" as const,
    schema_version: 1 as const,
    workspace_id: intent.workspace_id,
    run_id: intent.run_id,
    controller_id: intent.controller_id,
    definition_digest: intent.definition_digest,
    activation_id: intent.activation_id,
    owner_epoch: intent.owner_epoch,
    action_id: intent.action_id,
    ts: Date.now(),
  };
}

function failed(intent: SourceWorkspaceIntent, code: SourceWorkspaceError["code"]) {
  return {
    type: "source_workspace_failed" as const,
    schema_version: 1 as const,
    workspace_id: intent.workspace_id,
    run_id: intent.run_id,
    controller_id: intent.controller_id,
    definition_digest: intent.definition_digest,
    activation_id: intent.activation_id,
    owner_epoch: intent.owner_epoch,
    code,
    cleanup: "retained" as const,
    ts: Date.now(),
  };
}

function asError(cause: unknown): SourceWorkspaceError {
  return cause instanceof SourceWorkspaceError
    ? cause
    : new SourceWorkspaceError("storage-failure", "source preparation failed", { cause });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
