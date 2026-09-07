#!/usr/bin/env node
/** Slice 0 live oMLX probe. Source paths and credentials stay outside the artifact. */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { streamSimple, Type } from "@earendil-works/pi-ai/compat";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

const TARGETS = [8_000, 10_000, 12_000, 15_000, 18_000, 20_000, 25_000, 30_000, 40_000, 50_000];
const PREFILL_TARGETS = new Set([10_000, 25_000, 50_000]);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function activeBranchMessages(text) {
  const entries = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const byId = new Map(entries.flatMap((entry) => (entry.id ? [[entry.id, entry]] : [])));
  let current = [...entries].reverse().find((entry) => entry.id);
  const branch = [];
  while (current) {
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch
    .reverse()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

function transformedAndRepaired(messages, model) {
  const transformed = transformMessages(messages, model, (id) => id);
  const nonEmpty = transformed.filter(
    (message) => message.role !== "assistant" || message.content.length > 0,
  );
  const calls = new Set(
    nonEmpty.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
        : [],
    ),
  );
  return nonEmpty.filter(
    (message) => message.role !== "toolResult" || calls.has(message.toolCallId),
  );
}

function hasSyntheticResult(messages) {
  return messages.some(
    (message) =>
      message.role === "toolResult" &&
      message.isError === true &&
      message.content.some(
        (block) => block.type === "text" && block.text === "No result provided",
      ),
  );
}

function estimatedTokens(messages) {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function sdkContextTokens(messages) {
  let lastUsageIndex = -1;
  let usageTokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.usage
    ) {
      const usage = message.usage;
      const count =
        usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      if (count > 0) {
        lastUsageIndex = index;
        usageTokens = count;
        break;
      }
    }
  }
  if (lastUsageIndex < 0) return estimatedTokens(messages);
  return (
    usageTokens +
    messages
      .slice(lastUsageIndex + 1)
      .reduce((total, message) => total + estimateTokens(message), 0)
  );
}

function nearestSafePrefix(messages, model, target) {
  const candidates = [];
  for (let end = 1; end <= messages.length; end += 1) {
    const repaired = transformedAndRepaired(messages.slice(0, end), model);
    if (hasSyntheticResult(repaired)) continue;
    const estimate = estimatedTokens(repaired);
    candidates.push({ end, repaired, estimate });
  }
  if (candidates.length === 0) throw new Error("source has no synthetically sealed prefix");
  return candidates.reduce((best, item) =>
    Math.abs(item.estimate - target) < Math.abs(best.estimate - target) ? item : best,
  );
}

function activeTools(messages) {
  const names = new Set(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []))
        : [],
    ),
  );
  return [...names].sort().map((name) => ({
    name,
    description: `Inert historical compatibility tool: ${name}`,
    parameters: Type.Object({}, { additionalProperties: true }),
  }));
}

async function probe(
  model,
  messages,
  tools = activeTools(messages),
  systemPrompt = "Reproduce the next token only.",
) {
  const started = performance.now();
  let ttftMs = null;
  let finalMessage;
  const context = { messages, tools };
  if (systemPrompt !== undefined) context.systemPrompt = systemPrompt;
  for await (const event of streamSimple(
    model,
    context,
    { apiKey: required("OMLX_API_KEY"), maxTokens: 1, reasoning: "off" },
  )) {
    if (ttftMs === null && event.type !== "start") ttftMs = performance.now() - started;
    if (event.type === "done") finalMessage = event.message;
    if (event.type === "error") {
      throw new Error(event.error.errorMessage ?? "oMLX probe failed");
    }
  }
  if (!finalMessage || ttftMs === null) throw new Error("oMLX probe returned no terminal event");
  return {
    ttft_ms: Math.round(ttftMs),
    input_tokens: finalMessage.usage.input + finalMessage.usage.cacheRead,
    output_tokens: finalMessage.usage.output,
  };
}

const modelConfig = JSON.parse(await readFile(required("PI_MODELS_JSON"), "utf8"));
const provider = modelConfig.providers?.omlx;
if (!provider) throw new Error("models JSON has no omlx provider");
const sourceSpecs = [
  ["sol", required("PREWALK_SOL_SESSION")],
  ["terra", required("PREWALK_TERRA_SESSION")],
  ["luna", required("PREWALK_LUNA_SESSION")],
];
const sources = await Promise.all(
  sourceSpecs.map(async ([guide, path]) => ({
    guide,
    source_file_basename: basename(path),
    messages: activeBranchMessages(await readFile(path, "utf8")),
  })),
);
const modelIds = required("PREWALK_EXECUTOR_MODELS").split(",");
const rows = [];
for (const id of modelIds) {
  const configured = provider.models.find((candidate) => candidate.id === id);
  if (!configured) throw new Error(`missing configured executor ${id}`);
  const model = {
    ...configured,
    provider: "omlx",
    api: provider.api,
    baseUrl: provider.baseUrl,
    compat: { ...provider.compat, ...configured.compat },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  await probe(model, [{ role: "user", content: "warm", timestamp: 0 }]);
  const emptyUser = [{ role: "user", content: "", timestamp: 0 }];
  const baseMessageTokens = (await probe(model, emptyUser, [], undefined)).input_tokens;
  for (const target of TARGETS) {
    const selected = sources
      .map((source) => ({ source, prefix: nearestSafePrefix(source.messages, model, target) }))
      .reduce((best, item) =>
        Math.abs(item.prefix.estimate - target) < Math.abs(best.prefix.estimate - target)
          ? item
          : best,
      );
    const { source, prefix } = selected;
    const tools = activeTools(prefix.repaired);
    const live = await probe(model, prefix.repaired, tools);
    const envelopeTokens = (await probe(model, emptyUser, tools)).input_tokens;
    const transcriptInputTokens = live.input_tokens - envelopeTokens + baseMessageTokens;
    rows.push({
      executor_model: id,
      guide: source.guide,
      requested_tokens: target,
      source_messages: prefix.end,
      transformed_messages: prefix.repaired.length,
      estimate_tokens: prefix.estimate,
      sdk_context_tokens: sdkContextTokens(source.messages.slice(0, prefix.end)),
      transcript_input_tokens: transcriptInputTokens,
      provider_envelope_tokens: envelopeTokens - baseMessageTokens,
      ...live,
      purpose: PREFILL_TARGETS.has(target) ? "calibration+prefill" : "calibration",
    });
  }
}
console.log(JSON.stringify({ schema_version: 1, sdk: "0.80.6", rows }, null, 2));
