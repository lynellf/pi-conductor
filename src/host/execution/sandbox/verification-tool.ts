/** Host-owned parameterless fixed-recipe verification tool (spec §5.2–§5.3). */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  parseVerificationRecipes,
  pinVerificationRecipe,
  type VerificationEvaluation,
  type VerificationRecipe,
  type VerificationRecipePin,
  validateVerificationRecipes,
} from "../../../manifest/verification-recipes.js";
import type { PersistedRecord } from "../../../persistence/log.js";
import type { SandboxAdmissionRecord } from "../../../persistence/sandbox-admission.js";
import type { SandboxExecutionTerminal } from "../../../persistence/sandbox-command.js";
import type { SandboxProjectMaterializationDescriptor } from "../../../persistence/sandbox-materialization.js";
import {
  isToolExecutionRecord,
  reconstructToolExecutionTimeline,
  type ToolExecutionRecord,
} from "../../../persistence/tool-execution.js";
import { verifyArgsSchema } from "../../../seam/schema.js";
import { type ToolExecutionController, ToolExecutionError } from "../tool-execution-controller.js";
import { createSandboxArgvRunner } from "./command-runner.js";
import type { SandboxCommandResult } from "./command-runner-contract.js";
import type { SandboxHostApproval } from "./host-approval.js";
import type { SandboxOperationGate } from "./operation-gate.js";
import {
  boundedVerificationPreview,
  combineVerificationSignals,
  normalizeVerificationStatus,
  safeVerificationTerminal,
} from "./verification-tool-support.js";

/** Inputs bound to an admitted child and one host-pinned recipe. */
export interface SandboxVerificationToolOptions {
  readonly gate: SandboxOperationGate;
  readonly admission: SandboxAdmissionRecord;
  readonly project: SandboxProjectMaterializationDescriptor;
  readonly runStateDir: string;
  readonly hostApproval: SandboxHostApproval;
  readonly getController: () => ToolExecutionController | null;
  readonly childSignal: AbortSignal;
  readonly recipe: VerificationRecipePin;
  readonly records?: () => readonly PersistedRecord[];
}

interface VerificationCallState {
  readonly consumed: number;
  readonly uncertain: boolean;
  readonly callIds: readonly string[];
}

interface CommandEvidence {
  readonly ordinal: number;
  readonly status: number | null;
  readonly timed_out: boolean;
  readonly cancelled: boolean;
  readonly cleanup: "confirmed" | "unconfirmed" | "not-started";
  readonly execution_id: string | null;
  readonly output_ref: string | null;
  readonly capture: "complete" | "incomplete" | "unknown";
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly stdout_preview?: string;
  readonly stderr_preview?: string;
}

/** Build one exact `verify({})` tool; no model-supplied command data is accepted. */
export function createSandboxVerificationTool(
  supplied: SandboxVerificationToolOptions,
): ToolDefinition {
  const options = {
    ...supplied,
    admission: structuredClone(supplied.admission),
    project: structuredClone(supplied.project),
    hostApproval: structuredClone(supplied.hostApproval),
  };
  assertOwner(options);
  const recipe = decodeRecipe(options.recipe);
  const prior = verificationCallState(options.records?.(), options.admission.childId);
  let consumed = prior.consumed;
  let uncertain = prior.uncertain;
  const consumedCallIds = new Set(prior.callIds);
  let tail = Promise.resolve();

  return defineTool<typeof verifyArgsSchema, unknown>({
    name: "verify",
    label: "verify",
    description: "Run the one manifest-pinned verification recipe in the private workspace.",
    parameters: verifyArgsSchema,
    execute: async (toolCallId, input, signal) => {
      if (!Value.Check(verifyArgsSchema, input)) return errorResult("verify accepts only {}");
      const operation = tail.then(async () => {
        if (uncertain)
          return failureResult(
            "verification_unavailable_after_ambiguous_execution",
            consumed,
            recipe,
          );
        if (consumedCallIds.has(toolCallId))
          return failureResult("verification_call_already_consumed", consumed, recipe);
        if (consumed >= recipe.max_calls)
          return failureResult("verification_call_limit_exhausted", consumed, recipe);
        consumedCallIds.add(toolCallId);
        consumed += 1;
        const ordinal = consumed;
        const result = await executeRecipeCall(options, recipe, toolCallId, signal, ordinal);
        if (result.uncertain) uncertain = true;
        return result.response;
      });
      tail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  }) as unknown as ToolDefinition;
}

async function executeRecipeCall(
  options: SandboxVerificationToolOptions,
  recipe: VerificationRecipe,
  toolCallId: string,
  signal: AbortSignal | undefined,
  callOrdinal: number,
): Promise<{
  readonly uncertain: boolean;
  readonly response:
    | ReturnType<typeof successResult>
    | ReturnType<typeof failureResult>
    | ReturnType<typeof errorResult>;
}> {
  const controller = options.getController();
  if (controller === null)
    return {
      uncertain: true,
      response: failureResult("verification_controller_unavailable", callOrdinal, recipe),
    };
  const combined = combineVerificationSignals(options.childSignal, signal);
  const commands: CommandEvidence[] = [];
  let firstUnattempted: number | undefined;
  try {
    for (const [index, command] of recipe.commands.entries()) {
      const ordinal = index + 1;
      let runner: ReturnType<typeof createSandboxArgvRunner> | undefined;
      try {
        const result = await options.gate.run(combined.signal, async (gateSignal) => {
          runner = createSandboxArgvRunner({
            binaryPath: options.hostApproval.binaryPath,
            approvedBuilds: options.hostApproval.approvedBuilds,
            ...(options.hostApproval.getcapPath === undefined
              ? {}
              : { getcapPath: options.hostApproval.getcapPath }),
            bootstrapApproval: options.hostApproval.bootstrapApproval,
            runStateDir: options.runStateDir,
            admission: options.admission,
            project: options.project,
            argv: [command.executable, ...command.args],
          });
          return controller.runLifecycle(
            "verify",
            toolCallId,
            { child_id: options.admission.childId, descriptor: options.admission.sandbox },
            runner,
            {
              signal: gateSignal,
              modelTimeoutSeconds: recipe.timeout_seconds,
            },
          );
        });
        commands.push(commandEvidence(ordinal, result));
        if (result.normalizedStatus !== 0 || result.output.capture !== "complete") {
          firstUnattempted = ordinal + 1 <= recipe.commands.length ? ordinal + 1 : undefined;
          break;
        }
      } catch (cause) {
        const terminal = runner === undefined ? undefined : safeVerificationTerminal(runner);
        if (runner !== undefined && terminal === undefined) options.gate.seal(cause);
        if (
          (cause instanceof ToolExecutionError &&
            (cause.cleanup === "unconfirmed" || cause.code === "tool_persistence_ambiguous")) ||
          terminal?.cleanup === "unconfirmed"
        )
          options.gate.seal(cause);
        const evidence = failedCommandEvidence(ordinal, cause, runner, combined.signal.aborted);
        commands.push(evidence.evidence);
        firstUnattempted = ordinal + 1 <= recipe.commands.length ? ordinal + 1 : undefined;
        const response = successResult(recipe, callOrdinal, commands, firstUnattempted, true);
        return { uncertain: evidence.uncertain || options.gate.isSealed(), response };
      }
    }
    return {
      uncertain: false,
      response: successResult(recipe, callOrdinal, commands, firstUnattempted),
    };
  } finally {
    combined.dispose();
  }
}

function commandEvidence(ordinal: number, result: SandboxCommandResult): CommandEvidence {
  return {
    ordinal,
    status: normalizeVerificationStatus(result.normalizedStatus),
    timed_out: false,
    cancelled: false,
    cleanup: "confirmed",
    execution_id: result.executionId,
    output_ref: result.output.outputRef,
    capture: result.output.capture,
    stdout_bytes: result.output.stdout.byteCount,
    stderr_bytes: result.output.stderr.byteCount,
    stdout_preview: boundedVerificationPreview(result.previews.stdout.data),
    stderr_preview: boundedVerificationPreview(result.previews.stderr.data),
  };
}

function failedCommandEvidence(
  ordinal: number,
  cause: unknown,
  runner: { readonly terminalEvidence: () => SandboxExecutionTerminal } | undefined,
  signalAborted: boolean,
): { readonly evidence: CommandEvidence; readonly uncertain: boolean } {
  const terminal = runner === undefined ? undefined : safeVerificationTerminal(runner);
  const toolError = cause instanceof ToolExecutionError ? cause : undefined;
  const cleanup = toolError?.cleanup ?? terminal?.cleanup ?? "not-started";
  const timedOut =
    toolError?.code === "tool_timeout" || toolError?.code === "tool_timeout_exhausted";
  const cancelled = toolError?.code === "tool_aborted" || signalAborted;
  const output = terminal?.output;
  return {
    uncertain: cleanup === "unconfirmed" || toolError?.code === "tool_persistence_ambiguous",
    evidence: {
      ordinal,
      status: terminal?.normalized_status ?? null,
      timed_out: timedOut,
      cancelled,
      cleanup,
      execution_id: toolError?.executionId ?? null,
      output_ref: output?.outputRef ?? terminal?.output_ref ?? null,
      capture: output?.capture ?? "unknown",
      stdout_bytes: output?.stdout.byteCount ?? 0,
      stderr_bytes: output?.stderr.byteCount ?? 0,
    },
  };
}

function successResult(
  recipe: VerificationRecipe,
  callOrdinal: number,
  commands: readonly CommandEvidence[],
  firstUnattempted: number | undefined,
  executionFailed = false,
) {
  const expectation = expectationSatisfied(recipe.evaluation, commands, recipe.commands.length);
  const body = {
    recipe_name: recipe.name,
    recipe_digest: pinVerificationRecipe(recipe).digest,
    call_ordinal: callOrdinal,
    remaining_call_allowance: Math.max(0, recipe.max_calls - callOrdinal),
    evaluation: recipe.evaluation,
    expectation_satisfied:
      recipe.evaluation === "report_only" ? null : executionFailed ? false : expectation,
    commands,
    ...(firstUnattempted === undefined ? {} : { first_unattempted_command: firstUnattempted }),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    details: body,
    terminate: false,
  };
}

function failureResult(code: string, consumed: number, recipe: VerificationRecipe) {
  const body = {
    error: code,
    recipe_name: recipe.name,
    recipe_digest: pinVerificationRecipe(recipe).digest,
    call_ordinal: consumed,
    remaining_call_allowance: Math.max(0, recipe.max_calls - consumed),
    evaluation: recipe.evaluation,
    expectation_satisfied: false,
    commands: [],
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    details: body,
    isError: true,
    terminate: false,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    details: { error: message },
    isError: true,
    terminate: false,
  };
}

function expectationSatisfied(
  evaluation: VerificationEvaluation,
  commands: readonly CommandEvidence[],
  commandCount: number,
): boolean | null {
  if (evaluation === "report_only") return null;
  if (commands.length !== commandCount) return false;
  if (
    commands.some(
      (command) =>
        command.timed_out ||
        command.cancelled ||
        command.cleanup !== "confirmed" ||
        command.capture !== "complete",
    )
  )
    return false;
  if (evaluation === "require_pass") return commands.every((command) => command.status === 0);
  const only = commands[0];
  return only !== undefined && only.status !== null && only.status !== 0;
}

function verificationCallState(
  records: readonly PersistedRecord[] | undefined,
  childId: string,
): VerificationCallState {
  if (records === undefined) return { consumed: 0, uncertain: false, callIds: [] };
  const scopedRecords = records.filter(
    (record): record is ToolExecutionRecord =>
      isToolExecutionRecord(record) &&
      "role_session_id" in record &&
      record.role_session_id === childId,
  );
  const executions = scopedRecords.filter(
    (record): record is ToolExecutionRecord =>
      record.type === "tool_execution_started" && record.tool_name === "verify",
  );
  if (executions.length === 0) return { consumed: 0, uncertain: false, callIds: [] };
  // One logical verify call may own several sequential command executions. The
  // SDK tool-call identity is the durable call boundary; counting physical
  // commands here would exhaust max_calls for multi-command recipes on resume.
  const callIds = new Set<string>();
  for (const execution of executions) {
    if (execution.tool_call_id !== undefined) callIds.add(execution.tool_call_id);
  }
  const timeline = reconstructToolExecutionTimeline(scopedRecords);
  const verifyIds = new Set(executions.map((record) => record.execution_id));
  const uncertain = timeline.unresolved.some((entry) => verifyIds.has(entry.started.execution_id));
  return { consumed: callIds.size, uncertain, callIds: [...callIds] };
}

function decodeRecipe(pin: VerificationRecipePin): VerificationRecipe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(pin.canonical_json);
  } catch (cause) {
    throw new Error("pinned verification recipe canonical JSON is invalid", { cause });
  }
  const parsedRecipes = parseVerificationRecipes([parsed], "pinned verification recipe");
  const recipe = parsedRecipes[0];
  if (recipe === undefined) throw new Error("pinned verification recipe is empty");
  const validationErrors = validateVerificationRecipes(parsedRecipes);
  if (validationErrors.length > 0)
    throw new Error(`pinned verification recipe is invalid: ${validationErrors[0]?.message}`);
  const expected = pinVerificationRecipe(recipe);
  if (
    expected.name !== pin.name ||
    expected.digest !== pin.digest ||
    expected.canonical_json !== pin.canonical_json
  )
    throw new Error("pinned verification recipe identity is invalid");
  return recipe;
}

function assertOwner(options: SandboxVerificationToolOptions): void {
  if (
    options.gate.owner.runId !== options.admission.runId ||
    options.gate.owner.childId !== options.admission.childId ||
    options.project.runId !== options.admission.runId ||
    options.project.childId !== options.admission.childId
  )
    throw new Error("sandbox verification tool has inconsistent child ownership");
}
