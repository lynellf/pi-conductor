import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  admitTrajectory,
  type TrajectoryHandoffError,
} from "../../src/host/trajectory-admission.js";

function model(overrides: Partial<Model<never>> = {}): Model<never> {
  return {
    id: "target",
    name: "target",
    api: "anthropic-messages",
    provider: "stub",
    baseUrl: "stub://no-network",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 100,
    ...overrides,
  } as Model<never>;
}

function input(overrides: Partial<Parameters<typeof admitTrajectory>[0]> = {}) {
  return {
    source: { tokens: 100, hasCompaction: false },
    targetModel: model(),
    targetModelName: "stub:target",
    systemPrompt: "target instructions",
    activeToolNames: ["handoff", "end", "ask_user"],
    activeToolDefinitions: [
      { name: "handoff", description: "handoff contract", parameters: { type: "object" } },
      { name: "end", description: "end contract", parameters: { type: "object" } },
      { name: "ask_user", description: "ask user", parameters: { type: "object" } },
    ],
    targetSeed: "continue",
    ...overrides,
  };
}

describe("Issue #63 trajectory admission", () => {
  it("persists the conservative known admission inputs", () => {
    const admitted = admitTrajectory(input());
    expect(admitted.safety_reservation_tokens).toBe(8192);
    expect(admitted.required_tokens).toBeGreaterThan(100 + 100 + 8192);
  });

  it("counts full active tool definitions in the role envelope", () => {
    const small = admitTrajectory(input());
    const large = admitTrajectory(
      input({
        activeToolDefinitions: [{ name: "target", description: "x".repeat(20_000) }],
      }),
    );
    expect(large.role_envelope_tokens).toBeGreaterThan(small.role_envelope_tokens);
  });

  const failures: readonly {
    readonly name: string;
    readonly args: Parameters<typeof admitTrajectory>[0];
    readonly code: TrajectoryHandoffError["code"];
  }[] = [
    {
      name: "compacted history wins over unknown estimate",
      args: input({ source: { tokens: null, hasCompaction: true } }),
      code: "trajectory_history_compacted",
    },
    {
      name: "null context estimate fails closed",
      args: input({ source: { tokens: null, hasCompaction: false } }),
      code: "trajectory_context_unknown",
    },
    {
      name: "invalid target metadata fails closed",
      args: input({ targetModel: model({ contextWindow: Number.NaN }) }),
      code: "trajectory_context_metadata_unknown",
    },
    {
      name: "oversized exact trajectory fails closed",
      args: input({ targetModel: model({ contextWindow: 1 }) }),
      code: "trajectory_context_too_large",
    },
  ];

  for (const failure of failures) {
    it(failure.name, () => {
      expect(() => admitTrajectory(failure.args)).toThrow(
        expect.objectContaining({ code: failure.code }),
      );
    });
  }
});
