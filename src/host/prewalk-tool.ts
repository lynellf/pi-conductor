/** Guide checkpoint tool and phase-local seam (Prewalk spec §R4, §R5, §R10). */

import {
  type AgentToolResult,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { FileMutationRecord } from "../persistence/file-mutation.js";
import type {
  ExecutionCheckpointArgs,
  ExecutionCheckpointTodo,
} from "../persistence/prewalk-records.js";
import { checkpointExecutable, isCheckpointPathContained } from "./prewalk-tool-validation.js";

const todoStatusSchema = Type.Union([
  Type.Literal("done"),
  Type.Literal("in_progress"),
  Type.Literal("pending"),
]);

/** SDK-visible TypeBox contract for `execution_checkpoint`. */
export const executionCheckpointArgsSchema = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal("handoff_to_executor"),
      Type.Literal("already_complete"),
      Type.Literal("blocked"),
    ]),
    approach: Type.String({ minLength: 1 }),
    rejected_approaches: Type.Array(Type.String()),
    todos: Type.Array(
      Type.Object(
        {
          task: Type.String({ minLength: 1 }),
          validation: Type.String({ minLength: 1 }),
          allowed_paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          status: todoStatusSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    first_edit_path: Type.String({ minLength: 1 }),
    blocked_reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

type SchemaArgs = Static<typeof executionCheckpointArgsSchema>;

export const PREWALK_CHECKPOINT_CORRECTIONS = Object.freeze({
  schema_invalid:
    "Execution checkpoint rejected [schema_invalid]: provide the complete execution_checkpoint object.",
  checkpoint_already_recorded:
    "Execution checkpoint rejected [checkpoint_already_recorded]: one valid checkpoint is already recorded for this visit.",
  todos_count:
    "Execution checkpoint rejected [todos_count]: provide between 1 and the configured max_todos checklist items.",
  approach_empty:
    "Execution checkpoint rejected [approach_empty]: approach must be non-empty after trimming.",
  task_empty:
    "Execution checkpoint rejected [task_empty]: every TODO task must be non-empty after trimming.",
  validation_empty:
    "Execution checkpoint rejected [validation_empty]: every TODO validation must be non-empty after trimming.",
  validation_unsafe:
    "Execution checkpoint rejected [validation_unsafe]: every validation must be one safe, syntactically complete command line without shell control, redirection, or substitution.",
  validation_not_allowed:
    "Execution checkpoint rejected [validation_not_allowed]: every validation executable basename must be in validation_allowlist.",
  allowed_paths_empty:
    "Execution checkpoint rejected [allowed_paths_empty]: every TODO must declare at least one allowed path.",
  allowed_path_invalid:
    "Execution checkpoint rejected [allowed_path_invalid]: allowed paths must be normalized workspace-relative paths contained in the role workspace.",
  outcome_todos_invalid:
    "Execution checkpoint rejected [outcome_todos_invalid]: handoff_to_executor requires an incomplete TODO and already_complete requires every TODO done.",
  blocked_reason_required:
    "Execution checkpoint rejected [blocked_reason_required]: blocked requires a non-empty blocked_reason.",
  blocked_reason_forbidden:
    "Execution checkpoint rejected [blocked_reason_forbidden]: blocked_reason is permitted only for outcome blocked.",
  first_edit_path_invalid:
    "Execution checkpoint rejected [first_edit_path_invalid]: first_edit_path must be a normalized workspace-relative path contained in the role workspace.",
  mutation_missing:
    "Execution checkpoint rejected [mutation_missing]: no successful matching file mutation was recorded after the guide phase began.",
});

export type PrewalkCheckpointCorrectionCode = keyof typeof PREWALK_CHECKPOINT_CORRECTIONS;

export type ExecutionCheckpointToolDetails =
  | {
      readonly ok: true;
      readonly next_action: "switch_to_executor" | "reenable_machine_tools";
    }
  | {
      readonly ok: false;
      readonly code: PrewalkCheckpointCorrectionCode | "executor_phase_inert";
    };

/** Dedicated per-visit state; intentionally independent of `SessionSeam`. */
export class PrewalkSeam {
  private checkpoint: ExecutionCheckpointArgs | null = null;
  private ghostCalls = 0;

  /** Record the first valid checkpoint without replacing it. */
  record(value: ExecutionCheckpointArgs): boolean {
    if (this.checkpoint !== null) return false;
    this.checkpoint = detachCheckpoint(value);
    return true;
  }

  /** Read the immutable checkpoint, or null before a valid call. */
  read(): ExecutionCheckpointArgs | null {
    return this.checkpoint;
  }

  /** Increment the observable executor imitation metric. */
  recordGhostCall(): void {
    this.ghostCalls += 1;
  }

  /** Number of inert executor calls observed in this visit. */
  get ghostToolCalls(): number {
    return this.ghostCalls;
  }
}

export interface ExecutionCheckpointToolOptions {
  readonly seam: PrewalkSeam;
  readonly maxTodos: number;
  readonly validationAllowlist: readonly string[];
  readonly workspaceRoot: string;
  readonly guidePhaseStartedAt: number;
  readonly roleSessionId: string;
  readonly mutations: () => readonly FileMutationRecord[];
  /** Dynamic native-session switch; absent keeps the guide-only Slice 4 behavior. */
  readonly executorPhase?: () => boolean;
}

/** Build the guide-phase terminating checkpoint tool. */
export function createExecutionCheckpointTool(
  options: ExecutionCheckpointToolOptions,
): ToolDefinition<typeof executionCheckpointArgsSchema, ExecutionCheckpointToolDetails> {
  return defineTool({
    name: "execution_checkpoint",
    label: "Execution checkpoint",
    description:
      "Record the bounded implementation checklist and exemplar edit, ending only the current guide turn.",
    parameters: executionCheckpointArgsSchema,
    executionMode: "sequential",
    execute: async (_id, params): Promise<AgentToolResult<ExecutionCheckpointToolDetails>> => {
      if (options.executorPhase?.() === true) {
        options.seam.recordGhostCall();
        return {
          content: [{ type: "text" as const, text: EXECUTOR_CHECKPOINT_CORRECTION }],
          details: { ok: false, code: "executor_phase_inert" },
          terminate: false,
        };
      }
      if (options.seam.read() !== null) return rejection("checkpoint_already_recorded");
      const code = validateCheckpoint(params, options);
      if (code !== null) return rejection(code);
      const checkpoint = params as ExecutionCheckpointArgs;
      if (!options.seam.record(checkpoint)) return rejection("checkpoint_already_recorded");
      return {
        content: [{ type: "text" as const, text: "Execution checkpoint recorded." }],
        details: { ok: true, next_action: checkpointNextAction(checkpoint) },
        terminate: true,
      };
    },
  });
}

export const EXECUTOR_CHECKPOINT_CORRECTION =
  "execution_checkpoint is only available during the guide phase. Continue the executor checklist with the currently active tools.";

/** Keep historical checkpoint calls declared but inert during execution. */
export function createExecutorExecutionCheckpointTool(
  seam: PrewalkSeam,
): ToolDefinition<typeof executionCheckpointArgsSchema, ExecutionCheckpointToolDetails> {
  return defineTool({
    name: "execution_checkpoint",
    label: "Execution checkpoint (guide phase complete)",
    description: "Inert compatibility tool retained for guide-history compatibility.",
    parameters: executionCheckpointArgsSchema,
    executionMode: "sequential",
    execute: async () => {
      seam.recordGhostCall();
      return {
        content: [{ type: "text" as const, text: EXECUTOR_CHECKPOINT_CORRECTION }],
        details: { ok: false, code: "executor_phase_inert" },
        terminate: false,
      };
    },
  });
}

/** Guide outcomes are host substate decisions, never machine events. */
export function checkpointNextAction(
  checkpoint: Pick<ExecutionCheckpointArgs, "outcome">,
): "switch_to_executor" | "reenable_machine_tools" {
  return checkpoint.outcome === "handoff_to_executor"
    ? "switch_to_executor"
    : "reenable_machine_tools";
}

/** Derive the guide's exact active-tool names without machine/delegation controls. */
export function getPrewalkGuideActiveToolNames(configured: readonly string[]): readonly string[] {
  const excluded = new Set(["handoff", "end", "delegate", "execution_checkpoint"]);
  const active = configured.filter(
    (name, index) => !excluded.has(name) && configured.indexOf(name) === index,
  );
  if (!active.includes("ask_user")) active.push("ask_user");
  active.push("execution_checkpoint");
  return Object.freeze(active);
}

function rejection(code: PrewalkCheckpointCorrectionCode) {
  return {
    content: [{ type: "text" as const, text: PREWALK_CHECKPOINT_CORRECTIONS[code] }],
    details: { ok: false as const, code },
    terminate: false,
  };
}

function validateCheckpoint(
  value: unknown,
  options: ExecutionCheckpointToolOptions,
): PrewalkCheckpointCorrectionCode | null {
  if (!isCheckpointShape(value)) return "schema_invalid";
  if (value.todos.length < 1 || value.todos.length > options.maxTodos) return "todos_count";
  if (value.approach.trim().length === 0) return "approach_empty";
  const allowlist = new Set(options.validationAllowlist);
  for (const todo of value.todos) {
    if (todo.task.trim().length === 0) return "task_empty";
    if (todo.validation.trim().length === 0) return "validation_empty";
    const executable = checkpointExecutable(todo.validation);
    if (executable === null) return "validation_unsafe";
    if (!allowlist.has(executable)) return "validation_not_allowed";
    if (todo.allowed_paths.length === 0) return "allowed_paths_empty";
    if (
      todo.allowed_paths.some((path) => !isCheckpointPathContained(path, options.workspaceRoot))
    ) {
      return "allowed_path_invalid";
    }
  }
  const allDone = value.todos.every((todo) => todo.status === "done");
  if (
    (value.outcome === "handoff_to_executor" && allDone) ||
    (value.outcome === "already_complete" && !allDone)
  ) {
    return "outcome_todos_invalid";
  }
  if (value.outcome === "blocked") {
    if (value.blocked_reason === undefined || value.blocked_reason.trim().length === 0) {
      return "blocked_reason_required";
    }
  } else if (value.blocked_reason !== undefined) return "blocked_reason_forbidden";
  if (!isCheckpointPathContained(value.first_edit_path, options.workspaceRoot)) {
    return "first_edit_path_invalid";
  }
  const matchingMutation = options
    .mutations()
    .some(
      (record) =>
        record.session_id === options.roleSessionId &&
        record.ts > options.guidePhaseStartedAt &&
        record.files.some((file) => file.path === value.first_edit_path),
    );
  return matchingMutation ? null : "mutation_missing";
}

function isCheckpointShape(value: unknown): value is SchemaArgs {
  if (!isObject(value) || !hasOnlyKeys(value, CHECKPOINT_KEYS)) return false;
  if (
    !["handoff_to_executor", "already_complete", "blocked"].includes(String(value.outcome)) ||
    typeof value.approach !== "string" ||
    !Array.isArray(value.rejected_approaches) ||
    !value.rejected_approaches.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.todos) ||
    typeof value.first_edit_path !== "string" ||
    (value.blocked_reason !== undefined && typeof value.blocked_reason !== "string")
  ) {
    return false;
  }
  return value.todos.every(isTodoShape);
}

const CHECKPOINT_KEYS = new Set([
  "outcome",
  "approach",
  "rejected_approaches",
  "todos",
  "first_edit_path",
  "blocked_reason",
]);
const TODO_KEYS = new Set(["task", "validation", "allowed_paths", "status"]);

function isTodoShape(value: unknown): value is ExecutionCheckpointTodo {
  return (
    isObject(value) &&
    hasOnlyKeys(value, TODO_KEYS) &&
    typeof value.task === "string" &&
    typeof value.validation === "string" &&
    Array.isArray(value.allowed_paths) &&
    value.allowed_paths.every((path) => typeof path === "string") &&
    (value.status === "done" || value.status === "in_progress" || value.status === "pending")
  );
}

function detachCheckpoint(value: ExecutionCheckpointArgs): ExecutionCheckpointArgs {
  const todos = Object.freeze(
    value.todos.map((todo) =>
      Object.freeze({ ...todo, allowed_paths: Object.freeze([...todo.allowed_paths]) }),
    ),
  );
  return Object.freeze({
    ...value,
    rejected_approaches: Object.freeze([...value.rejected_approaches]),
    todos,
  });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
