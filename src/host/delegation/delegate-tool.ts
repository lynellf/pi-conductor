/**
 * `delegate` tool factory — parent side (spec §7.1, issue #17 §7.1).
 *
 * A `defineTool`-style factory that:
 * - Validates the input via `validateDelegateBatch`
 * - On batch rejection: returns a structured error result WITHOUT calling the manager
 * - On accepted input: calls `DelegationManager.run()` and returns a
 *   JSON-serialized `readonly ChildResult[]` payload
 *
 * The tool is registered in the parent's `customTools` ONLY when the role has
 * both a `delegation:` block AND `tools: [delegate]` (Phase 1 validation).
 *
 * Defensive: never throws; manager errors are returned as tool-result errors
 * with a generic message and a host-side log line.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Role } from "../../index.js";
import type { DelegationPolicy } from "../../manifest/types.js";
import { delegateInputSchema } from "../../seam/schema.js";
import type { ChildResult, DelegationManager } from "./manager.js";
import type { DelegateValidationResult } from "./validate-batch.js";
import { type DelegateTask, validateDelegateBatch } from "./validate-batch.js";

/** Details payload on the delegate tool's result. */
export interface DelegateToolDetails {
  readonly ok: boolean;
  readonly reason?: string;
}

// Explicit type for the tool to avoid generic inference issues
type DelegateTool = ToolDefinition<typeof delegateInputSchema, DelegateToolDetails>;

export interface CreateDelegateToolArgs {
  /** The active parent role for this tool instance. */
  readonly parentRole: Role;
  /** The parent session ID. */
  readonly parentSession: string;
  /** The loaded delegation policy for the parent role. */
  readonly policy: DelegationPolicy;
  /** The delegation manager instance. */
  readonly manager: DelegationManager;
  /**
   * Number of children already admitted in this role's lifetime.
   * Used to enforce `max_children`.
   */
  readonly admittedChildren?: number;
  /** Read the live remaining child capacity when multiple batches are possible. */
  readonly getRemainingChildren?: () => number;
  /** Log a diagnostic message (host-side diagnostics). */
  readonly log?: (msg: string) => void;
}

/**
 * Create the `delegate` tool for a parent role.
 *
 * Registered in `customTools` for roles that have both:
 * - `delegation:` block in the manifest
 * - `delegate` in the role's `tools:` list
 *
 * The tool is a proper SDK `ToolDefinition` created via `defineTool`.
 */
export function createDelegateTool(args: CreateDelegateToolArgs): DelegateTool {
  const { parentRole, policy, manager, admittedChildren = 0, getRemainingChildren, log } = args;

  return defineTool<typeof delegateInputSchema, DelegateToolDetails>({
    name: "delegate",
    label: "Delegate",
    description: `Delegate a batch of independent tasks to auxiliary sub-agent sessions (role: ${parentRole})`,
    parameters: delegateInputSchema,
    execute: async (_toolCallId, params) => {
      // Step 1: validate the batch.
      const validation: DelegateValidationResult = validateDelegateBatch(
        params,
        policy,
        Math.max(0, getRemainingChildren?.() ?? policy.max_children - admittedChildren),
      );

      if (!validation.ok) {
        // Return a structured error WITHOUT calling the manager.
        log?.(`delegate batch rejected: ${validation.code} — ${validation.message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `[delegate] ${validation.code}: ${validation.message}`,
            },
          ],
          details: { ok: false, reason: validation.code } satisfies DelegateToolDetails,
          terminate: false,
        };
      }

      // Step 2: run the delegation batch.
      log?.(`delegate: spawning ${validation.tasks.length} tasks for role "${parentRole}"`);
      try {
        const results: readonly ChildResult[] = await manager.run(
          validation.tasks as unknown as readonly DelegateTask[],
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(results),
            },
          ],
          details: { ok: true } satisfies DelegateToolDetails,
          terminate: false,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log?.(`delegate manager error: ${msg}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `[delegate] internal error: ${msg}`,
            },
          ],
          details: { ok: false, reason: "manager_error" } satisfies DelegateToolDetails,
          terminate: false,
        };
      }
    },
  });
}
