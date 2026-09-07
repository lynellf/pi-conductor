/** Production guide turn/budget controller and recoverable failure handling (§R6, §R8, §R11). */
import type { PrewalkFailureCode } from "../persistence/prewalk-records.js";
import { evaluatePrewalkGuideBudget, evaluatePrewalkGuideCaps } from "./prewalk-budget.js";
import type { PrewalkGitBase } from "./prewalk-git-checkpoint.js";
import type { CreatePrewalkRoleSessionOptions } from "./prewalk-role-session.js";
import { normalizePrewalkRoleSessionFailure } from "./prewalk-role-session-errors.js";
import { failPrewalkRoleSession } from "./prewalk-role-session-failure.js";

/** Runtime executor-targeted measurement; the budget already reserves its safety margin. */
export interface PrewalkGuideControl {
  readonly maxTurns: number;
  readonly maxCostUsd: number;
  readonly budgetTokens: number;
  readonly measureTokens: () => number;
}

/** Drive exactly the guide phase; no queued guide steer survives the switch. */
export async function runPrewalkGuide(
  options: CreatePrewalkRoleSessionOptions,
  seed: string,
  base: PrewalkGitBase,
): Promise<{ readonly forceProjection: boolean; readonly turns: number }> {
  const control = options.guideControl;
  let turns = 0;
  let forceProjection = false;
  let failure: { code: PrewalkFailureCode; message: string } | null = null;
  let warningState = { warningIssued: false };
  const pending: Promise<void>[] = [];
  const noteFailure = (error: unknown) => {
    const typed = normalizePrewalkRoleSessionFailure(error);
    failure ??= { code: typed.code, message: typed.message };
  };
  const abort = () => pending.push(options.guide.abort().catch(noteFailure));
  const unsubscribe = options.guide.subscribe((event) => {
    if (event.type !== "turn_end" || failure !== null || forceProjection) return;
    turns += 1;
    if (control === undefined) return;
    try {
      const cap = evaluatePrewalkGuideCaps({
        guideUsage: options.guideUsage(),
        guideMaxCostUsd: control.maxCostUsd,
        completedGuideTurns: turns,
        guideMaxTurns: control.maxTurns,
      });
      if (cap.type === "fail") {
        failure = {
          code: cap.code,
          message: `guide reached its ${cap.code === "prewalk_guide_cost_cap_exceeded" ? "cost" : "turn"} limit`,
        };
        abort();
        return;
      }
      const decision = evaluatePrewalkGuideBudget({
        budgetTokens: control.budgetTokens,
        consumedTokens: control.measureTokens(),
        state: warningState,
      });
      warningState = decision.state;
      if (decision.action.type === "converge") {
        if (options.guide.steer === undefined)
          throw new Error("Prewalk guide cannot accept convergence steering");
        pending.push(
          options.guide.steer(decision.action.message).catch((error) => {
            noteFailure(error);
            abort();
          }),
        );
      } else if (decision.action.type === "force_projection") {
        forceProjection = true;
        abort();
      }
    } catch (error) {
      noteFailure(error);
      abort();
    }
  });
  let promptError: unknown = null;
  try {
    await options.guide.prompt(seed);
  } catch (error) {
    promptError = error;
  } finally {
    unsubscribe();
    // Abort/steer are async SDK operations; surface their failures rather than leaking rejections.
    for (let index = 0; index < pending.length; index += 1) await pending[index];
    options.guide.clearQueue?.();
  }
  if (failure === null && promptError !== null && !forceProjection) throw promptError;
  if (failure === null && forceProjection && options.seam.read() === null) {
    failure = {
      code: "prewalk_checkpoint_missing",
      message:
        "guide exhausted its transcript budget before recording a valid checklist; exemplar preserved",
    };
  }
  if (failure !== null) {
    const failed: { code: PrewalkFailureCode; message: string } = failure;
    let exemplarSha: string | null = null;
    try {
      exemplarSha = (await options.createGitCheckpoint(base)).exemplar_sha;
    } catch (error) {
      failed.message += `; exemplar checkpoint failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    options.markTerminalFailure?.(options.guide.sessionId, failed.code, failed.message);
    return failPrewalkRoleSession(options, { baseSha: base.base_sha, exemplarSha, ...failed });
  }
  return { forceProjection, turns: control === undefined ? options.guideTurns() : turns };
}
