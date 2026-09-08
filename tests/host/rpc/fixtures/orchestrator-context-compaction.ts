import { appendFileSync } from "node:fs";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Usage,
} from "@earendil-works/pi-ai";
import { compact, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

const usage: Usage = {
  input: 19,
  output: 7,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 26,
  cost: { input: 0.019, output: 0.007, cacheRead: 0, cacheWrite: 0, total: 0.026 },
};
const compactionUsages: Usage[] = [];
const failedCompactionUsages: Array<Usage | undefined> = [];
let providerCalls = 0;

function summaryStream(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "rpc compact summary" }],
    api: "anthropic-messages",
    provider: "context-spike",
    model: "context-spike-model",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: message });
  stream.push({ type: "text_start", contentIndex: 0, partial: message });
  stream.push({
    type: "text_delta",
    contentIndex: 0,
    delta: "rpc compact summary",
    partial: message,
  });
  stream.push({
    type: "text_end",
    contentIndex: 0,
    content: "rpc compact summary",
    partial: message,
  });
  stream.push({ type: "done", reason: "stop", message });
  stream.end();
  return stream;
}

function meteredSummaryStream(): AssistantMessageEventStream {
  const stream = summaryStream();
  void stream.result().then((message) => compactionUsages.push(message.usage));
  return stream;
}

function failedSummaryStream(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "partial compact summary" }],
    api: "anthropic-messages",
    provider: "context-spike",
    model: "context-spike-model",
    usage,
    stopReason: "error",
    errorMessage: "compaction provider failed after partial output",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: message });
  stream.push({ type: "error", reason: "error", error: message });
  stream.end();
  return stream;
}

function meteredFailedSummaryStream(): AssistantMessageEventStream {
  const stream = failedSummaryStream();
  void stream.result().then((message) => failedCompactionUsages.push(message.usage));
  return stream;
}

function throwingSummaryStream(): AssistantMessageEventStream {
  throw new Error("compaction provider failed before assistant usage");
}

function writeEvidence(value: unknown): void {
  const path = process.env.PI_CONTEXT_SPIKE_EVIDENCE;
  if (path === undefined) throw new Error("PI_CONTEXT_SPIKE_EVIDENCE is required");
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

const extension: ExtensionFactory = (pi) => {
  pi.registerProvider("context-spike", {
    api: "anthropic-messages",
    apiKey: "context-spike-key",
    baseUrl: "context-spike://local",
    streamSimple: () => {
      providerCalls += 1;
      return summaryStream();
    },
    models: [
      {
        id: "context-spike-model",
        name: "Context spike model",
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
        contextWindow: 200_000,
        maxTokens: 4096,
      },
    ],
  });

  pi.on("session_before_compact", async (event, context) => {
    const preparation = event.preparation;
    const before = context.sessionManager.buildContextEntries().length;
    if (process.env.PI_CONTEXT_SPIKE_THROW === "1") {
      writeEvidence({ kind: "hook_throw", before });
      throw new Error("intentional context hook failure");
    }
    try {
      const streamFn =
        process.env.PI_CONTEXT_SPIKE_FAIL === "1"
          ? process.env.PI_CONTEXT_SPIKE_UNKNOWN === "1"
            ? throwingSummaryStream
            : meteredFailedSummaryStream
          : meteredSummaryStream;
      const result = await compact(
        preparation,
        context.model ??
          (() => {
            throw new Error("missing active model");
          })(),
        undefined,
        undefined,
        event.customInstructions,
        event.signal,
        undefined,
        streamFn,
      );
      writeEvidence({
        kind: "success",
        before,
        messagesToSummarize: preparation.messagesToSummarize.length,
        tokensBefore: preparation.tokensBefore,
        usage: compactionUsages.at(-1),
        result,
      });
      return { compaction: result };
    } catch (error) {
      const failedUsage = failedCompactionUsages.at(-1);
      writeEvidence({
        kind: "compaction_failure",
        error: error instanceof Error ? error.message : String(error),
        usage: failedUsage,
        diagnostic: failedUsage?.totalTokens
          ? `failed-after-${failedUsage.totalTokens}-tokens`
          : "unknown-usage",
        nativeProviderCalls: providerCalls,
      });
      return { cancel: true };
    }
  });
};

export default extension;
