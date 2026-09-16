/** Match repository requests to protected operator authority before effects (#115 §2). */
import {
  type ControllerConfig,
  parseControllerConfig,
  resolveControllerLimits,
} from "../../manifest/controller.js";
import {
  assertControllerRecord,
  type ControllerDefinitionPinnedRecord,
  controllerDefinitionDigest,
} from "../../persistence/controller-records.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { effectAuthorityDigest } from "./effect-registry.js";
import { type ControllerHostApproval, validateControllerHostApproval } from "./host-approval.js";

/** The exact operator-authorized inputs pinned for one controller definition. */
export interface ApprovedControllerDefinition {
  readonly record: ControllerDefinitionPinnedRecord;
  readonly config: ControllerConfig;
  readonly approval: ControllerHostApproval;
}

/** Resolve every program, capability and schema without granting repository input authority. */
export function approveControllerDefinition(
  runId: string,
  request: ControllerConfig,
  suppliedApproval: ControllerHostApproval,
  ts: number,
): ApprovedControllerDefinition {
  const approval = validateControllerHostApproval(suppliedApproval);
  const config = parseControllerConfig(request);
  for (const policy of config.child_outputs ?? []) {
    const registered = approval.child_outputs?.find(
      (entry) => entry.profile_id === policy.profile_id,
    );
    if (registered === undefined || sha256Canonical(registered) !== sha256Canonical(policy))
      throw new Error(`controller output policy '${policy.profile_id}' is not approved`);
  }
  const controller = approval.controllers.find(
    (entry) => entry.controller_id === config.controller_id,
  );
  if (
    controller === undefined ||
    sha256Canonical(controller) !==
      sha256Canonical({
        controller_id: config.controller_id,
        runtime_id: config.runtime_id,
        executable: config.executable,
        argv: config.argv,
      })
  )
    throw new Error("controller executable and arguments are not approved");
  const controllerAuthority = authority(approval, controller.runtime_id, controller.executable, {
    program: controller,
    capability: "read_only",
    limits: resolveControllerLimits(config.limits),
  });
  const adapterAuthorities = config.adapters.map((adapter) => {
    const registered = approval.adapters.find((entry) => entry.id === adapter.id);
    if (registered === undefined || sha256Canonical(registered) !== sha256Canonical(adapter))
      throw new Error(`controller adapter '${adapter.id}' capability or program is not approved`);
    const schemas = [adapter.input_schema_id, adapter.output_schema_id].map((id) => {
      const schema = approval.schemas.find((entry) => entry.schema_id === id);
      if (schema === undefined) throw new Error("controller adapter schema is not approved");
      return schema;
    });
    return {
      adapter_id: adapter.id,
      ...authority(approval, adapter.runtime_id, adapter.executable, { program: adapter, schemas }),
    };
  });
  const runtimeIds = new Set([
    config.runtime_id,
    ...config.adapters.map((entry) => entry.runtime_id),
  ]);
  const schemaIds = new Set(
    config.adapters.flatMap((entry) => [entry.input_schema_id, entry.output_schema_id]),
  );
  // Pin only used registrations: revoking an unrelated program does not change this definition.
  const effectIds = new Set(
    config.adapters.flatMap((adapter) =>
      adapter.effect_id === undefined ? [] : [adapter.effect_id],
    ),
  );
  const effects = (approval.effects ?? [])
    .filter((grant) => effectIds.has(grant.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((grant) => ({ grant, authority_digest: effectAuthorityDigest(grant) }));
  const pinnedDefinition = {
    ...(effects.length === 0 ? {} : { effects }),
    config,
    approval_id: approval.approval_id,
    runtimes: approval.runtimes
      .filter((entry) => runtimeIds.has(entry.runtime_id))
      .sort((a, b) => a.runtime_id.localeCompare(b.runtime_id)),
    schemas: approval.schemas
      .filter((entry) => schemaIds.has(entry.schema_id))
      .sort((a, b) => a.schema_id.localeCompare(b.schema_id)),
    controller_authority: controllerAuthority,
    adapter_authorities: adapterAuthorities,
  };
  const limits = resolveControllerLimits(config.limits);
  const fields = {
    type: "controller_definition_pinned" as const,
    schema_version: 1 as const,
    run_id: runId,
    controller_id: config.controller_id,
    pinned_definition: pinnedDefinition,
    controller_authority: controllerAuthority,
    adapter_authorities: adapterAuthorities,
    limits: {
      max_decisions: limits.max_decisions,
      max_actions: limits.max_actions,
      max_outstanding_actions: limits.max_outstanding_actions,
    },
    ts,
  };
  const record: ControllerDefinitionPinnedRecord = {
    ...fields,
    definition_digest: controllerDefinitionDigest(fields),
  };
  assertControllerRecord(record);
  return Object.freeze({ record: freeze(record), config, approval });
}

/** Resume/revocation checks use the pinned request and require its original authority. */
export function verifyControllerApproval(
  pinned: ControllerDefinitionPinnedRecord,
  current: ControllerHostApproval,
): ApprovedControllerDefinition {
  assertControllerRecord(pinned);
  const definition = pinned.pinned_definition;
  if (definition === null || typeof definition !== "object" || !("config" in definition))
    throw new Error("pinned controller definition has no configuration");
  const config = parseControllerConfig(definition.config);
  const resolved = approveControllerDefinition(pinned.run_id, config, current, pinned.ts);
  if (sha256Canonical(resolved.record) !== sha256Canonical(pinned))
    throw new Error("pinned controller authority changed or was revoked");
  return resolved;
}

function authority(
  approval: ControllerHostApproval,
  runtimeId: string,
  executable: string,
  capability: unknown,
): ControllerDefinitionPinnedRecord["controller_authority"] {
  const runtime = approval.runtimes.find((entry) => entry.runtime_id === runtimeId);
  const file = runtime?.bootstrap_approval.files.find((entry) => `/${entry.path}` === executable);
  if (runtime === undefined || file === undefined)
    throw new Error("controller executable is absent from its complete approved runtime");
  return {
    registration_id: runtimeId,
    approval_id: approval.approval_id,
    runtime_digest: runtime.inventory_sha256,
    executable_digest: file.sha256,
    capability_digest: sha256Canonical(capability),
  };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
