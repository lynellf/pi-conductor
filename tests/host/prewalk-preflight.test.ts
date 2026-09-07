import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  type PrewalkExecutorModelResolution,
  runPrewalkTransformPreflight,
} from "../../src/host/prewalk-preflight.js";

const GUIDE = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  model: "gpt-5.6-terra",
} as const;

const usage: AssistantMessage["usage"] = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage["content"],
  options: Partial<Pick<AssistantMessage, "stopReason" | "provider" | "api" | "model">> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    provider: options.provider ?? GUIDE.provider,
    api: options.api ?? GUIDE.api,
    model: options.model ?? GUIDE.model,
    usage,
    stopReason: options.stopReason ?? "toolUse",
    timestamp: 2,
  };
}

function result(toolCallId: string, toolName: string, text = "real result"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  };
}

function executorModel(): Model<"openai-completions"> {
  return {
    id: "Qwen3.8-27B-oQ4e-mtp",
    name: "Qwen",
    provider: "omlx",
    api: "openai-completions",
    baseUrl: "http://localhost.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 163_840,
    maxTokens: 32_768,
  };
}

function resolution(
  overrides: Partial<PrewalkExecutorModelResolution<"openai-completions">> = {},
): PrewalkExecutorModelResolution<"openai-completions"> {
  return {
    model: executorModel(),
    normalizeToolCallId: (id) => id.replaceAll("|", "_").replaceAll(" ", "_"),
    isToolCallIdValid: (id) => /^[A-Za-z0-9_-]{1,64}$/u.test(id),
    ...overrides,
  };
}

function preflight(
  messages: readonly Message[],
  options: {
    readonly executor?: PrewalkExecutorModelResolution<"openai-completions">;
    readonly activeToolNames?: readonly string[];
    readonly inertToolNames?: readonly string[];
    readonly budget?: number;
    readonly countTokens?: (messages: readonly Message[]) => number;
  } = {},
) {
  return runPrewalkTransformPreflight({
    messages,
    executor: options.executor ?? resolution(),
    activeToolNames: options.activeToolNames ?? ["read", "execution_checkpoint"],
    inertToolNames: options.inertToolNames ?? ["execution_checkpoint"],
    transcriptBudgetTokens: options.budget ?? 10_000,
    countTokens: options.countTokens ?? ((transformed) => JSON.stringify(transformed).length),
  });
}

function callTranscript(name = "read", id = "call|unsafe"): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "task" }], timestamp: 1 },
    assistant([{ type: "toolCall", id, name, arguments: { path: "src/a.ts" } }]),
    result(id, name),
  ];
}

describe("runPrewalkTransformPreflight", () => {
  it("repairs a cross-model thinking-only empty assistant by dropping it", () => {
    const messages: Message[] = [
      { role: "user", content: "task", timestamp: 1 },
      assistant([
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: "opaque-signed-reasoning",
        },
      ]),
    ];

    const actual = preflight(messages);

    expect(actual.summary).toEqual({
      ok: true,
      repairs: ["drop_empty_assistant_message:1"],
      rejections: [],
      transformed_message_count: 1,
      transformed_tokens: JSON.stringify([messages[0]]).length,
      reasoning_blocks_dropped: 1,
      thinking_blocks_downgraded: 0,
      assistant_messages_skipped: 0,
      live_probe: "skipped",
    });
    expect(actual.transformedMessages).toEqual([messages[0]]);
  });

  it("accepts a sealed execution checkpoint with its real result", () => {
    const messages = callTranscript("execution_checkpoint", "checkpoint|1");

    const actual = preflight(messages);

    expect(actual.summary.ok).toBe(true);
    expect(actual.summary.repairs).toEqual([]);
    expect(actual.summary.rejections).toEqual([]);
    expect(actual.transformedMessages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "checkpoint_1",
        toolName: "execution_checkpoint",
        isError: false,
      }),
    );
  });

  it("plans checkpoint re-drive and rejects an SDK synthetic result until sealing", () => {
    const messages: Message[] = [
      { role: "user", content: "task", timestamp: 1 },
      assistant([
        {
          type: "toolCall",
          id: "checkpoint|open",
          name: "execution_checkpoint",
          arguments: { outcome: "handoff_to_executor" },
        },
      ]),
    ];

    const actual = preflight(messages);

    expect(actual.summary.ok).toBe(false);
    expect(actual.summary.repairs).toEqual(["redrive_checkpoint_result:checkpoint_open"]);
    expect(actual.summary.rejections).toEqual(["checkpoint_result_unsealed:checkpoint_open"]);
    expect(actual.transformedMessages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "checkpoint_open",
        isError: true,
        content: [{ type: "text", text: "No result provided" }],
        timestamp: 0,
      }),
    );
  });

  for (const stopReason of ["error", "aborted"] as const) {
    it(`drops a tool result orphaned by a skipped ${stopReason} assistant turn`, () => {
      const messages: Message[] = [
        { role: "user", content: "task", timestamp: 1 },
        assistant([{ type: "toolCall", id: `failed|${stopReason}`, name: "read", arguments: {} }], {
          stopReason,
        }),
        result(`failed|${stopReason}`, "read"),
      ];

      const actual = preflight(messages);

      expect(actual.summary.ok).toBe(true);
      expect(actual.summary.repairs).toEqual([`drop_orphan_tool_result:failed_${stopReason}`]);
      expect(actual.summary.assistant_messages_skipped).toBe(1);
      expect(actual.transformedMessages).toEqual([messages[0]]);
    });
  }

  it("rejects a historical tool outside both the active allowlist and inert set", () => {
    const actual = preflight(callTranscript("bash", "bash-1"), {
      activeToolNames: ["read"],
      inertToolNames: ["execution_checkpoint"],
    });

    expect(actual.summary.ok).toBe(false);
    expect(actual.summary.rejections).toEqual(["historical_tool_unavailable:bash"]);
  });

  it("accepts a historical tool in the executor inert set", () => {
    const actual = preflight(callTranscript("execution_checkpoint", "checkpoint-1"), {
      activeToolNames: ["read"],
      inertToolNames: ["execution_checkpoint"],
    });

    expect(actual.summary.ok).toBe(true);
  });

  it("rejects a target-invalid tool-call ID after normalization", () => {
    const actual = preflight(callTranscript("read", "unsafe id"), {
      executor: resolution({
        normalizeToolCallId: () => "still invalid!",
      }),
    });

    expect(actual.summary.ok).toBe(false);
    expect(actual.summary.rejections).toContain("tool_call_id_invalid:still invalid!");
  });

  it("counts the repaired transformed list and rejects an oversized transcript", () => {
    const messages = callTranscript();
    let counted: readonly Message[] | undefined;

    const actual = preflight(messages, {
      budget: 2,
      countTokens: (transformed) => {
        counted = transformed;
        return 3;
      },
    });

    expect(counted).toBe(actual.transformedMessages);
    expect(actual.summary.transformed_tokens).toBe(3);
    expect(actual.summary.rejections).toContain("transformed_budget_exceeded:3>2");
  });

  it("passes a cross-vendor transcript while preserving calls, arguments, results, and input state", () => {
    const messages = callTranscript("read", "foreign|call");
    const original = structuredClone(messages);
    const model = executorModel();
    const activeToolNames = ["read"] as const;
    const inertToolNames = ["execution_checkpoint"] as const;
    let countedModel: Model<Api> | undefined;

    const actual = runPrewalkTransformPreflight({
      messages,
      executor: resolution({ model }),
      activeToolNames,
      inertToolNames,
      transcriptBudgetTokens: 10_000,
      countTokens: (transformed, executor) => {
        expect(transformed).not.toBe(messages);
        countedModel = executor;
        return 42;
      },
    });

    expect(actual.summary).toMatchObject({
      ok: true,
      repairs: [],
      rejections: [],
      transformed_tokens: 42,
      reasoning_blocks_dropped: 0,
      thinking_blocks_downgraded: 0,
      assistant_messages_skipped: 0,
      live_probe: "skipped",
    });
    expect(actual.transformedMessages[1]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "foreign_call",
          name: "read",
          arguments: { path: "src/a.ts" },
        },
      ],
    });
    expect(actual.transformedMessages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "foreign_call",
      content: [{ type: "text", text: "real result" }],
    });
    expect(countedModel).toBe(model);
    expect(messages).toEqual(original);
    expect(activeToolNames).toEqual(["read"]);
    expect(inertToolNames).toEqual(["execution_checkpoint"]);
  });

  it("records visible-thinking downgrade loss for a cross-model assistant", () => {
    const messages: Message[] = [
      { role: "user", content: "task", timestamp: 1 },
      assistant(
        [
          { type: "thinking", thinking: "visible reasoning", thinkingSignature: "opaque" },
          { type: "text", text: "plan" },
        ],
        { stopReason: "stop" },
      ),
    ];

    const actual = preflight(messages);

    expect(actual.summary.ok).toBe(true);
    expect(actual.summary.thinking_blocks_downgraded).toBe(1);
    expect(actual.summary.reasoning_blocks_dropped).toBe(0);
    expect(actual.transformedMessages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "visible reasoning" },
        { type: "text", text: "plan" },
      ],
    });
  });
});
