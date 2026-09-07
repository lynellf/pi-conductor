import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Message, Model, ToolCall } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { describe, expect, it } from "vitest";

interface Fixture {
  readonly id: string;
  readonly evidenceKind: string;
  readonly model: string;
  readonly messages: Message[];
}

interface FixtureFile {
  readonly fixtures: readonly Fixture[];
  readonly syntheticAugmentation: Fixture;
}

const fixturePath = fileURLToPath(
  new URL("./fixtures/prewalk/real-guide-transcripts.json", import.meta.url),
);
const fixtureFile = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureFile;
const guideFixtures = fixtureFile.fixtures.filter((fixture) =>
  ["real-sol-capture", "real-terra-capture", "real-luna-capture"].includes(fixture.id),
);
const executorIds = ["Qwen3.8-27B-oQ4e-mtp", "Tiel-Coder-35B-A3B-MLX-oQ4e"] as const;

function executor(id: (typeof executorIds)[number]): Model<"openai-completions"> {
  return {
    id,
    name: id,
    provider: "omlx",
    api: "openai-completions",
    baseUrl: "http://localhost.invalid/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: id.startsWith("Qwen") ? 163_840 : 262_144,
    maxTokens: 32_768,
  };
}

function toolCalls(messages: readonly Message[]): readonly ToolCall[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((block) => (block.type === "toolCall" ? [block] : []))
      : [],
  );
}

function textBlocks(messages: readonly Message[]): readonly string[] {
  return messages.flatMap((message) => {
    if (message.role === "assistant") {
      return message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
    }
    if (message.role === "user" || message.role === "toolResult") {
      const content = typeof message.content === "string" ? [] : message.content;
      return content.flatMap((block) => (block.type === "text" ? [block.text] : []));
    }
    return [];
  });
}

function errorCallIds(messages: readonly Message[]): readonly string[] {
  return messages.flatMap((message) =>
    message.role === "assistant" && ["error", "aborted"].includes(message.stopReason)
      ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
      : [],
  );
}

describe("Slice 0 transformMessages conformance", () => {
  for (const fixture of guideFixtures) {
    for (const executorId of executorIds) {
      it(`${fixture.model} -> omlx:${executorId} preserves the observable work record`, () => {
        const normalizedPrefix = `${executorId.slice(0, 8)}-`;
        const transformed = transformMessages(
          structuredClone(fixture.messages),
          executor(executorId),
          (id) => `${normalizedPrefix}${id}`,
        );
        const sourceNonErrorCalls = toolCalls(
          fixture.messages.filter(
            (message) => message.role !== "assistant" || message.stopReason !== "error",
          ),
        );
        const transformedCalls = toolCalls(transformed);

        expect(
          fixture.messages
            .filter((message) => message.role === "user")
            .map((message) => JSON.stringify(message.content)),
        ).toEqual(
          transformed
            .filter((message) => message.role === "user")
            .map((message) => JSON.stringify(message.content)),
        );
        expect(transformedCalls.map(({ name, arguments: args }) => ({ name, args }))).toEqual(
          sourceNonErrorCalls.map(({ name, arguments: args }) => ({ name, args })),
        );
        const sourceAssistantText = fixture.messages.flatMap((message) =>
          message.role === "assistant" && message.stopReason !== "error"
            ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
            : [],
        );
        expect(sourceAssistantText.every((text) => textBlocks(transformed).includes(text))).toBe(
          true,
        );
        const sourceResults = fixture.messages
          .filter((message) => message.role === "toolResult")
          .map((message) => JSON.stringify(message.content));
        const targetResults = transformed
          .filter((message) => message.role === "toolResult")
          .map((message) => JSON.stringify(message.content));
        expect(targetResults).toEqual(sourceResults);
        expect(transformedCalls.every((call) => call.id.startsWith(normalizedPrefix))).toBe(true);
        expect(
          transformed
            .filter((message) => message.role === "toolResult")
            .every((result) => transformedCalls.some((call) => call.id === result.toolCallId)),
        ).toBe(true);
        expect(
          errorCallIds(fixture.messages).every(
            (id) => !transformedCalls.some((call) => call.id.endsWith(id)),
          ),
        ).toBe(true);
        expect(
          transformed.every(
            (message) =>
              message.role !== "assistant" ||
              message.content.every((block) => block.type !== "thinking"),
          ),
        ).toBe(true);
      });
    }
  }

  it("downgrades real visible thinking and drops real signed empty-visible thinking", () => {
    const fixture = guideFixtures.find((candidate) => candidate.model === "gpt-5.6-sol");
    if (!fixture) throw new Error("missing sol fixture");
    const visible = fixture.messages.flatMap((message) =>
      message.role === "assistant" && message.stopReason !== "error"
        ? message.content.flatMap((block) =>
            block.type === "thinking" && block.thinking.length > 0 ? [block.thinking] : [],
          )
        : [],
    );
    const transformed = transformMessages(
      structuredClone(fixture.messages),
      executor(executorIds[0]),
    );

    expect(visible.every((text) => textBlocks(transformed).includes(text))).toBe(true);
    expect(
      transformed.every(
        (message) =>
          message.role !== "assistant" ||
          message.content.every((block) =>
            block.type !== "thinking" ? true : block.thinking.length > 0,
          ),
      ),
    ).toBe(true);
  });

  it("preserves the real checkpoint call arguments and sealed result", () => {
    const fixture = fixtureFile.fixtures.find(
      (candidate) => candidate.id === "real-checkpoint-capture",
    );
    if (!fixture) throw new Error("missing checkpoint fixture");
    const transformed = transformMessages(
      structuredClone(fixture.messages),
      executor(executorIds[0]),
    );
    const sourceCall = toolCalls(fixture.messages)[0];
    const targetCall = toolCalls(transformed)[0];
    const result = transformed.find((message) => message.role === "toolResult");

    expect(targetCall?.name).toBe("execution_checkpoint");
    expect(targetCall?.arguments).toEqual(sourceCall?.arguments);
    expect(result?.role === "toolResult" ? textBlocks([result]) : []).toEqual([
      "<real-tool-result-1>",
    ]);
  });

  it("classifies a real interrupted checkpoint as repairable synthetic-result insertion", () => {
    const fixture = fixtureFile.fixtures.find(
      (candidate) => candidate.id === "real-unresolved-capture",
    );
    if (!fixture) throw new Error("missing unresolved fixture");
    const transformed = transformMessages(
      structuredClone(fixture.messages),
      executor(executorIds[0]),
    );
    const result = transformed.find((message) => message.role === "toolResult");

    expect(result).toMatchObject({
      role: "toolResult",
      toolName: "execution_checkpoint",
      isError: true,
      content: [{ type: "text", text: "No result provided" }],
    });
  });

  it("covers redacted thinking and tool thoughtSignature only as synthetic non-fidelity paths", () => {
    const synthetic = fixtureFile.syntheticAugmentation;
    const transformed = transformMessages(
      structuredClone(synthetic.messages),
      executor(executorIds[0]),
    );
    const calls = toolCalls(transformed);

    expect(synthetic.evidenceKind).toBe("synthetic-structural-only");
    expect(
      transformed.every(
        (message) =>
          message.role !== "assistant" ||
          message.content.every((block) => block.type !== "thinking"),
      ),
    ).toBe(true);
    expect(calls[0]).not.toHaveProperty("thoughtSignature");
  });
});
