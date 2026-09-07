import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { runProductionPreflight } from "../../src/host/prewalk-production-preflight.js";
import { makeStubModel } from "../../src/host/stub-provider.js";

const model = { ...makeStubModel(), api: "openai-completions" as const };
const assistant: AssistantMessage = {
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
};

describe("production native preflight", () => {
  it("does not authorize native replay using repairs only applied to a dry-run copy", () => {
    const result = runProductionPreflight(
      {
        preflightContext: () => ({
          messages: [assistant],
          registeredTools: [],
          hasCompaction: false,
          contextTokens: 2,
        }),
      },
      model,
      [],
    );
    expect(result.summary).toMatchObject({
      ok: false,
      rejections: ["native_replay_repairs_unavailable"],
    });
    expect(result.summary.repairs).toEqual(["drop_empty_assistant_message:0"]);
  });
  it("retains native authorization when the SDK transform needs no extra repairs", () => {
    const result = runProductionPreflight(
      {
        preflightContext: () => ({
          messages: [{ ...assistant, content: [{ type: "text", text: "guide context" }] }],
          registeredTools: [],
          hasCompaction: false,
          contextTokens: 2,
        }),
      },
      model,
      [],
    );
    expect(result.summary.ok).toBe(true);
  });
});
