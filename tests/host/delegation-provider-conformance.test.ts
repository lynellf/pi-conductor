import type { Context, Model, StreamFunction, StreamOptions } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as bedrockStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { stream as googleGenerativeStream } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as googleVertexStream } from "@earendil-works/pi-ai/api/google-vertex";
import { stream as mistralStream } from "@earendil-works/pi-ai/api/mistral-conversations";
import { stream as openAiCompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as openAiResponsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { delegateTaskArgsSchema, delegationControlArgsSchema } from "../../src/seam/schema.js";

/**
 * Pi 0.80.6 adapter conformance: every public API-family converter receives the
 * same closed assignment/control TypeBox schemas without a provider request.
 */
type SupportedApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "google-generative-ai"
  | "google-vertex"
  | "bedrock-converse-stream"
  | "mistral-conversations";

const validTaskArgs = Object.freeze({
  assignment: "api-review",
  brief: "Implement the endpoint validation and run focused checks.",
});
const historicalBatchArgs = Object.freeze({
  tasks: [
    {
      id: "api-review",
      subagent: "api-implementer",
      objective: "Implement the endpoint validation.",
      expected_output: "A focused patch.",
    },
  ],
});

const context: Context = {
  messages: [{ role: "user", content: "Prepare the delegated work.", timestamp: 0 }],
  tools: [
    {
      name: "delegate_task",
      description: "Submit one pinned assignment.",
      parameters: delegateTaskArgsSchema,
    },
    {
      name: "delegation_control",
      description: "Control accepted child handles.",
      parameters: delegationControlArgsSchema,
    },
  ],
};

function fixtureModel<TApi extends SupportedApi>(api: TApi, provider: string): Model<TApi> {
  return {
    id: "conformance-fixture",
    name: "conformance-fixture",
    api,
    provider,
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 1_024,
  };
}

async function capturePayload<TApi extends SupportedApi, TOptions extends StreamOptions>(
  stream: StreamFunction<TApi, TOptions>,
  model: Model<TApi>,
): Promise<unknown> {
  let resolvePayload: (payload: unknown) => void = () => {};
  const payloadPromise = new Promise<unknown>((resolve) => {
    resolvePayload = resolve;
  });

  // Throw from the public payload hook after capture. Pi turns this into the
  // stream's normal error event, so no credentials or network request are used.
  const stopAfterCapture = new Error("conformance capture complete");
  stream(model, context, {
    apiKey: "fixture-only",
    onPayload(payload: unknown) {
      resolvePayload(payload);
      throw stopAfterCapture;
    },
  } as unknown as TOptions);

  return Promise.race([
    payloadPromise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Pi adapter did not invoke onPayload")), 2_000);
    }),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delegationSchemas(payload: unknown): readonly Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const name = value.name;
    if (name === "delegate_task" || name === "delegation_control") {
      for (const key of ["parameters", "input_schema", "parametersJsonSchema", "inputSchema"]) {
        const schema = value[key];
        if (!isRecord(schema)) continue;
        if (key === "inputSchema" && isRecord(schema.json)) found.push(schema.json);
        else found.push(schema);
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  return found;
}

function assertClosedAssignmentSchema(schema: Record<string, unknown>): void {
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties === undefined || schema.additionalProperties === false).toBe(
    true,
  );
  const properties = schema.properties;
  expect(isRecord(properties)).toBe(true);
  if (!isRecord(properties)) return;
  expect(Object.keys(properties).sort()).toEqual(["assignment", "brief"]);
  expect(schema.required).toEqual(["assignment", "brief"]);
}

function assertClosedControlSchema(schema: Record<string, unknown>): void {
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties === undefined || schema.additionalProperties === false).toBe(
    true,
  );
  const properties = schema.properties;
  expect(isRecord(properties)).toBe(true);
  if (!isRecord(properties)) return;
  expect(Object.keys(properties).sort()).toEqual(["child_ids", "operation"]);
  expect(schema.required).toEqual(["operation", "child_ids"]);
}

const adapterCases: readonly (readonly [string, () => Promise<unknown>])[] = [
  [
    "Anthropic Messages",
    () => capturePayload(anthropicStream, fixtureModel("anthropic-messages", "anthropic")),
  ],
  [
    "OpenAI-compatible chat/completions",
    () => capturePayload(openAiCompletionsStream, fixtureModel("openai-completions", "openai")),
  ],
  [
    "OpenAI Responses",
    () => capturePayload(openAiResponsesStream, fixtureModel("openai-responses", "openai")),
  ],
  [
    "Google Generative AI",
    () => capturePayload(googleGenerativeStream, fixtureModel("google-generative-ai", "google")),
  ],
  [
    "Google Vertex",
    () => capturePayload(googleVertexStream, fixtureModel("google-vertex", "google-vertex")),
  ],
  [
    "Bedrock Converse",
    () => capturePayload(bedrockStream, fixtureModel("bedrock-converse-stream", "amazon-bedrock")),
  ],
  [
    "Mistral Conversations",
    () => capturePayload(mistralStream, fixtureModel("mistral-conversations", "mistral")),
  ],
];

describe("Pi 0.80.6 delegation provider conformance", () => {
  it.each(adapterCases)("converts the closed tools for %s", async (_family, capture) => {
    const payload = await capture();
    const schemas = delegationSchemas(payload);
    expect(schemas).toHaveLength(2);
    const assignmentSchema = schemas.find((schema) => {
      const properties = schema.properties;
      return isRecord(properties) && "assignment" in properties;
    });
    const controlSchema = schemas.find((schema) => {
      const properties = schema.properties;
      return isRecord(properties) && "child_ids" in properties;
    });
    expect(assignmentSchema).toBeDefined();
    expect(controlSchema).toBeDefined();
    if (assignmentSchema !== undefined) assertClosedAssignmentSchema(assignmentSchema);
    if (controlSchema !== undefined) assertClosedControlSchema(controlSchema);

    expect(Value.Check(delegateTaskArgsSchema, validTaskArgs)).toBe(true);
    expect(
      Value.Check(delegationControlArgsSchema, { operation: "status", child_ids: ["c1"] }),
    ).toBe(true);
    expect(Value.Check(delegateTaskArgsSchema, historicalBatchArgs)).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('"tasks"');
  });
});
