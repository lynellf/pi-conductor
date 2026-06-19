/**
 * Tool-sealing wrapper — spec §12.1, plan Task 15.5.
 *
 * Wraps a `ToolDefinition` so that, while a "sealed" flag is true,
 * the tool short-circuits to an error result WITHOUT invoking the
 * underlying execute. Used to prevent work-after-handoff from
 * mutating the workspace after a role has declared its exit intent
 * (the moment a valid `handoff` or `end` capture is recorded, Task 14).
 *
 * The flag is per-session host state on `SessionSeam` (Task 14) —
 * the reducer never sees it. `handoff` / `end` themselves remain
 * unwrapped (they don't execute side effects; they only write to the
 * capture buffer, which is exactly what we want for the
 * `extra_emission` path).
 *
 * ## Production usage (Task 15's SDK-backed sibling, not yet built)
 *
 * At `spawnRole` time, the SDK-backed Host:
 *
 *   1. Builds the built-in tools (`createBashTool`, `createEditTool`, …)
 *      and the role's declared custom tools.
 *   2. Wraps EVERY tool in the allowlist with `wrapAllToolsWithSeal`,
 *      passing `() => seam.isSealed` as the check.
 *   3. Builds the `handoff` / `end` tools separately (Task 14's
 *      factories) and registers them unwrapped so the `extra_emission`
 *      marker path still works.
 *
 * The agent never sees an unwrapped side-effecting tool — once a
 * valid machine-event capture is recorded, every other tool's
 * `execute` short-circuits.
 *
 * ## Why the seal flag is host state, not reducer state
 *
 * The reducer is pure and deterministic (§12). A sealed flag would
 * couple it to per-session mutable state. By keeping the flag on
 * `SessionSeam` (Task 14) and exposing it through a `() => boolean`
 * callback, the reducer stays untouched. The wrapper is host-internal.
 *
 * ## Type erasure rationale
 *
 * `ToolDefinition<TParams, TDetails, TState>` is a generic that the
 * SDK erases at the `customTools: ToolDefinition[]` boundary on
 * `CreateAgentSessionOptions`. The wrapper preserves the call signature
 * (`(toolCallId, params, signal, onUpdate, ctx)`) so the runtime
 * dispatches to it correctly, but the inner cast is type-erased for
 * compatibility with arbitrary tools — preserving `TParams` / `TDetails`
 * through the wrapper would cost type gymnastics for no runtime gain.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// ─── Public types ──────────────────────────────────────────────────────

/** A function returning true if the session is sealed. */
export type SealCheck = () => boolean;

const SEALED_ERROR_TEXT =
  "session sealed; emission recorded. The loop will end this session; further tool calls are blocked. (§12.1, Task 15.5)";

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Wrap a single `ToolDefinition` so it short-circuits to an error
 * result when `sealCheck()` returns true.
 *
 * The wrapped tool preserves all metadata (`name`, `label`,
 * `description`, `parameters`, `renderCall`, `renderResult`,
 * `promptSnippet`, `promptGuidelines`, `executionMode`,
 * `prepareArguments`); only `execute` is replaced with a function
 * that consults `sealCheck` before delegating to the original.
 *
 * `sealCheck` is called each time the tool is invoked. A typical
 * implementation closes over the `SessionSeam`:
 *
 *   wrapToolWithSeal(bash, () => seam.isSealed)
 *
 * `execute` returns `terminate: true` so the agent stops calling
 * further tools after being sealed.
 */
export function wrapToolWithSeal(
  // biome-ignore lint/suspicious/noExplicitAny: ToolDefinition is generic; the SDK erases generics at the customTools[] boundary (matching the Model<any> pattern in src/host/host.ts). See module-level JSDoc.
  tool: ToolDefinition<any, any, any>,
  sealCheck: SealCheck,
  // biome-ignore lint/suspicious/noExplicitAny: see above.
): ToolDefinition<any, any, any> {
  // Capture the original execute. Type-erased because the SDK erases
  // generics at the customTools[] boundary; preserving TParams/TDetails
  // through the wrapper isn't worth the type gymnastics for a single
  // forward call.
  const originalExecute = tool.execute as (
    toolCallId: string,
    // biome-ignore lint/suspicious/noExplicitAny: see wrapToolWithSeal signature.
    params: any,
    signal: AbortSignal | undefined,
    // biome-ignore lint/suspicious/noExplicitAny: see wrapToolWithSeal signature.
    onUpdate: any,
    // biome-ignore lint/suspicious/noExplicitAny: see wrapToolWithSeal signature.
    ctx: any,
  ) => Promise<unknown>;

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (sealCheck()) {
        return {
          content: [{ type: "text", text: SEALED_ERROR_TEXT }],
          details: { sealed: true },
          terminate: true,
        };
      }
      return originalExecute.call(tool, toolCallId, params, signal, onUpdate, ctx);
    },
    // biome-ignore lint/suspicious/noExplicitAny: see above.
  } as ToolDefinition<any, any, any>;
}

/**
 * Wrap a list of tools with sealing. Used at session construction
 * time so the agent only ever sees wrapped built-ins + custom tools.
 *
 * `handoff` and `end` should NOT be in this list — they don't
 * execute side effects. The SDK-backed Host (Task 15's sibling)
 * builds those via the Task 14 factories and registers them
 * unwrapped so the `extra_emission` marker path (Task 14) still
 * works — the wrappers below only block side-effecting tools.
 */
export function wrapAllToolsWithSeal(
  // biome-ignore lint/suspicious/noExplicitAny: see wrapToolWithSeal.
  tools: readonly ToolDefinition<any, any, any>[],
  sealCheck: SealCheck,
  // biome-ignore lint/suspicious/noExplicitAny: see above.
): ToolDefinition<any, any, any>[] {
  return tools.map((t) => wrapToolWithSeal(t, sealCheck));
}
