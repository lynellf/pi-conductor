/** Child system-prompt assembly — delegation lite §6. */

import { readFile } from "node:fs/promises";

import type { SubagentProfile } from "../../manifest/types.js";

/** System prompt and task metadata supplied to one standalone child session. */
export interface ChildPrompt {
  readonly systemPrompt: string;
  readonly runId: string;
  readonly parentRole: string;
  readonly taskId: string;
  readonly worktreePath: string;
}

/** Read a declared profile prompt and append the child-only task contract. */
export async function buildChildPrompt(
  profile: SubagentProfile,
  systemPromptPath: string,
  taskId: string,
  objective: string,
  expectedOutput: string,
  runId: string,
  parentRole: string,
  worktreePath: string,
): Promise<ChildPrompt> {
  const baseSystemPrompt = await readFile(systemPromptPath, "utf8");
  return {
    systemPrompt: [
      baseSystemPrompt.trim(),
      "",
      "---",
      "CONDUCTOR SUBAGENT CONTEXT",
      `Subagent Profile: ${profile.name}`,
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
      "You may use only read, grep, find, ls, edit, write, run, and report_result.",
      "Commit meaningful changes in this worktree before reporting completed.",
      "Call report_result with completed, no_changes, or failed when finished.",
    ].join("\n"),
    runId,
    parentRole,
    taskId,
    worktreePath,
  };
}
