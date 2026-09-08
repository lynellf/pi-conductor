/** Host-run TODO validation and zero-cost executor circuit breakers (Prewalk §R8–R9). */

import type {
  ExecutionCheckpointArgs,
  PrewalkValidationRunRecord,
} from "../persistence/prewalk-records.js";
import {
  runSupervisedProcess,
  type SupervisedProcessResult,
} from "./execution/supervised-process.js";
import type { ToolExecutionController } from "./execution/tool-execution-controller.js";
import { parseCheckpointCommand } from "./prewalk-tool-validation.js";

const MAX_VALIDATION_OUTPUT_BYTES = 16_384;

export interface PrewalkValidationExecution {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

interface ValidationExecutionScope {
  readonly executionId: string;
  readonly supervisionId: string;
  readonly signal: AbortSignal;
  readonly graceMs: number;
  remainingTimeoutMs(): number;
  assertOpen(): void;
}

export interface PrewalkValidationExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PrewalkValidationResult {
  readonly task: string;
  readonly command: string;
  readonly exit_code: number;
  readonly claimed_done: boolean;
  readonly output: string;
}

export interface PrewalkValidationRun {
  readonly results: readonly PrewalkValidationResult[];
  readonly false_done_count: number;
  readonly false_done_rate: number;
}

export type ExecutePrewalkValidation = (
  execution: PrewalkValidationExecution,
) => Promise<PrewalkValidationExecutionResult>;

/** Execute one argv validation under the already-open tool scope. */
async function executeValidationCommand(
  execution: PrewalkValidationExecution,
  scope: ValidationExecutionScope,
): Promise<PrewalkValidationExecutionResult> {
  scope.assertOpen();
  const result: SupervisedProcessResult = await runSupervisedProcess({
    file: execution.file,
    args: execution.args,
    cwd: execution.cwd,
    executionId: scope.supervisionId,
    timeoutMs: scope.remainingTimeoutMs(),
    graceMs: scope.graceMs,
    outputLimitBytes: MAX_VALIDATION_OUTPUT_BYTES,
    signal: scope.signal,
    onStart: () => scope.assertOpen(),
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Execute every checkpoint validation as argv, never as free-form shell text. */
export async function runPrewalkValidations(options: {
  readonly checkpoint: ExecutionCheckpointArgs;
  readonly cwd: string;
  readonly execute?: ExecutePrewalkValidation;
  readonly terminalClaimed?: boolean;
  readonly signal?: AbortSignal;
  readonly controller?: ToolExecutionController;
  readonly toolCallId?: string;
}): Promise<PrewalkValidationRun> {
  const execute = options.execute;
  const results: PrewalkValidationResult[] = [];
  for (const todo of options.checkpoint.todos) {
    const command = parseCheckpointCommand(todo.validation);
    if (command === null) {
      throw new Error(`checkpoint validation command is no longer safe: ${todo.validation}`);
    }
    const execution = {
      file: command.file,
      args: command.args,
      cwd: options.cwd,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    const executed =
      options.controller === undefined
        ? await (execute === undefined
            ? Promise.reject(new Error("Prewalk validation requires a supervised controller"))
            : execute(execution))
        : await options.controller.run(
            "prewalk_validation",
            options.toolCallId ?? "host-validation",
            async (scope) => {
              if (execute !== undefined) return execute(execution);
              scope.assertOpen();
              return executeValidationCommand(execution, scope);
            },
            options.signal === undefined ? {} : { signal: options.signal },
          );
    results.push(
      Object.freeze({
        task: todo.task,
        command: todo.validation,
        exit_code: executed.exitCode,
        // A terminal executor/complete emission claims all TODOs. A blocked guide
        // claims only the items it explicitly marked done at its checkpoint.
        claimed_done:
          (options.terminalClaimed ?? true) && options.checkpoint.outcome !== "blocked"
            ? true
            : todo.status === "done",
        output: boundedOutput(executed.stdout, executed.stderr),
      }),
    );
  }
  const falseDoneCount = results.filter(
    (result) => result.claimed_done && result.exit_code !== 0,
  ).length;
  const claimedDoneCount = results.filter((result) => result.claimed_done).length;
  return Object.freeze({
    results: Object.freeze(results),
    false_done_count: falseDoneCount,
    false_done_rate: claimedDoneCount === 0 ? 0 : falseDoneCount / claimedDoneCount,
  });
}

export interface PrewalkValidationGate {
  readonly hasRun: boolean;
  beforeMachineEmission(
    signal?: AbortSignal,
    context?: { readonly toolCallId: string },
  ): Promise<
    | { readonly allow: true }
    | { readonly allow: false; readonly terminate: false; readonly correction: string }
  >;
  /** Whether this over-budget assistant step is part of terminal validation/correction. */
  allowPostBudgetContinuation(attempt: {
    readonly hasToolCall: boolean;
    readonly machineEmissionAttempted: boolean;
  }): boolean;
  /** Persist the visit metric when the phase terminates before any machine emission. */
  ensureRecorded(): Promise<void>;
  /** Prevent host cleanup from starting a validation after session abort/failure. */
  close(): void;
  /** Await an active validation after admission has been closed. */
  settle(): Promise<void>;
}

/** Build the terminal-emission gate whose corrections consume the configured retry budget. */
export function createPrewalkValidationGate(options: {
  readonly runId: string;
  readonly roleSessionId: string;
  readonly checkpoint: ExecutionCheckpointArgs;
  readonly validationRetries: number;
  readonly blockOnFailure?: boolean;
  readonly cwd: string;
  readonly execute?: ExecutePrewalkValidation;
  readonly getController?: () => ToolExecutionController | null;
  readonly persist: (record: PrewalkValidationRunRecord) => void;
  readonly onUnsatisfied?: (run: PrewalkValidationRun) => void;
  readonly now?: () => number;
  readonly canRun?: () => boolean;
}): PrewalkValidationGate {
  let corrections = 0;
  let exhaustedRecorded = false;
  let correctiveIteration = false;
  let runCount = 0;
  let validationAttempted = false;
  let closed = false;
  const validationAbort = new AbortController();
  const activeValidations = new Set<Promise<unknown>>();
  const trackValidation = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed || options.canRun?.() === false)
      throw new Error("prewalk validation gate is closed");
    const pending = operation();
    activeValidations.add(pending);
    try {
      return await pending;
    } finally {
      activeValidations.delete(pending);
    }
  };
  const executeAndPersist = async (
    terminalClaimed: boolean,
    signal?: AbortSignal,
    context?: { readonly toolCallId: string },
  ) => {
    validationAttempted = true;
    const controller = options.getController?.() ?? undefined;
    const abortFromCaller = () => validationAbort.abort(signal?.reason);
    if (signal?.aborted === true) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    let run: PrewalkValidationRun;
    try {
      run = await runPrewalkValidations({
        checkpoint: options.checkpoint,
        cwd: options.cwd,
        terminalClaimed,
        signal: validationAbort.signal,
        ...(options.execute !== undefined ? { execute: options.execute } : {}),
        ...(controller !== undefined ? { controller } : {}),
        ...(context !== undefined ? { toolCallId: context.toolCallId } : {}),
      });
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
    }
    runCount += 1;
    options.persist({
      type: "prewalk_validation_run",
      schema_version: 1,
      run_id: options.runId,
      role_session_id: options.roleSessionId,
      results: run.results.map(({ output: _output, ...result }) => result),
      false_done_count: run.false_done_count,
      false_done_rate: run.false_done_rate,
      ts: (options.now ?? Date.now)(),
    });
    return run;
  };
  return {
    get hasRun() {
      return runCount > 0;
    },
    beforeMachineEmission: async (signal, context) => {
      const run = await trackValidation(() => executeAndPersist(true, signal, context));
      const failing = run.results.filter((result) => result.exit_code !== 0);
      if (failing.length === 0 || options.blockOnFailure === false) {
        correctiveIteration = false;
        return { allow: true };
      }
      if (corrections < options.validationRetries) {
        corrections += 1;
        correctiveIteration = true;
        return {
          allow: false,
          terminate: false,
          correction: formatValidationCorrection(failing, corrections, options.validationRetries),
        };
      }
      if (!exhaustedRecorded) {
        exhaustedRecorded = true;
        options.onUnsatisfied?.(run);
      }
      correctiveIteration = false;
      return { allow: true };
    },
    allowPostBudgetContinuation: (attempt) =>
      attempt.machineEmissionAttempted || (correctiveIteration && attempt.hasToolCall),
    ensureRecorded: async () => {
      if (!closed && options.canRun?.() !== false && runCount === 0 && !validationAttempted) {
        await trackValidation(() => executeAndPersist(false));
      }
    },
    close: () => {
      closed = true;
      validationAbort.abort(new Error("prewalk validation gate closed"));
    },
    settle: async () => {
      while (activeValidations.size > 0) {
        await Promise.allSettled([...activeValidations]);
      }
    },
  };
}

/** Turn and wall-clock guard used only while the executor phase is active. */
export function createPrewalkExecutorCaps(options: {
  readonly maxTurns: number;
  readonly maxWallClockMs: number;
  readonly onExceeded: (
    code: "prewalk_executor_turn_cap_exceeded" | "prewalk_executor_wall_clock_exceeded",
  ) => void;
}): {
  readonly turns: number;
  start(): void;
  onTurnEnd(): void;
  stop(): void;
} {
  let turns = 0;
  let exceeded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = (
    code: "prewalk_executor_turn_cap_exceeded" | "prewalk_executor_wall_clock_exceeded",
  ) => {
    if (exceeded) return;
    exceeded = true;
    options.onExceeded(code);
  };
  return {
    get turns() {
      return turns;
    },
    start() {
      if (timer !== null || exceeded) return;
      timer = setTimeout(
        () => fire("prewalk_executor_wall_clock_exceeded"),
        options.maxWallClockMs,
      );
    },
    onTurnEnd() {
      if (exceeded) return;
      turns += 1;
      if (turns >= options.maxTurns) fire("prewalk_executor_turn_cap_exceeded");
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

function boundedOutput(stdout: string, stderr: string): string {
  const combined = [stdout, stderr].filter((part) => part.length > 0).join("\n");
  if (combined.length <= MAX_VALIDATION_OUTPUT_BYTES) return combined;
  return `${combined.slice(0, MAX_VALIDATION_OUTPUT_BYTES)}\n[validation output truncated]`;
}

function formatValidationCorrection(
  failing: readonly PrewalkValidationResult[],
  attempt: number,
  retries: number,
): string {
  return [
    `Host validation failed (${attempt}/${retries}); the machine emission was not recorded. Correct the failing items and emit again.`,
    ...failing.map(
      (result) =>
        `- ${result.task}: command ${JSON.stringify(result.command)} exited ${result.exit_code}\n${result.output || "(no output)"}`,
    ),
  ].join("\n");
}
