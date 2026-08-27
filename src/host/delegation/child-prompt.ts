/** Child system-prompt assembly — delegation lite §6 / Issue #57 §6.2. */

import { readFile } from "node:fs/promises";

import type { SubagentProfile } from "../../manifest/types.js";

/** System prompt supplied to one standalone child session. */
export interface ChildPrompt {
  readonly systemPrompt: string;
}

/** Read a declared profile prompt and append only the selected protocol's task contract. */
export async function buildChildPrompt(
  profile: SubagentProfile,
  systemPromptPath: string,
  taskId: string,
  objective: string,
  expectedOutput: string,
  runId: string,
  parentRole: string,
  worktreePath: string,
  projectionPaths?: readonly string[],
): Promise<ChildPrompt> {
  const baseSystemPrompt = await readFile(systemPromptPath, "utf8");
  return {
    systemPrompt:
      profile.completion_protocol === "minimal"
        ? minimalChildPrompt(baseSystemPrompt, objective, expectedOutput, projectionPaths)
        : legacyChildPrompt(
            baseSystemPrompt,
            profile.name,
            taskId,
            objective,
            expectedOutput,
            runId,
            parentRole,
            worktreePath,
          ),
  };
}

function minimalChildPrompt(
  baseSystemPrompt: string,
  objective: string,
  expectedOutput: string,
  projectionPaths: readonly string[] | undefined,
): string {
  const visibleFiles =
    projectionPaths === undefined
      ? "the files materialized in this worktree"
      : projectionPaths.join("\n");
  return [
    baseSystemPrompt.trim(),
    "",
    "TASK",
    "Goal:",
    objective,
    "",
    "Visible files:",
    visibleFiles,
    "",
    "Required behavior:",
    "- Work only through the available file tools.",
    "- Stay within the visible files and do not run commands.",
    "",
    "Expected outcome:",
    expectedOutput,
    "",
    "When finished, respond normally with a concise final summary. Do not call a conductor completion tool. If you cannot continue because required context or an external dependency is missing, start the first non-empty line of the final response with: BLOCKED: <reason>",
  ].join("\n");
}

function legacyChildPrompt(
  baseSystemPrompt: string,
  profileName: string,
  taskId: string,
  objective: string,
  expectedOutput: string,
  runId: string,
  parentRole: string,
  worktreePath: string,
): string {
  return [
    baseSystemPrompt.trim(),
    "",
    "---",
    "CONDUCTOR SUBAGENT CONTEXT",
    `Subagent Profile: ${profileName}`,
    `Task ID: ${taskId}`,
    `Parent Run: ${runId}`,
    `Parent Role: ${parentRole}`,
    `Worktree: ${worktreePath}`,
    "",
    "YOUR TASK:",
    objective,
    "",
    "EXPECTED OUTPUT:",
    expectedOutput,
    "",
    "You may use only read, grep, find, ls, edit, write, and report_result.",
    "Do not run commands or create commits. The parent verifies and commits your work.",
    "Call report_result with completed, no_changes, or failed when finished.",
  ].join("\n");
}
