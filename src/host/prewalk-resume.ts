/** Durable Prewalk recovery selection and executor-only resume (spec §R12 / Slice 7). */

import { createHash } from "node:crypto";
import type { Role, UsageRecord } from "../core/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import type {
  PrewalkExecutorSeedDeliveredRecord,
  PrewalkExecutorSeedIntentRecord,
  PrewalkRecord,
  PrewalkSwitchSelectedRecord,
} from "../persistence/prewalk-records.js";
import type { RoleSession } from "./host.js";
import {
  persistPrewalkExecutorUsage,
  startPrewalkExecutorCaps,
} from "./prewalk-executor-lifecycle.js";
import type { PrewalkExecutorEnvironment, PrewalkPhaseSession } from "./prewalk-role-session.js";
import { PrewalkRoleSessionError } from "./prewalk-role-session-errors.js";
import { persistPrewalkFailure } from "./prewalk-role-session-failure.js";
import {
  assertPrewalkExecutorEnvironment,
  hashPrewalkExecutorEnvironment,
} from "./prewalk-role-session-records.js";
import {
  hasDurablePrewalkSeed,
  preparePrewalkSeedDelivery,
  recordPrewalkSeedDelivered,
} from "./prewalk-seed-delivery.js";
import type { PrewalkValidationGate } from "./prewalk-validation.js";

const RESUME_PROMPT = [
  "[prewalk-resume]",
  "The persisted executor continuation seed was already delivered before the process stopped.",
  "Resume the executor phase from the durable conversation. Re-read the authoritative task and repository instructions, verify the recorded checklist, then emit the appropriate machine event.",
  "[/prewalk-resume]",
].join("\n");

/** Validated durable selector for an executor phase interrupted after switch selection. */
export interface PrewalkRecovery {
  readonly selected: PrewalkSwitchSelectedRecord;
  readonly seedDelivered: PrewalkExecutorSeedDeliveredRecord | null;
  readonly seedIntent?: PrewalkExecutorSeedIntentRecord | null;
}

/** Find the latest still-active Prewalk switch and reject ambiguous replay state. */
export function inspectPrewalkRecovery(
  records: readonly PersistedRecord[],
  runId: string,
  role: Role,
): PrewalkRecovery | null {
  let selectedIndex = -1;
  let selected: PrewalkSwitchSelectedRecord | null = null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record?.type === "prewalk_switch_selected" &&
      record.run_id === runId &&
      record.role === role
    ) {
      selectedIndex = index;
      selected = record;
      break;
    }
  }
  if (selected === null) return null;

  const later = records.slice(selectedIndex + 1);
  if (
    later.some(
      (record) =>
        record.type === "transition_accepted" && record.run_id === runId && record.role === role,
    )
  ) {
    return null;
  }
  const priorFailure = later.find(
    (record) =>
      record.type === "prewalk_switch_failed" &&
      record.run_id === runId &&
      record.role_session_id === selected?.role_session_id &&
      record.code !== "prewalk_validation_unsatisfied",
  );
  if (priorFailure?.type === "prewalk_switch_failed") {
    throw invalidResume(
      priorFailure.code === "prewalk_resume_invalid"
        ? priorFailure.message
        : `persisted switch already failed with ${priorFailure.code}`,
    );
  }

  assertSelectedEnvironmentHash(selected);
  const deliveries = later.filter(
    (record): record is PrewalkExecutorSeedDeliveredRecord =>
      record.type === "prewalk_executor_seed_delivered" &&
      record.run_id === runId &&
      record.role_session_id === selected?.role_session_id,
  );
  if (deliveries.length > 1) {
    throw invalidResume("multiple executor seed-delivery markers make replay ambiguous");
  }
  const delivery = deliveries[0] ?? null;
  if (delivery !== null) {
    const expectedSeedHash = sha256(selected.executor.continuation_seed);
    if (delivery.continuation_seed_sha256 !== expectedSeedHash) {
      throw invalidResume("executor seed-delivery marker does not match the persisted seed");
    }
    if (
      selected.transfer_mode === "native" &&
      delivery.conversation_id !== selected.executor.conversation?.id
    ) {
      throw invalidResume("native executor seed-delivery marker targets another conversation");
    }
  }
  const intents = later.filter(
    (record): record is PrewalkExecutorSeedIntentRecord =>
      record.type === "prewalk_executor_seed_intent" &&
      record.run_id === runId &&
      record.role_session_id === selected?.role_session_id,
  );
  if (intents.length > 1)
    throw invalidResume("multiple executor seed intents make replay ambiguous");
  const intent = intents[0] ?? null;
  if (
    intent !== null &&
    (intent.continuation_seed_sha256 !== sha256(selected.executor.continuation_seed) ||
      (delivery !== null && intent.conversation.id !== delivery.conversation_id) ||
      (selected.transfer_mode === "native" &&
        intent.conversation.id !== selected.executor.conversation?.id))
  )
    throw invalidResume("seed intent does not match the persisted selection or delivery");
  return Object.freeze({ selected, seedDelivered: delivery, seedIntent: intent });
}

/** Restore the exact persisted environment and expose an idempotent executor-only RoleSession. */
export async function createPrewalkResumeRoleSession(options: {
  readonly recovery: PrewalkRecovery;
  readonly executor: PrewalkPhaseSession;
  /** Outer conductor invocation identity retained across physical projection sessions. */
  readonly logicalRoleSessionId?: string;
  readonly environment: PrewalkExecutorEnvironment;
  readonly persist: (record: PrewalkRecord) => void;
  readonly validationGate?: PrewalkValidationGate;
  readonly executorLimits?: { readonly maxTurns: number; readonly maxWallClockMs: number };
  readonly sessionUsage?: (sessionId: string) => UsageRecord;
  readonly markTerminalFailure?: (
    sessionId: string,
    code: "prewalk_executor_turn_cap_exceeded" | "prewalk_executor_wall_clock_exceeded",
    message: string,
  ) => void;
  readonly now?: () => number;
}): Promise<RoleSession> {
  const { selected, seedDelivered } = options.recovery;
  try {
    assertEnvironmentMatchesSelection(options.environment, selected);
    const intent = options.recovery.seedIntent;
    if (
      intent != null &&
      (intent.conversation.id !== options.executor.conversationId ||
        intent.conversation.file !== options.executor.sessionFile)
    ) {
      throw invalidResume("resumed executor conversation does not match its delivery intent");
    }
    if (
      seedDelivered !== null &&
      options.executor.conversationId !== seedDelivered.conversation_id
    ) {
      throw invalidResume("resumed executor conversation does not match its delivery marker");
    }
    if (
      seedDelivered === null &&
      selected.transfer_mode === "native" &&
      options.executor.conversationId !== selected.executor.conversation?.id
    ) {
      throw invalidResume(
        "resumed native executor conversation does not match its switch selector",
      );
    }
    await options.executor.applyEnvironment(options.environment);
    assertPrewalkExecutorEnvironment(
      options.executor.snapshot(),
      options.environment,
      selected.executor.environment_sha256,
    );
  } catch (error) {
    const typed = invalidResume(
      error instanceof Error
        ? error.message
        : "persisted executor environment could not be restored",
      error,
    );
    persistResumeInvalid(options, typed.message);
    throw typed;
  }

  let firstPrompt = true;
  return {
    role: options.executor.role,
    sessionId: options.logicalRoleSessionId ?? options.executor.sessionId,
    get conversationId() {
      return options.executor.conversationId;
    },
    sessionFile: options.executor.sessionFile,
    get model() {
      return options.executor.snapshot().model;
    },
    get effort() {
      return options.executor.snapshot().effort;
    },
    retries: options.executor.retries ?? 0,
    retryDelayMs: options.executor.retryDelayMs ?? 0,
    readCaptureBuffer: () => options.executor.readCaptureBuffer(),
    resetCaptureBuffer: () => options.executor.resetCaptureBuffer(),
    takeHandoffValidationFailures: () => options.executor.takeHandoffValidationFailures?.() ?? [],
    subscribe: (listener) => options.executor.subscribe(listener),
    steer: (text) => options.executor.steer?.(text) ?? Promise.resolve(),
    clearQueue: () => options.executor.clearQueue?.() ?? { steering: [], followUp: [] },
    isSealed: () => options.executor.isSealed?.() ?? false,
    subscribeSealed: (listener) =>
      options.executor.subscribeSealed?.(listener) ?? (() => undefined),
    abortOwnedWork: async () => {
      options.validationGate?.close();
      await options.validationGate?.settle();
    },
    prompt: async (text) => {
      if (!firstPrompt) return options.executor.prompt(text);
      firstPrompt = false;
      return runResumedExecutorPrompt(options);
    },
    dispose: async () => {
      options.validationGate?.close();
      await options.validationGate?.settle();
      await options.executor.dispose();
    },
  };
}

async function runResumedExecutorPrompt(
  options: Parameters<typeof createPrewalkResumeRoleSession>[0],
): Promise<void> {
  const selected = options.recovery.selected;
  const cap =
    options.executorLimits === undefined
      ? null
      : startPrewalkExecutorCaps({
          executor: options.executor,
          limits: options.executorLimits,
          onExceeded: (code, message) => {
            persistPrewalkFailure(
              {
                runId: selected.run_id,
                roleSessionId: selected.role_session_id,
                persist: options.persist,
                guideUsage: () => selected.guide_usage,
                ...(options.now !== undefined ? { now: options.now } : {}),
              },
              {
                baseSha: selected.git_checkpoint.base_sha,
                exemplarSha: selected.git_checkpoint.exemplar_sha,
                code,
                message,
                guideUsage: selected.guide_usage,
              },
            );
            options.markTerminalFailure?.(options.executor.sessionId, code, message);
          },
        });
  let promptError: unknown = null;
  try {
    const seed = selected.executor.continuation_seed;
    const persistedIntent = options.recovery.seedIntent ?? null;
    const seedWasDelivered = hasDurablePrewalkSeed(options.executor, seed, persistedIntent);
    // Old markers were written before SDK acceptance. Reconcile history even for those records.
    const intent =
      persistedIntent ??
      preparePrewalkSeedDelivery({
        executor: options.executor,
        seed,
        runId: selected.run_id,
        roleSessionId: selected.role_session_id,
        ...(seedWasDelivered ? { afterEntryId: null } : {}),
        persist: options.persist,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
    if (seedWasDelivered && options.recovery.seedDelivered === null) {
      recordPrewalkSeedDelivered({
        executor: options.executor,
        seed,
        intent,
        persist: options.persist,
      });
    }
    await options.executor.prompt(seedWasDelivered ? RESUME_PROMPT : seed);
    if (!seedWasDelivered && options.recovery.seedDelivered === null) {
      recordPrewalkSeedDelivered({
        executor: options.executor,
        seed,
        intent,
        persist: options.persist,
      });
    }
  } catch (error) {
    promptError = error;
  } finally {
    cap?.stop();
    if (promptError !== null || (cap?.code ?? null) !== null) options.validationGate?.close();
    await options.validationGate?.ensureRecorded();
    persistPrewalkExecutorUsage({
      runId: selected.run_id,
      roleSessionId: selected.role_session_id,
      // A resumed host's live SessionState starts at zero even when the reopened
      // native conversation contains guide history; do not subtract durable guide usage twice.
      guideSessionId: "<persisted-guide-usage>",
      executor: options.executor,
      guideUsage: selected.guide_usage,
      turns: cap?.turns ?? 0,
      ts: (options.now ?? Date.now)(),
      ...(options.sessionUsage !== undefined ? { sessionUsage: options.sessionUsage } : {}),
      persist: options.persist,
    });
  }
  if (promptError !== null && (cap === null || cap.code === null)) throw promptError;
}

function assertSelectedEnvironmentHash(selected: PrewalkSwitchSelectedRecord): void {
  const actual = hashPrewalkExecutorEnvironment(environmentFrom(selected));
  if (actual !== selected.executor.environment_sha256) {
    throw invalidResume("persisted executor environment hash does not match its contents");
  }
}

function assertEnvironmentMatchesSelection(
  environment: PrewalkExecutorEnvironment,
  selected: PrewalkSwitchSelectedRecord,
): void {
  const persisted = environmentFrom(selected);
  if (
    hashPrewalkExecutorEnvironment(environment) !== selected.executor.environment_sha256 ||
    environment.provider !== selected.executor.provider ||
    environment.api !== selected.executor.api ||
    JSON.stringify(environment.activeToolNames) !== JSON.stringify(persisted.activeToolNames)
  ) {
    throw invalidResume("resolved executor environment differs from the persisted selection");
  }
}

/** Reconstruct only persisted fields; callers attach the runtime SDK model after resolution. */
export function environmentFrom(selected: PrewalkSwitchSelectedRecord): PrewalkExecutorEnvironment {
  return {
    model: selected.executor.model,
    effort: selected.executor.effort,
    provider: selected.executor.provider,
    api: selected.executor.api,
    systemPrompt: selected.executor.system_prompt,
    activeToolNames: [...selected.executor.active_tool_names],
    continuationSeed: selected.executor.continuation_seed,
  };
}

function persistResumeInvalid(
  options: Parameters<typeof createPrewalkResumeRoleSession>[0],
  message: string,
): void {
  const selected = options.recovery.selected;
  options.persist({
    type: "prewalk_switch_failed",
    schema_version: 1,
    run_id: selected.run_id,
    role_session_id: selected.role_session_id,
    code: "prewalk_resume_invalid",
    message,
    guide_usage: selected.guide_usage,
    git_checkpoint: selected.git_checkpoint,
    ts: (options.now ?? Date.now)(),
  });
}

function invalidResume(message: string, cause?: unknown): PrewalkRoleSessionError {
  return new PrewalkRoleSessionError(
    "prewalk_resume_invalid",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
