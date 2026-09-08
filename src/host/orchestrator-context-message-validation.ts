import { OrchestratorContextFileError } from "./orchestrator-context-file-errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OrchestratorContextFileError("invalid_entry", `${label} must be a non-empty string`);
  }
}

function validateContent(
  content: unknown,
  index: number,
  assistant: boolean,
  allowString: boolean,
): void {
  if (typeof content === "string") {
    if (allowString) return;
    throw new OrchestratorContextFileError(
      "invalid_entry",
      `message ${index} content must be an array`,
    );
  }
  if (!Array.isArray(content))
    throw new OrchestratorContextFileError("invalid_entry", `message ${index} content is invalid`);
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string")
      throw new OrchestratorContextFileError("invalid_entry", `message ${index} block is invalid`);
    if (block.type === "text") {
      if (typeof block.text !== "string")
        throw new OrchestratorContextFileError("invalid_entry", `message ${index} text is invalid`);
    } else if (block.type === "thinking") {
      if (!assistant)
        throw new OrchestratorContextFileError(
          "invalid_entry",
          `message ${index} thinking block is invalid`,
        );
      if (typeof block.thinking !== "string")
        throw new OrchestratorContextFileError(
          "invalid_entry",
          `message ${index} thinking is invalid`,
        );
    } else if (block.type === "image") {
      if (assistant)
        throw new OrchestratorContextFileError(
          "invalid_entry",
          `message ${index} assistant image is invalid`,
        );
      assertString(block.data, `message ${index} image data`);
      assertString(block.mimeType, `message ${index} image mimeType`);
    } else if (block.type === "toolCall") {
      if (!assistant)
        throw new OrchestratorContextFileError(
          "invalid_entry",
          `message ${index} tool call is invalid`,
        );
      assertString(block.id, `message ${index} tool call id`);
      assertString(block.name, `message ${index} tool call name`);
      if (!isRecord(block.arguments))
        throw new OrchestratorContextFileError(
          "invalid_entry",
          `message ${index} tool call arguments are invalid`,
        );
    } else
      throw new OrchestratorContextFileError(
        "invalid_entry",
        `message ${index} block type is unsupported`,
      );
  }
}

/** Validate provider-visible message fields before SDK context reconstruction. */
export function validateOrchestratorContextMessage(
  message: Record<string, unknown>,
  index: number,
): void {
  if (
    typeof message.timestamp !== "number" ||
    !Number.isFinite(message.timestamp) ||
    message.timestamp < 0
  ) {
    throw new OrchestratorContextFileError(
      "invalid_entry",
      `message ${index} timestamp is invalid`,
    );
  }
  const role = message.role;
  if (role === "user") {
    validateContent(message.content, index, false, true);
    return;
  }
  if (role === "assistant") {
    assertString(message.api, `assistant message ${index} api`);
    assertString(message.provider, `assistant message ${index} provider`);
    assertString(message.model, `assistant message ${index} model`);
    const usage = message.usage;
    if (
      !isRecord(usage) ||
      ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].some(
        (field) =>
          typeof usage[field] !== "number" || !Number.isFinite(usage[field]) || usage[field] < 0,
      )
    ) {
      throw new OrchestratorContextFileError(
        "invalid_entry",
        `assistant message ${index} usage is invalid`,
      );
    }
    const cost = usage.cost;
    if (
      !isRecord(cost) ||
      ["input", "output", "cacheRead", "cacheWrite", "total"].some(
        (field) =>
          typeof cost[field] !== "number" || !Number.isFinite(cost[field]) || cost[field] < 0,
      )
    ) {
      throw new OrchestratorContextFileError(
        "invalid_entry",
        `assistant message ${index} usage cost is invalid`,
      );
    }
    if (
      message.stopReason !== "stop" &&
      message.stopReason !== "length" &&
      message.stopReason !== "toolUse" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted"
    ) {
      throw new OrchestratorContextFileError(
        "invalid_entry",
        `assistant message ${index} stopReason is invalid`,
      );
    }
    validateContent(message.content, index, true, false);
    return;
  }
  if (role === "toolResult") {
    assertString(message.toolCallId, `tool result ${index} toolCallId`);
    assertString(message.toolName, `tool result ${index} toolName`);
    if (typeof message.isError !== "boolean") {
      throw new OrchestratorContextFileError(
        "invalid_entry",
        `tool result ${index} isError is invalid`,
      );
    }
    validateContent(message.content, index, false, false);
    return;
  }
  if (
    role === "bashExecution" ||
    role === "custom" ||
    role === "branchSummary" ||
    role === "compactionSummary"
  )
    return;
  throw new OrchestratorContextFileError("invalid_entry", `unsupported message role at ${index}`);
}
