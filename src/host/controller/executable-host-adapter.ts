/** Source-aware adapter inputs, envelopes, and immutable publication bindings — issue #118. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ControllerAdapterConfig } from "../../manifest/controller.js";
import type { ControllerOutputPrincipal } from "../../manifest/controller-output.js";
import type { ControllerAction } from "../../manifest/controller-protocol.js";
import { combineInputAudiences, intersectOutputAudience } from "../../manifest/output-audience.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { ApprovedControllerDefinition } from "./approved-definition.js";
import type { ArtifactBinding } from "./artifact-store.js";
import type {
  CreateExecutableControllerHostOptions,
  ProgramResult,
} from "./executable-host-contract.js";
import { isResolvedControllerOutput } from "./output-resolver.js";
import {
  materializeSourceAdapterInputs,
  type SourceAdapterInputs,
} from "./source-adapter-inputs.js";

type AdapterAction = Extract<ControllerAction, { readonly kind: "adapter" }>;
type SourceAdapterOptions = Pick<
  CreateExecutableControllerHostOptions,
  "runStateDir" | "resolveRef" | "openSourceWorkspace"
>;

/** Source mounts and their fresh authority check retained until publication. */
export interface SourceAdapterInvocation {
  readonly workspaceRoot: string;
  readonly readonlyInputs: readonly {
    readonly sourcePath: string;
    readonly destination: "/inputs" | "/source-git";
  }[];
  readonly scratchBytes: number;
  readonly timeoutMs: number;
  readonly inputAudience: readonly ControllerOutputPrincipal[] | null;
  readonly identity: {
    readonly ref: string;
    readonly sourceId: string;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly treeId: string;
    readonly inventoryDigest: string;
    readonly policyDigest: string;
  };
  verify(): Promise<void>;
  dispose(): Promise<void>;
}

/** Resolve the ordinary immutable controller outputs used in an adapter request. */
export async function adapterInput(
  options: Readonly<CreateExecutableControllerHostOptions>,
  definition: ApprovedControllerDefinition,
  adapter: ControllerAdapterConfig,
  action: AdapterAction,
): Promise<{
  readonly input: {
    readonly protocol_version: 1;
    readonly run_id: string;
    readonly controller_id: string;
    readonly definition_digest: string;
    readonly action_id: string;
    readonly input_refs: readonly { readonly ref: string; readonly value: unknown }[];
  };
  readonly inputAudience: readonly ControllerOutputPrincipal[] | null;
}> {
  const resolved = await Promise.all(
    action.input_refs.map(async (ref) => {
      const value = await options.resolveRef(ref, { kind: "adapter", adapter_id: adapter.id });
      const audience = isResolvedControllerOutput(value)
        ? value.audience
        : await options.getInputAudience?.(ref, { kind: "adapter", adapter_id: adapter.id });
      return Object.freeze({
        ref,
        value: isResolvedControllerOutput(value) ? adapterValue(value) : value,
        audience: audience ?? null,
      });
    }),
  );
  return Object.freeze({
    input: Object.freeze({
      protocol_version: 1 as const,
      run_id: definition.record.run_id,
      controller_id: definition.record.controller_id,
      definition_digest: definition.record.definition_digest,
      action_id: action.action_id,
      input_refs: Object.freeze(resolved.map(({ ref, value }) => Object.freeze({ ref, value }))),
    }),
    inputAudience: combineInputAudiences(resolved.map((entry) => entry.audience)),
  });
}

/** Open host-owned source authority and copy approved immutable file inputs. */
export async function sourceInvocation(
  options: Readonly<SourceAdapterOptions>,
  adapter: ControllerAdapterConfig,
  action: AdapterAction,
): Promise<SourceAdapterInvocation | undefined> {
  const wantsSource =
    action.source_workspace_ref !== undefined || action.file_input_refs !== undefined;
  if (!wantsSource) return undefined;
  if (adapter.source_policy === undefined)
    throw new Error("source adapter inputs require a pinned source policy");
  if (action.source_workspace_ref === undefined || options.openSourceWorkspace === undefined)
    throw new Error("source adapter workspace is unavailable");
  if ((action.file_input_refs?.length ?? 0) > adapter.source_policy.max_file_input_files)
    throw new Error("source adapter input file count exceeds policy");
  const principal = { kind: "adapter" as const, adapter_id: adapter.id };
  const source = await options.openSourceWorkspace(action.source_workspace_ref, principal);
  if (!adapter.source_policy.source_ids.includes(source.sourceId))
    throw new Error("source adapter workspace is outside pinned policy");
  const files = await Promise.all(
    (action.file_input_refs ?? []).map(async (entry) => {
      const value = await options.resolveRef(entry.ref, principal);
      if (!isResolvedControllerOutput(value))
        throw new Error("source adapter file input is not an immutable controller output");
      return { path: entry.path, bytes: value.bytes, audience: value.audience };
    }),
  );
  const materialized = await materializeFileInputs(options, adapter, action.action_id, files);
  const identity = Object.freeze({
    ref: source.ref,
    sourceId: source.sourceId,
    baseCommit: source.baseCommit,
    headCommit: source.headCommit,
    treeId: source.treeId,
    inventoryDigest: source.inventoryDigest,
    policyDigest: source.policyDigest,
  });
  const verify = async () => {
    const current = await options.openSourceWorkspace?.(identity.ref, principal);
    if (current === undefined || !sameSourceIdentity(current, identity))
      throw new Error("source adapter workspace changed before launch or publication");
    await materialized?.verify();
  };
  return Object.freeze({
    workspaceRoot: source.sourcePath,
    readonlyInputs: Object.freeze([
      ...(materialized === undefined
        ? []
        : [{ sourcePath: materialized.directory, destination: "/inputs" as const }]),
      ...(source.allowGitView
        ? [{ sourcePath: source.checkoutPath, destination: "/source-git" as const }]
        : []),
    ]),
    scratchBytes: adapter.source_policy.max_scratch_bytes,
    timeoutMs: adapter.source_policy.timeout_ms,
    inputAudience: combineInputAudiences([source.audience, ...files.map((file) => file.audience)]),
    identity,
    verify,
    dispose: async () => {
      await materialized?.dispose();
    },
  });
}

/** Build the auditable result envelope for a source-aware adapter invocation. */
export function sourceEnvelope(source: SourceAdapterInvocation, result: ProgramResult): Buffer {
  const payload =
    result.execution.normalizedStatus === 0
      ? parseJson(result.stdout, "source adapter result")
      : null;
  return Buffer.from(
    JSON.stringify({
      schema_version: 1,
      source: {
        ref: source.identity.ref,
        base_commit: source.identity.baseCommit,
        head_commit: source.identity.headCommit,
        tree_id: source.identity.treeId,
        inventory_digest: source.identity.inventoryDigest,
        policy_digest: source.identity.policyDigest,
      },
      execution: {
        execution_id: result.execution.executionId,
        normalized_status: result.execution.normalizedStatus,
        capture: result.execution.capture,
        cleanup: "confirmed",
      },
      result: payload,
    }),
  );
}

/** Extract a successful source envelope result for ordinary adapter output validation. */
export function sourceEnvelopeResult(value: unknown): unknown {
  if (value === null || typeof value !== "object" || !("result" in value))
    throw new Error("source adapter envelope is invalid");
  return value.result;
}

/** Bind immutable adapter output to every private input used by the fixed program. */
export function adapterBinding(
  definition: ApprovedControllerDefinition,
  adapter: ControllerAdapterConfig,
  authority: ApprovedControllerDefinition["record"]["adapter_authorities"][number],
  actionId: string,
  requestDigest: string,
  origin: { readonly operation_id: string },
  inputAudience: readonly ControllerOutputPrincipal[] | null,
  sourceEnvelope = false,
): ArtifactBinding {
  const output = definition.approval.schemas.find(
    (entry) => entry.schema_id === adapter.output_schema_id,
  );
  if (output === undefined) throw new Error("controller output schema was revoked");
  const requestedAudience =
    adapter.effect_id === undefined
      ? (adapter.output_consumers ?? legacyAudience(definition))
      : (adapter.output_consumers ?? []);
  const audience = intersectOutputAudience(requestedAudience, inputAudience);
  return Object.freeze({
    runId: definition.record.run_id,
    definitionDigest: definition.record.definition_digest,
    actionId,
    requestDigest,
    producer: { kind: "operation" as const, operationId: origin.operation_id, requestDigest },
    outputSchema: sourceEnvelope
      ? {
          id: "source-adapter-envelope-v1",
          digest: sha256Canonical({ schema_version: 1, kind: "source-adapter-envelope" }),
        }
      : { id: adapter.output_schema_id, digest: output.schema_digest },
    capabilityDigest: authority.capability_digest,
    mediaType: "application/json" as const,
    allowedConsumerProfileIds: Object.freeze([...definition.config.delegation.allowed_subagents]),
    ...(adapter.output_consumers !== undefined ||
    inputAudience !== null ||
    adapter.effect_id !== undefined
      ? { audience: Object.freeze([...audience]) }
      : {}),
  });
}

function adapterValue(value: import("./output-resolver.js").ResolvedControllerOutput): unknown {
  if (value.format === "artifact/v1") return parseJson(value.bytes, "controller adapter input");
  return Object.freeze({
    encoding: "base64",
    data: value.bytes.toString("base64"),
    sha256: value.sha256,
    byte_length: value.byteLength,
    media_type: value.mediaType,
  });
}

async function materializeFileInputs(
  options: Readonly<SourceAdapterOptions>,
  adapter: ControllerAdapterConfig,
  actionId: string,
  files: readonly { readonly path: string; readonly bytes: Buffer }[],
): Promise<SourceAdapterInputs | undefined> {
  if (files.length === 0) return undefined;
  if (adapter.source_policy === undefined) throw new Error("source adapter policy is absent");
  const root = await mkdtemp(join(options.runStateDir, `source-adapter-inputs-${actionId}-`));
  let inputs: SourceAdapterInputs | undefined;
  try {
    inputs = await materializeSourceAdapterInputs({
      root,
      files,
      maxFiles: adapter.source_policy.max_file_input_files,
      maxBytes: adapter.source_policy.max_file_input_bytes,
    });
    await writeFile(
      join(root, "README"),
      `Private source-adapter inputs retained for action ${actionId}; inspect before repair or replay.\n`,
      { flag: "wx", mode: 0o400 },
    );
    return inputs;
  } catch (cause) {
    if (inputs === undefined) await rm(root, { recursive: true, force: true });
    else await inputs.dispose();
    throw cause;
  }
}

function sameSourceIdentity(
  current: Awaited<
    ReturnType<NonNullable<CreateExecutableControllerHostOptions["openSourceWorkspace"]>>
  >,
  expected: SourceAdapterInvocation["identity"],
): boolean {
  return (
    current.ref === expected.ref &&
    current.sourceId === expected.sourceId &&
    current.baseCommit === expected.baseCommit &&
    current.headCommit === expected.headCommit &&
    current.treeId === expected.treeId &&
    current.inventoryDigest === expected.inventoryDigest &&
    current.policyDigest === expected.policyDigest
  );
}

function legacyAudience(
  definition: ApprovedControllerDefinition,
): readonly ControllerOutputPrincipal[] {
  return Object.freeze([
    { kind: "controller" },
    ...definition.config.delegation.allowed_subagents.map((profile_id) => ({
      kind: "native" as const,
      profile_id,
    })),
    ...definition.config.adapters.map((adapter) => ({
      kind: "adapter" as const,
      adapter_id: adapter.id,
    })),
  ]);
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
}
