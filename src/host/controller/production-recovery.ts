/** Recovery assembly that reconciles effects before creating a successor activation — issue #116. */
import type { PersistedRecord } from "../../persistence/log.js";
import { ControllerActivationFence } from "./activation-fence.js";
import type { ApprovedControllerDefinition } from "./approved-definition.js";
import type { ArtifactStore } from "./artifact-store.js";
import { ArtifactStore as ControllerArtifactStore } from "./artifact-store.js";
import type { ControllerHostApproval } from "./host-approval.js";
import { createProductionEffects } from "./production-effects.js";
import type { OpenedProductionOutputs } from "./production-outputs.js";
import { openProductionOutputs } from "./production-outputs.js";
import { createProductionSources } from "./production-sources.js";
import { planControllerRecovery } from "./recovery.js";

/** Open both artifact stores and finish reconciliation before successor activation planning. */
export async function openAndPrepareProductionRecovery(
  options: Omit<Parameters<typeof prepareProductionRecovery>[0], "artifacts" | "outputs"> & {
    readonly artifactRoot: string;
    readonly assertOpen: () => void;
  },
) {
  const artifacts = await ControllerArtifactStore.open({
    root: options.artifactRoot,
    assertPublicationOpen: options.assertOpen,
  });
  const outputs = await openProductionOutputs({
    runId: options.definition.record.run_id,
    definitionDigest: options.definition.record.definition_digest,
    runStateDir: options.runStateDir,
    artifacts,
    records: options.records,
    assertOpen: options.assertOpen,
  });
  const recovery = await prepareProductionRecovery({ ...options, artifacts, outputs });
  return Object.freeze({ artifacts, outputs, recovery });
}

/** Reconcile old effect journals under their owner fence, then plan from refreshed records. */
export async function prepareProductionRecovery(options: {
  readonly definition: ApprovedControllerDefinition;
  readonly artifacts: ArtifactStore;
  readonly outputs: OpenedProductionOutputs;
  readonly records: () => readonly PersistedRecord[];
  readonly persist: (record: PersistedRecord) => void;
  readonly loadApproval: () => Promise<ControllerHostApproval>;
  readonly runStateDir: string;
}) {
  const initial = options.records();
  const latestActivation = [...initial]
    .reverse()
    .find((record) => record.type === "controller_activation_started");
  const sources =
    (options.definition.config.source_repositories?.length ?? 0) === 0
      ? undefined
      : await createProductionSources({
          ...options,
          outputResolver: options.outputs.resolver,
          assertOpen: () => {
            throw new Error("recovery cannot prepare sources");
          },
        });
  let recoverEffectAction:
    | Awaited<ReturnType<typeof createProductionEffects>>["recoverEffectAction"]
    | undefined;
  if (
    latestActivation?.type === "controller_activation_started" &&
    options.definition.config.adapters.some((adapter) => adapter.effect_id !== undefined)
  ) {
    const fence = new ControllerActivationFence(latestActivation, options.records);
    const persist = (record: PersistedRecord): void => {
      fence.assertAppend(record);
      options.persist(record);
    };
    const approval = await options.loadApproval();
    const effects = await createProductionEffects({
      definition: options.definition,
      activation: latestActivation,
      artifacts: options.artifacts,
      outputResolver: options.outputs.resolver,
      records: options.records,
      persist,
      loadApproval: options.loadApproval,
      runStateDir: options.runStateDir,
      assertOpen: () => fence.assertOpen(),
      credentialFiles: Object.fromEntries(
        (approval.credential_sources ?? []).map((entry) => [entry.id, entry.path]),
      ),
      ...(sources === undefined
        ? {}
        : {
            resolveSourceWorkspace: (ref: string) =>
              sources.openSourceWorkspace(ref, { kind: "controller" }),
          }),
    });
    recoverEffectAction = effects.recoverEffectAction;
  }
  const recoveryArtifacts = {
    ...(sources === undefined ? {} : { recoverSourceAction: sources.recoverSourceAction }),
    recoverAction: options.artifacts.recoverAction.bind(options.artifacts),
    recoverActionPayload: options.artifacts.recoverActionPayload.bind(options.artifacts),
    rangeReadForController: options.artifacts.rangeReadForController.bind(options.artifacts),
    getInputAudience: async (
      ref: string,
      principal: import("../../manifest/controller-output.js").ControllerOutputPrincipal,
    ) =>
      ref.startsWith("source-workspace/v1/") && sources !== undefined
        ? (await sources.openSourceWorkspace(ref, principal)).audience
        : ref.startsWith("artifact/v1/") || ref.startsWith("child-output/v2/")
          ? options.outputs.resolver.getInputAudience(ref, principal)
          : null,
    ...(recoverEffectAction === undefined ? {} : { recoverEffectAction }),
  };
  const first = await planControllerRecovery({
    approvedDefinition: options.definition,
    records: initial,
    artifacts: recoveryArtifacts,
  });
  if (options.records().length === initial.length) return first;
  return planControllerRecovery({
    approvedDefinition: options.definition,
    records: options.records(),
    artifacts: recoveryArtifacts,
  });
}
