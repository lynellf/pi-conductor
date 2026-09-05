/** Pure guide-transcript transform preflight (Prewalk spec §R2.2, Slice 3a). */

import { isDeepStrictEqual } from "node:util";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { PrewalkSwitchSelectedRecord } from "../persistence/prewalk-records.js";

/** Target model plus the exact provider-request ID policy used around `transformMessages()`. */
export interface PrewalkExecutorModelResolution<TApi extends Api = Api> {
  readonly model: Model<TApi>;
  readonly normalizeToolCallId: (
    id: string,
    model: Model<TApi>,
    source: AssistantMessage,
  ) => string;
  readonly isToolCallIdValid: (id: string) => boolean;
}

/** Record-compatible pure facts; requested mode and the side-effecting live probe are deferred. */
export type PrewalkTransformPreflightSummary = Omit<
  PrewalkSwitchSelectedRecord["preflight"],
  "requested_mode" | "live_probe"
> & { readonly live_probe: "skipped" };

/** The repaired dry-run transcript and facts used to authorize or reject native transfer. */
export interface PrewalkTransformPreflightResult {
  readonly transformedMessages: readonly Message[];
  readonly summary: PrewalkTransformPreflightSummary;
}

/** Inputs are values only; injected normalization, validation, and counting must be pure. */
export interface RunPrewalkTransformPreflightArgs<TApi extends Api = Api> {
  readonly messages: readonly Message[];
  readonly executor: PrewalkExecutorModelResolution<TApi>;
  readonly activeToolNames: readonly string[];
  readonly inertToolNames: readonly string[];
  readonly transcriptBudgetTokens: number;
  readonly countTokens: (messages: readonly Message[], model: Model<TApi>) => number;
}

interface SourceCall {
  readonly call: ToolCall;
  readonly assistant: AssistantMessage;
  readonly skipped: boolean;
  readonly sourceResults: readonly ToolResultMessage[];
  targetId: string;
}

interface LossCounters {
  readonly reasoningBlocksDropped: number;
  readonly thinkingBlocksDowngraded: number;
  readonly assistantMessagesSkipped: number;
}

/**
 * Run the SDK transform, apply the bounded repairs allowed by §R2.2, and validate native input.
 */
export function runPrewalkTransformPreflight<TApi extends Api>(
  args: RunPrewalkTransformPreflightArgs<TApi>,
): PrewalkTransformPreflightResult {
  const repairs: string[] = [];
  const rejections: string[] = [];
  let losses: LossCounters = {
    reasoningBlocksDropped: 0,
    thinkingBlocksDowngraded: 0,
    assistantMessagesSkipped: 0,
  };
  let sourceCalls: SourceCall[] = [];
  let transformed: Message[];

  try {
    losses = countTransformLosses(args.messages, args.executor.model);
    sourceCalls = collectSourceCalls(args.messages);
    const callsByAssistant = groupCallsByAssistant(sourceCalls);
    const normalizerOffsets = new Map<AssistantMessage, number>();
    transformed = canonicalizeSyntheticTimestamps(
      transformMessages([...args.messages], args.executor.model, (id, model, source) => {
        const normalized = args.executor.normalizeToolCallId(id, model, source);
        if (typeof normalized !== "string") throw new Error("normalizer returned a non-string ID");
        const calls = callsByAssistant.get(source) ?? [];
        const offset = normalizerOffsets.get(source) ?? 0;
        const sourceCall = calls[offset];
        if (sourceCall !== undefined) sourceCall.targetId = normalized;
        normalizerOffsets.set(source, offset + 1);
        return normalized;
      }),
      sourceCalls,
    );
  } catch {
    addUnique(rejections, "transform_failed");
    return result([], repairs, rejections, 0, losses);
  }

  const retainedSourceCalls = sourceCalls.filter((entry) => !entry.skipped);
  const skippedTargetIds = new Set(
    sourceCalls.filter((entry) => entry.skipped).map((entry) => entry.targetId),
  );
  const retainedTargetIds = new Set(retainedSourceCalls.map((entry) => entry.targetId));
  const repairedMessages: Message[] = [];

  for (const [index, message] of transformed.entries()) {
    if (message.role === "assistant" && message.content.length === 0) {
      repairs.push(`drop_empty_assistant_message:${index}`);
      continue;
    }
    if (
      message.role === "toolResult" &&
      skippedTargetIds.has(message.toolCallId) &&
      !retainedTargetIds.has(message.toolCallId)
    ) {
      repairs.push(`drop_orphan_tool_result:${message.toolCallId}`);
      continue;
    }
    repairedMessages.push(message);
  }

  const targetCalls = collectTargetCalls(repairedMessages);
  validateTransformContract(retainedSourceCalls, targetCalls, rejections);
  validateToolPolicy(targetCalls, args, rejections);
  validatePairing(retainedSourceCalls, targetCalls, repairedMessages, repairs, rejections);

  let transformedTokens = 0;
  try {
    transformedTokens = args.countTokens(repairedMessages, args.executor.model);
    if (!Number.isInteger(transformedTokens) || transformedTokens < 0) {
      transformedTokens = 0;
      addUnique(rejections, "transformed_token_count_invalid");
    }
  } catch {
    addUnique(rejections, "transformed_token_count_invalid");
  }

  if (!Number.isInteger(args.transcriptBudgetTokens) || args.transcriptBudgetTokens < 0) {
    addUnique(rejections, "transcript_budget_invalid");
  } else if (transformedTokens > args.transcriptBudgetTokens) {
    addUnique(
      rejections,
      `transformed_budget_exceeded:${transformedTokens}>${args.transcriptBudgetTokens}`,
    );
  }

  return result(repairedMessages, repairs, rejections, transformedTokens, losses);
}

function collectSourceCalls(messages: readonly Message[]): SourceCall[] {
  const resultsById = new Map<string, ToolResultMessage[]>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      const results = resultsById.get(message.toolCallId) ?? [];
      results.push(message);
      resultsById.set(message.toolCallId, results);
    }
  }

  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [];
    const skipped = message.stopReason === "error" || message.stopReason === "aborted";
    return message.content.flatMap((block) =>
      block.type === "toolCall"
        ? [
            {
              call: block,
              assistant: message,
              skipped,
              sourceResults: resultsById.get(block.id) ?? [],
              targetId: block.id,
            },
          ]
        : [],
    );
  });
}

function canonicalizeSyntheticTimestamps(
  messages: readonly Message[],
  sourceCalls: readonly SourceCall[],
): Message[] {
  const unresolvedIds = new Set(
    sourceCalls
      .filter((call) => call.sourceResults.every((result) => isSdkSyntheticResult(result)))
      .map((call) => call.targetId),
  );
  return messages.map((message) =>
    message.role === "toolResult" &&
    unresolvedIds.has(message.toolCallId) &&
    isSdkSyntheticResult(message)
      ? { ...message, timestamp: 0 }
      : message,
  );
}

function groupCallsByAssistant(
  calls: readonly SourceCall[],
): ReadonlyMap<AssistantMessage, readonly SourceCall[]> {
  const grouped = new Map<AssistantMessage, SourceCall[]>();
  for (const call of calls) {
    const entries = grouped.get(call.assistant) ?? [];
    entries.push(call);
    grouped.set(call.assistant, entries);
  }
  return grouped;
}

function collectTargetCalls(messages: readonly Message[]): ToolCall[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((block) => (block.type === "toolCall" ? [block] : []))
      : [],
  );
}

function validateTransformContract(
  sourceCalls: readonly SourceCall[],
  targetCalls: readonly ToolCall[],
  rejections: string[],
): void {
  if (sourceCalls.length !== targetCalls.length) {
    addUnique(
      rejections,
      `transform_tool_call_count_mismatch:${sourceCalls.length}>${targetCalls.length}`,
    );
  }
  const length = Math.min(sourceCalls.length, targetCalls.length);
  for (let index = 0; index < length; index += 1) {
    const source = sourceCalls[index];
    const target = targetCalls[index];
    if (source === undefined || target === undefined) continue;
    if (
      source.call.name !== target.name ||
      !isDeepStrictEqual(source.call.arguments, target.arguments)
    ) {
      addUnique(rejections, `transform_tool_call_changed:${index}`);
    }
    if (source.targetId !== target.id) {
      addUnique(rejections, `transform_tool_call_id_mismatch:${index}`);
    }
  }
}

function validateToolPolicy<TApi extends Api>(
  calls: readonly ToolCall[],
  args: RunPrewalkTransformPreflightArgs<TApi>,
  rejections: string[],
): void {
  const allowed = new Set([...args.activeToolNames, ...args.inertToolNames]);
  const seenIds = new Set<string>();
  for (const call of calls) {
    if (!allowed.has(call.name)) addUnique(rejections, `historical_tool_unavailable:${call.name}`);
    let valid = false;
    try {
      valid = args.executor.isToolCallIdValid(call.id);
    } catch {
      valid = false;
    }
    if (!valid) addUnique(rejections, `tool_call_id_invalid:${call.id}`);
    if (seenIds.has(call.id)) addUnique(rejections, `tool_call_id_duplicate:${call.id}`);
    seenIds.add(call.id);
  }
}

function validatePairing(
  sourceCalls: readonly SourceCall[],
  targetCalls: readonly ToolCall[],
  messages: readonly Message[],
  repairs: string[],
  rejections: string[],
): void {
  const resultsById = new Map<string, Extract<Message, { role: "toolResult" }>[]>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const entries = resultsById.get(message.toolCallId) ?? [];
    entries.push(message);
    resultsById.set(message.toolCallId, entries);
  }
  const callIds = new Set(targetCalls.map((call) => call.id));
  for (const id of resultsById.keys()) {
    if (!callIds.has(id)) addUnique(rejections, `tool_result_orphaned:${id}`);
  }

  for (let index = 0; index < targetCalls.length; index += 1) {
    const target = targetCalls[index];
    const source = sourceCalls[index];
    if (target === undefined || source === undefined) continue;
    const paired = resultsById.get(target.id) ?? [];
    const realSourceResults = source.sourceResults.filter(
      (result) => !isSdkSyntheticResult(result),
    );
    if (realSourceResults.length === 0) {
      if (target.name === "execution_checkpoint") {
        repairs.push(`redrive_checkpoint_result:${target.id}`);
        addUnique(rejections, `checkpoint_result_unsealed:${target.id}`);
      } else {
        addUnique(rejections, `tool_result_missing:${target.id}`);
      }
      continue;
    }
    if (
      realSourceResults.length !== 1 ||
      source.sourceResults.length !== 1 ||
      paired.length !== 1
    ) {
      addUnique(rejections, `tool_result_pair_count_invalid:${target.id}`);
      continue;
    }
    const pairedResult = paired[0];
    const sourceResult = realSourceResults[0];
    if (pairedResult?.toolName !== target.name) {
      addUnique(rejections, `tool_result_name_mismatch:${target.id}`);
    }
    if (
      pairedResult !== undefined &&
      sourceResult !== undefined &&
      !isDeepStrictEqual({ ...pairedResult, toolCallId: source.call.id }, sourceResult)
    ) {
      addUnique(rejections, `tool_result_changed:${target.id}`);
    }
  }
}

function isSdkSyntheticResult(message: ToolResultMessage): boolean {
  return (
    message.isError === true &&
    message.content.length === 1 &&
    message.content[0]?.type === "text" &&
    message.content[0].text === "No result provided"
  );
}

function countTransformLosses<TApi extends Api>(
  messages: readonly Message[],
  model: Model<TApi>,
): LossCounters {
  let reasoningBlocksDropped = 0;
  let thinkingBlocksDowngraded = 0;
  let assistantMessagesSkipped = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      assistantMessagesSkipped += 1;
      continue;
    }
    const sameModel =
      message.provider === model.provider &&
      message.api === model.api &&
      message.model === model.id;
    for (const block of message.content) {
      if (block.type !== "thinking") continue;
      if (block.redacted === true) {
        if (!sameModel) reasoningBlocksDropped += 1;
      } else if (block.thinking.trim().length === 0) {
        if (!sameModel || !block.thinkingSignature) reasoningBlocksDropped += 1;
      } else if (!sameModel) {
        thinkingBlocksDowngraded += 1;
      }
    }
  }
  return { reasoningBlocksDropped, thinkingBlocksDowngraded, assistantMessagesSkipped };
}

function result(
  messages: readonly Message[],
  repairs: readonly string[],
  rejections: readonly string[],
  transformedTokens: number,
  losses: LossCounters,
): PrewalkTransformPreflightResult {
  const transformedMessages = Object.freeze(messages);
  return Object.freeze({
    transformedMessages,
    summary: Object.freeze({
      ok: rejections.length === 0,
      repairs: Object.freeze([...repairs]),
      rejections: Object.freeze([...rejections]),
      transformed_message_count: transformedMessages.length,
      transformed_tokens: transformedTokens,
      reasoning_blocks_dropped: losses.reasoningBlocksDropped,
      thinking_blocks_downgraded: losses.thinkingBlocksDowngraded,
      assistant_messages_skipped: losses.assistantMessagesSkipped,
      live_probe: "skipped" as const,
    }),
  });
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}
