/** Opt-in repository controller configuration — issue #115 §2. */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  controllerChildOutputPolicySchema,
  controllerOutputPrincipalSchema,
  validateControllerChildOutputPolicies,
} from "./controller-output.js";
import {
  controllerSourcePolicySchema,
  validateControllerSourcePolicy,
} from "./controller-source.js";
import { outputPrincipalKey } from "./output-audience.js";
import { ManifestParseError } from "./types.js";

const id = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
});
const argv = Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 });
const executable = Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\u0000]+$" });
const contextArtifactLimitsSchema = Type.Object(
  {
    max_items: Type.Integer({ minimum: 1, maximum: 16 }),
    max_item_utf8_bytes: Type.Integer({ minimum: 1, maximum: 32768 }),
    max_total_utf8_bytes: Type.Integer({ minimum: 1, maximum: 131072 }),
  },
  { additionalProperties: false },
);

/** Approved capability granted to one fixed local adapter. */
export const controllerCapabilitySchema = Type.Union([
  Type.Literal("read_only"),
  Type.Literal("private_staging"),
]);

/** One fixed, operator-approved local adapter definition. */
export const controllerAdapterSchema = Type.Object(
  {
    id,
    runtime_id: id,
    executable,
    argv,
    input_schema_id: id,
    output_schema_id: id,
    capability: controllerCapabilitySchema,
    effect_id: Type.Optional(id),
    output_consumers: Type.Optional(Type.Array(controllerOutputPrincipalSchema, { maxItems: 64 })),
    source_consumers: Type.Optional(Type.Array(controllerOutputPrincipalSchema, { maxItems: 64 })),
    result_consumers: Type.Optional(Type.Array(controllerOutputPrincipalSchema, { maxItems: 64 })),
    source_policy: Type.Optional(controllerSourcePolicySchema),
  },
  { additionalProperties: false },
);

/** Bounded controller execution limits. */
export const controllerLimitsSchema = Type.Object(
  {
    planner_deadline_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
    max_outstanding_adapters: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    max_decisions: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })),
    max_actions: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })),
    max_outstanding_actions: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
  },
  { additionalProperties: false },
);

/** Optional top-level controller definition, pinned into a run snapshot. */
export const controllerConfigSchema = Type.Object(
  {
    protocol_version: Type.Literal(1),
    controller_id: id,
    runtime_id: id,
    executable,
    argv,
    adapters: Type.Array(controllerAdapterSchema, { maxItems: 64 }),
    source_repositories: Type.Optional(Type.Array(id, { maxItems: 64, uniqueItems: true })),
    child_outputs: Type.Optional(Type.Array(controllerChildOutputPolicySchema, { maxItems: 64 })),
    delegation: Type.Object(
      {
        allowed_subagents: Type.Array(id, { minItems: 1, maxItems: 64 }),
        max_children_per_session: Type.Integer({ minimum: 1 }),
        max_parallel: Type.Integer({ minimum: 1 }),
        context_artifact_limits: Type.Optional(contextArtifactLimitsSchema),
      },
      { additionalProperties: false },
    ),
    limits: Type.Optional(controllerLimitsSchema),
  },
  { additionalProperties: false },
);

/** Parsed controller configuration type. */
export type ControllerConfig = Readonly<Static<typeof controllerConfigSchema>>;

/** Parsed controller adapter type. */
export type ControllerAdapterConfig = Readonly<Static<typeof controllerAdapterSchema>>;

/** Parse and validate one controller mapping from a manifest object. */
export function parseControllerConfig(raw: unknown): ControllerConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new ManifestParseError("controller must be a YAML mapping (object)");
  const entry = raw as Record<string, unknown>;
  const keys = new Set([
    "protocol_version",
    "controller_id",
    "runtime_id",
    "executable",
    "argv",
    "adapters",
    "source_repositories",
    "child_outputs",
    "delegation",
    "limits",
  ]);
  for (const key of Object.keys(entry))
    if (!keys.has(key)) throw new ManifestParseError(`controller has unknown key '${key}'`);
  const candidate = structuredClone(entry);
  if (!Value.Check(controllerConfigSchema, candidate))
    throw new ManifestParseError("controller does not match the version 1 configuration schema");
  if (candidate.child_outputs !== undefined) {
    const errors = validateControllerChildOutputPolicies(candidate.child_outputs);
    if (errors.length > 0) throw new ManifestParseError(errors.join("; "));
  }
  const selectedSourceIds = new Set(candidate.source_repositories ?? []);
  for (const adapter of candidate.adapters) {
    if (adapter.source_policy === undefined) continue;
    if (adapter.capability !== "read_only" || adapter.effect_id !== undefined)
      throw new ManifestParseError(
        "source-enabled adapters require read_only capability without an effect",
      );
    const errors = validateControllerSourcePolicy(adapter.source_policy);
    if (errors.length > 0) throw new ManifestParseError(errors.join("; "));
    for (const sourceId of adapter.source_policy.source_ids)
      if (!selectedSourceIds.has(sourceId))
        throw new ManifestParseError(
          `adapter source policy references unselected source repository '${sourceId}'`,
        );
  }
  const profiles = new Set(candidate.delegation.allowed_subagents);
  const adapters = new Set(candidate.adapters.map((adapter) => adapter.id));
  const effects = new Set(
    candidate.adapters.flatMap((adapter) =>
      adapter.effect_id === undefined ? [] : [adapter.effect_id],
    ),
  );
  for (const adapter of candidate.adapters)
    if (
      adapter.effect_id === undefined &&
      (adapter.source_consumers !== undefined || adapter.result_consumers !== undefined)
    )
      throw new ManifestParseError("effect publication consumers require an adapter effect");
    else if (
      adapter.effect_id !== undefined &&
      !adapter.output_consumers?.some(
        (principal) => principal.kind === "effect" && principal.effect_id === adapter.effect_id,
      )
    )
      throw new ManifestParseError("effect adapter output must authorize its own effect principal");
  for (const policy of candidate.child_outputs ?? []) {
    if (!profiles.has(policy.profile_id))
      throw new ManifestParseError("output producer is not an allowed native profile");
  }
  const audiences = [
    ...(candidate.child_outputs ?? []).flatMap((policy) => [
      ...policy.reports.map((report) => report.consumers),
      ...(policy.patch === undefined ? [] : [policy.patch.consumers]),
    ]),
    ...candidate.adapters.flatMap((adapter) =>
      adapter.output_consumers === undefined ? [] : [adapter.output_consumers],
    ),
    ...candidate.adapters.flatMap((adapter) =>
      adapter.source_consumers === undefined ? [] : [adapter.source_consumers],
    ),
    ...candidate.adapters.flatMap((adapter) =>
      adapter.result_consumers === undefined ? [] : [adapter.result_consumers],
    ),
  ];
  for (const audience of audiences) {
    if (new Set(audience.map(outputPrincipalKey)).size !== audience.length)
      throw new ManifestParseError("output audience repeats a principal");
    for (const principal of audience) {
      if (
        (principal.kind === "native" && !profiles.has(principal.profile_id)) ||
        (principal.kind === "adapter" && !adapters.has(principal.adapter_id)) ||
        (principal.kind === "effect" && !effects.has(principal.effect_id))
      )
        throw new ManifestParseError("output consumer is not configured for this controller");
    }
  }
  return freeze(candidate) as ControllerConfig;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** Conservative defaults for omitted controller limits. */
export const DEFAULT_CONTROLLER_LIMITS = Object.freeze({
  planner_deadline_seconds: 30,
  max_outstanding_adapters: 1,
  max_decisions: 10000,
  max_actions: 10000,
  max_outstanding_actions: 64,
});

/** Resolve omitted controller limits to the bounded v1 defaults. */
export function resolveControllerLimits(limits: ControllerConfig["limits"] | undefined): Readonly<{
  planner_deadline_seconds: number;
  max_outstanding_adapters: number;
  max_decisions: number;
  max_actions: number;
  max_outstanding_actions: number;
}> {
  return Object.freeze({
    planner_deadline_seconds:
      limits?.planner_deadline_seconds ?? DEFAULT_CONTROLLER_LIMITS.planner_deadline_seconds,
    max_outstanding_adapters:
      limits?.max_outstanding_adapters ?? DEFAULT_CONTROLLER_LIMITS.max_outstanding_adapters,
    max_decisions: limits?.max_decisions ?? DEFAULT_CONTROLLER_LIMITS.max_decisions,
    max_actions: limits?.max_actions ?? DEFAULT_CONTROLLER_LIMITS.max_actions,
    max_outstanding_actions:
      limits?.max_outstanding_actions ?? DEFAULT_CONTROLLER_LIMITS.max_outstanding_actions,
  });
}
