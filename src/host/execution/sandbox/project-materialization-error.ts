/** Failure to safely capture or verify private project bytes. */
export class SandboxProjectMaterializationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "SandboxProjectMaterializationError";
  }
}
