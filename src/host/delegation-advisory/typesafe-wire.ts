/** TypeSafe request construction and strict Choice/Noul response validation. */

import { Value } from "typebox/value";
import {
  DELEGATION_ADVISORY_QUESTION_INSTRUCTIONS,
  DELEGATION_DISPATCH_QUESTION_IDS,
  DELEGATION_RESULT_QUESTION_IDS,
  type DelegationAdvisoryFailureCode,
  type DelegationAdvisoryUsage,
  type DelegationDispatchAdvisoryAnswers,
  type DelegationResultAdvisoryAnswers,
  delegationAdvisoryNoulAnswerSchema,
  delegationAdvisoryScopeAnswerSchema,
  delegationAdvisoryUsageSchema,
  delegationDispatchAdvisoryAnswersSchema,
  delegationResultAdvisoryAnswersSchema,
} from "../../seam/delegation-advisory.js";
import type {
  DelegationDispatchAdvisoryRequest,
  DelegationDispatchAdvisoryState,
  DelegationResultAdvisoryRequest,
} from "./contracts.js";

const MAX_MODEL_LENGTH = 128;
const MAX_PROFILE_OPTIONS = 254;
const PROBABILITY_SUM_TOLERANCE = 1e-6;

const SCOPE_CRITERIA = Object.freeze({
  single_contract: "One focused change within a single contract or component.",
  related_bundle: "Several related changes that form one coherent deliverable.",
  unrelated_bundle: "Distinct, unrelated deliverables grouped into the same task.",
});
const CLAIMS_CRITERIA = Object.freeze({
  supported: "Reported verification claims agree with the host-normalized evidence.",
  contradicted: "Reported verification claims conflict with the host-normalized evidence.",
  not_assessable: "The host-normalized evidence cannot assess the reported claims.",
});
const NONE_FIT_DESCRIPTION = "None of the allowed profiles fits the task.";

interface TypesafeResponse {
  readonly model: string;
  readonly usage: DelegationAdvisoryUsage;
  readonly answers: Record<string, unknown>;
}

/** Typed rejection for malformed local input or untrusted provider responses. */
export class TypesafeAdvisoryRejection extends Error {
  constructor(readonly code: DelegationAdvisoryFailureCode) {
    super(`typesafe delegation advisory rejected: ${code}`);
    this.name = "TypesafeAdvisoryRejection";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function hasDistribution(probabilities: Readonly<Record<string, number>>): boolean {
  const values = Object.values(probabilities);
  return (
    values.length > 0 &&
    values.every((value) => typeof value === "number" && Number.isFinite(value)) &&
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= PROBABILITY_SUM_TOLERANCE
  );
}

function labelMatchesMaximum(
  choice: string,
  probabilities: Readonly<Record<string, number>>,
): boolean {
  const maximum = Math.max(...Object.values(probabilities));
  return probabilities[choice] === maximum;
}

function profileLabels(state: DelegationDispatchAdvisoryState): readonly string[] {
  const profiles = state.profiles;
  if (
    profiles === undefined ||
    profiles.length < 2 ||
    profiles.length > MAX_PROFILE_OPTIONS ||
    profiles.some(
      (profile) =>
        profile.name.length === 0 ||
        profile.name.length > 96 ||
        profile.name === "none_fit" ||
        profile.description.length === 0 ||
        profile.description.length > 1000,
    )
  ) {
    throw new TypesafeAdvisoryRejection("input_mismatch");
  }
  const labels = profiles.map((profile) => profile.name);
  if (new Set(labels).size !== labels.length) throw new TypesafeAdvisoryRejection("input_mismatch");
  return [...labels, "none_fit"];
}

function dispatchQuestions(request: DelegationDispatchAdvisoryRequest): Record<string, unknown> {
  const questions: Record<string, unknown> = {
    objective_verifiable: {
      type: "noul",
      instructions: DELEGATION_ADVISORY_QUESTION_INSTRUCTIONS.objective_verifiable,
    },
    output_checkable: {
      type: "noul",
      instructions: DELEGATION_ADVISORY_QUESTION_INSTRUCTIONS.output_checkable,
    },
    self_contained: {
      type: "noul",
      instructions: DELEGATION_ADVISORY_QUESTION_INSTRUCTIONS.self_contained,
    },
    scope: {
      type: "choice",
      instructions: DELEGATION_ADVISORY_QUESTION_INSTRUCTIONS.scope,
      criteria: { ...SCOPE_CRITERIA },
    },
  };
  if (request.state.profile_fit.kind === "choice") {
    const profiles = request.state.state.profiles;
    const labels = profileLabels(request.state.state);
    if (profiles === undefined) throw new TypesafeAdvisoryRejection("input_mismatch");
    const criteria: Record<string, string> = Object.fromEntries(
      profiles.map((profile) => [profile.name, profile.description]),
    );
    criteria.none_fit = NONE_FIT_DESCRIPTION;
    questions.profile_fit = {
      type: "choice",
      instructions: DELEGATION_ADVISORY_QUESTION_INSTRUCTIONS.profile_fit,
      criteria,
    };
    if (labels.length !== profiles.length + 1)
      throw new TypesafeAdvisoryRejection("input_mismatch");
  } else if (request.state.state.profiles !== undefined) {
    throw new TypesafeAdvisoryRejection("input_mismatch");
  }
  return questions;
}

/** Build one documented MAP-keyed dispatch request without sending it. */
export function buildDelegationDispatchRequestBody(
  request: DelegationDispatchAdvisoryRequest,
): unknown {
  return {
    model: request.model,
    state: request.state.state,
    questions: dispatchQuestions(request),
  };
}

/** Build one documented MAP-keyed result request without sending it. */
export function buildDelegationResultRequestBody(
  request: DelegationResultAdvisoryRequest,
): unknown {
  return {
    model: request.model,
    state: request.state,
    questions: {
      claims_supported: {
        type: "choice",
        instructions: DELEGATION_ADVISORY_QUESTION_INSTRUCTIONS.claims_supported,
        criteria: { ...CLAIMS_CRITERIA },
      },
      objective_addressed: {
        type: "noul",
        instructions: DELEGATION_ADVISORY_QUESTION_INSTRUCTIONS.objective_addressed,
      },
    },
  };
}

/** Validate the exact answer map for a dispatch or result request atomically. */
export function validateDelegationAdvisoryResponse(
  value: unknown,
  request: DelegationDispatchAdvisoryRequest | DelegationResultAdvisoryRequest,
): {
  readonly response: TypesafeResponse;
  readonly judgments: DelegationDispatchAdvisoryAnswers | DelegationResultAdvisoryAnswers;
} {
  if (!isRecord(value) || !exactKeys(value, ["model", "usage", "answers"])) {
    throw new TypesafeAdvisoryRejection("response_invalid");
  }
  if (
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    value.model.length > MAX_MODEL_LENGTH ||
    !Value.Check(delegationAdvisoryUsageSchema, value.usage) ||
    !isRecord(value.answers)
  ) {
    throw new TypesafeAdvisoryRejection("response_invalid");
  }
  const usage = value.usage as DelegationAdvisoryUsage;
  const expectedIds =
    "profile_fit" in request.state
      ? expectedDispatchIds(request as DelegationDispatchAdvisoryRequest)
      : [...DELEGATION_RESULT_QUESTION_IDS];
  const answers = value.answers;
  if (!exactKeys(answers, expectedIds)) throw new TypesafeAdvisoryRejection("response_invalid");

  if ("profile_fit" in request.state) {
    if (request.state.profile_fit.kind === "choice") {
      if (!Value.Check(delegationDispatchAdvisoryAnswersSchema, answers)) {
        throw new TypesafeAdvisoryRejection("response_invalid");
      }
      const checked = answers as DelegationDispatchAdvisoryAnswers;
      if (
        !hasDistribution(checked.scope.probabilities) ||
        !labelMatchesMaximum(checked.scope.choice, checked.scope.probabilities)
      ) {
        throw new TypesafeAdvisoryRejection("response_invalid");
      }
      const labels = profileLabels(request.state.state);
      const fit = checked.profile_fit;
      if (
        !("probabilities" in fit) ||
        !exactKeys(fit.probabilities, labels) ||
        !hasDistribution(fit.probabilities) ||
        !labels.includes(fit.choice) ||
        !labelMatchesMaximum(fit.choice, fit.probabilities)
      ) {
        throw new TypesafeAdvisoryRejection("response_invalid");
      }
      return { response: { model: value.model, usage, answers }, judgments: checked };
    }
    if (
      !Value.Check(delegationAdvisoryNoulAnswerSchema, answers.objective_verifiable) ||
      !Value.Check(delegationAdvisoryNoulAnswerSchema, answers.output_checkable) ||
      !Value.Check(delegationAdvisoryNoulAnswerSchema, answers.self_contained) ||
      !Value.Check(delegationAdvisoryScopeAnswerSchema, answers.scope)
    ) {
      throw new TypesafeAdvisoryRejection("response_invalid");
    }
    const scope = answers.scope as DelegationDispatchAdvisoryAnswers["scope"];
    if (
      !hasDistribution(scope.probabilities) ||
      !labelMatchesMaximum(scope.choice, scope.probabilities)
    ) {
      throw new TypesafeAdvisoryRejection("response_invalid");
    }
    const checked: DelegationDispatchAdvisoryAnswers = {
      objective_verifiable:
        answers.objective_verifiable as DelegationDispatchAdvisoryAnswers["objective_verifiable"],
      output_checkable:
        answers.output_checkable as DelegationDispatchAdvisoryAnswers["output_checkable"],
      self_contained: answers.self_contained as DelegationDispatchAdvisoryAnswers["self_contained"],
      scope,
      profile_fit: { omitted: request.state.profile_fit.omitted },
    };
    return { response: { model: value.model, usage, answers }, judgments: checked };
  }

  if (!Value.Check(delegationResultAdvisoryAnswersSchema, answers)) {
    throw new TypesafeAdvisoryRejection("response_invalid");
  }
  const checked = answers as DelegationResultAdvisoryAnswers;
  if (
    !hasDistribution(checked.claims_supported.probabilities) ||
    !labelMatchesMaximum(checked.claims_supported.choice, checked.claims_supported.probabilities)
  ) {
    throw new TypesafeAdvisoryRejection("response_invalid");
  }
  return { response: { model: value.model, usage, answers }, judgments: checked };
}

function expectedDispatchIds(request: DelegationDispatchAdvisoryRequest): readonly string[] {
  if (request.state.profile_fit.kind === "choice") {
    profileLabels(request.state.state);
    return [...DELEGATION_DISPATCH_QUESTION_IDS];
  }
  if (request.state.state.profiles !== undefined)
    throw new TypesafeAdvisoryRejection("input_mismatch");
  return DELEGATION_DISPATCH_QUESTION_IDS.filter((id) => id !== "profile_fit");
}
