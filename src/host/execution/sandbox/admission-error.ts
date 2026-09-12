/** Failure while durably capturing or reopening sandbox admission authority. */
export class SandboxAdmissionStoreError extends Error {
  constructor(
    message: string,
    readonly artifactPath?: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "SandboxAdmissionStoreError";
  }
}
