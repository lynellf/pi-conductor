/** Consumer-aware immutable output resolution for controller inputs — issue #116 A4. */

import type { ControllerOutputPrincipal } from "../../manifest/controller-output.js";
import { reconstructChildOutputTimeline } from "../../persistence/child-output-timeline.js";
import type { PersistedRecord } from "../../persistence/log.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ChildOutputStore } from "./child-output-store.js";

const READ_CHUNK_BYTES = 32 * 1024;

/** Exact immutable bytes and the audience that constrained their resolution. */
export interface ResolvedControllerOutput {
  readonly ref: string;
  readonly format: "artifact/v1" | "child-output/v2";
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  /** Null means the legacy output has no private audience restriction. */
  readonly audience: readonly ControllerOutputPrincipal[] | null;
}

/** Resolve v1 controller artifacts and v2 child outputs for their actual principal. */
export function createControllerOutputResolver(options: {
  readonly artifactStore: Pick<ArtifactStore, "rangeReadForPrincipal">;
  readonly childOutputStore: Pick<ChildOutputStore, "read">;
  readonly records: () => readonly PersistedRecord[];
  readonly runId: string;
  readonly definitionDigest: string;
}): {
  readonly resolveRef: (
    ref: string,
    principal: ControllerOutputPrincipal,
  ) => Promise<ResolvedControllerOutput>;
  readonly getInputAudience: (
    ref: string,
    principal?: ControllerOutputPrincipal,
  ) => Promise<readonly ControllerOutputPrincipal[] | null>;
} {
  const resolveRef = async (
    ref: string,
    principal: ControllerOutputPrincipal,
  ): Promise<ResolvedControllerOutput> => {
    if (ref.startsWith("artifact/v1/")) return resolveV1(options, ref, principal);
    if (ref.startsWith("child-output/v2/")) return resolveV2(options, ref, principal);
    throw new Error("controller output reference is unsupported");
  };
  return Object.freeze({
    resolveRef,
    async getInputAudience(
      ref: string,
      principal: ControllerOutputPrincipal = { kind: "controller" },
    ): Promise<readonly ControllerOutputPrincipal[] | null> {
      const resolved = await resolveRef(ref, principal);
      return resolved.audience;
    },
  });
}

/** Identify the structured resolver result without accepting lookalike action data. */
export function isResolvedControllerOutput(value: unknown): value is ResolvedControllerOutput {
  return (
    value !== null &&
    typeof value === "object" &&
    "format" in value &&
    ((value as { readonly format?: unknown }).format === "artifact/v1" ||
      (value as { readonly format?: unknown }).format === "child-output/v2") &&
    "bytes" in value &&
    Buffer.isBuffer((value as { readonly bytes?: unknown }).bytes)
  );
}

async function resolveV1(
  options: Parameters<typeof createControllerOutputResolver>[0],
  ref: string,
  principal: ControllerOutputPrincipal,
): Promise<ResolvedControllerOutput> {
  const first = await options.artifactStore.rangeReadForPrincipal({
    ref,
    runId: options.runId,
    definitionDigest: options.definitionDigest,
    principal,
    offset: 0,
    length: 1,
  });
  const chunks = [first.bytes];
  for (let offset = first.bytes.byteLength; offset < first.byteLength; offset += READ_CHUNK_BYTES) {
    const chunk = await options.artifactStore.rangeReadForPrincipal({
      ref,
      runId: options.runId,
      definitionDigest: options.definitionDigest,
      principal,
      offset,
      length: Math.min(READ_CHUNK_BYTES, first.byteLength - offset),
    });
    chunks.push(chunk.bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== first.byteLength)
    throw new Error("controller artifact range read changed");
  return Object.freeze({
    ref,
    format: "artifact/v1",
    bytes,
    sha256: first.sha256,
    byteLength: first.byteLength,
    mediaType: first.mediaType,
    audience: first.binding.audience ?? null,
  });
}

async function resolveV2(
  options: Parameters<typeof createControllerOutputResolver>[0],
  ref: string,
  principal: ControllerOutputPrincipal,
): Promise<ResolvedControllerOutput> {
  const timeline = reconstructChildOutputTimeline(options.records());
  const descriptor = timeline.children
    .filter(
      (child) =>
        child.status === "published" &&
        child.publication?.type === "controller_child_output_published",
    )
    .flatMap((child) =>
      child.publication?.type === "controller_child_output_published"
        ? child.publication.outputs
        : [],
    )
    .find((output) => output.ref === ref);
  if (
    descriptor === undefined ||
    descriptor.binding.runId !== options.runId ||
    descriptor.binding.definitionDigest !== options.definitionDigest
  )
    throw new Error("child output reference is not durably published for this controller");
  const output = await options.childOutputStore.read({
    ref,
    principal,
    expectedBinding: descriptor.binding,
  });
  return Object.freeze({
    ref,
    format: "child-output/v2",
    bytes: output.bytes,
    sha256: output.sha256,
    byteLength: output.byteLength,
    mediaType: output.mediaType,
    audience: output.binding.audience,
  });
}
