/** Contracts shared by executable host dispatch, preparation, and program modules. */
import type { ControllerAdapterConfig } from "../../manifest/controller.js";
import type {
  ControllerAction,
  ControllerRequest,
  ControllerResponse,
} from "../../manifest/controller-protocol.js";
import type { ControllerSandboxExecutionOwner } from "../../persistence/sandbox-execution.js";
import type { ControllerExecutionOrigin } from "../../persistence/tool-execution-origin.js";
import type { HostApprovedBubblewrapBuild } from "../execution/sandbox/prerequisites.js";
import type { RuntimeHostProtection } from "../execution/sandbox/runtime-types.js";
import type {
  ToolExecutionRunOptions,
  ToolExecutionScope,
} from "../execution/tool-execution-controller.js";
import type { SandboxToolExecutionAdapter } from "../execution/tool-execution-lifecycle.js";
import type { ApprovedControllerDefinition } from "./approved-definition.js";
import type { ArtifactStaging, ArtifactStore, PublishedArtifact } from "./artifact-store.js";
import type { ControllerHostApproval } from "./host-approval.js";
import type { ControllerRuntimeStore } from "./runtime-store.js";

export interface ControllerSandboxHostApproval {
  readonly binaryPath: string;
  readonly approvedBuilds: readonly HostApprovedBubblewrapBuild[];
  readonly getcapPath?: string;
  readonly probeApproval: { readonly approvalId: string; readonly sha256: string };
}
export interface ControllerExecutionDriver {
  runController<T>(
    origin: ControllerExecutionOrigin,
    operation: (scope: ToolExecutionScope) => Promise<T>,
    options?: ToolExecutionRunOptions,
  ): Promise<T>;
  runControllerLifecycle<T>(
    origin: ControllerExecutionOrigin,
    owner: ControllerSandboxExecutionOwner,
    adapter: SandboxToolExecutionAdapter<T>,
    options?: ToolExecutionRunOptions,
  ): Promise<T>;
}
export interface CreateExecutableControllerHostOptions {
  readonly approvedDefinition: ApprovedControllerDefinition;
  readonly getCurrentApproval: () => Promise<ControllerHostApproval>;
  readonly runStateDir: string;
  readonly protection: RuntimeHostProtection;
  readonly sandboxHostApproval: ControllerSandboxHostApproval;
  readonly activationId: string;
  readonly ownerEpoch: number;
  readonly toolExecutionController: ControllerExecutionDriver;
  readonly assertOpen: () => void;
  readonly artifactStore: ArtifactStore;
  readonly resolveRef: (ref: string) => Promise<unknown>;
}
export interface ControllerAdapterInvocationResult {
  readonly artifact: PublishedArtifact;
  readonly operationId: string;
}
export interface ExecutableControllerHost {
  invokePlanner(request: ControllerRequest, signal?: AbortSignal): Promise<ControllerResponse>;
  invokeAdapter(
    action: Extract<ControllerAction, { readonly kind: "adapter" }>,
    requestDigest: string,
    signal?: AbortSignal,
  ): Promise<ControllerAdapterInvocationResult>;
}
export type Authority =
  | ApprovedControllerDefinition["record"]["controller_authority"]
  | ApprovedControllerDefinition["record"]["adapter_authorities"][number];
export interface ProgramInvocation {
  readonly options: Readonly<CreateExecutableControllerHostOptions>;
  readonly runtimeStore: ControllerRuntimeStore;
  readonly currentDefinition: () => Promise<ApprovedControllerDefinition>;
  readonly origin: ControllerExecutionOrigin;
  readonly runtimeId: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly authority: Authority;
  readonly capability: "read_only" | "private_staging";
  readonly request: unknown;
  readonly signal?: AbortSignal;
  readonly needsStaging: boolean;
}
export interface ProgramResult {
  readonly stdout: Buffer;
  readonly staging?: ArtifactStaging;
}
export type AdapterAuthority = {
  readonly adapter: ControllerAdapterConfig;
  readonly authority: Authority;
};
