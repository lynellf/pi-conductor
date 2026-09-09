import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { admitOrchestratorPrompt } from "../../src/host/orchestrator-context-admission.js";

function makeSession(options: {
  readonly contextWindow?: number;
  readonly contextTokens?: number | null;
  readonly systemPrompt?: string;
  readonly messages?: AgentSession["messages"];
  readonly onCompact?: () => void;
}): AgentSession {
  let messages = options.messages ?? [];
  const compact = vi.fn(async () => {
    messages = [];
    options.onCompact?.();
  });
  return {
    model:
      options.contextWindow === undefined
        ? undefined
        : ({ contextWindow: options.contextWindow } as AgentSession["model"]),
    getContextUsage: () =>
      options.contextTokens === undefined
        ? undefined
        : {
            tokens: options.contextTokens,
            contextWindow: options.contextWindow ?? 0,
            percent: null,
          },
    getActiveToolNames: () => ["read"],
    getAllTools: () => [
      {
        name: "read",
        description: "read a file",
        parameters: { type: "object", properties: {} },
        promptGuidelines: [],
        sourceInfo: { extensionPath: "test" },
      },
    ],
    get systemPrompt() {
      return options.systemPrompt ?? "";
    },
    get messages() {
      return messages;
    },
    compact,
  } as unknown as AgentSession;
}

const disabled = { enabled: false, reserveTokens: 8, keepRecentTokens: 10 } as const;

describe("retained context admission", () => {
  it("keeps the reserve when compaction is disabled", async () => {
    const session = makeSession({ contextWindow: 40, contextTokens: 35 });

    await expect(admitOrchestratorPrompt(session, "seed", disabled)).rejects.toThrow(
      "active model context budget",
    );
  });

  it("includes current system prompt and active tools when usage is unknown", async () => {
    const session = makeSession({
      contextWindow: 40,
      contextTokens: null,
      systemPrompt: "authority ".repeat(20),
    });

    await expect(admitOrchestratorPrompt(session, "seed", disabled)).rejects.toThrow(
      "active model context budget",
    );
  });

  it("diagnoses a reserve that leaves no active budget", async () => {
    const session = makeSession({ contextWindow: 8, contextTokens: 0 });

    await expect(
      admitOrchestratorPrompt(session, "seed", {
        enabled: true,
        reserveTokens: 8,
        keepRecentTokens: 2,
      }),
    ).rejects.toThrow("no active model context budget");
  });

  it("diagnoses a seed that remains oversized after compaction", async () => {
    let compactions = 0;
    const session = makeSession({
      contextWindow: 50,
      contextTokens: 100,
      systemPrompt: "current authority ".repeat(50),
      onCompact: () => {
        compactions += 1;
      },
    });

    await expect(
      admitOrchestratorPrompt(session, "seed", {
        enabled: true,
        reserveTokens: 8,
        keepRecentTokens: 2,
      }),
    ).rejects.toThrow("remains too large after compaction");
    expect(compactions).toBe(1);
  });

  it("diagnoses an unavailable provider model", async () => {
    const session = makeSession({});

    await expect(admitOrchestratorPrompt(session, "seed", disabled)).rejects.toThrow(
      "active model context window",
    );
  });
});
