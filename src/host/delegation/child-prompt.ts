/**
 * Child session system prompt builder (spec §7.3, issue #17 §7.3).
 *
 * The envelope is the ONLY prompt content sent to a child session.
 * It does NOT include the parent's full transcript, prior handoff
 * payloads, or any state from the parent's session (spec §7.3
 * boundary).
 *
 * The envelope is plain text, ≤ 8 KiB for a typical task.
 *
 * Pure function — no I/O, no SDK imports.
 */

import type { Role } from "../../index.js";

export interface BuildChildSystemPromptArgs {
  readonly role: Role;
  readonly runId: string;
  readonly taskId: string;
  readonly parentRole: Role;
  readonly workspace: "read_only" | "worktree";
  readonly objective: string;
  readonly expectedOutput: string;
  readonly tools: readonly string[];
  readonly cwd: string;
  /** The Git commit the worktree was created from. Null for read_only mode. */
  readonly baseCommit: string | null;
}

/**
 * Build the system prompt for a child auxiliary session.
 *
 * The envelope includes:
 * - The child's role name and run context
 * - The task objective and expected output
 * - The allowed tool list
 * - The worktree / read-only contract
 * - The mandatory `report_result` call contract
 * - A hard policy block: no handoff, end, ask_user, or delegate
 *
 * The envelope does NOT include the parent's transcript, prior handoff
 * payloads, or any state from the parent's session (spec §7.3).
 */
export function buildChildSystemPrompt(args: BuildChildSystemPromptArgs): string {
  const {
    role,
    runId,
    taskId,
    parentRole,
    workspace,
    objective,
    expectedOutput,
    tools,
    cwd,
    baseCommit,
  } = args;

  const workspaceBlock =
    workspace === "worktree"
      ? `Working directory: ${cwd}
Based on commit: ${baseCommit ?? "(unknown)"}`
      : `Working directory: ${cwd}
This is a read-only task. Do not modify any files.`;

  const toolsBlock =
    tools.length > 0 ? `Available tools: ${tools.join(", ")}.` : "No tools are available.";

  return `You are an auxiliary session for role "${role}" in run ${runId}.
You are executing a single delegated task on behalf of parent role "${parentRole}".

TASK OBJECTIVE:
${objective}

EXPECTED OUTPUT:
${expectedOutput}

${workspaceBlock}

${toolsBlock}

REPORTING CONTRACT:
- You MUST call the \`report_result\` tool exactly once before stopping.
- Do not call \`handoff\`, \`end\`, \`ask_user\`, or \`delegate\`.
- You will not be prompted again after this task.

Task ID: ${taskId}
`.trim();
}
