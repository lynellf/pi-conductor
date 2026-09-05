/** Production Pi SDK adapter for one physical phase of a logical Prewalk session. */

import type { Message, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PrewalkExecutorEnvironment, PrewalkPhaseSession } from "./prewalk-role-session.js";
import type { RoleSessionAdapter } from "./role-session.js";

/** Add the exact mutable SDK environment needed by the Prewalk composite driver. */
export function createPrewalkPhaseSessionAdapter(opts: {
  readonly adapter: RoleSessionAdapter;
  readonly session: AgentSession;
  readonly initialLogicalModel: string;
  readonly getSystemPrompt: () => string;
  readonly setSystemPrompt: (prompt: string) => void;
  readonly resolveModel: (logical: string) => Model<never>;
  readonly setExecutorPhase: () => void;
}): PrewalkPhaseSession {
  let logicalModel = opts.initialLogicalModel;
  return {
    ...opts.adapter,
    conversationId: opts.session.sessionId,
    snapshot: () => {
      const boundary = checkpointBoundary(opts.session.messages);
      return {
        isIdle: opts.session.isIdle,
        autoCompactionEnabled: opts.session.autoCompactionEnabled,
        checkpointResultDurable: boundary.durable,
        sideEffectAfterCheckpoint: boundary.unsafe,
        model: logicalModel,
        effort: opts.session.thinkingLevel,
        provider: opts.session.model?.provider ?? "",
        api: opts.session.model?.api ?? "",
        systemPrompt: opts.getSystemPrompt(),
        activeToolNames: opts.session.getActiveToolNames(),
      };
    },
    applyEnvironment: async (environment: PrewalkExecutorEnvironment) => {
      if (!opts.session.isIdle)
        throw new Error("Prewalk environment apply requires an idle session");
      opts.setSystemPrompt(environment.systemPrompt);
      await opts.session.setModel(
        environment.resolvedModel ?? opts.resolveModel(environment.model),
      );
      opts.session.setThinkingLevel(environment.effort);
      opts.session.setActiveToolsByName([...environment.activeToolNames]);
      logicalModel = environment.model;
      opts.setExecutorPhase();
    },
    enableGuideMachineTools: async (activeToolNames) => {
      if (!opts.session.isIdle) throw new Error("Prewalk tool restore requires an idle session");
      opts.session.setActiveToolsByName([...activeToolNames]);
    },
    preflightContext: () => ({
      messages: opts.session.messages.filter(isProviderMessage) as Message[],
      registeredTools: opts.session.getAllTools(),
      contextTokens: opts.session.getContextUsage()?.tokens,
      hasCompaction: opts.session.sessionManager
        .buildContextEntries()
        .some((entry) => entry.type === "compaction"),
    }),
  };
}

function checkpointBoundary(messages: readonly unknown[]): { durable: boolean; unsafe: boolean } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!recordWithRole(message, "assistant") || !Array.isArray(message.content)) continue;
    const calls = message.content.filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "toolCall" && typeof part.name === "string",
    );
    const checkpoint = calls.find((part) => part.name === "execution_checkpoint");
    if (checkpoint === undefined || typeof checkpoint.id !== "string") continue;
    const resultIndex = messages.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index &&
        recordWithRole(candidate, "toolResult") &&
        candidate.toolCallId === checkpoint.id,
    );
    const durable = resultIndex >= 0;
    const unsafe =
      calls.length !== 1 ||
      !durable ||
      messages
        .slice(resultIndex + 1)
        .some(
          (candidate) =>
            recordWithRole(candidate, "assistant") || recordWithRole(candidate, "toolResult"),
        );
    return { durable, unsafe };
  }
  return { durable: false, unsafe: false };
}

function isProviderMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.role === "user" || value.role === "assistant" || value.role === "toolResult")
  );
}

function recordWithRole(value: unknown, role: string): value is Record<string, unknown> {
  return isRecord(value) && value.role === role;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
