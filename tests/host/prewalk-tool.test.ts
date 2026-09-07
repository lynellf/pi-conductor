import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  checkpointNextAction,
  createExecutionCheckpointTool,
  createExecutorExecutionCheckpointTool,
  type ExecutionCheckpointToolDetails,
  executionCheckpointArgsSchema,
  getPrewalkGuideActiveToolNames,
  PREWALK_CHECKPOINT_CORRECTIONS,
  PrewalkSeam,
} from "../../src/host/prewalk-tool.js";
import { SessionSeam } from "../../src/host/seam.js";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import type { FileMutationRecord } from "../../src/persistence/file-mutation.js";
import type { ExecutionCheckpointArgs } from "../../src/persistence/prewalk-records.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const WORKSPACE = process.cwd();
const PHASE_STARTED_AT = 100;
const ROLE_SESSION_ID = "role-session-1";

const validArgs: ExecutionCheckpointArgs = {
  outcome: "handoff_to_executor",
  approach: "Implement the smallest pure checkpoint seam and verify it.",
  rejected_approaches: ["Write directly to the machine seam"],
  todos: [
    {
      task: "Implement checkpoint validation",
      validation: "pnpm test -- prewalk-tool",
      allowed_paths: ["src/host/prewalk-tool.ts", "tests/host/prewalk-tool.test.ts"],
      status: "in_progress",
    },
  ],
  first_edit_path: "src/host/prewalk-tool.ts",
};

function mutation(ts = 101, path = validArgs.first_edit_path): FileMutationRecord {
  return {
    type: "file_mutation",
    run_id: "run-1",
    role: "implementation-lead",
    session_id: ROLE_SESSION_ID,
    session_file: "/tmp/session.jsonl",
    tool_name: "edit",
    files: [{ path, additions: 1, deletions: 1 }],
    ts,
  };
}

type ExecuteResult = {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly details: ExecutionCheckpointToolDetails;
  readonly terminate?: boolean;
};

async function invoke(
  tool: { readonly execute: unknown },
  params: unknown,
): Promise<ExecuteResult> {
  const execute = tool.execute as (id: string, params: unknown) => Promise<ExecuteResult>;
  return execute("checkpoint-call", params);
}

function createTool(
  options: {
    readonly seam?: PrewalkSeam;
    readonly mutations?: readonly FileMutationRecord[];
    readonly maxTodos?: number;
  } = {},
) {
  const seam = options.seam ?? new PrewalkSeam();
  return {
    seam,
    tool: createExecutionCheckpointTool({
      seam,
      maxTodos: options.maxTodos ?? 3,
      validationAllowlist: ["pnpm", "git", "node"],
      workspaceRoot: WORKSPACE,
      guidePhaseStartedAt: PHASE_STARTED_AT,
      roleSessionId: ROLE_SESSION_ID,
      mutations: () => options.mutations ?? [mutation()],
    }),
  };
}

function correction(code: keyof typeof PREWALK_CHECKPOINT_CORRECTIONS): string {
  return PREWALK_CHECKPOINT_CORRECTIONS[code];
}

describe("execution_checkpoint schema and validation", () => {
  it("uses a closed TypeBox object schema", () => {
    expect(executionCheckpointArgsSchema.type).toBe("object");
    expect(
      (executionCheckpointArgsSchema as { additionalProperties?: unknown }).additionalProperties,
    ).toBe(false);
    expect(executionCheckpointArgsSchema.required).toEqual([
      "outcome",
      "approach",
      "rejected_approaches",
      "todos",
      "first_edit_path",
    ]);
  });

  const rejectionCases: readonly {
    readonly name: string;
    readonly args: unknown;
    readonly code: keyof typeof PREWALK_CHECKPOINT_CORRECTIONS;
    readonly maxTodos?: number;
    readonly mutations?: readonly FileMutationRecord[];
  }[] = [
    { name: "malformed runtime value", args: null, code: "schema_invalid" },
    { name: "zero TODOs", args: { ...validArgs, todos: [] }, code: "todos_count" },
    {
      name: "more than max_todos",
      args: { ...validArgs, todos: [validArgs.todos[0], validArgs.todos[0]] },
      code: "todos_count",
      maxTodos: 1,
    },
    { name: "blank approach", args: { ...validArgs, approach: " \t " }, code: "approach_empty" },
    {
      name: "blank TODO task",
      args: { ...validArgs, todos: [{ ...validArgs.todos[0], task: "  " }] },
      code: "task_empty",
    },
    {
      name: "blank TODO validation",
      args: { ...validArgs, todos: [{ ...validArgs.todos[0], validation: "  " }] },
      code: "validation_empty",
    },
    {
      name: "unallowlisted executable basename",
      args: { ...validArgs, todos: [{ ...validArgs.todos[0], validation: "npm test" }] },
      code: "validation_not_allowed",
    },
    {
      name: "shell chaining",
      args: {
        ...validArgs,
        todos: [{ ...validArgs.todos[0], validation: "pnpm test && rm -rf ." }],
      },
      code: "validation_unsafe",
    },
    {
      name: "shell redirection",
      args: { ...validArgs, todos: [{ ...validArgs.todos[0], validation: "pnpm test > result" }] },
      code: "validation_unsafe",
    },
    {
      name: "command substitution",
      args: {
        ...validArgs,
        todos: [{ ...validArgs.todos[0], validation: "pnpm test $(node bad.js)" }],
      },
      code: "validation_unsafe",
    },
    {
      name: "backtick substitution",
      args: {
        ...validArgs,
        todos: [{ ...validArgs.todos[0], validation: "pnpm test `node bad.js`" }],
      },
      code: "validation_unsafe",
    },
    {
      name: "multiline shell",
      args: { ...validArgs, todos: [{ ...validArgs.todos[0], validation: "pnpm test\nrm -rf ." }] },
      code: "validation_unsafe",
    },
    {
      name: "unclosed quote",
      args: { ...validArgs, todos: [{ ...validArgs.todos[0], validation: "pnpm test 'open" }] },
      code: "validation_unsafe",
    },
    {
      name: "empty allowed_paths",
      args: { ...validArgs, todos: [{ ...validArgs.todos[0], allowed_paths: [] }] },
      code: "allowed_paths_empty",
    },
    {
      name: "non-normalized allowed path",
      args: {
        ...validArgs,
        todos: [{ ...validArgs.todos[0], allowed_paths: ["src/host/../host/prewalk-tool.ts"] }],
      },
      code: "allowed_path_invalid",
    },
    {
      name: "absolute allowed path",
      args: { ...validArgs, todos: [{ ...validArgs.todos[0], allowed_paths: ["/tmp/escape"] }] },
      code: "allowed_path_invalid",
    },
    {
      name: "escaping allowed path",
      args: { ...validArgs, todos: [{ ...validArgs.todos[0], allowed_paths: ["../escape"] }] },
      code: "allowed_path_invalid",
    },
    {
      name: "handoff with every TODO done",
      args: { ...validArgs, todos: [{ ...validArgs.todos[0], status: "done" }] },
      code: "outcome_todos_invalid",
    },
    {
      name: "already_complete with incomplete TODO",
      args: { ...validArgs, outcome: "already_complete" },
      code: "outcome_todos_invalid",
    },
    {
      name: "blocked without reason",
      args: { ...validArgs, outcome: "blocked" },
      code: "blocked_reason_required",
    },
    {
      name: "blocked with blank reason",
      args: { ...validArgs, outcome: "blocked", blocked_reason: "  " },
      code: "blocked_reason_required",
    },
    {
      name: "non-blocked with blocked reason",
      args: { ...validArgs, blocked_reason: "not blocked" },
      code: "blocked_reason_forbidden",
    },
    {
      name: "non-normalized first edit path",
      args: { ...validArgs, first_edit_path: "src/host/../host/prewalk-tool.ts" },
      code: "first_edit_path_invalid",
    },
    {
      name: "first edit outside workspace",
      args: { ...validArgs, first_edit_path: "../prewalk-tool.ts" },
      code: "first_edit_path_invalid",
    },
    {
      name: "mutation before guide phase",
      args: validArgs,
      code: "mutation_missing",
      mutations: [mutation(PHASE_STARTED_AT)],
    },
    {
      name: "mutation from another role session",
      args: validArgs,
      code: "mutation_missing",
      mutations: [{ ...mutation(), session_id: "other-session" }],
    },
    {
      name: "mutation for another path",
      args: validArgs,
      code: "mutation_missing",
      mutations: [mutation(101, "src/host/other.ts")],
    },
  ];

  for (const testCase of rejectionCases) {
    it(`returns the stable non-terminating correction for ${testCase.name}`, async () => {
      const { seam, tool } = createTool({
        ...(testCase.maxTodos !== undefined && { maxTodos: testCase.maxTodos }),
        ...(testCase.mutations !== undefined && { mutations: testCase.mutations }),
      });

      const result = await invoke(tool, testCase.args);

      expect(result.content).toEqual([{ type: "text", text: correction(testCase.code) }]);
      expect(result.details).toEqual({ ok: false, code: testCase.code });
      expect(result.terminate).toBe(false);
      expect(seam.read()).toBeNull();
    });
  }

  it("accepts a quoted single safe command and checks the executable basename", async () => {
    const { tool } = createTool();
    const result = await invoke(tool, {
      ...validArgs,
      todos: [{ ...validArgs.todos[0], validation: "./tools/pnpm test -- --runInBand 'one test'" }],
    });
    expect(result.details).toEqual({ ok: true, next_action: "switch_to_executor" });
  });

  it("rejects an allowed path whose existing symlink ancestor escapes the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "prewalk-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "prewalk-outside-"));
    try {
      symlinkSync(outside, join(root, "escape"));
      const seam = new PrewalkSeam();
      const tool = createExecutionCheckpointTool({
        seam,
        maxTodos: 3,
        validationAllowlist: ["pnpm"],
        workspaceRoot: root,
        guidePhaseStartedAt: PHASE_STARTED_AT,
        roleSessionId: ROLE_SESSION_ID,
        mutations: () => [mutation()],
      });

      const result = await invoke(tool, {
        ...validArgs,
        todos: [{ ...validArgs.todos[0], allowed_paths: ["escape/new-file.ts"] }],
      });

      expect(result.content[0]?.text).toBe(correction("allowed_path_invalid"));
      expect(result.terminate).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("PrewalkSeam isolation and phase outcomes", () => {
  it("records exactly one detached checkpoint and returns the exact terminating result", async () => {
    const input = structuredClone(validArgs) as ExecutionCheckpointArgs;
    const machineSeam = new SessionSeam();
    const { seam, tool } = createTool();

    const result = await invoke(tool, input);
    const mutableInput = input as unknown as { todos: { allowed_paths: string[] }[] };
    mutableInput.todos[0]?.allowed_paths.push("mutated-after-call");

    expect(result.content).toEqual([{ type: "text", text: "Execution checkpoint recorded." }]);
    expect(result.details).toEqual({ ok: true, next_action: "switch_to_executor" });
    expect(result.terminate).toBe(true);
    expect(seam.read()).toEqual(validArgs);
    expect(Object.isFrozen(seam.read())).toBe(true);
    expect(machineSeam.read()).toEqual([]);
    expect(machineSeam.isSealed).toBe(false);
  });

  it("rejects a duplicate valid call without replacing the first checkpoint", async () => {
    const { seam, tool } = createTool();
    await invoke(tool, validArgs);
    const duplicate = await invoke(tool, { ...validArgs, approach: "replacement" });

    expect(duplicate.content[0]?.text).toBe(correction("checkpoint_already_recorded"));
    expect(duplicate.terminate).toBe(false);
    expect(seam.read()?.approach).toBe(validArgs.approach);
  });

  it.each([
    ["already_complete", "reenable_machine_tools"],
    ["blocked", "reenable_machine_tools"],
    ["handoff_to_executor", "switch_to_executor"],
  ] as const)("maps %s to %s without producing a machine event", (outcome, action) => {
    expect(checkpointNextAction({ ...validArgs, outcome })).toBe(action);
  });

  it.each([
    {
      name: "already_complete",
      args: {
        ...validArgs,
        outcome: "already_complete" as const,
        todos: [{ ...validArgs.todos[0], status: "done" as const }],
      },
    },
    {
      name: "blocked",
      args: { ...validArgs, outcome: "blocked" as const, blocked_reason: "Upstream API absent." },
    },
  ])("accepts $name so the host may re-enable machine tools later", async ({ args }) => {
    const machineSeam = new SessionSeam();
    const { tool } = createTool();

    const result = await invoke(tool, args);

    expect(result.details).toEqual({ ok: true, next_action: "reenable_machine_tools" });
    expect(machineSeam.read()).toEqual([]);
    expect(machineSeam.isSealed).toBe(false);
  });

  it("builds the guide active-tool contract without handoff, end, or delegate", () => {
    const configured = ["read", "handoff", "write", "end", "delegate", "ask_user"];
    const copy = [...configured];

    expect(getPrewalkGuideActiveToolNames(configured)).toEqual([
      "read",
      "write",
      "ask_user",
      "execution_checkpoint",
    ]);
    expect(configured).toEqual(copy);
  });

  it("keeps executor checkpoint calls inert and counts every ghost call", async () => {
    const seam = new PrewalkSeam();
    const tool = createExecutorExecutionCheckpointTool(seam);

    const first = await invoke(tool, validArgs);
    const second = await invoke(tool, validArgs);

    expect(first.content).toEqual([
      {
        type: "text",
        text: "execution_checkpoint is only available during the guide phase. Continue the executor checklist with the currently active tools.",
      },
    ]);
    expect(first.terminate).toBe(false);
    expect(second.terminate).toBe(false);
    expect(seam.ghostToolCalls).toBe(2);
    expect(seam.read()).toBeNull();
  });
});

describe("execution_checkpoint through Pi SDK 0.80.6", () => {
  it("durably appends the terminating result and ends only the current native turn", async () => {
    const authStorage = AuthStorage.inMemory();
    const registry = ModelRegistry.inMemory(authStorage);
    registry.registerProvider("stub", {
      api: "anthropic-messages",
      apiKey: "stub-key",
      streamSimple: makeStubStreamFunction({
        steps: [
          {
            kind: "emit_tool_calls",
            calls: [{ name: "execution_checkpoint", arguments: { ...validArgs } }],
          },
          { kind: "emit_text", text: "second native prompt completed" },
        ],
      }),
    });
    const seam = new PrewalkSeam();
    const checkpointTool = createExecutionCheckpointTool({
      seam,
      maxTodos: 3,
      validationAllowlist: ["pnpm"],
      workspaceRoot: WORKSPACE,
      guidePhaseStartedAt: PHASE_STARTED_AT,
      roleSessionId: ROLE_SESSION_ID,
      mutations: () => [mutation()],
    });
    const manager = SessionManager.inMemory();
    const { session } = await createAgentSession({
      model: makeStubModel(),
      modelRegistry: registry,
      sessionManager: manager,
      customTools: [checkpointTool as ToolDefinition],
      tools: ["execution_checkpoint"],
      agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-prewalk-tool-"),
    });

    await session.prompt("guide prompt");
    const afterCheckpoint = manager.getEntries();
    const checkpointResult = afterCheckpoint.find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "execution_checkpoint",
    );
    expect(
      checkpointResult?.type === "message" && checkpointResult.message.role === "toolResult"
        ? checkpointResult.message.content
        : undefined,
    ).toEqual([{ type: "text", text: "Execution checkpoint recorded." }]);

    await session.prompt("prove the session remains usable");
    expect(
      manager
        .getEntries()
        .filter((entry) => entry.type === "message" && entry.message.role === "user"),
    ).toHaveLength(2);
    expect(seam.read()).toEqual(validArgs);

    session.dispose();
  }, 10_000);
});
