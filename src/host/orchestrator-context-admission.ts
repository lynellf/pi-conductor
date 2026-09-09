import { type AgentSession, estimateTokens, shouldCompact } from "@earendil-works/pi-coding-agent";
import type { CompactionSettingsSnapshot } from "./orchestrator-context-settings.js";

/** Admit a new seed against the current model window, compacting through public SDK APIs. */
export async function admitOrchestratorPrompt(
  session: AgentSession,
  text: string,
  settings: CompactionSettingsSnapshot,
): Promise<void> {
  const model = session.model;
  if (model === undefined || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
    throw new Error("retained context cannot estimate the active model context window");
  }
  if (
    !Number.isFinite(settings.reserveTokens) ||
    settings.reserveTokens < 0 ||
    model.contextWindow - settings.reserveTokens <= 0
  ) {
    throw new Error("retained context has no active model context budget");
  }
  const pendingTokens = estimateTokens({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
  const observed = session.getContextUsage()?.tokens;
  const current =
    observed !== null && observed !== undefined && Number.isFinite(observed) && observed >= 0
      ? observed
      : estimateCurrentAuthority(session);
  const projected = current + pendingTokens;
  const limit = model.contextWindow - settings.reserveTokens;
  if (!shouldCompact(projected, model.contextWindow, settings)) {
    if (projected > limit) {
      throw new Error("retained context seed exceeds the active model context budget");
    }
    return;
  }
  if (!settings.enabled) {
    throw new Error("retained context requires compaction, but compaction is disabled");
  }
  await session.compact();
  const after = estimateCurrentAuthority(session) + pendingTokens;
  if (after > limit) {
    throw new Error("retained context remains too large after compaction");
  }
}

function estimateCurrentAuthority(session: AgentSession): number {
  const history = session.messages.reduce((total, message) => total + estimateTokens(message), 0);
  const systemPrompt = estimateTokens({
    role: "user",
    content: session.systemPrompt,
    timestamp: 0,
  });
  const activeTools = new Set(session.getActiveToolNames());
  const tools = session
    .getAllTools()
    .filter((tool) => activeTools.has(tool.name))
    .reduce(
      (total, tool) =>
        total +
        estimateTokens({
          role: "user",
          content: JSON.stringify(tool),
          timestamp: 0,
        }),
      0,
    );
  return history + systemPrompt + tools;
}
