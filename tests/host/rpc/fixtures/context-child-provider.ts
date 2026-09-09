import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const model: Model<"anthropic-messages"> = {
  id: "context-child-model",
  name: "Context child model",
  api: "anthropic-messages",
  provider: "context-child",
  baseUrl: "context-child://local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1024,
};

const usage = {
  input: 3,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const streamSimple: StreamFunction = (_model, _context, _options) => {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "toolCall", id: `end-${randomUUID()}`, name: "end", arguments: { reason: "done" } },
    ],
    api: "anthropic-messages",
    provider: "context-child",
    model: "context-child-model",
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "toolUse", message });
  stream.end();
  return stream;
};

/** Trusted deterministic provider and machine-tool fixture for the compiled child. */
const extension: ExtensionFactory = (pi) => {
  pi.registerProvider("context-child", {
    api: "anthropic-messages",
    apiKey: "context-child-key",
    baseUrl: "context-child://local",
    streamSimple,
    models: [model],
  });
};

export default extension;

import { randomUUID } from "node:crypto";
