/**
 * Verified artifact resolution and publication for protected controller effects — issue #116.
 * Kept below 500 lines as one manifest-binding boundary: resolving producer evidence and
 * publishing operation slots share the exact action/schema identity contract. Keeping that
 * interpretation here avoids separate readers and writers disagreeing about effect artifacts.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { EffectResult, GitIntegrateRequest } from "../../manifest/controller-effect.js";
import type { ControllerOutputPrincipal } from "../../manifest/controller-output.js";
import { outputPrincipalKey } from "../../manifest/output-audience.js";
import type { ChildOutputArtifactDescriptor } from "../../persistence/child-output-artifact.js";
import { reconstructChildOutputTimeline } from "../../persistence/child-output-timeline.js";
import {
  getControllerAction,
  reconstructControllerTimeline,
} from "../../persistence/controller-timeline.js";
import type { PersistedRecord } from "../../persistence/log.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { ArtifactBinding, ArtifactStore, PublishedArtifact } from "./artifact-store.js";
import type { ControllerAdapterInvocationResult } from "./executable-host-contract.js";
import type {
  ResolvedGitPatch,
  SelectedSourceArtifact,
  VerifiedHeadEvidence,
} from "./git-effect.js";
import type { ResolvedControllerOutput } from "./output-resolver.js";

const MAX_READ = 1_048_576;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface EffectArtifactContext {
  readonly runId: string;
  readonly definitionDigest: string;
  readonly actionId: string;
  readonly adapterId: string;
  readonly effectId: string;
}

/** Prove that an adapter result is the immutable request artifact for this exact action. */
export function effectRequestArtifact(
  context: EffectArtifactContext,
  invocation: ControllerAdapterInvocationResult,
  expectedSchema: { readonly id: string; readonly digest: string },
) {
  const binding = invocation.artifact.binding;
  if (
    binding.runId !== context.runId ||
    binding.definitionDigest !== context.definitionDigest ||
    binding.actionId !== context.actionId ||
    binding.publication !== undefined ||
    binding.producer.kind !== "operation" ||
    binding.producer.operationId !== invocation.operationId ||
    binding.outputSchema.id !== expectedSchema.id ||
    binding.outputSchema.digest !== expectedSchema.digest ||
    invocation.artifact.sha256.length !== 64
  )
    throw new Error("effect request artifact identity is invalid");
  return Object.freeze({
    ref: invocation.artifact.ref,
    sha256: invocation.artifact.sha256,
    byte_length: invocation.artifact.byteLength,
    producer: {
      adapter_id: context.adapterId,
      action_id: context.actionId,
      operation_id: invocation.operationId,
    },
    schema: expectedSchema,
    run_id: context.runId,
    definition_digest: context.definitionDigest,
  });
}

/** Read and rebind a v1 artifact to its complete immutable manifest. */
export async function readEffectArtifact(
  store: Pick<ArtifactStore, "rangeReadForPrincipal">,
  context: Pick<EffectArtifactContext, "runId" | "definitionDigest" | "effectId">,
  artifact: { readonly ref: string; readonly sha256: string; readonly byte_length: number },
): Promise<{ readonly bytes: Buffer; readonly binding: ArtifactBinding }> {
  if (artifact.byte_length < 1 || artifact.byte_length > MAX_READ)
    throw new Error("effect artifact size is invalid");
  const principal = { kind: "effect", effect_id: context.effectId } as const;
  const chunks: Buffer[] = [];
  let binding: ArtifactBinding | undefined;
  for (let offset = 0; offset < artifact.byte_length; offset += 32 * 1024) {
    const part = await store.rangeReadForPrincipal({
      ref: artifact.ref,
      runId: context.runId,
      definitionDigest: context.definitionDigest,
      principal,
      offset,
      length: Math.min(32 * 1024, artifact.byte_length - offset),
    });
    binding ??= part.binding;
    if (part.sha256 !== artifact.sha256 || part.byteLength !== artifact.byte_length)
      throw new Error("effect artifact metadata changed");
    chunks.push(part.bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (
    binding === undefined ||
    bytes.byteLength !== artifact.byte_length ||
    digest(bytes) !== artifact.sha256
  )
    throw new Error("effect artifact bytes do not match metadata");
  return Object.freeze({ bytes, binding });
}

/** Resolve a native patch only from its durable v2 descriptor and pinned producer policy. */
export async function resolveEffectPatch(options: {
  readonly claim: GitIntegrateRequest["patches"][number];
  readonly effectId: string;
  readonly records: readonly PersistedRecord[];
  readonly resolveRef: (
    ref: string,
    principal: ControllerOutputPrincipal,
  ) => Promise<ResolvedControllerOutput>;
  readonly allowedProfiles: ReadonlyMap<string, readonly string[]>;
  readonly resolveEvidence: (
    claim: GitIntegrateRequest["patches"][number]["evidence"][number],
  ) => Promise<VerifiedHeadEvidence>;
}): Promise<ResolvedGitPatch> {
  const descriptor = childDescriptor(options.records, options.claim.artifact_ref);
  const binding = descriptor.binding;
  const paths = options.allowedProfiles.get(binding.producerProfileId);
  if (
    descriptor.sha256 !== options.claim.sha256 ||
    descriptor.media_type !== "application/x-git-patch" ||
    binding.output.kind !== "patch" ||
    binding.acceptedBase !== options.claim.base_commit ||
    paths === undefined
  )
    throw new Error("effect patch is not a pinned native patch publication");
  const resolved = await options.resolveRef(descriptor.ref, {
    kind: "effect",
    effect_id: options.effectId,
  });
  if (resolved.sha256 !== descriptor.sha256 || digest(resolved.bytes) !== descriptor.sha256)
    throw new Error("effect patch bytes do not match their durable descriptor");
  const evidence = await Promise.all(options.claim.evidence.map(options.resolveEvidence));
  return Object.freeze({
    bytes: resolved.bytes,
    sha256: descriptor.sha256,
    baseCommit: binding.acceptedBase,
    allowedPaths: Object.freeze([...paths]),
    evidence: Object.freeze(
      evidence.map((entry, index) => {
        const claim = options.claim.evidence[index];
        if (claim === undefined || entry.subjectHead !== claim.subject_digest)
          throw new Error("patch evidence is not bound to the patch digest");
        return Object.freeze({ ...entry, subjectDigest: claim.subject_digest });
      }),
    ),
  });
}

/** Parse closed approval evidence after its audience and immutable metadata were verified. */
export function parseHeadEvidence(
  bytes: Buffer,
  claim: {
    readonly artifact_ref: string;
    readonly sha256: string;
    readonly producer_id: string;
    readonly schema_id: string;
    readonly subject_head: string;
  },
): VerifiedHeadEvidence {
  if (digest(bytes) !== claim.sha256) throw new Error("effect evidence digest mismatch");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schema_version", "subject_head", "verdict"]) ||
    value.schema_version !== 1 ||
    value.subject_head !== claim.subject_head ||
    value.verdict !== "approved"
  )
    throw new Error("effect evidence payload is invalid");
  return Object.freeze({
    artifactRef: claim.artifact_ref,
    sha256: claim.sha256,
    producerId: claim.producer_id,
    schemaId: claim.schema_id,
    subjectHead: claim.subject_head,
    verdict: "approved",
  });
}

/** Parse a closed patch-review verdict bound to exact patch bytes. */
export function parseDigestEvidence(
  bytes: Buffer,
  claim: {
    readonly artifact_ref: string;
    readonly sha256: string;
    readonly producer_id: string;
    readonly schema_id: string;
    readonly subject_digest: string;
  },
): VerifiedHeadEvidence {
  if (digest(bytes) !== claim.sha256) throw new Error("effect evidence digest mismatch");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schema_version", "subject_digest", "verdict"]) ||
    value.schema_version !== 1 ||
    value.subject_digest !== claim.subject_digest ||
    value.verdict !== "approved"
  )
    throw new Error("effect evidence payload is invalid");
  return Object.freeze({
    artifactRef: claim.artifact_ref,
    sha256: claim.sha256,
    producerId: claim.producer_id,
    schemaId: claim.schema_id,
    subjectHead: claim.subject_digest,
    verdict: "approved",
  });
}

/** Resolve approval evidence from actual durable producer and schema metadata. */
export async function resolveEffectEvidence(options: {
  readonly claim: {
    readonly artifact_ref: string;
    readonly sha256: string;
    readonly producer_id: string;
    readonly schema_id: string;
  } & ({ readonly subject_head: string } | { readonly subject_digest: string });
  readonly effectId: string;
  readonly runId: string;
  readonly definitionDigest: string;
  readonly records: readonly PersistedRecord[];
  readonly artifacts: Pick<ArtifactStore, "rangeReadForPrincipal">;
  readonly resolveRef: (
    ref: string,
    principal: ControllerOutputPrincipal,
  ) => Promise<ResolvedControllerOutput>;
  readonly adapterSchemas: ReadonlyMap<string, { readonly id: string; readonly digest: string }>;
}): Promise<VerifiedHeadEvidence> {
  const principal = { kind: "effect", effect_id: options.effectId } as const;
  if (options.claim.artifact_ref.startsWith("child-output/v2/")) {
    const descriptor = childDescriptor(options.records, options.claim.artifact_ref);
    if (
      descriptor.sha256 !== options.claim.sha256 ||
      descriptor.binding.producerProfileId !== options.claim.producer_id ||
      descriptor.binding.output.kind !== "report" ||
      descriptor.binding.output.id !== options.claim.schema_id ||
      descriptor.media_type !== "application/json"
    )
      throw new Error("native effect evidence producer or schema is not verified");
    const resolved = await options.resolveRef(descriptor.ref, principal);
    return "subject_head" in options.claim
      ? parseHeadEvidence(resolved.bytes, options.claim)
      : parseDigestEvidence(resolved.bytes, options.claim);
  }
  const first = await options.artifacts.rangeReadForPrincipal({
    ref: options.claim.artifact_ref,
    runId: options.runId,
    definitionDigest: options.definitionDigest,
    principal,
    offset: 0,
    length: 1,
  });
  const producer = adapterProducer(
    options.records,
    first.binding.actionId,
    options.claim.artifact_ref,
  );
  const schema = options.adapterSchemas.get(producer.adapterId);
  if (
    first.sha256 !== options.claim.sha256 ||
    first.binding.outputSchema.id !== options.claim.schema_id ||
    first.binding.outputSchema.id !== schema?.id ||
    first.binding.outputSchema.digest !== schema.digest ||
    producer.adapterId !== options.claim.producer_id ||
    first.binding.publication !== undefined ||
    first.binding.producer.kind !== "operation" ||
    first.binding.producer.operationId !== producer.operationId
  )
    throw new Error("adapter effect evidence producer or schema is not verified");
  const resolved = await options.resolveRef(options.claim.artifact_ref, principal);
  return "subject_head" in options.claim
    ? parseHeadEvidence(resolved.bytes, options.claim)
    : parseDigestEvidence(resolved.bytes, options.claim);
}

/** Publish selected integrated source with an explicit default-deny audience. */
export async function publishEffectSource(
  options: PublicationOptions & {
    readonly selected: SelectedSourceArtifact;
    readonly consumers: readonly ControllerOutputPrincipal[];
  },
): Promise<{ readonly ref: string; readonly sha256: string }> {
  const document = {
    schema_version: 1,
    integrated_head: options.selected.integratedHead,
    files: options.selected.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      sha256: file.sha256,
      encoding: "base64",
      data: file.bytes.toString("base64"),
    })),
  };
  const published = await publishJson(
    options,
    "effect_source",
    "effect-integrated-source-v1",
    document,
    options.consumers,
  );
  return Object.freeze({ ref: published.ref, sha256: published.sha256 });
}

/** Publish a closed typed result without copying request or credential bytes. */
export async function publishEffectResult(
  options: PublicationOptions & {
    readonly result: EffectResult;
    readonly consumers: readonly ControllerOutputPrincipal[];
    readonly outputSchema: { readonly id: string; readonly digest: string };
  },
): Promise<PublishedArtifact> {
  return publishJson(
    options,
    "effect_result",
    options.outputSchema,
    options.result,
    options.consumers,
  );
}

interface PublicationOptions extends EffectArtifactContext {
  readonly operationId: string;
  readonly requestDigest: string;
  readonly artifacts: Pick<ArtifactStore, "createStaging" | "publish">;
  readonly assertOpen: () => void;
}

async function publishJson(
  options: PublicationOptions,
  kind: "effect_source" | "effect_result",
  schema: string | { readonly id: string; readonly digest: string },
  value: unknown,
  audience: readonly ControllerOutputPrincipal[],
): Promise<PublishedArtifact> {
  const bytes = Buffer.from(JSON.stringify(value));
  const staging = await options.artifacts.createStaging(options.actionId);
  await writeFile(staging.outputPath, bytes, { flag: "wx", mode: 0o600 });
  const outputSchema =
    typeof schema === "string"
      ? { id: schema, digest: sha256Canonical({ schema_id: schema, version: 1 }) }
      : schema;
  return options.artifacts.publish({
    staging,
    binding: {
      runId: options.runId,
      definitionDigest: options.definitionDigest,
      actionId: options.actionId,
      requestDigest: options.requestDigest,
      producer: {
        kind: "operation",
        operationId: options.operationId,
        requestDigest: options.requestDigest,
      },
      outputSchema,
      capabilityDigest: sha256Canonical({ kind, effect_id: options.effectId }),
      mediaType: "application/json",
      allowedConsumerProfileIds: [],
      audience: [...audience],
      publication: { kind, operationId: options.operationId, effectId: options.effectId },
    },
    validate: (candidate) => {
      if (digest(candidate) !== digest(bytes)) throw new Error("effect publication changed");
    },
    assertPublicationOpen: options.assertOpen,
  });
}

function childDescriptor(
  records: readonly PersistedRecord[],
  ref: string,
): ChildOutputArtifactDescriptor {
  const matches = reconstructChildOutputTimeline(records).children.flatMap((child) =>
    child.publication?.type === "controller_child_output_published"
      ? child.publication.outputs.filter((entry) => entry.ref === ref)
      : [],
  );
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error("effect patch has no unique durable publication");
  return matches[0];
}
/** Return the immutable audience attached to one durably published native patch. */
export function effectPatchAudience(
  records: readonly PersistedRecord[],
  ref: string,
): readonly ControllerOutputPrincipal[] {
  return Object.freeze([...childDescriptor(records, ref).binding.audience]);
}
/** Intersect one operation's requested source consumers with every exact patch audience. */
export function intersectEffectConsumers(
  requested: readonly ControllerOutputPrincipal[],
  patchAudiences: readonly (readonly ControllerOutputPrincipal[])[],
): readonly ControllerOutputPrincipal[] {
  const allowed = patchAudiences.map((audience) => new Set(audience.map(outputPrincipalKey)));
  return Object.freeze(
    requested.filter((principal) =>
      allowed.every((audience) => audience.has(outputPrincipalKey(principal))),
    ),
  );
}
function adapterProducer(
  records: readonly PersistedRecord[],
  actionId: string,
  artifactRef: string,
) {
  const action = getControllerAction(reconstructControllerTimeline(records), actionId);
  if (action?.intent.request.kind === "adapter") {
    const receipts = action.receipts.filter(
      (receipt) =>
        receipt.outcome === "completed" &&
        receipt.operation_id !== null &&
        receipt.result_refs.includes(artifactRef),
    );
    const receipt = receipts[0];
    if (receipts.length !== 1 || receipt?.operation_id === null || receipt === undefined)
      throw new Error("adapter evidence has no unique durable producer operation");
    return {
      adapterId: action.intent.request.adapter_id,
      operationId: receipt.operation_id,
    };
  }
  throw new Error("adapter evidence has no durable producer action");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
