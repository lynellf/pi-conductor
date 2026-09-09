import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  type SessionEntry,
  type SessionHeader,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { ContextBoundaryReference } from "../persistence/orchestrator-context.js";
import { OrchestratorContextFileError } from "./orchestrator-context-file-errors.js";
import { validateOrchestratorContextMessage } from "./orchestrator-context-message-validation.js";

export { OrchestratorContextFileError } from "./orchestrator-context-file-errors.js";
export { restoreOrchestratorContextBoundary } from "./orchestrator-context-file-restore.js";

/** Input needed to capture one exact, settled session boundary. */
export interface CaptureContextBoundaryOptions {
  readonly roleSessionId: string;
  readonly sessionFile: string;
  readonly conversationId: string;
  readonly leafId: string;
}

/** A validated source file and its selected SDK branch. */
export interface CapturedContextBoundary {
  readonly reference: ContextBoundaryReference;
  readonly header: SessionHeader;
  readonly entries: readonly SessionEntry[];
}

/** Destination for an exact-tip branch restoration. */
export interface RestoreContextBoundaryOptions {
  readonly boundary: ContextBoundaryReference;
  readonly destinationSessionDir: string;
  readonly cwd: string;
}

/** Result of creating a new physical session from a committed boundary. */
export interface RestoredContextBoundary {
  readonly sessionFile: string;
  readonly manager: SessionManager;
  readonly reference: ContextBoundaryReference;
}

interface ValidatedFile {
  readonly header: SessionHeader;
  readonly entries: readonly SessionEntry[];
  readonly selectedBranch: readonly SessionEntry[];
  readonly canonicalHash: string;
}

type ContextMessage = ReturnType<SessionManager["buildSessionContext"]>["messages"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OrchestratorContextFileError("invalid_entry", `${label} must be a non-empty string`);
  }
}

function validateHeader(value: unknown): SessionHeader {
  if (!isRecord(value) || value.type !== "session") {
    throw new OrchestratorContextFileError(
      "invalid_header",
      "session file must start with a session header",
    );
  }
  assertString(value.id, "session header id");
  assertString(value.cwd, "session header cwd");
  if (value.version !== CURRENT_SESSION_VERSION) {
    throw new OrchestratorContextFileError(
      "invalid_header",
      `session header version must be ${CURRENT_SESSION_VERSION}`,
    );
  }
  if (typeof value.timestamp !== "string") {
    throw new OrchestratorContextFileError(
      "invalid_header",
      "session header timestamp is required",
    );
  }
  return value as unknown as SessionHeader;
}

function validateEntry(value: unknown, index: number): SessionEntry {
  if (!isRecord(value) || value.type === "session") {
    throw new OrchestratorContextFileError("invalid_entry", `session entry ${index} is malformed`);
  }
  assertString(value.id, `session entry ${index} id`);
  if (value.parentId !== null) assertString(value.parentId, `session entry ${index} parentId`);
  if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) {
    throw new OrchestratorContextFileError(
      "invalid_entry",
      `session entry ${index} timestamp is invalid`,
    );
  }
  switch (value.type) {
    case "message":
      if (!isRecord(value.message) || typeof value.message.role !== "string") {
        throw new OrchestratorContextFileError(
          "invalid_entry",
          `message entry ${index} has no valid message`,
        );
      }
      if (
        typeof value.message.timestamp !== "number" ||
        !Number.isFinite(value.message.timestamp)
      ) {
        throw new OrchestratorContextFileError(
          "invalid_entry",
          `message entry ${index} timestamp is invalid`,
        );
      }
      validateOrchestratorContextMessage(value.message, index);
      break;
    case "model_change":
      assertString(value.provider, `model change ${index} provider`);
      assertString(value.modelId, `model change ${index} modelId`);
      break;
    case "thinking_level_change":
      assertString(value.thinkingLevel, `thinking level change ${index} thinkingLevel`);
      break;
    case "compaction":
      assertString(value.summary, `compaction ${index} summary`);
      assertString(value.firstKeptEntryId, `compaction ${index} firstKeptEntryId`);
      if (typeof value.tokensBefore !== "number" || !Number.isFinite(value.tokensBefore)) {
        throw new OrchestratorContextFileError(
          "invalid_entry",
          `compaction ${index} tokensBefore is invalid`,
        );
      }
      break;
    case "branch_summary":
      assertString(value.fromId, `branch summary ${index} fromId`);
      assertString(value.summary, `branch summary ${index} summary`);
      break;
    case "custom":
      assertString(value.customType, `custom entry ${index} customType`);
      break;
    case "custom_message":
      assertString(value.customType, `custom message ${index} customType`);
      if (typeof value.display !== "boolean") {
        throw new OrchestratorContextFileError(
          "invalid_entry",
          `custom message ${index} display is invalid`,
        );
      }
      validateOrchestratorContextMessage(
        { role: "user", content: value.content, timestamp: Date.parse(value.timestamp) },
        index,
      );
      break;
    case "label":
      assertString(value.targetId, `label ${index} targetId`);
      break;
    case "session_info":
      break;
    default:
      throw new OrchestratorContextFileError(
        "invalid_entry",
        `unsupported session entry type at ${index}`,
      );
  }
  return value as unknown as SessionEntry;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function selectedBranch(entries: readonly SessionEntry[], leafId: string): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      throw new OrchestratorContextFileError(
        "duplicate_id",
        `duplicate session entry id ${entry.id}`,
      );
    }
    byId.set(entry.id, entry);
  }
  for (const entry of entries) {
    if (entry.parentId !== null && !byId.has(entry.parentId)) {
      throw new OrchestratorContextFileError(
        "broken_parent_chain",
        `${entry.id} references missing parent ${entry.parentId}`,
      );
    }
  }
  const selected: SessionEntry[] = [];
  const visited = new Set<string>();
  let current: SessionEntry | undefined = byId.get(leafId);
  if (!current)
    throw new OrchestratorContextFileError("unknown_tip", `committed tip ${leafId} is absent`);
  while (current) {
    if (visited.has(current.id)) {
      throw new OrchestratorContextFileError(
        "cyclic_parent_chain",
        `cycle detected at ${current.id}`,
      );
    }
    visited.add(current.id);
    selected.push(current);
    if (current.parentId === null) break;
    const parent = byId.get(current.parentId);
    if (!parent) {
      throw new OrchestratorContextFileError(
        "broken_parent_chain",
        `${current.id} references missing parent ${current.parentId}`,
      );
    }
    current = parent;
  }
  selected.reverse();
  return selected;
}

function assertToolPairing(messages: readonly ContextMessage[]): void {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (pending.size > 0 && message.role !== "toolResult") {
      throw new OrchestratorContextFileError(
        "unresolved_tool_call",
        "a new conversation message appears before all tool results settled",
      );
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") {
          if (pending.has(block.id)) {
            throw new OrchestratorContextFileError(
              "unresolved_tool_call",
              `duplicate tool call id ${block.id}`,
            );
          }
          pending.set(block.id, block.name);
        }
      }
    } else if (message.role === "toolResult") {
      const expectedToolName = pending.get(message.toolCallId);
      if (expectedToolName === undefined) {
        throw new OrchestratorContextFileError(
          "unresolved_tool_call",
          `tool result ${message.toolCallId} has no preceding tool call`,
        );
      }
      if (expectedToolName !== message.toolName) {
        throw new OrchestratorContextFileError(
          "unresolved_tool_call",
          `tool result ${message.toolCallId} names ${message.toolName}, expected ${expectedToolName}`,
        );
      }
      pending.delete(message.toolCallId);
    }
  }
  if (pending.size > 0) {
    throw new OrchestratorContextFileError(
      "unresolved_tool_call",
      `session has ${pending.size} tool call(s) without results`,
    );
  }
}

async function readValidatedFile(sessionFile: string, leafId: string): Promise<ValidatedFile> {
  let content: string;
  try {
    content = await readFile(sessionFile, "utf8");
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new OrchestratorContextFileError(
      "missing_file",
      `cannot read session file ${sessionFile}: ${detail}`,
    );
  }
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0)
    throw new OrchestratorContextFileError("malformed_jsonl", "session file is empty");
  const values = lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new OrchestratorContextFileError(
        "malformed_jsonl",
        `session line ${index + 1} is invalid: ${detail}`,
      );
    }
  });
  const header = validateHeader(values[0]);
  const entries = values.slice(1).map(validateEntry);
  const branch = selectedBranch(entries, leafId);
  for (const [entryIndex, entry] of branch.entries()) {
    if (
      entry.type === "compaction" &&
      !branch.some((candidate) => candidate.id === entry.firstKeptEntryId)
    ) {
      throw new OrchestratorContextFileError(
        "broken_parent_chain",
        `compaction ${entry.id} keeps an unknown entry`,
      );
    }
    if (
      entry.type === "compaction" &&
      branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId) >= entryIndex
    ) {
      throw new OrchestratorContextFileError(
        "broken_parent_chain",
        `compaction ${entry.id} keeps a future entry`,
      );
    }
    if (
      entry.type === "branch_summary" &&
      !entries.some((candidate) => candidate.id === entry.fromId)
    ) {
      throw new OrchestratorContextFileError(
        "broken_parent_chain",
        `branch summary ${entry.id} references an unknown entry`,
      );
    }
  }
  const canonicalHash = createHash("sha256")
    .update(canonicalize([header, ...branch]))
    .digest("hex");
  return { header, entries, selectedBranch: branch, canonicalHash };
}

/** Capture and validate one exact source branch before it can be restored. */
export async function captureOrchestratorContextBoundary(
  options: CaptureContextBoundaryOptions,
): Promise<CapturedContextBoundary> {
  const validated = await readValidatedFile(options.sessionFile, options.leafId);
  if (validated.header.id !== options.conversationId) {
    throw new OrchestratorContextFileError(
      "hash_mismatch",
      "session conversation id differs from the expected identity",
    );
  }
  if (validated.header.id.length === 0)
    throw new OrchestratorContextFileError("invalid_header", "conversation id is empty");
  let context: ReturnType<typeof buildSessionContext>;
  try {
    const entries = [...validated.selectedBranch];
    context = buildSessionContext(
      entries,
      options.leafId,
      new Map(entries.map((entry) => [entry.id, entry])),
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new OrchestratorContextFileError(
      "sdk_restore_failed",
      `SDK context reconstruction failed: ${detail}`,
    );
  }
  assertToolPairing(context.messages);
  const reference: ContextBoundaryReference = {
    role_session_id: options.roleSessionId,
    conversation_id: validated.header.id,
    session_file: options.sessionFile,
    leaf_id: options.leafId,
    history_sha256: validated.canonicalHash,
  };
  return { reference, header: validated.header, entries: validated.selectedBranch };
}
