/** Host-run TODO validation and zero-cost executor circuit breakers (Prewalk §R8–R9). */

import { execFile } from "node:child_process";
import type {
  ExecutionCheckpointArgs,
  PrewalkValidationRunRecord,
} from "../persistence/prewalk-records.js";
import { parseCheckpointCommand } from "./prewalk-tool-validation.js";

const MAX_VALIDATION_OUTPUT_BYTES = 16_384;
const MAX_EXEC_FILE_BUFFER_BYTES = 1_048_576;

export interface PrewalkValidationExecution {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
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

/** Execute every checkpoint validation as argv, never as free-form shell text. */
export async function runPrewalkValidations(options: {
  readonly checkpoint: ExecutionCheckpointArgs;
  readonly cwd: string;
  readonly execute?: ExecutePrewalkValidation;
  readonly terminalClaimed?: boolean;
  readonly signal?: AbortSignal;
}): Promise<PrewalkValidationRun> {
  const execute = options.execute ?? executeValidationCommand;
  const results: PrewalkValidationResult[] = [];
  for (const todo of options.checkpoint.todos) {
    const command = parseCheckpointCommand(todo.validation);
    if (command === null) {
      throw new Error(`checkpoint validation command is no longer safe: ${todo.validation}`);
    }
    const executed = await execute({
      file: command.file,
      args: command.args,
      cwd: options.cwd,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
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
  readonly persist: (record: PrewalkValidationRunRecord) => void;
  readonly onUnsatisfied?: (run: PrewalkValidationRun) => void;
  readonly now?: () => number;
}): PrewalkValidationGate {
  let corrections = 0;
  let exhaustedRecorded = false;
  let correctiveIteration = false;
  let runCount = 0;
  const executeAndPersist = async (terminalClaimed: boolean, signal?: AbortSignal) => {
    const run = await runPrewalkValidations({
      checkpoint: options.checkpoint,
      cwd: options.cwd,
      terminalClaimed,
      ...(signal !== undefined ? { signal } : {}),
      ...(options.execute !== undefined ? { execute: options.execute } : {}),
    });
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
    beforeMachineEmission: async (signal) => {
      const run = await executeAndPersist(true, signal);
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
      if (runCount === 0) await executeAndPersist(false);
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

function executeValidationCommand(
  execution: PrewalkValidationExecution,
): Promise<PrewalkValidationExecutionResult> {
  return new Promise((resolve) => {
    execFile(
      execution.file,
      [...execution.args],
      {
        cwd: execution.cwd,
        encoding: "utf8",
        maxBuffer: MAX_EXEC_FILE_BUFFER_BYTES,
        windowsHide: true,
        ...(execution.signal !== undefined ? { signal: execution.signal } : {}),
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : -1,
          stdout,
          stderr: error !== null && stderr.length === 0 ? error.message : stderr,
        });
      },
    );
  });
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
