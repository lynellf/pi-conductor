/** Planner and adapter dispatch for approved controller executables — issue #115. */
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { ControllerAction, ControllerRequest } from "../../manifest/controller-protocol.js";
import { combineInputAudiences } from "../../manifest/output-audience.js";
import { controllerActionRequestDigest } from "../../persistence/controller-records.js";
import { ToolExecutionError } from "../execution/tool-execution-controller.js";
import {
  type ApprovedControllerDefinition,
  verifyControllerApproval,
} from "./approved-definition.js";
import {
  adapterBinding,
  adapterInput,
  sourceEnvelope,
  sourceEnvelopeResult,
  sourceInvocation,
} from "./executable-host-adapter.js";
import type {
  CreateExecutableControllerHostOptions,
  ExecutableControllerHost,
} from "./executable-host-contract.js";
import { createRuntimePreparation } from "./executable-host-preparation.js";
import { runControllerProgram } from "./executable-host-program.js";
import { decodeControllerResponse, encodeControllerRequest } from "./protocol-codec.js";
import { ControllerRuntimeStore } from "./runtime-store.js";

export type {
  ControllerAdapterInvocationResult,
  ControllerExecutionDriver,
  ControllerSandboxHostApproval,
  CreateExecutableControllerHostOptions,
  ExecutableControllerHost,
} from "./executable-host-contract.js";

const MAX_JSON_BYTES = 1024 * 1024;
const adapterInputSchema = Type.Object(
  {
    protocol_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1 }),
    controller_id: Type.String({ minLength: 1 }),
    definition_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    action_id: Type.String({ minLength: 1, maxLength: 128 }),
    input_refs: Type.Array(
      Type.Object(
        { ref: Type.String({ minLength: 1, maxLength: 256 }), value: Type.Unknown() },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
  },
  { additionalProperties: false },
);

/** Create one activation-bound executable host. It starts no process during construction. */
export function createExecutableControllerHost(
  supplied: CreateExecutableControllerHostOptions,
): ExecutableControllerHost {
  const options = Object.freeze({ ...supplied });
  assertActivation(options);
  const runtimeStore = new ControllerRuntimeStore({
    runStateDir: options.runStateDir,
    definition: options.approvedDefinition,
    protection: options.protection,
    assertOpen: options.assertOpen,
  });
  const currentDefinition = async (): Promise<ApprovedControllerDefinition> => {
    options.assertOpen();
    const definition = verifyControllerApproval(
      options.approvedDefinition.record,
      await options.getCurrentApproval(),
    );
    options.assertOpen();
    if (definition.record.definition_digest !== options.approvedDefinition.record.definition_digest)
      throw new Error("controller approval does not reproduce the pinned definition");
    return definition;
  };
  const ensurePrepared = createRuntimePreparation({ options, runtimeStore, currentDefinition });
  return Object.freeze({
    async invokePlanner(request: ControllerRequest, signal?: AbortSignal) {
      const definition = await currentDefinition();
      await ensurePrepared(definition.config.runtime_id, "read_only", signal);
      const result = await runControllerProgram({
        options,
        runtimeStore,
        currentDefinition,
        origin: makeOrigin(options, "planner", null, sha256(encodeControllerRequest(request))),
        runtimeId: definition.config.runtime_id,
        executable: definition.config.executable,
        argv: definition.config.argv,
        adapterId: null,
        authority: definition.record.controller_authority,
        capability: "read_only",
        request,
        needsStaging: false,
        ...(signal === undefined ? {} : { signal }),
      });
      return decodeControllerResponse(result.stdout, request);
    },
    async invokeAdapter(
      action: Extract<ControllerAction, { readonly kind: "adapter" }>,
      requestDigest: string,
      signal?: AbortSignal,
    ) {
      const definition = await currentDefinition();
      if (
        requestDigest !== controllerActionRequestDigest(definition.record.definition_digest, action)
      )
        throw new Error("controller adapter request digest does not match the pinned action");
      const adapter = definition.config.adapters.find((entry) => entry.id === action.adapter_id);
      const authority = definition.record.adapter_authorities.find(
        (entry) => entry.adapter_id === action.adapter_id,
      );
      if (adapter === undefined || authority === undefined)
        throw new Error("controller adapter is not pinned");
      const source = await sourceInvocation(options, adapter, action);
      let executionStarted = false;
      let inputCleanup: "confirmed" | "unconfirmed" | "not-started" = "not-started";
      try {
        const adapterInputs = await adapterInput(options, definition, adapter, action);
        const input = adapterInputs.input;
        if (
          !Value.Check(adapterInputSchema, input) ||
          !checkSchema(schema(definition, adapter.input_schema_id), input)
        )
          throw new Error("controller adapter input does not match its approved schema");
        await ensurePrepared(adapter.runtime_id, adapter.capability, signal);
        const operationId = randomUUID();
        const origin = makeOrigin(options, "adapter", action.action_id, requestDigest, operationId);
        executionStarted = true;
        const result = await runControllerProgram({
          options,
          runtimeStore,
          currentDefinition,
          origin,
          runtimeId: adapter.runtime_id,
          executable: adapter.executable,
          argv: adapter.argv,
          adapterId: adapter.id,
          authority,
          capability: adapter.capability,
          request: input,
          needsStaging: true,
          ...(source === undefined ? {} : { source }),
          ...(signal === undefined ? {} : { signal }),
        });
        inputCleanup = "confirmed";
        if (result.staging === undefined)
          throw new Error("controller adapter staging was not created");
        await source?.verify();
        const envelopeBytes = source === undefined ? undefined : sourceEnvelope(source, result);
        if (adapter.capability === "private_staging") assertAcknowledgement(result.stdout);
        else
          await writeFile(result.staging.outputPath, envelopeBytes ?? result.stdout, {
            flag: "wx",
            mode: 0o600,
          });
        options.assertOpen();
        const artifact = await options.artifactStore.publish({
          staging: result.staging,
          binding: adapterBinding(
            definition,
            adapter,
            authority,
            action.action_id,
            requestDigest,
            origin,
            combineInputAudiences([adapterInputs.inputAudience, source?.inputAudience ?? null]),
            envelopeBytes !== undefined,
          ),
          assertPublicationOpen: () => {
            signal?.throwIfAborted();
            options.assertOpen();
          },
          validate: (bytes) => {
            const value =
              envelopeBytes === undefined
                ? parseJson(bytes, "controller adapter result")
                : sourceEnvelopeResult(parseJson(bytes, "source adapter envelope"));
            validateJsonDepth(value);
            if (value === null && result.execution.normalizedStatus !== 0) return;
            if (!checkSchema(schema(definition, adapter.output_schema_id), value))
              throw new Error("controller adapter result schema mismatch");
          },
        });
        return Object.freeze({ artifact, operationId });
      } catch (cause) {
        if (inputCleanup !== "confirmed") inputCleanup = cleanupCertainty(cause, executionStarted);
        throw cause;
      } finally {
        if (inputCleanup !== "unconfirmed") await source?.dispose();
      }
    },
  });
}

function makeOrigin(
  options: Readonly<CreateExecutableControllerHostOptions>,
  operationKind: "planner" | "adapter" | "preparation",
  actionId: string | null,
  requestSha256: string,
  operationId = randomUUID(),
) {
  return Object.freeze({
    kind: "controller_operation" as const,
    controller_id: options.approvedDefinition.record.controller_id,
    definition_digest: options.approvedDefinition.record.definition_digest,
    activation_id: options.activationId,
    owner_epoch: options.ownerEpoch,
    operation_id: operationId,
    operation_kind: operationKind,
    action_id: actionId,
    request_sha256: requestSha256,
  });
}
function schema(definition: ApprovedControllerDefinition, id: string): unknown {
  const found = definition.approval.schemas.find((entry) => entry.schema_id === id);
  if (found === undefined) throw new Error("controller adapter schema was revoked");
  return found.schema;
}
function checkSchema(value: unknown, input: unknown): boolean {
  try {
    return Value.Check(value as TSchema, input);
  } catch {
    return false;
  }
}
function parseJson(bytes: Buffer, label: string): unknown {
  if (bytes.length > MAX_JSON_BYTES) throw new Error(`${label} exceeds 1 MiB`);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
}
function validateJsonDepth(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error("controller JSON exceeds depth limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("controller JSON contains a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJsonDepth(item, depth + 1);
    return;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("controller JSON must contain plain objects");
  for (const item of Object.values(value)) validateJsonDepth(item, depth + 1);
}
function assertAcknowledgement(bytes: Buffer): void {
  const value = parseJson(bytes, "controller adapter staging acknowledgement");
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("output" in value) ||
    value.output !== "result.json"
  )
    throw new Error("controller staging adapter must acknowledge exactly result.json");
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cleanupCertainty(
  cause: unknown,
  executionStarted: boolean,
): "confirmed" | "unconfirmed" | "not-started" {
  if (cause instanceof ToolExecutionError) return cause.cleanup;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "terminal" in cause &&
    typeof cause.terminal === "object" &&
    cause.terminal !== null &&
    "cleanup" in cause.terminal &&
    (cause.terminal.cleanup === "confirmed" || cause.terminal.cleanup === "unconfirmed")
  )
    return cause.terminal.cleanup;
  return executionStarted ? "unconfirmed" : "not-started";
}

function assertActivation(options: Readonly<CreateExecutableControllerHostOptions>): void {
  if (
    options.activationId.length === 0 ||
    options.activationId.length > 256 ||
    !Number.isSafeInteger(options.ownerEpoch) ||
    options.ownerEpoch < 1
  )
    throw new Error("controller activation identity is invalid");
}
