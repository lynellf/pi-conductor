/** Redacted bounded state builders for issue #154's offline-only advisory. */

import { redactOutboundText } from "../../persistence/context-enrichment-v2.js";
import type {
  DelegationAdvisoryProfileState,
  DelegationDispatchAdvisoryStateBuild,
  DelegationResultAdvisoryState,
} from "./contracts.js";

const MAX_TEXT_CHARS = 1000;
const MAX_TOOLS = 16;
const MAX_VERIFICATION_ITEMS = 16;
const MAX_VERIFICATION_CLAIMS = 16;

/** Minimal trusted task data needed to build one dispatch advisory state. */
export interface DelegationDispatchAdvisoryStateInput {
  readonly task: {
    readonly objective: string;
    readonly expected_output: string;
    readonly subagent: string;
    readonly tools?: readonly string[];
    readonly projection_paths?: readonly string[];
    readonly context_artifacts?: readonly unknown[];
    readonly verification_recipe?: string;
  };
  /** Exactly the profiles allowed by the parent role's pinned delegation policy. */
  readonly allowed_profiles: readonly {
    readonly name: string;
    readonly description?: string;
  }[];
}

/** Minimal host and reported data needed for one child-result advisory state. */
export interface DelegationResultAdvisoryStateInput {
  readonly task: {
    readonly objective: string;
    readonly expected_output: string;
  };
  readonly host: {
    readonly status: string;
    readonly normalization_reason: string;
    readonly worktree_state: string;
    readonly changed_paths: readonly string[];
    readonly verification: readonly { readonly name: string; readonly outcome: string }[];
  };
  readonly reported: {
    readonly summary: string;
    readonly verification_claims: readonly string[];
  };
}

function boundedText(value: string): string {
  return redactOutboundText(value).slice(0, MAX_TEXT_CHARS);
}

function profileDescription(profile: { readonly description?: string }): string | null {
  if (typeof profile.description !== "string" || profile.description.trim().length === 0)
    return null;
  return boundedText(profile.description.trim());
}

/** Build a bounded, redacted dispatch state and explicit profile-fit eligibility. */
export function buildDelegationDispatchAdvisoryState(
  input: DelegationDispatchAdvisoryStateInput,
): DelegationDispatchAdvisoryStateBuild {
  const task = {
    objective: boundedText(input.task.objective),
    expected_output: boundedText(input.task.expected_output),
    subagent: boundedText(input.task.subagent),
    tools: (input.task.tools ?? []).slice(0, MAX_TOOLS).map(boundedText),
    projection_path_count: input.task.projection_paths?.length ?? 0,
    context_artifact_count: input.task.context_artifacts?.length ?? 0,
    verification_recipe:
      input.task.verification_recipe === undefined
        ? null
        : boundedText(input.task.verification_recipe),
  };
  const profiles = input.allowed_profiles;
  if (profiles.length < 2) {
    return {
      state: { task },
      profile_fit: { kind: "omitted", omitted: "single_profile" },
    };
  }
  const describedProfiles: DelegationAdvisoryProfileState[] = [];
  for (const profile of profiles) {
    const description = profileDescription(profile);
    if (description === null) {
      return {
        state: { task },
        profile_fit: { kind: "omitted", omitted: "missing_descriptions" },
      };
    }
    describedProfiles.push({ name: boundedText(profile.name), description });
  }
  return {
    state: { task, profiles: describedProfiles },
    profile_fit: { kind: "choice" },
  };
}

/** Build a bounded, redacted result state without exposing paths or raw tool output. */
export function buildDelegationResultAdvisoryState(
  input: DelegationResultAdvisoryStateInput,
): DelegationResultAdvisoryState {
  return {
    task: {
      objective: boundedText(input.task.objective),
      expected_output: boundedText(input.task.expected_output),
    },
    host: {
      status: boundedText(input.host.status),
      normalization_reason: boundedText(input.host.normalization_reason),
      worktree_state: boundedText(input.host.worktree_state),
      changed_path_count: input.host.changed_paths.length,
      verification: input.host.verification.slice(0, MAX_VERIFICATION_ITEMS).map((entry) => ({
        name: boundedText(entry.name),
        outcome: boundedText(entry.outcome),
      })),
    },
    reported: {
      summary: boundedText(input.reported.summary),
      verification_claims: input.reported.verification_claims
        .slice(0, MAX_VERIFICATION_CLAIMS)
        .map(boundedText),
    },
  };
}
