/** Installed SDK transform/count policy for the evidenced executor API (Prewalk §R2, §R6). */
import type { Api, Model } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { runPrewalkTransformPreflight } from "./prewalk-preflight.js";
import type { PrewalkPhaseSession } from "./prewalk-role-session.js";

/** Measure the executor-transformed transcript; guide usage is an integrity sentinel only. */
export function runProductionPreflight(
  session: Pick<PrewalkPhaseSession, "preflightContext">,
  model: Model<Api>,
  activeToolNames: readonly string[],
) {
  const context = session.preflightContext?.();
  if (context === undefined || context.hasCompaction || context.contextTokens == null) {
    throw Object.assign(new Error("Prewalk guide context is unavailable or compacted"), {
      code: "prewalk_context_unknown",
    });
  }
  if (model.api !== "openai-completions") {
    throw Object.assign(new Error(`Prewalk has no route-scoped ID policy for API '${model.api}'`), {
      code: "prewalk_transform_unsupported",
    });
  }
  const result = runPrewalkTransformPreflight({
    messages: context.messages,
    executor: {
      model,
      normalizeToolCallId: (id) => normalizeOpenAiCompletionId(id, model),
      isToolCallIdValid: (id) => id.length > 0,
    },
    activeToolNames,
    inertToolNames: ["execution_checkpoint"],
    transcriptBudgetTokens: Number.MAX_SAFE_INTEGER,
    countTokens: (messages) => messages.reduce((sum, message) => sum + estimateTokens(message), 0),
  });
  // The live native session reruns the SDK transform, not this dry-run's extra
  // conductor drops. Reject rather than authorize a different transcript; auto
  // and projection fallback can safely use the deterministic projected seed.
  if (!result.summary.repairs.some((repair) => repair.startsWith("drop_"))) return result;
  return {
    ...result,
    summary: {
      ...result.summary,
      ok: false,
      rejections: [...result.summary.rejections, "native_replay_repairs_unavailable"],
    },
  };
}

function normalizeOpenAiCompletionId(id: string, model: Model<Api>): string {
  if (id.includes("|")) {
    return (id.split("|")[0] ?? "").replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 40);
  }
  return model.provider === "openai" ? id.slice(0, 40) : id;
}
