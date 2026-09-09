import { randomUUID } from "node:crypto";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const models: readonly Model<"anthropic-messages">[] = [
  {
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
  },
  {
    id: "context-child-next",
    name: "Context child fallback model",
    api: "anthropic-messages",
    provider: "context-child",
    baseUrl: "context-child://local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1024,
  },
];

const usage = {
  input: 3,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
};

const streamSimple: StreamFunction = (model, context) => {
  const stream = createAssistantMessageEventStream();
  const failed =
    model.id === "context-child-model" && JSON.stringify(context).includes("fail-first");
  const message = {
    role: "assistant",
    content: failed
      ? []
      : [
          {
            type: "toolCall",
            id: `end-${randomUUID()}`,
            name: "end",
            arguments: { reason: "done" },
          },
        ],
    api: "anthropic-messages",
    provider: "context-child",
    model: model.id,
    usage,
    stopReason: failed ? "error" : "toolUse",
    timestamp: Date.now(),
    ...(failed ? { errorMessage: "first model failed after partial usage" } : {}),
  } as AssistantMessage;
  stream.push({ type: "start", partial: message });
  if (failed) {
    stream.push({ type: "error", reason: "error", error: message });
  } else {
    stream.push({ type: "done", reason: "toolUse", message });
  }
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
    models: [...models],
  });
};

export default extension;
