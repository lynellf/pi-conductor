/** Run-scoped, best-effort issue #154 advisory persistence; never an authority input. */

import { createHash } from "node:crypto";
import type { DelegationAdvisoryPolicy, SubagentProfile } from "../../manifest/types.js";
import type {
  DelegationDispatchAdvisoryRecord,
  DelegationResultAdvisoryRecord,
} from "../../persistence/delegation-advisory-record.js";
import type { DelegationSubmissionAcceptedRecord } from "../../persistence/delegation-task.js";
import type { PersistedRecord } from "../../persistence/log.js";
import type {
  DelegationDispatchAdvisoryAnswers,
  DelegationResultAdvisoryAnswers,
} from "../../seam/delegation-advisory.js";
import type { PreparedDelegateChild } from "../delegation/admission.js";
import type { PoolChildResult } from "../delegation/pool.js";
import type { DelegationAdvisor, DelegationAdvisoryOutcome } from "./contracts.js";
import {
  buildDelegationDispatchAdvisoryState,
  buildDelegationResultAdvisoryState,
} from "./state.js";

// Bound active plus queued jobs; overflow is skipped without a request or record.
const MAX_PENDING_PER_PARALLEL = 4;

interface ShadowJob {
  readonly assess: () => Promise<DelegationAdvisoryOutcome>;
  readonly record: (outcome: DelegationAdvisoryOutcome) => PersistedRecord;
  readonly failureRecord: () => PersistedRecord | null;
  readonly done: Promise<void>;
  readonly finish: () => void;
  dropped: boolean;
}

/** Dependencies for one run's isolated advisory request queue. */
export interface DelegationAdvisoryShadowOptions {
  readonly advisor: DelegationAdvisor;
  readonly policy: DelegationAdvisoryPolicy;
  readonly runId: string;
  readonly persistRecord: (record: PersistedRecord) => void;
}

/**
 * Enqueue redacted advisory requests only after authoritative delegation records exist.
 * Nothing reads the records produced here; run close drains within the pinned budget.
 */
export class DelegationAdvisoryShadow {
  private readonly pending = new Set<ShadowJob>();
  private readonly queued: ShadowJob[] = [];
  private running = 0;
  private pumpScheduled = false;
  private accepting = true;
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly options: DelegationAdvisoryShadowOptions) {}

  /** Start one dispatch assessment after its submission-accepted record was appended. */
  dispatchAccepted(
    accepted: DelegationSubmissionAcceptedRecord,
    task: PreparedDelegateChild,
    allowedProfiles: readonly SubagentProfile[],
  ): void {
    if (!this.accepting) return;
    let inputSha256: string | undefined;
    let profileFit:
      | ReturnType<typeof buildDelegationDispatchAdvisoryState>["profile_fit"]
      | undefined;
    const record = (outcome: DelegationAdvisoryOutcome): PersistedRecord => {
      if (inputSha256 === undefined || profileFit === undefined)
        throw new Error("delegation dispatch advisory request was not prepared");
      return dispatchRecord(
        accepted,
        task,
        this.options.policy.model,
        inputSha256,
        profileFit,
        outcome,
      );
    };
    this.enqueue(
      () => {
        const state = buildDelegationDispatchAdvisoryState({
          task: {
            objective: task.objective,
            expected_output: task.expectedOutput,
            subagent: task.profile.name,
            tools: task.effectiveTools ?? [],
            projection_paths: new Array<string>(task.projectionFingerprint.path_count),
            context_artifacts: new Array<unknown>(task.contextArtifacts.length),
            ...(task.verificationRecipe === undefined
              ? {}
              : { verification_recipe: task.verificationRecipe.name }),
          },
          allowed_profiles: allowedProfiles.map((profile) => ({
            name: profile.name,
            ...(profile.description === undefined ? {} : { description: profile.description }),
          })),
        });
        profileFit = state.profile_fit;
        const request = { model: this.options.policy.model, state };
        inputSha256 = hashInput(request);
        return this.options.advisor.assessDispatch(request);
      },
      record,
      () =>
        inputSha256 === undefined || profileFit === undefined
          ? null
          : record({ kind: "unavailable", code: "network_error", attempts: 1 }),
    );
  }

  /** Start one result assessment only after its child terminal was appended. */
  childTerminal(
    result: PoolChildResult,
    task: PreparedDelegateChild,
    logicalParentId: string,
  ): void {
    if (!this.accepting) return;
    let inputSha256: string | undefined;
    const record = (outcome: DelegationAdvisoryOutcome): PersistedRecord => {
      if (inputSha256 === undefined)
        throw new Error("delegation result advisory request was not prepared");
      return resultRecord(
        result,
        this.options.runId,
        logicalParentId,
        this.options.policy.model,
        inputSha256,
        outcome,
      );
    };
    this.enqueue(
      () => {
        const reportedVerificationClaims =
          "verification" in result ? (result.verification ?? []) : [];
        const state = buildDelegationResultAdvisoryState({
          task: { objective: task.objective, expected_output: task.expectedOutput },
          host: {
            status: result.status,
            normalization_reason:
              result.completionEvidence?.normalization_reason ?? "not_available",
            worktree_state:
              result.completionEvidence?.worktree_state ??
              result.terminalObservation?.workspace_state ??
              "uninspected",
            changed_paths: result.completionEvidence?.changed_paths ?? [],
            // The terminal seam carries child claims, not host-observed pinned-recipe outcomes.
            verification: [],
          },
          reported: {
            summary: result.summary,
            verification_claims: reportedVerificationClaims,
          },
        });
        const request = { model: this.options.policy.model, state };
        inputSha256 = hashInput(request);
        return this.options.advisor.assessResult(request);
      },
      record,
      () =>
        inputSha256 === undefined
          ? null
          : record({ kind: "unavailable", code: "network_error", attempts: 1 }),
    );
  }

  /** Wait for bounded work at run close; requests unfinished at the deadline are dropped. */
  drain(): Promise<void> {
    if (this.drainPromise !== null) return this.drainPromise;
    this.accepting = false;
    this.drainPromise = this.drainPending();
    return this.drainPromise;
  }

  private enqueue(
    assess: () => Promise<DelegationAdvisoryOutcome>,
    record: (outcome: DelegationAdvisoryOutcome) => PersistedRecord,
    failureRecord: () => PersistedRecord | null,
  ): void {
    if (this.pending.size >= this.options.policy.max_parallel * MAX_PENDING_PER_PARALLEL) return;
    let finish = (): void => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job: ShadowJob = { assess, record, failureRecord, done, finish, dropped: false };
    this.pending.add(job);
    this.queued.push(job);
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.options.policy.max_parallel) {
      const job = this.queued.shift();
      if (job === undefined) return;
      if (job.dropped) continue;
      this.running += 1;
      void Promise.resolve()
        .then(job.assess)
        .then(
          (outcome) => {
            if (!job.dropped) this.persist(job.record(outcome));
          },
          () => {
            if (!job.dropped) {
              const failure = job.failureRecord();
              if (failure !== null) this.persist(failure);
            }
          },
        )
        .catch(() => {
          // Advisory validation, serialization, and persistence failures are shadow-only.
        })
        .finally(() => {
          this.running -= 1;
          this.pending.delete(job);
          job.finish();
          this.schedulePump();
        });
    }
  }

  private persist(record: PersistedRecord): void {
    try {
      this.options.persistRecord(record);
    } catch {
      // A shadow record can never poison child admission, settlement, or run completion.
    }
  }

  private async drainPending(): Promise<void> {
    const pendingAtClose = [...this.pending];
    if (pendingAtClose.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.all(pendingAtClose.map((job) => job.done)).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          this.options.policy.request_timeout_ms * this.options.policy.max_attempts,
        );
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (drained) return;
    for (const job of this.pending) job.dropped = true;
    this.pending.clear();
    this.queued.length = 0;
  }
}

function dispatchRecord(
  accepted: DelegationSubmissionAcceptedRecord,
  task: PreparedDelegateChild,
  requestedModel: string,
  inputSha256: string,
  profileFit: ReturnType<typeof buildDelegationDispatchAdvisoryState>["profile_fit"],
  outcome: DelegationAdvisoryOutcome,
): DelegationDispatchAdvisoryRecord {
  const common = {
    schema_version: 1 as const,
    run_id: accepted.run_id,
    logical_parent_id: accepted.logical_parent_id,
    child_id: task.childId,
    task_id: task.taskId,
    subagent: task.profile.name,
    input_sha256: inputSha256,
    requested_model: requestedModel,
    ts: Date.now(),
  };
  if (outcome.kind === "unavailable") {
    return {
      type: "delegation_dispatch_advisory",
      ...common,
      status: "unavailable",
      failure: { code: outcome.code, attempts: boundedAttempts(outcome.attempts) },
    };
  }
  const judgments = outcome.judgments as DelegationDispatchAdvisoryAnswers;
  const persistedProfileFit = persistedProfileFitAnswer(profileFit, judgments.profile_fit);
  if (persistedProfileFit === null) {
    return {
      type: "delegation_dispatch_advisory",
      ...common,
      status: "unavailable",
      failure: { code: "response_invalid", attempts: boundedAttempts(outcome.attempts) },
    };
  }
  return {
    type: "delegation_dispatch_advisory",
    ...common,
    status: "completed",
    actual_model: outcome.actual_model,
    usage: outcome.usage,
    judgments: {
      objective_verifiable: { noul: judgments.objective_verifiable.noul },
      output_checkable: { noul: judgments.output_checkable.noul },
      self_contained: { noul: judgments.self_contained.noul },
      scope: {
        choice: judgments.scope.choice,
        confidence: judgments.scope.confidence,
        probabilities: { ...judgments.scope.probabilities },
      },
      profile_fit: persistedProfileFit,
    },
  };
}

type PersistedProfileFitAnswer = NonNullable<
  NonNullable<DelegationDispatchAdvisoryRecord["judgments"]>["profile_fit"]
>;

function persistedProfileFitAnswer(
  plan: ReturnType<typeof buildDelegationDispatchAdvisoryState>["profile_fit"],
  answer: DelegationDispatchAdvisoryAnswers["profile_fit"],
): PersistedProfileFitAnswer | null {
  if (plan.kind === "omitted") return { omitted: plan.omitted };
  if (!("probabilities" in answer)) return null;
  return {
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: { ...answer.probabilities },
  };
}

function resultRecord(
  result: PoolChildResult,
  runId: string,
  logicalParentId: string,
  requestedModel: string,
  inputSha256: string,
  outcome: DelegationAdvisoryOutcome,
): DelegationResultAdvisoryRecord {
  const common = {
    schema_version: 1 as const,
    run_id: runId,
    logical_parent_id: logicalParentId,
    child_id: result.childId,
    task_id: result.taskId,
    subagent: result.subagent,
    input_sha256: inputSha256,
    requested_model: requestedModel,
    host_status: result.status,
    ts: Date.now(),
  };
  if (outcome.kind === "unavailable") {
    return {
      type: "delegation_result_advisory",
      ...common,
      status: "unavailable",
      failure: { code: outcome.code, attempts: boundedAttempts(outcome.attempts) },
    };
  }
  return {
    type: "delegation_result_advisory",
    ...common,
    status: "completed",
    actual_model: outcome.actual_model,
    usage: outcome.usage,
    judgments: resultJudgments(outcome.judgments as DelegationResultAdvisoryAnswers),
  };
}

function resultJudgments(
  judgments: DelegationResultAdvisoryAnswers,
): NonNullable<DelegationResultAdvisoryRecord["judgments"]> {
  return {
    claims_supported: {
      choice: judgments.claims_supported.choice,
      confidence: judgments.claims_supported.confidence,
      probabilities: { ...judgments.claims_supported.probabilities },
    },
    objective_addressed: { noul: judgments.objective_addressed.noul },
  };
}

function boundedAttempts(attempts: number): number {
  return Number.isSafeInteger(attempts) ? Math.max(0, Math.min(5, attempts)) : 0;
}

function hashInput(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
