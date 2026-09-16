/** Closed per-subagent output policy — issue #116. */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ManifestParseError } from "./types.js";

const MAX_TOTAL_BYTES = 1_048_576;
const IDENTIFIER = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$",
});
const OUTPUT_ID = IDENTIFIER;
const PATH = Type.String({ minLength: 1, maxLength: 1024 });

const controllerPrincipalSchema = Type.Object(
  { kind: Type.Literal("controller") },
  { additionalProperties: false },
);
const nativePrincipalSchema = Type.Object(
  { kind: Type.Literal("native"), profile_id: IDENTIFIER },
  { additionalProperties: false },
);
const adapterPrincipalSchema = Type.Object(
  { kind: Type.Literal("adapter"), adapter_id: IDENTIFIER },
  { additionalProperties: false },
);
const effectPrincipalSchema = Type.Object(
  { kind: Type.Literal("effect"), effect_id: IDENTIFIER },
  { additionalProperties: false },
);

/** Closed principal audience contract shared by controller output consumers. */
export const controllerOutputPrincipalSchema = Type.Union([
  controllerPrincipalSchema,
  nativePrincipalSchema,
  adapterPrincipalSchema,
  effectPrincipalSchema,
]);
const mediaTypeSchema = Type.Union([
  Type.Literal("text/plain"),
  Type.Literal("text/markdown"),
  Type.Literal("application/json"),
  Type.Literal("application/octet-stream"),
]);
const reportSchema = Type.Object(
  {
    id: OUTPUT_ID,
    path: PATH,
    media_type: mediaTypeSchema,
    max_bytes: Type.Integer({ minimum: 1, maximum: 131_072 }),
    consumers: Type.Array(controllerOutputPrincipalSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);
const patchSchema = Type.Object(
  {
    id: OUTPUT_ID,
    paths: Type.Array(PATH, { minItems: 1, maxItems: 256 }),
    max_bytes: Type.Integer({ minimum: 1, maximum: 524_288 }),
    consumers: Type.Array(controllerOutputPrincipalSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);

/** TypeBox contract for the pinned per-subagent output policy. */
export const controllerOutputPolicySchema = Type.Object(
  {
    profile_id: IDENTIFIER,
    reports: Type.Array(reportSchema, { maxItems: 15 }),
    patch: Type.Optional(patchSchema),
  },
  { additionalProperties: false },
);

/** TypeBox contract name used by controller configuration consumers. */
export const controllerChildOutputPolicySchema = controllerOutputPolicySchema;

/** Patch outputs are always transported as a git patch. */
export const CONTROLLER_PATCH_MEDIA_TYPE = "application/x-git-patch" as const;

/** Parsed controller output policy. */
export type ControllerOutputPolicy = Readonly<Static<typeof controllerOutputPolicySchema>>;

/** Type name used by controller configuration consumers. */
export type ControllerChildOutputPolicy = ControllerOutputPolicy;

/** A closed, discriminated output consumer principal. */
export type ControllerOutputPrincipal = Readonly<Static<typeof controllerOutputPrincipalSchema>>;

/** Return structural and cross-field validation errors for an output policy. */
function validateControllerOutputPolicy(
  policy: unknown,
  path = "child_outputs",
): readonly string[] {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return Object.freeze([`${path} must be a mapping (object)`]);
  }
  if (!Value.Check(controllerOutputPolicySchema, policy)) {
    return Object.freeze([`${path} does not match the controller output policy schema`]);
  }

  const entry = policy as Static<typeof controllerOutputPolicySchema>;
  const errors: string[] = [];
  if (entry.reports.length === 0 && entry.patch === undefined) {
    errors.push(`${path} must declare at least one report or a patch`);
  }
  const ids = new Set<string>();
  const reportPaths = new Set<string>();
  const patchPaths = new Set<string>();
  let totalBytes = 0;
  for (const [index, report] of entry.reports.entries()) {
    const reportPath = `${path}.reports[${index}]`;
    checkUnique(ids, report.id, `${reportPath}.id`, errors, "output id");
    checkSafePath(report.path, `${reportPath}.path`, errors);
    checkUnique(reportPaths, report.path, `${reportPath}.path`, errors, "path");
    checkPrincipals(report.consumers, `${reportPath}.consumers`, errors);
    totalBytes += report.max_bytes;
  }
  if (entry.patch !== undefined) {
    checkUnique(ids, entry.patch.id, `${path}.patch.id`, errors, "output id");
    checkPrincipals(entry.patch.consumers, `${path}.patch.consumers`, errors);
    for (const [index, patchPath] of entry.patch.paths.entries()) {
      const itemPath = `${path}.patch.paths[${index}]`;
      checkSafePath(patchPath, itemPath, errors);
      checkUnique(patchPaths, patchPath, itemPath, errors, "path");
    }
    totalBytes += entry.patch.max_bytes;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    errors.push(`${path} declares ${totalBytes} bytes, above the maximum ${MAX_TOTAL_BYTES}`);
  }
  return Object.freeze(errors);
}

/** Validate a controller's complete list of per-subagent output policies. */
export function validateControllerChildOutputPolicies(
  policies: unknown,
  path = "child_outputs",
): readonly string[] {
  if (!Array.isArray(policies)) return Object.freeze([`${path} must be an array`]);
  const errors: string[] = [];
  const profiles = new Set<string>();
  for (const [index, policy] of policies.entries()) {
    const policyPath = `${path}[${index}]`;
    errors.push(...validateControllerOutputPolicy(policy, policyPath));
    if (Value.Check(controllerOutputPolicySchema, policy)) {
      const profileId = (policy as { readonly profile_id: string }).profile_id;
      if (profiles.has(profileId))
        errors.push(`${policyPath}.profile_id duplicates '${profileId}'`);
      else profiles.add(profileId);
    }
  }
  return Object.freeze(errors);
}

/** Parse, validate, clone, and deeply freeze one output policy. */
export function parseControllerChildOutputPolicy(
  raw: unknown,
  path = "child_outputs",
): ControllerOutputPolicy {
  const errors = validateControllerOutputPolicy(raw, path);
  if (errors.length > 0) throw new ManifestParseError(errors[0] ?? `${path} is invalid`);
  return freeze(structuredClone(raw)) as ControllerOutputPolicy;
}

function checkUnique(
  seen: Set<string>,
  value: string,
  path: string,
  errors: string[],
  label: string,
): void {
  if (seen.has(value)) errors.push(`${path} duplicates ${label} '${value}'`);
  else seen.add(value);
}

function checkPrincipals(value: readonly unknown[], path: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const [index, principal] of value.entries()) {
    const typed = principal as ControllerOutputPrincipal;
    const key =
      typed.kind === "controller"
        ? "controller"
        : typed.kind === "native"
          ? `native:${typed.profile_id}`
          : typed.kind === "adapter"
            ? `adapter:${typed.adapter_id}`
            : `effect:${typed.effect_id}`;
    if (seen.has(key)) errors.push(`${path}[${index}] duplicates a consumer principal`);
    else seen.add(key);
  }
}

function checkSafePath(value: string, path: string, errors: string[]): void {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.toLowerCase() === ".git" ||
          segment.toLowerCase() === ".pi-conductor",
      )
  ) {
    errors.push(`${path} must be an exact safe repository-relative path`);
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
