/** Controller-backed public SDK tools — September execution controls §76. */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { ToolExecutionPolicy } from "../../manifest/execution-policy.js";
import { type FileToolWorkerModel, runFileToolWorker } from "./file-tool-worker.js";
import { runSupervisedProcess, SupervisedProcessError } from "./supervised-process.js";
import type { ToolExecutionController, ToolExecutionScope } from "./tool-execution-controller.js";
import { ToolExecutionError as RuntimeToolExecutionError } from "./tool-execution-controller.js";
import { toToolExecutionModelError } from "./tool-execution-model-error.js";

const FILE_TOOL_NAMES = ["read", "write", "edit", "ls", "find", "grep"] as const;
type FileToolName = (typeof FILE_TOOL_NAMES)[number];
type Policy = Readonly<Required<ToolExecutionPolicy>>;
type DefinitionFactory = (cwd: string) => unknown;
type BashParams = { readonly command: string; readonly timeout?: number };

/** Options for controller-backed built-in tools. */
export interface SupervisedToolsOptions {
  readonly cwd: string;
  readonly getController: () => ToolExecutionController | null;
  readonly getPolicy: () => Policy;
  readonly declaredTools?: readonly string[];
  readonly isSealed?: () => boolean;
  /** Apply confinement after controller admission and before the worker starts. */
  readonly wrapFileTool?: (rawTool: ToolDefinition) => ToolDefinition;
  /** Test seam for proving mutation admission independently of the SDK worker. */
  readonly runFileToolWorker?: typeof runFileToolWorker;
}

/** Structured details returned for controller failures. */
export interface SupervisedToolErrorDetails {
  readonly code: string;
  readonly cleanup: "confirmed" | "unconfirmed" | "not-started";
  readonly executionId?: string;
}

interface MutationState {
  readonly tail: Promise<void>;
  poisoned: boolean;
  readonly children: Set<MutationState>;
  release?: () => void;
}

const mutationTails = new Map<string, MutationState>();

function modelMetadata(ctx: {
  readonly model: { readonly input?: readonly string[] } | undefined;
}): FileToolWorkerModel | undefined {
  return ctx.model?.input === undefined ? undefined : { input: [...ctx.model.input] };
}

function controllerFor(options: SupervisedToolsOptions): ToolExecutionController {
  const controller = options.getController();
  if (controller === undefined || controller === null) {
    throw new Error("executable tool controller is not bound");
  }
  return controller;
}

function policyFor(options: SupervisedToolsOptions): Policy {
  return options.getPolicy();
}

function paramsPath(params: unknown): string {
  if (typeof params === "object" && params !== null && "path" in params) {
    return typeof params.path === "string" ? params.path : ".";
  }
  return ".";
}

/** Match the public SDK's path normalization before physical lock lookup. */
function normalizeSdkPath(input: string): string {
  let normalized = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return `${homedir()}/${normalized.slice(2)}`;
  if (normalized.startsWith("file://")) return fileURLToPath(normalized);
  return normalized;
}

async function physicalMutationKey(cwd: string, params: unknown): Promise<string> {
  let candidate = resolve(cwd, normalizeSdkPath(paramsPath(params)));
  const missing: string[] = [];
  for (;;) {
    try {
      const physical = await realpath(candidate);
      return missing.length === 0 ? physical : resolve(physical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(candidate.slice(parent.length + 1));
      candidate = parent;
    }
  }
}

async function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("mutation wait aborted");
  await new Promise<void>((resolveTurn, rejectTurn) => {
    const onAbort = () => rejectTurn(new Error("mutation wait aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolveTurn();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectTurn(error);
      },
    );
  });
}

async function serializeMutation<T>(
  key: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  const existing = mutationTails.get(key);
  if (existing?.poisoned) {
    throw new RuntimeToolExecutionError(
      "tool_cleanup_unconfirmed",
      "mutation path is poisoned after unconfirmed cleanup",
      { cleanup: "unconfirmed" },
    );
  }
  const previous = existing?.tail ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolveTail) => {
    release = resolveTail;
  });
  const state: MutationState = { tail, poisoned: false, children: new Set(), release };
  existing?.children.add(state);
  mutationTails.set(key, state);
  let acquired = false;
  try {
    await waitForTurn(previous, signal);
    if (state.poisoned) {
      throw new RuntimeToolExecutionError(
        "tool_cleanup_unconfirmed",
        "mutation path is poisoned after unconfirmed cleanup",
        { cleanup: "unconfirmed" },
      );
    }
    acquired = true;
    return await operation();
  } catch (error) {
    if (error instanceof SupervisedProcessError && error.cleanup === "unconfirmed") {
      poisonMutationState(state);
      return Promise.reject(error);
    }
    throw error;
  } finally {
    if (!state.poisoned) {
      if (acquired) release();
      else void previous.then(release, release);
      if (acquired && mutationTails.get(key) === state) mutationTails.delete(key);
    }
  }
}

function poisonMutationState(state: MutationState): void {
  if (state.poisoned) return;
  state.poisoned = true;
  state.release?.();
  for (const child of state.children) poisonMutationState(child);
}

function sealedResult(): AgentToolResult<SupervisedToolErrorDetails> & { readonly isError: true } {
  return {
    content: [{ type: "text", text: "session sealed; tool execution is unavailable" }],
    details: { code: "tool_closed", cleanup: "not-started" },
    isError: true,
    terminate: true,
  };
}

function rawFileDefinition(
  factory: DefinitionFactory,
  toolName: FileToolName,
  cwd: string,
  scope: ToolExecutionScope,
  policy: Policy,
  worker: typeof runFileToolWorker,
): ToolDefinition {
  const metadata = factory(cwd) as ToolDefinition;
  return {
    ...metadata,
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      scope.assertOpen();
      const model = modelMetadata(ctx);
      const executeWorker = () =>
        worker({
          toolName,
          toolCallId,
          params,
          cwd,
          ...(model === undefined ? {} : { model }),
          supervision: {
            executionId: scope.supervisionId,
            timeoutMs: scope.remainingTimeoutMs(),
            graceMs: policy.termination_grace_seconds * 1_000,
            ...(signal === undefined ? {} : { signal }),
            onStart: () => scope.assertOpen(),
          },
        }) as Promise<AgentToolResult<unknown>>;
      if (toolName === "read" || toolName === "ls" || toolName === "find" || toolName === "grep") {
        return executeWorker();
      }
      const key = await physicalMutationKey(cwd, params);
      scope.assertOpen();
      return serializeMutation(key, scope.signal, executeWorker);
    },
  };
}

function fileFactory(name: FileToolName): DefinitionFactory {
  return {
    read: createReadToolDefinition,
    write: createWriteToolDefinition,
    edit: createEditToolDefinition,
    ls: createLsToolDefinition,
    find: createFindToolDefinition,
    grep: createGrepToolDefinition,
  }[name];
}

function supervisedFileDefinition(
  name: FileToolName,
  options: SupervisedToolsOptions,
): ToolDefinition {
  const metadata = fileFactory(name)(options.cwd) as ToolDefinition;
  return {
    ...metadata,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (options.isSealed?.() === true) return sealedResult();
      try {
        return await controllerFor(options).run(
          name,
          toolCallId,
          async (scope) => {
            const raw = rawFileDefinition(
              fileFactory(name),
              name,
              options.cwd,
              scope,
              policyFor(options),
              options.runFileToolWorker ?? runFileToolWorker,
            );
            const wrapped = options.wrapFileTool?.(raw) ?? raw;
            scope.assertOpen();
            return wrapped.execute(toolCallId, params, scope.signal, onUpdate, ctx);
          },
          signal === undefined ? {} : { signal },
        );
      } catch (error) {
        throw toToolExecutionModelError(error);
      }
    },
  };
}

function supervisedBashDefinition(options: SupervisedToolsOptions): ToolDefinition {
  const metadata = createBashToolDefinition(options.cwd) as unknown as ToolDefinition;
  const pinnedDeadline = policyFor(options).timeout_seconds;
  const guidance = `Keep the full workload in the foreground and finish it within the pinned ${pinnedDeadline}-second limit. Do not use nohup, &, setsid, or disown to evade the deadline; detached/background jobs are unsupported. Set timeout to the full allowed window when needed; it may shorten a call or raise a shorter per-call timeout, but cannot exceed ${pinnedDeadline} seconds. This is guidance rather than enforcement: a background launch may still end with cleanup unconfirmed. If the workload needs longer, split it into bounded foreground calls or ask the owner to configure a finite higher limit for a new run. After a timeout, inspect partial effects before manually retrying; the host never automatically replays a command.`;
  const description = `${metadata.description ?? "Execute a bash command."} ${guidance}`;
  return {
    ...metadata,
    description,
    promptSnippet: `${metadata.promptSnippet ?? "Execute bash commands."} Pinned max: ${pinnedDeadline}s; keep work foreground.`,
    promptGuidelines: [...(metadata.promptGuidelines ?? []), guidance],
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (options.isSealed?.() === true) return sealedResult();
      const bashParams = params as BashParams;
      try {
        return await controllerFor(options).run(
          "bash",
          toolCallId,
          async (scope) => {
            scope.assertOpen();
            const definition = createBashToolDefinition(options.cwd, {
              operations: {
                exec: async (command, cwd, execOptions) => {
                  scope.assertOpen();
                  const result = await runSupervisedProcess({
                    executionId: scope.supervisionId,
                    command,
                    cwd,
                    ...(execOptions.env === undefined ? {} : { env: execOptions.env }),
                    timeoutMs: scope.remainingTimeoutMs(),
                    graceMs: policyFor(options).termination_grace_seconds * 1_000,
                    signal: scope.signal,
                    outputLimitBytes: 0,
                    onStart: () => scope.assertOpen(),
                    onOutput: (_stream, chunk) => execOptions.onData(chunk),
                  });
                  return { exitCode: result.exitCode };
                },
              },
            });
            return definition.execute(toolCallId, bashParams, scope.signal, onUpdate, ctx);
          },
          {
            ...(signal === undefined ? {} : { signal }),
            ...(typeof bashParams.timeout === "number"
              ? { modelTimeoutSeconds: bashParams.timeout }
              : {}),
          },
        );
      } catch (error) {
        throw toToolExecutionModelError(error);
      }
    },
  };
}

/** Create all seven built-in definitions; callers filter by the role allowlist. */
export function createSupervisedTools(options: SupervisedToolsOptions): ToolDefinition[] {
  const declaredTools = options.declaredTools;
  const selected =
    declaredTools === undefined
      ? FILE_TOOL_NAMES
      : FILE_TOOL_NAMES.filter((name) => declaredTools.includes(name));
  return [
    ...selected.map((name) => supervisedFileDefinition(name, options)),
    ...(declaredTools === undefined || declaredTools.includes("bash")
      ? [supervisedBashDefinition(options)]
      : []),
  ];
}
