/**
 * Delegate tool execution — delegation lite §4–§5 / Issue #57 §7.
 * Worktree, admission, and terminal evidence share one child lifecycle; splitting
 * them would duplicate its source-capability boundary.
 */
import { mkdir } from "node:fs/promises";
import type { ControllerOutputPrincipal } from "../../manifest/controller-output.js";
import type {
  DelegationPolicy,
  SubagentProfile,
  VerificationRecipe,
} from "../../manifest/types.js";
import type {
  ChildCompletionEvidence,
  ChildProjectionFingerprint,
  ChildProtocolDiagnostic,
  DelegateResultStatus,
} from "../../persistence/child-completion.js";
import type { ChildContinuitySibling } from "../../persistence/continuity.js";
import type { DelegationSourceWorkspace } from "../../persistence/delegation-task-schema.js";
import type { SubagentUsage } from "../../persistence/log.js";
import type { SubagentSandboxDescriptor } from "../../persistence/subagent-sandbox.js";
import type { PreparedDelegateChild } from "./admission.js";
import {
  type ChildWorktreeInspection,
  capChildText,
  type LegacyChildReport,
  normalizeChildTerminal,
} from "./child-result.js";
import {
  completionEvidence,
  isPoolCompleted,
  mapPoolResult,
  preStartFailure,
  selectedFailureReason,
  selectedSummary,
} from "./child-result-mapping.js";
import type { PreparedTask } from "./context-artifact-admission.js";
import type { HostArtifactContextResolver } from "./context-artifact-contract.js";
import type {
  ResolveContextArtifactBatchOptions,
  ResolvedContextArtifact,
} from "./context-artifacts.js";
import { DelegationOwnershipError } from "./delegate-error.js";

export type { DelegateValidationErrorItem } from "./delegate-error.js";
export { DelegateToolError } from "./delegate-error.js";

import { prepareDelegateSubmission } from "./admission.js";
import { projectionFingerprint, taskFingerprint } from "./fingerprints.js";
import type { ChildId } from "./ids.js";
import type {
  PoolChildResult,
  PoolChildStartedInfo,
  PoolCompletedResult,
  PoolFailedResult,
} from "./pool.js";
import { runBoundedPool } from "./pool.js";
import {
  configureExactSparseWorktree,
  createIndependentSourceWorktree,
  createWorktree,
  inspectChildWorktree,
} from "./worktree.js";
/** Host-resolved source view used only while preparing and running a native child (#118). */
export interface ResolvedDelegatedSource {
  readonly ref: string;
  readonly sourceId: string;
  readonly checkoutPath: string | null;
  readonly headCommit: string;
  readonly treeId: string;
  readonly inventoryDigest: string;
  readonly policyDigest: string;
  readonly audience: readonly ControllerOutputPrincipal[];
}
/** Child status exposed by the parent tool. */
export type { DelegateResultStatus } from "../../persistence/child-completion.js";
/** One ordered delegate result. */
export interface DelegateTaskResult {
  readonly task_id: string;
  readonly subagent: string;
  readonly child_id: string;
  readonly status: DelegateResultStatus;
  readonly summary: string;
  readonly verification?: readonly string[];
  readonly branch: string;
  readonly worktree_path: string;
  readonly base_commit: string;
  readonly head_commit: string | null;
  readonly session_file: string;
  readonly usage: SubagentUsage;
  readonly failure_reason?: string;
  /** Additive Issue #57 terminal evidence; absent only from legacy callers. */
  readonly completion_evidence?: ChildCompletionEvidence;
}
/** Parent-facing delegate response. */
export interface DelegateResult {
  readonly results: readonly DelegateTaskResult[];
}
/** Dependencies for one delegate tool invocation. */
export interface DelegateToolOptions {
  readonly args: import("../../seam/schema.js").DelegateSubmissionArgs;
  readonly controlProtocol?: "v1" | "v2";
  readonly policy: DelegationPolicy;
  readonly profiles: readonly SubagentProfile[];
  /** Pinned top-level recipe inventory for this run; never reread at child start. */
  readonly verificationRecipes?: readonly VerificationRecipe[];
  readonly remainingChildren: number;
  readonly runStateDir: string;
  readonly runId: string;
  readonly parentRole: string;
  readonly primaryCheckout: string;
  readonly systemPromptRoot: string;
  readonly spawnAndRunChild: (opts: SpawnChildConfig) => Promise<ChildTerminal>;
  /** Deterministic resolver race injection for tests; never exposed by the delegate tool schema. */
  readonly contextArtifactTestHook?: ResolveContextArtifactBatchOptions["testHook"];
  /** Controller-only resolver for host-issued immutable outputs; model input never supplies paths. */
  readonly hostArtifactResolver?: HostArtifactContextResolver;
  /** Synchronous host assertion after preparation and before filesystem or pool work. */
  readonly assertAdmissionOpen?: () => void;
  readonly isAdmissionClosed?: () => boolean;
  readonly onChildStarted?: (info: PoolChildStartedInfo) => void;
  readonly onChildCompleted?: (result: PoolCompletedResult) => void;
  readonly onChildFailed?: (result: PoolFailedResult) => void;
  /** Host-owned prepared-runtime admission; absent keeps execution fail-closed. */
  readonly sandboxAdmission?: SandboxAdmissionAdapter;
  /** Native-controller-only immutable source resolver; SDK delegate calls cannot supply a ref. */
  readonly resolveDelegatedSource?: (
    ref: string,
    profileId: string,
  ) => Promise<ResolvedDelegatedSource>;
  /** Host-only source workspace reference bound to this native submission. */
  readonly sourceWorkspaceRef?: string;
}
/** Capture and revalidate one private sandbox admission without exposing metadata to children. */
export interface SandboxAdmissionAdapter {
  readonly capture: (input: {
    readonly childId: string;
    readonly runId: string;
    readonly primaryCheckout: string;
    readonly profile: SubagentProfile;
    readonly selectedPaths: readonly string[];
    readonly trackedPaths: readonly string[];
    readonly projectionRoots?: readonly string[];
    /** Resolver-derived sealed source identity; this path is host-only. */
    readonly sourceWorkspace?: ResolvedDelegatedSource;
  }) => Promise<{ readonly sandbox: SubagentSandboxDescriptor }>;
  readonly verify: (input: {
    readonly childId: string;
    readonly sandbox: SubagentSandboxDescriptor;
  }) => Promise<void>;
}

/** Immutable inputs for a single child SDK session. */
export interface SpawnChildConfig {
  /** Pinned parent run control protocol for the normal child result tool. */
  readonly controlProtocol?: "v1" | "v2";
  readonly childId: string;
  readonly taskId: string;
  readonly profile: SubagentProfile;
  readonly objective: string;
  readonly expectedOutput: string;
  /** Exact configured child tool authority; omitted for legacy profiles. */
  readonly effectiveTools?: readonly import("../../manifest/subagent-tool-policy.js").ChildToolName[];
  /** Pinned fixed recipe identity/content; omitted when verify is unavailable. */
  readonly verificationRecipe?: import("../../manifest/verification-recipes.js").VerificationRecipePin;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly projectionPaths?: readonly string[];
  /** Frozen host-resolved prompt-only snapshots; raw descriptors never reach a child. */
  readonly contextArtifacts: readonly ResolvedContextArtifact[];
  readonly taskFingerprint: string;
  readonly projectionFingerprint: ChildProjectionFingerprint;
  /** Accepted sandbox identity, when this child has explicit execution authority. */
  readonly sandbox?: SubagentSandboxDescriptor;
  /** Immutable source identity retained at child start; it has no host path. */
  readonly sourceWorkspace?: DelegationSourceWorkspace;
  /** Ephemeral sealed source checkout for host sandbox setup; never persisted or exposed to a model. */
  readonly sourceCheckoutPath?: string;
  /** Host-only setup cancellation; never persisted or exposed to a model. */
  readonly setupSignal?: AbortSignal;
  readonly systemPrompt: string;
}

/** Settled child-session observations before host Git inspection (§7.1). */
export interface ChildTerminal {
  readonly started: boolean;
  readonly model: string;
  readonly report?: LegacyChildReport | null;
  /** v2 report_result terminal intent, without importing legacy status semantics. */
  readonly v2TerminalIntent?: boolean;
  /** Optional bounded child status, retained as reported context only. */
  readonly reportedStatus?: string;
  readonly finalResponse?: string | null;
  readonly summaryTruncated?: boolean;
  readonly cancelled?: boolean;
  readonly sessionError?: string | null;
  readonly fileToolCalls?: ChildCompletionEvidence["file_tool_calls"];
  readonly duplicateReadCalls?: number;
  readonly sessionFile: string | null;
  readonly usage: SubagentUsage;
  /**
   * Spec §9: validated continuity packet + host-authored evidence
   * resolutions captured at the child tool boundary. Absent when the
   * child did not supply a packet, when validation rejected it, or
   * when the pinned ContinuityPolicy did not require one. Provenance
   * (run/parent/child/task/attempt) is host-derived and never
   * supplied by the child.
   */
  readonly continuity?: ChildContinuitySibling;
  /** Stable host protocol diagnostic retained when the child violates a pinned requirement. */
  readonly protocolDiagnostic?: ChildProtocolDiagnostic;
  /** Compatibility input for existing direct host adapters; never written by new SDK sessions. */
  readonly status?: "completed" | "failed" | "no_changes" | "cancelled";
  readonly summary?: string;
  readonly verification?: readonly string[];
  readonly failureReason?: string;
  /** Host-only trusted inspection; required for sandbox children. */
  readonly worktreeInspection?: ChildWorktreeInspection;
}

/** Validate, create worktrees, run bounded children, and preserve input order. */
export async function executeDelegate(options: DelegateToolOptions): Promise<DelegateResult> {
  const prepared = await prepareDelegateSubmission(options);
  options.assertAdmissionOpen?.();
  const tasks = prepared.tasks.map((child) => ({
    taskId: child.taskId,
    subagent: child.profile.name,
    profile: child.profile,
    objective: child.objective,
    expectedOutput: child.expectedOutput,
    ...(child.projectionPaths === undefined ? {} : { projectionPaths: child.projectionPaths }),
    resolvedContextArtifacts: child.contextArtifacts,
  }));
  const preparedByTask = new Map(prepared.tasks.map((child) => [child.taskId, child] as const));

  await Promise.all([
    mkdir(`${options.runStateDir}/worktrees`, { recursive: true }),
    mkdir(`${options.runStateDir}/sessions`, { recursive: true }),
  ]);
  const pool = await runBoundedPool(
    tasks,
    {
      maxParallel: options.policy.max_parallel,
      baseCommit: prepared.baseCommit,
      runStateDir: options.runStateDir,
      runId: options.runId,
      parentRole: options.parentRole,
      primaryCheckout: options.primaryCheckout,
      callbacks: {
        onChildStarted: (info) => options.onChildStarted?.(info),
        onChildCompleted: (result) => options.onChildCompleted?.(result),
        onChildFailed: (result) => options.onChildFailed?.(result),
      },
    },
    async (poolOptions) => {
      const child = preparedByTask.get(poolOptions.task.taskId);
      if (child === undefined)
        throw new Error(`prepared child '${poolOptions.task.taskId}' is missing`);
      const result = await runPreparedChild({
        prepared: child,
        runId: options.runId,
        parentRole: options.parentRole,
        primaryCheckout: options.primaryCheckout,
        parentMaterializedPaths: prepared.materializedParentPaths,
        systemPromptRoot: options.systemPromptRoot,
        ...(options.controlProtocol === undefined
          ? {}
          : { controlProtocol: options.controlProtocol }),
        spawnAndRunChild: options.spawnAndRunChild,
        ...(options.isAdmissionClosed === undefined
          ? {}
          : { isAdmissionClosed: options.isAdmissionClosed }),
      });
      if (isPoolCompleted(result)) {
        poolOptions.callbacks.onChildCompleted(result);
      } else {
        poolOptions.callbacks.onChildFailed(result);
      }
    },
  );
  return { results: pool.results.map(mapPoolResult) };
}

interface RunSingleChildOptions {
  readonly childId: ChildId;
  readonly task: PreparedTask;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly runId: string;
  readonly parentRole: string;
  readonly primaryCheckout: string;
  readonly parentMaterializedPaths: readonly string[];
  readonly systemPromptRoot: string;
  readonly controlProtocol?: "v1" | "v2";
  readonly spawnAndRunChild: (opts: SpawnChildConfig) => Promise<ChildTerminal>;
  readonly isAdmissionClosed?: () => boolean;
  readonly signal?: AbortSignal;
  readonly prepared: PreparedDelegateChild;
}

async function runSingleChild(options: RunSingleChildOptions): Promise<PoolChildResult> {
  const { childId, task, worktreePath, branch, baseCommit } = options;
  if (options.isAdmissionClosed?.() === true) {
    return preStartFailure(options, "cancelled", "child admission closed by run abort");
  }
  if (options.prepared.sandbox === undefined) {
    try {
      if (options.prepared.resolvedSourceWorkspace === undefined) {
        await createWorktree(worktreePath, branch, baseCommit, options.primaryCheckout);
      } else {
        if (options.prepared.resolvedSourceWorkspace.checkoutPath === null)
          throw new Error("native source has no sealed Git checkout");
        await createIndependentSourceWorktree(
          worktreePath,
          branch,
          baseCommit,
          options.prepared.resolvedSourceWorkspace.checkoutPath,
          options.signal,
        );
      }
      if (task.projectionPaths !== undefined) {
        await configureExactSparseWorktree(
          worktreePath,
          branch,
          baseCommit,
          task.projectionPaths,
          options.prepared.resolvedSourceWorkspace === undefined ? undefined : options.signal,
        );
      }
    } catch (cause) {
      return preStartFailure(options, "failed", `failed to create worktree: ${message(cause)}`);
    }
  }

  const prompt = { systemPrompt: options.prepared.systemPrompt };

  const authorityPaths = task.projectionPaths ?? options.parentMaterializedPaths;
  const childTaskFingerprint = taskFingerprint(
    task.objective,
    task.expectedOutput,
    baseCommit,
    authorityPaths,
    task.effectiveTools,
    task.verificationRecipe,
  );
  const childProjectionFingerprint = projectionFingerprint(
    task.projectionPaths === undefined ? "full_materialized" : "exact",
    authorityPaths,
  );

  let terminal: ChildTerminal;
  try {
    terminal = await options.spawnAndRunChild({
      childId,
      taskId: task.taskId,
      profile: task.profile,
      objective: task.objective,
      expectedOutput: task.expectedOutput,
      ...(task.effectiveTools === undefined ? {} : { effectiveTools: task.effectiveTools }),
      ...(task.verificationRecipe === undefined
        ? {}
        : { verificationRecipe: task.verificationRecipe }),
      worktreePath,
      branch,
      baseCommit,
      ...(task.projectionPaths === undefined ? {} : { projectionPaths: task.projectionPaths }),
      contextArtifacts: task.resolvedContextArtifacts,
      taskFingerprint: childTaskFingerprint,
      projectionFingerprint: childProjectionFingerprint,
      systemPrompt: prompt.systemPrompt,
      ...(options.controlProtocol === undefined
        ? {}
        : { controlProtocol: options.controlProtocol }),
      ...(options.prepared.sandbox === undefined ? {} : { sandbox: options.prepared.sandbox }),
      ...(options.prepared.resolvedSourceWorkspace === undefined
        ? {}
        : {
            sourceWorkspace: sourceIdentity(options.prepared.resolvedSourceWorkspace),
            ...(options.prepared.resolvedSourceWorkspace.checkoutPath === null
              ? {}
              : { sourceCheckoutPath: options.prepared.resolvedSourceWorkspace.checkoutPath }),
            ...(options.signal === undefined ? {} : { setupSignal: options.signal }),
          }),
    });
  } catch (cause) {
    if (cause instanceof DelegationOwnershipError) throw cause;
    terminal = {
      started: false,
      model: task.profile.models[0]?.model ?? "",
      sessionFile: null,
      usage: zeroUsage(),
      sessionError: `child session error: ${message(cause)}`,
    };
  }

  const report = terminal.report ?? legacyReportFromCompatibilityTerminal(terminal, task.profile);
  const worktree =
    options.prepared.sandbox === undefined
      ? await inspectChildWorktree(
          worktreePath,
          branch,
          baseCommit,
          options.prepared.resolvedSourceWorkspace === undefined ? undefined : options.signal,
        )
      : terminal.worktreeInspection;
  if (worktree === undefined)
    throw new DelegationOwnershipError(
      "sandbox child returned without trusted worktree inspection",
      new Error("missing sandbox worktree inspection"),
    );
  const raw = {
    protocol: task.profile.completion_protocol,
    cancelled: terminal.cancelled === true || terminal.status === "cancelled",
    sessionError: terminal.sessionError ?? terminal.failureReason ?? null,
    ...(terminal.v2TerminalIntent === true ? { v2_terminal_intent: true } : {}),
    ...(terminal.reportedStatus === undefined ? {} : { reported_status: terminal.reportedStatus }),
    report: terminal.v2TerminalIntent === true ? null : report,
    finalResponse: terminal.finalResponse ?? null,
    worktree,
    ...(terminal.fileToolCalls === undefined ? {} : { fileToolCalls: terminal.fileToolCalls }),
    ...(terminal.duplicateReadCalls === undefined
      ? {}
      : { duplicateReadCalls: terminal.duplicateReadCalls }),
    ...(terminal.continuity === undefined ? {} : { continuity: terminal.continuity }),
    ...(terminal.protocolDiagnostic === undefined
      ? {}
      : { protocolDiagnostic: terminal.protocolDiagnostic }),
  } as const;
  const normalized = normalizeChildTerminal(raw);
  const evidence = completionEvidence(raw, normalized, terminal.summaryTruncated ?? false);
  const terminalObservation =
    options.controlProtocol === "v2"
      ? {
          outcome:
            raw.cancelled || normalized.status === "cancelled"
              ? ("cancelled" as const)
              : normalized.status === "failed" || normalized.status === "blocked"
                ? ("failed" as const)
                : ("returned" as const),
          workspace_state: raw.worktree.state,
          ...(raw.reported_status === undefined ? {} : { reported_status: raw.reported_status }),
        }
      : undefined;
  const summary =
    normalized.status === "failed" && terminal.failureReason !== undefined
      ? terminal.failureReason
      : selectedSummary(raw, normalized.normalizationReason);
  const failureReason =
    terminal.failureReason ?? selectedFailureReason(raw, normalized.normalizationReason);

  if (normalized.status === "completed" || normalized.status === "no_changes") {
    return {
      childId,
      taskId: task.taskId,
      subagent: task.subagent,
      model: terminal.model,
      status: normalized.status,
      summary,
      ...(report?.verification === undefined ? {} : { verification: report.verification }),
      worktreePath,
      branch,
      baseCommit,
      headCommit: raw.worktree.headCommit ?? baseCommit,
      sessionFile: terminal.sessionFile ?? "",
      usage: terminal.usage,
      completionEvidence: evidence,
      ...(terminal.continuity === undefined ? {} : { continuity: terminal.continuity }),
      ...(terminalObservation === undefined ? {} : { terminalObservation: terminalObservation }),
    };
  }
  return {
    childId,
    taskId: task.taskId,
    subagent: task.subagent,
    model: terminal.model,
    status: normalized.status,
    summary,
    failureReason,
    worktreePath,
    branch,
    baseCommit,
    headCommit: raw.worktree.headCommit,
    sessionFile: terminal.sessionFile,
    usage: terminal.usage,
    lifecycleStarted: terminal.started,
    completionEvidence: evidence,
    ...(terminalObservation === undefined ? {} : { terminalObservation: terminalObservation }),
  };
}

function sourceIdentity(source: ResolvedDelegatedSource): DelegationSourceWorkspace {
  return {
    ref: source.ref,
    source_id: source.sourceId,
    head_commit: source.headCommit,
    tree_id: source.treeId,
    inventory_digest: source.inventoryDigest,
    policy_digest: source.policyDigest,
    audience: source.audience.map((principal) => ({ ...principal })),
  };
}

/** Execute one already-prepared child without rereading parent checkout state. */
export async function runPreparedChild(options: {
  readonly prepared: PreparedDelegateChild;
  readonly runId: string;
  readonly parentRole: string;
  readonly primaryCheckout: string;
  readonly parentMaterializedPaths: readonly string[];
  readonly systemPromptRoot: string;
  readonly controlProtocol?: "v1" | "v2";
  readonly spawnAndRunChild: (opts: SpawnChildConfig) => Promise<ChildTerminal>;
  readonly isAdmissionClosed?: () => boolean;
  readonly signal?: AbortSignal;
}): Promise<PoolChildResult> {
  const prepared = options.prepared;
  return runSingleChild({
    childId: prepared.childId,
    task: {
      taskId: prepared.taskId,
      subagent: prepared.profile.name,
      profile: prepared.profile,
      objective: prepared.objective,
      expectedOutput: prepared.expectedOutput,
      ...(prepared.effectiveTools === undefined ? {} : { effectiveTools: prepared.effectiveTools }),
      ...(prepared.verificationRecipe === undefined
        ? {}
        : { verificationRecipe: prepared.verificationRecipe }),
      ...(prepared.projectionPaths === undefined
        ? {}
        : { projectionPaths: prepared.projectionPaths }),
      resolvedContextArtifacts: prepared.contextArtifacts,
    },
    worktreePath: prepared.worktreePath,
    branch: prepared.branch,
    baseCommit: prepared.baseCommit,
    runId: options.runId,
    parentRole: options.parentRole,
    primaryCheckout: options.primaryCheckout,
    parentMaterializedPaths: options.parentMaterializedPaths,
    systemPromptRoot: options.systemPromptRoot,
    ...(options.controlProtocol === undefined ? {} : { controlProtocol: options.controlProtocol }),
    spawnAndRunChild: options.spawnAndRunChild,
    ...(options.isAdmissionClosed === undefined
      ? {}
      : { isAdmissionClosed: options.isAdmissionClosed }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    prepared,
  });
}

function legacyReportFromCompatibilityTerminal(
  terminal: ChildTerminal,
  profile: SubagentProfile,
): LegacyChildReport | null {
  if (profile.completion_protocol !== "report_result" || terminal.status === undefined) return null;
  if (terminal.status === "cancelled" || terminal.failureReason !== undefined) return null;
  return {
    status: terminal.status,
    summary: capChildText(terminal.summary ?? "").text,
    ...(terminal.verification === undefined ? {} : { verification: terminal.verification }),
  };
}

function zeroUsage(): SubagentUsage {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
