/**
 * Stub provider — spec §15.3, plan Task 16.
 *
 * A deterministic `StreamFunction` + `Model` pair that drives a real
 * `createAgentSession` end-to-end without a network or API key.
 * Replaces the manual-run surface with CI-runnable assertions on
 * the §11.4 usage mapping and the §11.2–§11.5 persisted record
 * shapes. Phase 5 (cost + observability) builds on the `usage`
 * capture here.
 *
 * ## Pinned SDK contract (do not change without re-running Tests 1 + 2)
 *
 * The contract for `createAgentSession({ model: stubModel })` was
 * pinned against `@earendil-works/pi-ai/dist/types.d.ts` and
 * `@earendil-works/pi-ai/dist/utils/event-stream.d.ts` (Task 13's
 * pre-flight, re-verified during Task 16). The stub must satisfy:
 *
 *  - `Model<TApi extends Api>` is data: `id`, `name`, `api`,
 *    `provider`, `baseUrl`, `reasoning`, `input`, `cost`,
 *    `contextWindow`, `maxTokens`. Streaming behavior is NOT on
 *    the model.
 *  - `Provider.stream` (a `StreamFunction`) returns an
 *    `AssistantMessageEventStream` — a class implementing
 *    `AsyncIterable<AssistantMessageEvent>` with `push()`,
 *    `end()`, and `result()`.
 *  - The event protocol (from `AssistantMessageEvent`):
 *      `start` | `text_*` | `thinking_*` | `toolcall_*` |
 *      `done { reason: "stop"|"length"|"toolUse", message }` |
 *      `error { reason: "aborted"|"error", error: AssistantMessage }`.
 *  - `Usage` shape (camelCase + nested `cost.total` +
 *    `totalTokens`) is the source for the §11.4 normalized record
 *    via `message.usage` on the `message_end` event.
 *
 * `ModelRegistry.registerProvider(providerName, { streamSimple,
 *  models: [] })` registers the stub's `streamSimple` so the
 * agent runtime resolves `model.provider === "stub"` to our
 * stream function — no model file on disk, no auth, no network.
 *
 * If a future SDK upgrade changes the event protocol or the
 * AssistantMessageEventStream class shape, the E2E tests in
 * `tests/host/e2e.test.ts` will fail FIRST (Task 16's gating
 * requirement) — they pin the contract end-to-end.
 *
 * ## Script semantics
 *
 * Each call to the `StreamFunction` consumes ONE step from the
 * script. The agent runtime calls `stream()` once per turn
 * (one turn = one assistant response + zero-or-more tool calls).
 * A multi-step script drives a multi-turn role session.
 *
 * The script is consumed in order. Past the last step, additional
 * calls produce `done { reason: "stop" }` (no further action).
 * Tests size the script to match the run topology.
 *
 * ## Why the stub is host-owned
 *
 * The stub lives in `src/host/` (not in `src/core/` or
 * `src/manifest/`) because it is the load-bearing assumption for
 * ALL host E2E tests in Phases 4 and 5. Only `src/host/` may
 * import the pi SDK packages — grep-guard enforces this.
 */

import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type StreamFunction,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";

// ─── Scripted emissions ─────────────────────────────────────────────────

/**
 * One scripted step the stub produces on the next stream() call.
 *
 * Tool calls use the SAME TypeBox schemas as Task 14's
 * `handoff`/`end` factories. The stub emits the tool call event;
 * the SDK agent runtime routes it to the registered tool's
 * `execute`, which is Task 14's wrapper writing to the
 * `SessionSeam` capture buffer.
 */
export type StubStep =
  | {
      readonly kind: "emit_handoff";
      readonly target_role: string;
      readonly reason?: string;
      readonly suggests_next?: string;
    }
  | { readonly kind: "emit_end"; readonly reason?: string }
  | { readonly kind: "emit_text"; readonly text: string }
  | { readonly kind: "no_emission" }
  | { readonly kind: "fail"; readonly errorMessage: string };

export interface StubStreamOptions {
  /** Per-turn scripted emissions. Consumed in order; past the last
   *  step, additional stream() calls produce a stop-only message. */
  readonly steps: readonly StubStep[];
  /** Canned usage applied to every emitted message. Defaults to
   *  zeros. Field shape matches `Usage` (camelCase + nested `cost`),
   *  which is the §11.4 SDK mapping source. */
  readonly usage?: Partial<Usage>;
}

/** A single-tool-call record the stub pushes through the event protocol. */
interface ScriptedToolCall {
  readonly name: "handoff" | "end";
  readonly arguments: Record<string, unknown>;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Build a stub `Model<any>` for use with `createAgentSession`. The
 * model carries data only; streaming behavior lives on the
 * Provider (registered separately via `ModelRegistry.registerProvider`).
 *
 * `api` is set to `"anthropic-messages"` so the model matches a
 * known `Api` discriminator; the stub provider ignores `api`
 * entirely.
 */
// biome-ignore lint/suspicious/noExplicitAny: pi-coding-agent's CreateAgentSessionOptions.model is Model<any>; matching the SDK convention (same pattern as src/host/host.ts SpawnRoleOptions).
export function makeStubModel(): Model<any> {
  return {
    id: "stub-model",
    name: "Stub Model (deterministic, no network)",
    api: "anthropic-messages" as const,
    provider: "stub",
    baseUrl: "stub://no-network",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

/**
 * Build a stub `StreamFunction`. Each call consumes one step from
 * the script and pushes the corresponding `AssistantMessageEvent`
 * sequence onto a fresh `AssistantMessageEventStream`.
 *
 * Returns a `StreamFunction` compatible with
 * `ModelRegistry.registerProvider("stub", { streamSimple: ... })`.
 *
 * The stub pushes events SYNCHRONOUSLY before returning. The agent
 * runtime's async iterator drains the queued events; `stream.end()`
 * signals completion; `stream.result()` resolves with the final
 * `AssistantMessage` (Task 17 reads `usage` from there).
 */
export function makeStubStreamFunction(opts: StubStreamOptions): StreamFunction {
  const { steps, usage: cannedUsage } = opts;
  let stepIndex = 0;

  return (_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();

    const usage: Usage = {
      input: cannedUsage?.input ?? 0,
      output: cannedUsage?.output ?? 0,
      cacheRead: cannedUsage?.cacheRead ?? 0,
      cacheWrite: cannedUsage?.cacheWrite ?? 0,
      totalTokens:
        cannedUsage?.totalTokens ?? (cannedUsage?.input ?? 0) + (cannedUsage?.output ?? 0),
      cost: cannedUsage?.cost ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };

    const step = steps[stepIndex];
    if (step !== undefined) stepIndex += 1;
    const finalMessage: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "stub",
      model: "stub-model",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    };

    if (step === undefined || step.kind === "no_emission") {
      // Past the script or an explicit no-emission: empty content,
      // stop. The agent runtime sees no tool calls; the role
      // session ends with no machine-event → Task 14's buffer
      // is empty → validateEmission → no_emission.
      stream.push({ type: "start", partial: finalMessage });
      stream.push({ type: "done", reason: "stop", message: finalMessage });
      stream.end();
      return stream;
    }

    if (step.kind === "fail") {
      finalMessage.stopReason = "error";
      finalMessage.errorMessage = step.errorMessage;
      stream.push({ type: "start", partial: finalMessage });
      stream.push({ type: "error", reason: "error", error: finalMessage });
      stream.end();
      return stream;
    }

    if (step.kind === "emit_text") {
      finalMessage.content.push({ type: "text", text: step.text });
      stream.push({ type: "start", partial: finalMessage });
      stream.push({ type: "text_start", contentIndex: 0, partial: finalMessage });
      stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: finalMessage });
      stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: finalMessage });
      stream.push({ type: "done", reason: "stop", message: finalMessage });
      stream.end();
      return stream;
    }

    // emit_handoff or emit_end: emit a single tool call event sequence.
    const tc: ScriptedToolCall =
      step.kind === "emit_handoff"
        ? {
            name: "handoff",
            arguments: {
              target_role: step.target_role,
              ...(step.reason !== undefined && { reason: step.reason }),
              ...(step.suggests_next !== undefined && { suggests_next: step.suggests_next }),
            },
          }
        : {
            name: "end",
            arguments: step.reason !== undefined ? { reason: step.reason } : {},
          };

    const argsStr = JSON.stringify(tc.arguments);
    const toolCall: ToolCall = {
      type: "toolCall",
      id: `tc-${stepIndex}`,
      name: tc.name,
      arguments: tc.arguments,
    };

    stream.push({ type: "start", partial: finalMessage });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: finalMessage });
    finalMessage.content.push(toolCall);
    stream.push({ type: "toolcall_delta", contentIndex: 0, delta: argsStr, partial: finalMessage });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: finalMessage });
    finalMessage.stopReason = "toolUse";
    stream.push({ type: "done", reason: "toolUse", message: finalMessage });
    stream.end();
    return stream;
  };
}
