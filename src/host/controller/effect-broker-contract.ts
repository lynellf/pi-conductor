/** Narrow injected boundaries for the host-owned controller effect broker — issue #116 B4. */
import type { GitIntegrateRequest, GitPromoteRequest } from "../../manifest/controller-effect.js";
import type {
  ControllerEffectRecord,
  EffectRequestArtifact,
} from "../../persistence/controller-effect-records.js";
import type {
  EffectGrant,
  PinnedEffectAuthority,
  SupportedEffectImplementation,
} from "./effect-registry.js";
import type {
  GitEffectPrepared,
  ResolvedGitPatch,
  SelectedSourceArtifact,
  VerifiedHeadEvidence,
} from "./git-effect.js";

export interface ResolvedEffectRequestArtifact {
  readonly artifact: EffectRequestArtifact;
  readonly bytes: Buffer;
}
export interface PublishedIntegratedSource {
  readonly ref: string;
  readonly sha256: string;
}
export interface EffectBrokerDependencies {
  readonly runId: string;
  readonly controllerId: string;
  readonly definitionDigest: string;
  readonly activationId: string;
  readonly ownerEpoch: number;
  readonly isKnownOwner: (activationId: string, ownerEpoch: number) => boolean;
  readonly records: () => readonly unknown[];
  readonly append: (record: ControllerEffectRecord) => void | Promise<void>;
  readonly assertActionIntent: (actionId: string, adapterId: string) => void;
  readonly resolveRequestArtifact: (
    artifact: EffectRequestArtifact,
  ) => Promise<ResolvedEffectRequestArtifact>;
  readonly currentEffectGrants: () => Promise<readonly unknown[]>;
  readonly pinnedAuthority: (effectId: string) => PinnedEffectAuthority;
  readonly currentSupportedImplementations: () => Promise<readonly SupportedEffectImplementation[]>;
  readonly resolvePatch: (
    effectId: string,
    claim: GitIntegrateRequest["patches"][number],
  ) => Promise<ResolvedGitPatch>;
  readonly resolveHeadEvidence: (
    effectId: string,
    claim: GitPromoteRequest["evidence"][number],
  ) => Promise<VerifiedHeadEvidence>;
  readonly publishIntegratedSource: (
    effectId: string,
    operationId: string,
    selected: SelectedSourceArtifact,
  ) => Promise<PublishedIntegratedSource>;
  readonly workspaceRoot: string;
  readonly credentialFiles: Readonly<Record<string, string>>;
  readonly assertOpen: () => void;
  readonly now?: () => number;
  readonly executors?: EffectBrokerExecutors;
}
export interface ExecuteControllerEffectInput {
  readonly actionId: string;
  readonly adapterId: string;
  readonly effectId: string;
  readonly requestArtifact: EffectRequestArtifact;
  readonly pinnedAuthority: PinnedEffectAuthority;
  readonly signal?: AbortSignal;
}
export interface EffectBrokerExecutors {
  readonly integrate?: typeof import("./git-effect.js").integrateGitEffect;
  readonly promote?: typeof import("./git-effect.js").promoteGitEffect;
  readonly reconcileGit?: typeof import("./git-effect.js").reconcileGitEffect;
  readonly deliver?: typeof import("./remote-effect.js").executeRemoteEffect;
  readonly reconcileRemote?: typeof import("./remote-effect.js").reconcileRemoteEffect;
  readonly verifyDeliverySource?: typeof import("./git-effect.js").assertDeliverySource;
}
export interface ControllerEffectBroker {
  execute(input: ExecuteControllerEffectInput): Promise<ControllerEffectRecord>;
  reconcile(operationId: string, signal?: AbortSignal): Promise<ControllerEffectRecord>;
}

export class EffectBrokerPoisonedError extends Error {
  constructor(message = "effect journal persistence is ambiguous") {
    super(message);
    this.name = "EffectBrokerPoisonedError";
  }
}

export type CurrentEffectGrant = EffectGrant;
export type PreparedEffect = GitEffectPrepared;
