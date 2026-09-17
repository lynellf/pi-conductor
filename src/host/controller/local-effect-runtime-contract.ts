/** Trusted local effect program execution contracts for issue #117. */

import type { LocalProgramInvocation, LocalProgramOutcome } from "../../manifest/local-effect.js";
import type { ToolAdmissionEvidence } from "../../persistence/tool-admission.js";
import type { ProcessIdentity } from "../execution/supervised-process-identity.js";
import type { LocalProgramEffectGrant } from "./local-effect-registry.js";

export type LocalProgramRuntimeGrant = LocalProgramEffectGrant;
export type LocalProgramProviderApproval = LocalProgramEffectGrant["provider"];
export type LocalProgramInvocationInput = Omit<LocalProgramInvocation, "scope" | "credentials">;

/** Durable same-host observation evidence captured before an attempt is admitted. */
export interface LocalProgramProcessAdmission {
  readonly supervisionId: string;
  readonly admission: ToolAdmissionEvidence;
}

export interface LocalProgramProcessSettlement {
  readonly operationId: string;
  readonly invocationId: string;
  readonly supervisionId: string;
  readonly cleanup: "confirmed" | "unconfirmed";
  readonly outcome: "completed" | "failed" | "timed_out" | "aborted";
  readonly identity: ProcessIdentity | null;
}

/** Inputs for one already-authorized execute or inspect attempt. */
export interface RunTrustedLocalEffectProgramOptions {
  readonly grant: LocalProgramRuntimeGrant;
  /** Host-authored invocation identity and private evidence; runtime adds scope and credentials. */
  readonly invocation: LocalProgramInvocationInput;
  readonly hostDriverDigest: string;
  readonly processAdmission: LocalProgramProcessAdmission;
  readonly workspaceRoot: string;
  readonly credentialFiles: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Recheck live grant, ownership, abort, repository/ref, and evidence authority before stdin. */
  readonly assertInvocationOpen: () => void | Promise<void>;
  /** Persist process identity; stdin remains withheld until this resolves. */
  readonly onSpawn: (identity: ProcessIdentity) => void | Promise<void>;
  /** Persist cleanup evidence before the attempt result is accepted by the broker. */
  readonly onSettled: (settlement: LocalProgramProcessSettlement) => void | Promise<void>;
}

export type LocalProgramRuntimeResult =
  | { readonly kind: "outcome"; readonly outcome: LocalProgramOutcome }
  | { readonly kind: "uncertain"; readonly diagnosticCode: string };

export interface LocalProgramRecoveryObservation {
  readonly state: "stopped" | "live" | "unconfirmed";
  readonly processes: readonly ProcessIdentity[];
}

export interface LocalProgramRecoveryAttempt extends LocalProgramProcessAdmission {
  readonly spawnedIdentity?: ProcessIdentity;
}

/** Pre-effect validation failures have no provider result and are safe to reject. */
export class LocalProgramRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalProgramRuntimeError";
  }
}
