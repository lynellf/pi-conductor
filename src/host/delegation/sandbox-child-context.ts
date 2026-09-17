/** Compose one admitted child's private tools, worktree, and integration lifecycle (#106 §9). */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { readSandboxAdmission } from "../execution/sandbox/admission-store.js";
import { createSandboxCommandTools } from "../execution/sandbox/command-tools.js";
import { createSandboxFileTools } from "../execution/sandbox/file-tools.js";
import type { SandboxHostApproval } from "../execution/sandbox/host-approval.js";
import { SandboxOperationGate } from "../execution/sandbox/operation-gate.js";
import { ingestSandboxProject } from "../execution/sandbox/project-ingestion.js";
import { materializeSandboxProject } from "../execution/sandbox/project-materialization.js";
import {
  createTrustedProjectedWorktree,
  inspectTrustedProjectedWorktree,
  type TrustedProjectedWorktree,
} from "../execution/sandbox/trusted-git.js";
import type { ToolExecutionController } from "../execution/tool-execution-controller.js";
import type { ChildWorktreeInspection } from "./child-result.js";
import type { SpawnChildConfig } from "./delegate-tool.js";
import {
  configureExactSparseWorktree,
  createIndependentSourceWorktree,
  inspectChildWorktree,
} from "./worktree.js";

const MAX_CHANGED_PATHS = 64;

/** Host-owned inputs binding one child to its accepted private execution authority. */
export interface CreateSandboxChildContextOptions {
  readonly config: SpawnChildConfig;
  readonly runId: string;
  readonly primaryCheckout: string;
  readonly runStateDir: string;
  readonly hostApproval: SandboxHostApproval;
  readonly getController: () => ToolExecutionController | null;
}

/** Private tools and settlement barriers retained until child disposal. */
export interface SandboxChildContext {
  readonly tools: readonly ToolDefinition[];
  closeToolAdmission(): Promise<void>;
  cancel(): Promise<void>;
  ingestAndInspect(): Promise<ChildWorktreeInspection>;
}

/** Prepare one sandbox child completely before its SDK session can start. */
export async function createSandboxChildContext(
  supplied: CreateSandboxChildContextOptions,
): Promise<SandboxChildContext> {
  const clonedConfig = structuredClone(supplied.config);
  const config: SpawnChildConfig =
    supplied.config.setupSignal === undefined
      ? clonedConfig
      : { ...clonedConfig, setupSignal: supplied.config.setupSignal };
  const hostApproval = structuredClone(supplied.hostApproval);
  const runId = supplied.runId;
  const primaryCheckout = supplied.primaryCheckout;
  const runStateDir = supplied.runStateDir;
  const getController = supplied.getController;
  if (config.sandbox === undefined) throw new Error("sandbox child context requires admission");
  const admission = await readSandboxAdmission({
    runStateDir,
    expectedRunId: runId,
    expectedChildId: config.childId,
    expectedSandbox: config.sandbox,
    bootstrapApproval: hostApproval.bootstrapApproval,
  });
  if (config.worktreePath.length === 0 || config.branch.length === 0)
    throw new Error("sandbox child requires its generated worktree identity");
  const sourceCheckout = sourceCheckoutForSandbox(config);
  const worktree =
    sourceCheckout === undefined
      ? await createTrustedProjectedWorktree({
          hostWorktreePath: primaryCheckout,
          generatedWorktreePath: config.worktreePath,
          generatedBranch: config.branch,
          baseCommit: config.baseCommit,
          selectedPaths: admission.policy.selectedPaths,
        })
      : await createIndependentSandboxWorktree(
          config,
          sourceCheckout,
          admission.policy.selectedPaths,
        );
  const project = await materializeSandboxProject({
    admission,
    runStateDir,
    expectedRunId: runId,
    expectedChildId: config.childId,
    generatedWorktreePath: worktree.workTree,
  });
  const gate = new SandboxOperationGate({ runId, childId: config.childId });
  const toolAbort = new AbortController();
  const integrationAbort = new AbortController();
  const fileTools = createSandboxFileTools({
    gate,
    admission,
    project,
    runStateDir,
  });
  const commandTools = createSandboxCommandTools({
    gate,
    admission,
    project,
    runStateDir,
    hostApproval,
    getController,
    childSignal: toolAbort.signal,
  });
  const tools = Object.freeze(
    [...fileTools, ...commandTools].map((tool) => wrapWithPersistentSignal(tool, toolAbort.signal)),
  );
  let closeWork: Promise<void> | undefined;
  let integrationWork: Promise<ChildWorktreeInspection> | undefined;
  let integrationApplied = false;

  const closeToolAdmission = (): Promise<void> => {
    toolAbort.abort();
    closeWork ??= gate.waitForIdle();
    return closeWork;
  };

  const ingestAndInspect = (): Promise<ChildWorktreeInspection> => {
    integrationWork ??= (async () => {
      await closeToolAdmission();
      integrationAbort.signal.throwIfAborted();
      const stage = await ingestSandboxProject({
        gate,
        admission,
        project,
        runStateDir,
        signal: integrationAbort.signal,
        verifyWorktree: async () => {
          await inspectSandboxWorktree(worktree, config, sourceCheckout);
        },
      });
      integrationApplied = true;
      const inspected = await inspectSandboxWorktree(worktree, config, sourceCheckout);
      const changedPaths = stage.entries.map((entry) => entry.path);
      return Object.freeze({
        state: changedPaths.length === 0 ? "clean" : "changed",
        headCommit: inspected.headCommit,
        changedPathCount: changedPaths.length,
        changedPaths: Object.freeze(changedPaths.slice(0, MAX_CHANGED_PATHS)),
        changedPathsTruncated: changedPaths.length > MAX_CHANGED_PATHS,
      });
    })();
    return integrationWork;
  };

  const cancel = async (): Promise<void> => {
    toolAbort.abort();
    integrationAbort.abort();
    const outcomes = await Promise.allSettled([
      closeToolAdmission(),
      ...(integrationWork === undefined ? [] : [integrationWork]),
    ]);
    const closeOutcome = outcomes[0];
    if (closeOutcome?.status === "rejected") throw closeOutcome.reason;
    const integrationOutcome = outcomes[1];
    if (
      integrationOutcome?.status === "rejected" &&
      (integrationApplied || isIncompleteIntegration(integrationOutcome.reason))
    )
      throw integrationOutcome.reason;
  };

  return Object.freeze({ tools, closeToolAdmission, cancel, ingestAndInspect });
}

async function createIndependentSandboxWorktree(
  config: SpawnChildConfig,
  sourceCheckout: string,
  selectedPaths: readonly string[],
): Promise<{ readonly workTree: string }> {
  if (config.setupSignal === undefined) {
    await createIndependentSourceWorktree(
      config.worktreePath,
      config.branch,
      config.baseCommit,
      sourceCheckout,
    );
  } else {
    await createIndependentSourceWorktree(
      config.worktreePath,
      config.branch,
      config.baseCommit,
      sourceCheckout,
      config.setupSignal,
    );
  }
  if (config.setupSignal === undefined) {
    await configureExactSparseWorktree(
      config.worktreePath,
      config.branch,
      config.baseCommit,
      selectedPaths,
    );
  } else {
    await configureExactSparseWorktree(
      config.worktreePath,
      config.branch,
      config.baseCommit,
      selectedPaths,
      config.setupSignal,
    );
  }
  return { workTree: config.worktreePath };
}

async function inspectSandboxWorktree(
  worktree: TrustedProjectedWorktree | { readonly workTree: string },
  config: SpawnChildConfig,
  sourceCheckout: string | undefined,
) {
  if (sourceCheckout === undefined)
    return inspectTrustedProjectedWorktree(worktree as TrustedProjectedWorktree);
  const inspected = await inspectChildWorktree(
    worktree.workTree,
    config.branch,
    config.baseCommit,
    config.setupSignal,
  );
  if (inspected.state === "invalid")
    throw new Error("independent sandbox source worktree is invalid");
  return { headCommit: inspected.headCommit };
}

function sourceCheckoutForSandbox(config: SpawnChildConfig): string | undefined {
  if (config.sourceWorkspace === undefined) return undefined;
  if (config.sourceCheckoutPath === undefined || config.sourceCheckoutPath.length === 0)
    throw new Error("sandbox source workspace has no sealed checkout");
  if (config.sourceWorkspace.head_commit !== config.baseCommit)
    throw new Error("sandbox source workspace does not match the child base");
  return config.sourceCheckoutPath;
}

function isIncompleteIntegration(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "integration" in cause &&
    cause.integration === "integration_incomplete"
  );
}

function wrapWithPersistentSignal<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  persistent: AbortSignal,
): ToolDefinition<TParams, TDetails, TState> {
  return {
    ...tool,
    async execute(toolCallId, params: Static<TParams>, signal, onUpdate, ctx) {
      const combined = combineSignals(persistent, signal);
      try {
        return await tool.execute(toolCallId, params, combined.signal, onUpdate, ctx);
      } finally {
        combined.dispose();
      }
    },
  };
}

function combineSignals(
  persistent: AbortSignal,
  caller: AbortSignal | undefined,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  persistent.addEventListener("abort", abort, { once: true });
  caller?.addEventListener("abort", abort, { once: true });
  if (persistent.aborted || caller?.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      persistent.removeEventListener("abort", abort);
      caller?.removeEventListener("abort", abort);
    },
  };
}
