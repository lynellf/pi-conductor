/** Production consumer resolution and native output assembly — issue #116. */
import { join } from "node:path";
import type { ControllerConfig } from "../../manifest/controller.js";
import type { ControllerActivationStartedRecord } from "../../persistence/controller-records.js";
import type { PersistedRecord } from "../../persistence/log.js";
import type { HostArtifactContextResolver } from "../delegation/context-artifact-contract.js";
import type { ArtifactStore } from "./artifact-store.js";
import { createChildOutputPublication } from "./child-output-publication.js";
import { ChildOutputStore } from "./child-output-store.js";
import { createControllerOutputResolver } from "./output-resolver.js";

export interface OpenedProductionOutputs {
  readonly store: ChildOutputStore;
  readonly resolver: ReturnType<typeof createControllerOutputResolver>;
}

/** Open read-capable output stores before recovery creates a successor activation. */
export async function openProductionOutputs(options: {
  readonly runId: string;
  readonly definitionDigest: string;
  readonly runStateDir: string;
  readonly artifacts: ArtifactStore;
  readonly records: () => readonly PersistedRecord[];
  readonly assertOpen: () => void;
}): Promise<OpenedProductionOutputs> {
  const store = await ChildOutputStore.open({
    root: join(options.runStateDir, "child-outputs"),
    assertPublicationOpen: options.assertOpen,
  });
  const resolver = createControllerOutputResolver({
    artifactStore: options.artifacts,
    childOutputStore: store,
    records: options.records,
    runId: options.runId,
    definitionDigest: options.definitionDigest,
  });
  return Object.freeze({ store, resolver });
}

/** Construct only host-owned stores and resolvers; callers begin recovery after session wiring. */
export async function createProductionOutputs(options: {
  readonly activation: ControllerActivationStartedRecord;
  readonly config: ControllerConfig;
  readonly runStateDir: string;
  readonly artifacts: ArtifactStore;
  readonly records: () => readonly PersistedRecord[];
  readonly persist: (record: PersistedRecord) => void;
  readonly assertOpen: () => void;
  readonly wake: () => void;
  readonly onFatal: (cause: unknown) => void;
  readonly opened?: OpenedProductionOutputs;
}) {
  const { store, resolver } =
    options.opened ??
    (await openProductionOutputs({
      runId: options.activation.run_id,
      definitionDigest: options.activation.definition_digest,
      runStateDir: options.runStateDir,
      artifacts: options.artifacts,
      records: options.records,
      assertOpen: options.assertOpen,
    }));
  const publication = createChildOutputPublication({
    ...options,
    store,
    inputAudience: resolver.getInputAudience,
  });
  const hostArtifactResolver: HostArtifactContextResolver = {
    async resolve(input) {
      const principal = { kind: "native" as const, profile_id: input.consumerProfileId };
      const output = await resolver.resolveRef(input.ref, principal);
      if (output.byteLength > input.maxBytes)
        throw new Error("controller artifact exceeds admitted context limit");
      let producingActionId: string;
      if (output.format === "artifact/v1") {
        const first = await options.artifacts.rangeReadForPrincipal({
          ref: input.ref,
          runId: options.activation.run_id,
          definitionDigest: options.activation.definition_digest,
          principal,
          offset: 0,
          length: 1,
        });
        producingActionId = first.binding.actionId;
      } else {
        const published = options
          .records()
          .find(
            (record) =>
              record.type === "controller_child_output_published" &&
              record.outputs.some((item) => item.ref === input.ref),
          );
        if (published?.type !== "controller_child_output_published")
          throw new Error("child output provenance unavailable");
        const accepted = options
          .records()
          .find(
            (record) =>
              record.type === "delegation_submission_accepted" &&
              record.children.some((item) => item.child_id === published.child_id),
          );
        if (
          accepted?.type !== "delegation_submission_accepted" ||
          accepted.schema_version !== 2 ||
          accepted.origin.kind !== "controller_action"
        )
          throw new Error("child output producing action unavailable");
        producingActionId = accepted.origin.action_id;
      }
      if (
        ![
          "application/json",
          "text/plain",
          "text/markdown",
          "application/octet-stream",
          "application/x-git-patch",
        ].includes(output.mediaType)
      )
        throw new Error("unsupported native context media type");
      return {
        bytes: output.bytes,
        sha256: output.sha256,
        byteLength: output.byteLength,
        producingActionId,
        mediaType: output.mediaType as Awaited<
          ReturnType<HostArtifactContextResolver["resolve"]>
        >["mediaType"],
      };
    },
  };
  return { store, resolver, publication, hostArtifactResolver };
}
