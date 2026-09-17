/** Bind source preparation and consumption to the active controller authority (#118). */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ControllerOutputPrincipal } from "../../manifest/controller-output.js";
import type { ControllerAction } from "../../manifest/controller-protocol.js";
import type { SourceRepositoryGrant } from "../../manifest/controller-source.js";
import { sourceWorkspaceReservationBytes as manifestReservationBytes } from "../../manifest/controller-source.js";
import { reconstructChildOutputTimeline } from "../../persistence/child-output-timeline.js";
import type {
  ControllerActionState,
  ControllerActivationStartedRecord,
  PersistedRecord,
} from "../../persistence/log.js";
import type {
  SourceWorkspaceIntent,
  SourceWorkspaceRecord,
} from "../../persistence/source-workspace.js";
import { assertSourceWorkspaceHistory } from "../../persistence/source-workspace-timeline.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { ToolExecutionError } from "../execution/tool-execution-controller.js";
import type { CreateControllerActionDispatcherOptions } from "./action-dispatcher-contract.js";
import {
  type ApprovedControllerDefinition,
  verifyControllerApproval,
} from "./approved-definition.js";
import type { ControllerExecutionDriver } from "./executable-host-contract.js";
import type { ControllerHostApproval } from "./host-approval.js";
import type { createControllerOutputResolver } from "./output-resolver.js";
import { controllerRecoveryReceipt } from "./recovery-contract.js";
import {
  createSourceWorkspaceService,
  type PreparedSourceWorkspace,
  type SourceWorkspaceGrant,
  SourceWorkspaceStore,
} from "./source-workspace.js";

type PrepareAction = Extract<ControllerAction, { kind: "prepare_source" }>;

/** Production dependencies contain authority and storage; controller actions contain identities only. */
export interface ProductionSourceOptions {
  readonly definition: ApprovedControllerDefinition;
  readonly runStateDir: string;
  readonly records: () => readonly PersistedRecord[];
  readonly persist: (record: PersistedRecord) => void;
  readonly loadApproval: () => Promise<ControllerHostApproval>;
  readonly assertOpen: () => void;
  readonly outputResolver: ReturnType<typeof createControllerOutputResolver>;
}

/** Open source services for both active dispatch and read-only recovery. */
export async function createProductionSources(options: ProductionSourceOptions) {
  assertSourceWorkspaceHistory(options.records());
  const store = await SourceWorkspaceStore.open({
    root: join(options.runStateDir, "source-workspaces"),
  });
  const service = createSourceWorkspaceService(store);
  const inFlight = new Map<string, Set<string>>();
  const definition = options.definition.record;
  const intentRecords = () =>
    options
      .records()
      .filter(
        (record): record is SourceWorkspaceIntent =>
          record.type === "source_workspace_intent" &&
          record.run_id === definition.run_id &&
          record.definition_digest === definition.definition_digest,
      );
  const currentGrant = async (sourceId: string): Promise<SourceRepositoryGrant> => {
    const current = verifyControllerApproval(definition, await options.loadApproval());
    if (!current.config.source_repositories?.includes(sourceId))
      throw new Error("source repository is not pinned");
    const grant = current.approval.source_repositories?.find((entry) => entry.id === sourceId);
    if (grant === undefined) throw new Error("source repository authority was revoked");
    return grant;
  };
  const persist = (record: SourceWorkspaceRecord): void => {
    try {
      options.persist(record);
    } catch (cause) {
      throw new ToolExecutionError(
        "tool_persistence_ambiguous",
        "source record persistence is ambiguous",
        { cause },
      );
    }
  };
  const resolvePatch = async (ref: string) => {
    const output = await options.outputResolver.resolveRef(ref, { kind: "controller" });
    const children = reconstructChildOutputTimeline(options.records()).children;
    const published = children
      .flatMap((child) =>
        child.publication?.type === "controller_child_output_published"
          ? child.publication.outputs
          : [],
      )
      .find((entry) => entry.ref === ref);
    const policy = options.definition.config.child_outputs?.find(
      (entry) => entry.profile_id === published?.binding.producerProfileId,
    )?.patch;
    if (
      published === undefined ||
      published.binding.output.kind !== "patch" ||
      policy === undefined ||
      published.binding.output.id !== policy.id ||
      output.audience === null ||
      output.mediaType !== "application/x-git-patch"
    )
      throw new Error(
        "source patch requires a durably published native patch with pinned provenance",
      );
    return {
      bytes: output.bytes,
      sha256: output.sha256,
      byteLength: output.byteLength,
      acceptedBase: published.binding.acceptedBase,
      allowedPaths: policy.paths,
      audience: output.audience,
    };
  };
  const validate = async (action: PrepareAction): Promise<void> => {
    const grant = await currentGrant(action.source_id);
    if (!grant.allowed_refs.includes(action.repository_ref))
      throw new Error("source ref is not approved");
    const patches = action.patch_refs ?? [];
    if (
      patches.length > grant.max_patch_files ||
      patches.reduce((sum, patch) => sum + patch.byte_length, 0) > grant.max_patch_bytes
    )
      throw new Error("source patch inputs exceed approved limits");
    for (const claim of patches) {
      const patch = await resolvePatch(claim.ref);
      if (
        patch.sha256 !== claim.sha256 ||
        patch.byteLength !== claim.byte_length ||
        patch.acceptedBase !== claim.accepted_base
      )
        throw new Error("source patch identity does not match published provenance");
    }
  };
  const openSourceWorkspace = async (ref: string, principal: ControllerOutputPrincipal) => {
    const workspaceId = /^source-workspace\/v1\/([a-f0-9]{64})\/[a-f0-9]{64}$/.exec(ref)?.[1];
    const intent = intentRecords().find((entry) => entry.workspace_id === workspaceId);
    if (intent === undefined)
      throw new Error("source workspace is not owned by this controller definition");
    const publication = options
      .records()
      .find(
        (record) =>
          record.type === "source_workspace_prepared" && record.workspace_id === workspaceId,
      );
    if (publication?.type !== "source_workspace_prepared" || publication.ref !== ref)
      throw new Error("source workspace has no matching durable publication");
    const grant = await currentGrant(intent.source_id);
    if (intent.source_authority_digest !== sha256Canonical(grant))
      throw new Error("source authority changed");
    const source = await service.open(ref, serviceGrant(grant), principal);
    const { ref: _ref, base_commit: _base, ...content } = sourceDescriptor(source);
    if (sha256Canonical(content) !== sha256Canonical(publication.content))
      throw new Error("source publication content does not match sealed storage");
    return {
      ...source,
      sourceId: grant.id,
      allowGitView: grant.isolated_git_view,
      policyDigest: intent.policy_digest,
    };
  };
  return {
    openSourceWorkspace,
    async recoverSourceAction(action: ControllerActionState) {
      const intent = intentRecords().find(
        (entry) =>
          entry.action_id === action.actionId &&
          entry.request_sha256 === action.intent.request_sha256,
      );
      if (intent === undefined)
        return {
          receipts: [
            controllerRecoveryReceipt(
              action,
              "interrupted",
              [],
              "source preparation was not durably pinned",
            ),
          ],
          blocked: [],
        };
      const records = options
        .records()
        .filter(
          (record) => "workspace_id" in record && record.workspace_id === intent.workspace_id,
        );
      const prepared = records.find((record) => record.type === "source_workspace_prepared");
      if (prepared?.type === "source_workspace_prepared") {
        try {
          await openSourceWorkspace(prepared.ref, { kind: "controller" });
          return {
            receipts: [controllerRecoveryReceipt(action, "completed", [prepared.ref], null)],
            blocked: [],
          };
        } catch {
          return {
            receipts: [],
            blocked: [`source action ${action.actionId} has an unverifiable publication`],
          };
        }
      }
      const failed = records.find((record) => record.type === "source_workspace_failed");
      if (failed?.type === "source_workspace_failed")
        return {
          receipts: [controllerRecoveryReceipt(action, "failed", [], failed.code)],
          blocked: [],
        };
      if (!records.some((record) => record.type === "source_workspace_started"))
        return {
          receipts: [
            controllerRecoveryReceipt(
              action,
              "interrupted",
              [],
              "pinned preparation never started; use a fresh action",
            ),
          ],
          blocked: [],
        };
      return {
        receipts: [],
        blocked: [
          `source action ${action.actionId} was interrupted after preparation started; retained work requires inspection`,
        ],
      };
    },
    dispatcher(
      activation: ControllerActivationStartedRecord,
      executions: ControllerExecutionDriver,
    ): NonNullable<CreateControllerActionDispatcherOptions["sources"]> {
      return {
        validate,
        async resolve(ref, principal) {
          const source = await openSourceWorkspace(ref, principal);
          return { descriptor: sourceDescriptor(source), audience: source.audience };
        },
        async prepare(action, requestDigest, signal) {
          await validate(action);
          const grant = await currentGrant(action.source_id);
          const pending = inFlight.get(grant.id) ?? new Set<string>();
          if (pending.size >= grant.max_parallel_preparations)
            throw new Error("source preparation capacity exhausted");
          const reserved = new Set([
            ...pending,
            ...intentRecords()
              .filter((entry) => entry.source_id === grant.id)
              .map((entry) => entry.action_id),
          ]).size;
          const perWorkspace = manifestReservationBytes(
            grant.max_source_bytes,
            grant.max_source_files,
          );
          const required = (reserved + 1) * perWorkspace;
          const approved = grant.max_total_bytes;
          const aggregateSafe = Number.isSafeInteger(perWorkspace * grant.max_workspaces);
          if (reserved >= grant.max_workspaces || required > approved) {
            const prefix = aggregateSafe
              ? ""
              : "source repository grant aggregate reservation is unsafe: ";
            throw new Error(
              `${prefix}source workspace storage reservation exceeds approved limits: required ${required} bytes, approved ${approved} bytes`,
            );
          }
          if (
            pending.has(action.action_id) ||
            intentRecords().some((entry) => entry.action_id === action.action_id)
          )
            throw new Error("source action is already pinned and cannot be replayed");
          pending.add(action.action_id);
          inFlight.set(grant.id, pending);
          const operationId = randomUUID();
          try {
            const source = await executions.runController(
              {
                kind: "controller_operation",
                controller_id: definition.controller_id,
                definition_digest: definition.definition_digest,
                activation_id: activation.activation_id,
                owner_epoch: activation.owner_epoch,
                operation_id: operationId,
                operation_kind: "preparation",
                action_id: action.action_id,
                request_sha256: requestDigest,
              },
              async (scope) => {
                const assertOpen = () => {
                  scope.assertOpen();
                  options.assertOpen();
                };
                assertOpen();
                const intent = await service.resolveIntent(
                  {
                    runId: definition.run_id,
                    controllerId: definition.controller_id,
                    definitionDigest: definition.definition_digest,
                    activationId: activation.activation_id,
                    ownerEpoch: activation.owner_epoch,
                    actionId: action.action_id,
                    requestDigest,
                    sourceId: action.source_id,
                    repositoryRef: action.repository_ref,
                    patches: (action.patch_refs ?? []).map((claim) => ({
                      ref: claim.ref,
                      sha256: claim.sha256,
                      byteLength: claim.byte_length,
                      acceptedBase: claim.accepted_base,
                    })),
                  },
                  serviceGrant(grant),
                  resolvePatch,
                );
                assertOpen();
                await currentGrant(grant.id);
                persist(intent);
                return service.prepare(intent, serviceGrant(grant), {
                  resolvePatch,
                  assertOpen,
                  signal: scope.signal,
                  persist: async (record) => {
                    assertOpen();
                    persist(record);
                  },
                });
              },
              {
                ...(signal === undefined ? {} : { signal }),
                modelTimeoutSeconds: grant.timeout_ms / 1000,
              },
            );
            await currentGrant(grant.id);
            options.assertOpen();
            return {
              outcome: "completed",
              operation_id: operationId,
              result_refs: [source.ref],
              diagnostic: null,
            };
          } finally {
            pending.delete(action.action_id);
          }
        },
      };
    },
  };
}

function serviceGrant(grant: SourceRepositoryGrant): SourceWorkspaceGrant {
  return {
    sourceId: grant.id,
    authorityDigest: sha256Canonical(grant),
    canonicalPath: grant.repository.canonical_path,
    repositoryFingerprint: grant.repository.fingerprint,
    allowedRefs: grant.allowed_refs,
    allowedPaths: grant.allowed_paths,
    maxFiles: grant.max_source_files,
    maxBytes: grant.max_source_bytes,
    consumers: grant.audience,
    allowGitView: grant.isolated_git_view,
  };
}

function sourceDescriptor(source: PreparedSourceWorkspace) {
  return {
    ref: source.ref,
    base_commit: source.baseCommit,
    head_commit: source.headCommit,
    tree_id: source.treeId,
    inventory_digest: source.inventoryDigest,
    file_count: source.fileCount,
    byte_length: source.byteLength,
    allowed_paths: [...source.allowedPaths].sort(),
    patches_digest: source.patchesDigest,
    patches: [...source.patches].map((entry) => ({
      ref: entry.ref,
      sha256: entry.sha256,
      byte_length: entry.byteLength,
      accepted_base: entry.acceptedBase,
      allowed_paths: [...entry.allowedPaths].sort(),
    })),
  };
}
